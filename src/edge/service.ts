import { frameWakeInstruction, type Delivery, type Provider, type Reason, type ReplaySnapshot } from "../domain.js";
import { BROKER_REQUEST_TIMEOUT_CODE, BrokerClient } from "./broker-client.js";
import { LiveIngressRegistry } from "./live-registry.js";
import {
  ProviderPreDispatchError,
  type ProviderAdapter,
  type ProviderDispatch,
} from "./providers.js";
import { EdgeStore } from "./store.js";

export interface EdgeTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
  /** Current epoch-ms — the clock the liveness observables are stamped from. */
  now(): number;
}

const systemEdgeTimers: EdgeTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Concurrent provider dispatches an edge will run at once. Discovered the hard
 * way on the first multi-actor edge (cx53, 2026-08-11): the loop used to await
 * each provider turn before claiming again, so one actor's 80-minute headless
 * turn starved every co-tenant actor's deliveries — they sat `pending` at the
 * broker for hours. Same-actor serialization is NOT the lease's job here — a
 * same-edge claim on a live lease shares the generation by design — so the
 * edge declares its busy actors on every claim and the broker skips their
 * deliveries. This cap therefore bounds how many *distinct* actors run turns
 * simultaneously on one machine.
 */
const MAX_CONCURRENT_DISPATCHES = 4;

/**
 * Wall-clock ceiling on one provider dispatch.
 *
 * Nothing bounded a dispatch before: a provider child that neither exits nor
 * errors held its slot indefinitely, and `withLeaseHeartbeat` renewed the
 * broker fence underneath it forever, so the broker's own lease-expiry sweep
 * could never reclaim the delivery either. Four such dispatches park the run
 * loop at capacity permanently.
 *
 * The longest legitimate headless turn observed on a Weave seat is 77 minutes
 * (cx53, 2026-08-15). Three hours is ~2.3× that: generous enough that killing a
 * live turn stays a genuine anomaly, tight enough that a wedged slot is not a
 * day-long outage. Crossing it releases the delivery for redelivery rather than
 * declaring an outcome — the seat-side dedupe contract is what makes that safe.
 */
const MAX_DISPATCH_MS = 3 * 60 * 60_000;

/**
 * Longest the run loop will park waiting for a slot to free. The park itself is
 * correct — at capacity there is nothing to claim — but an unbounded `await`
 * anywhere in the loop is a place the loop can be lost. Returning to the top on
 * a timer keeps `signal.aborted` observable and keeps the loop's own liveness
 * legible to the watchdog.
 */
const CAPACITY_PARK_MS = 30_000;

/** Pause after an empty long-poll or a failed iteration before claiming again. */
const EMPTY_POLL_BACKOFF_MS = 100;

/** A dispatch that outlived {@link MAX_DISPATCH_MS}; uncertainty, so the delivery is released. */
export class DispatchDeadlineError extends Error {
  constructor(readonly deliveryId: number, readonly elapsedMs: number) {
    super(`dispatch for delivery ${deliveryId} exceeded ${elapsedMs}ms`);
    this.name = "DispatchDeadlineError";
  }
}

export class EdgeService {
  private after = 0;
  private running = false;
  /** Epoch-ms of the last COMPLETED broker claim round-trip — the watchdog's evidence. */
  private pollCompletedAt: number | null = null;
  /** Live background dispatches; each promise settles (never rejects) when its delivery reaches a disposition. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Actors with a dispatch currently running — declared to the broker on claim so it never hands out a second concurrent turn for the same actor. */
  private readonly busyActors = new Set<string>();

  constructor(
    readonly broker: BrokerClient,
    readonly store: EdgeStore,
    readonly live: LiveIngressRegistry,
    adapters: ProviderAdapter[],
    private readonly timers = systemEdgeTimers,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  private readonly adapters: Map<Provider, ProviderAdapter>;

  /**
   * Epoch-ms of the last completed broker claim round-trip, or null if none has
   * completed since boot. "Completed" means the broker answered — an errored or
   * timed-out poll deliberately does not count, because reaching the broker is
   * the only thing that distinguishes a live edge from a deaf one.
   */
  lastPollAt(): number | null {
    return this.pollCompletedAt;
  }

  /** True when every dispatch slot is occupied, so the loop is legitimately not polling. */
  saturated(): boolean {
    return this.inFlight.size >= MAX_CONCURRENT_DISPATCHES;
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("edge service already running");
    this.running = true;
    try {
      await this.recoverInterruptedDispatches();
      while (!signal?.aborted) {
        try {
          if (this.saturated()) {
            // At capacity: wait for any running turn to reach a disposition
            // before claiming more. Dispatch promises never reject. The timer
            // arm bounds the park — every dispatch already carries its own
            // deadline, so this is defence in depth rather than the mechanism
            // that frees a wedged slot.
            const park = this.parkTick(CAPACITY_PARK_MS);
            try {
              await Promise.race([...this.inFlight, park.reached]);
            } finally {
              park.cancel();
            }
            continue;
          }
          const claimed = await this.claimNext(25_000);
          if (!claimed) await this.sleep(EMPTY_POLL_BACKOFF_MS);
        } catch (error) {
          if (signal?.aborted) break;
          console.error("hive edge iteration failed", safeEdgeErrorCode(error));
          await this.sleep(EMPTY_POLL_BACKOFF_MS);
        }
      }
      // Shutdown: give in-flight dispatches the chance to record their
      // disposition (systemd's stop timeout is the outer bound; anything cut
      // off mid-turn is recovered by recoverInterruptedDispatches on reboot).
      await Promise.allSettled([...this.inFlight]);
    } finally {
      this.running = false;
    }
  }

  /**
   * ADR-0003 R-3: an edge restart mid-dispatch is ordinary uncertainty. Ask
   * the broker to requeue each interrupted delivery; a stale fence means the
   * broker's lease-expiry sweep already owns the requeue. Either way the
   * delivery retries — never a reconciliation obligation.
   */
  async recoverInterruptedDispatches(): Promise<number> {
    let recovered = 0;
    for (const local of this.store.listInterruptedDispatches()) {
      const delivery = this.store.delivery(local.delivery_id);
      if (!delivery) continue;
      try {
        await this.broker.release(delivery, {
          code: "edge_restarted_during_dispatch",
          detail: "local edge restarted before the provider dispatch outcome was recorded",
        });
        this.store.setStatus(local.delivery_id, local.generation, "released");
        recovered += 1;
      } catch {
        // A stale fence means the broker is authoritative and its lease-expiry sweep owns recovery.
      }
    }
    return recovered;
  }

  /**
   * Claim one delivery and run its dispatch to a disposition, fully awaited.
   * The run() loop uses {@link claimNext} instead so co-tenant actors' turns
   * overlap; this awaited form is the deterministic surface tests drive.
   */
  async processOne(waitMs = 0): Promise<boolean> {
    const claimed = await this.claimNext(waitMs);
    if (!claimed) return false;
    await claimed.done;
    return true;
  }

  /**
   * Claim one delivery; if one was claimed, start its dispatch in the
   * background (tracked in {@link inFlight}) and return its `done` promise —
   * BOXED in an object, because `await` flattens a bare returned promise and
   * the run() loop must be able to observe the claim without awaiting the
   * dispatch. Returns null when the long-poll came back empty. `done` never
   * rejects — every failure path inside dispatch records a disposition.
   */
  private async claimNext(waitMs: number): Promise<{ done: Promise<void> } | null> {
    const delivery = await this.broker.claim(this.after, waitMs, [...this.busyActors]);
    // Stamped only on a completed round-trip: a throw leaves the previous stamp
    // standing and the watchdog's window keeps running.
    this.pollCompletedAt = this.timers.now();
    if (!delivery) return null;
    this.after = Math.max(this.after, delivery.id);
    const generation = delivery.leaseGeneration;
    if (generation === null) {
      console.error("hive edge delivery rejected", "claimed_delivery_missing_generation");
      return { done: Promise.resolve() };
    }
    this.busyActors.add(delivery.actor);
    const tracked: Promise<void> = this.dispatchClaimed(delivery, generation)
      .finally(() => {
        this.inFlight.delete(tracked);
        this.busyActors.delete(delivery.actor);
      });
    this.inFlight.add(tracked);
    return { done: tracked };
  }

  /** The full post-claim delivery lifecycle; never throws — all failures land in recordDeliveryFailure. */
  private async dispatchClaimed(delivery: Delivery, generation: number): Promise<void> {
    let current = delivery;
    let providerStarted = false;
    try {
      const existing = this.store.receive(delivery, generation);
      if (["dispatched", "processed"].includes(existing.status)) return;

      current = await this.broker.accept(delivery);
      const replay = await this.broker.replay(current);
      current = await this.broker.beginDispatch(current);
      this.store.setStatus(current.id, generation, "dispatching");

      // The deadline sits INSIDE the heartbeat, not around it: a dispatch that
      // outlives its bound must stop the lease renewals too, or the edge would
      // keep the broker's fence alive for a turn nobody is waiting on.
      const dispatch = await this.withLeaseHeartbeat(
        current,
        () => this.withDispatchDeadline(
          current,
          (deadline) => this.dispatch(current, replay, () => { providerStarted = true; }, deadline),
        ),
      );
      current = await this.broker.markDispatched(current);
      this.store.setStatus(current.id, generation, "dispatched", dispatch.receipt);
      if (dispatch.processed) {
        // A completed provider turn (headless, or a completion-tracked Codex
        // live turn) carries the agent's final text in `outcome`; `receipt` is
        // bounded diagnostic evidence only. The outcome travels inside the
        // terminal transition so the broker commits `processed` and the
        // durable thread post together — a Slack outage can neither lose the
        // outcome nor cause this trusted instruction to rerun.
        await this.broker.finish(current, {
          generation,
          status: "processed",
          reasons: [],
          providerReceipt: dispatch.receipt,
          outcome: dispatch.outcome,
        });
        this.store.setStatus(current.id, generation, "processed", dispatch.receipt);
        return;
      }
      // A non-completion-tracked live delivery (currently Claude inbox write)
      // is durable but the agent has not answered yet. The delivery stays
      // `dispatched` until the agent's `hive reply` closes it (R-6); if no
      // outcome ever arrives, the broker sweep requeues it after the
      // dispatched-outcome grace and exhaustion becomes a visible `failed` —
      // never a silent `processed` with no answer.
    } catch (error) {
      await this.recordDeliveryFailure(current, generation, providerStarted, error);
    }
  }

  /**
   * ADR-0003 R-3 failure split: a deterministic pre-dispatch rejection proves
   * no provider effect and terminalizes as `undeliverable`; everything else is
   * uncertainty and releases the delivery for another attempt. The broker
   * decides whether the release requeues or exhausts into `failed`.
   */
  private async recordDeliveryFailure(
    delivery: Delivery,
    generation: number,
    providerStarted: boolean,
    error: unknown,
  ): Promise<void> {
    const reason = classifyDeliveryFailure(error, providerStarted);
    const attemptLabel = `attempt ${delivery.attempts}/${delivery.subscription.maxAttempts}`;
    // A spawn-rate rejection is transient — the window passes — so it releases
    // for redelivery instead of terminalizing (2026-08-11: four queued wakes
    // burned undeliverable in one burst after an edge restart).
    const deterministic = (error instanceof ProviderPreDispatchError
      || (error instanceof PreDispatchError && !providerStarted))
      && reason.code !== "spawn_rate_limited";
    // The attempt counter is the bound that decides redelivery vs terminal
    // `failed`; the lease generation is a per-ACTOR monotonic counter that says
    // nothing about this delivery's retries. Logging only the latter read as
    // "re-leased 80 times with no exhaustion" during the 2026-08-15 incident
    // triage. Print the bound that is actually enforced, and label both.
    console.error("hive edge delivery failed", delivery.id, `gen ${generation}`, attemptLabel, reason.code);
    try {
      if (deterministic) {
        await this.broker.finish(delivery, { generation, status: "undeliverable", reasons: [reason], providerReceipt: null, outcome: null });
      } else {
        await this.broker.release(delivery, reason);
      }
    } catch (dispositionError) {
      // The broker lease-expiry sweep is the authority of last resort. Never let one
      // poisoned delivery terminate the edge loop merely because its disposition
      // could not be recorded during the same iteration.
      console.error("hive edge delivery disposition failed", safeEdgeErrorCode(dispositionError));
      return;
    }
    try {
      this.store.setStatus(delivery.id, generation, deterministic ? "undeliverable" : "released");
    } catch (storeError) {
      // Broker state is already durable. A local journal write failure is isolated
      // to this delivery and reconverges on the next receive.
      console.error("hive edge local disposition failed", safeEdgeErrorCode(storeError));
    }
  }

  /** Every wait in the run loop goes through the injected timers, so the loop's own clock is testable. */
  private sleep(delayMs: number): Promise<void> {
    const tick = this.parkTick(delayMs);
    return tick.reached;
  }

  /**
   * A timer arm for the capacity park, with an explicit cancel so a dispatch
   * that settles first does not leave a live handle behind.
   */
  private parkTick(delayMs: number): { reached: Promise<void>; cancel: () => void } {
    let handle: unknown = null;
    const reached = new Promise<void>((resolve) => {
      handle = this.timers.set(() => {
        handle = null;
        resolve();
      }, delayMs);
    });
    return {
      reached,
      cancel: () => {
        if (handle !== null) this.timers.clear(handle);
        handle = null;
      },
    };
  }

  /**
   * Run one dispatch under a wall-clock deadline. On expiry the returned
   * promise rejects immediately — freeing the slot and letting the delivery
   * reach a disposition — and the operation is asked to abort so its provider
   * child does not outlive the turn. A late settlement of the aborted operation
   * is absorbed here rather than surfacing as an unhandled rejection.
   */
  private withDispatchDeadline<T>(
    delivery: Delivery,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const startedAt = this.timers.now();
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.set(() => {
        console.error(
          "hive edge dispatch deadline elapsed",
          delivery.id,
          delivery.actor,
          `${MAX_DISPATCH_MS}ms`,
        );
        controller.abort();
        reject(new DispatchDeadlineError(delivery.id, this.timers.now() - startedAt));
      }, MAX_DISPATCH_MS);
      operation(controller.signal).then(
        (value) => {
          this.timers.clear(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.timers.clear(timer);
          reject(error);
        },
      );
    });
  }

  private async withLeaseHeartbeat<T>(
    delivery: Delivery,
    operation: () => Promise<T>,
  ): Promise<T> {
    const intervalMs = Math.max(250, Math.floor(delivery.subscription.leaseTtlMs / 3));
    let heartbeatError: unknown = null;
    let stopped = false;
    let waitTimer: unknown | null = null;
    let releaseWait: (() => void) | null = null;
    const waitForInterval = (): Promise<void> => new Promise((resolve) => {
      releaseWait = resolve;
      waitTimer = this.timers.set(() => {
        waitTimer = null;
        releaseWait = null;
        resolve();
      }, intervalMs);
    });
    const stopHeartbeat = (): void => {
      stopped = true;
      if (waitTimer !== null) this.timers.clear(waitTimer);
      waitTimer = null;
      const release = releaseWait;
      releaseWait = null;
      release?.();
    };

    // Accept and replay may have consumed most of the TTL acquired by claim.
    // Refresh the broker fence synchronously before invoking any provider,
    // then serialize all periodic renewals behind this one.
    await this.broker.renew(delivery);
    const heartbeat = (async () => {
      while (!stopped) {
        await waitForInterval();
        if (stopped) return;
        try {
          // Renewals are intentionally serialized. A failed renewal is sticky and
          // terminates this loop, so no later success can resurrect stale authority.
          await this.broker.renew(delivery);
        } catch (error) {
          heartbeatError = error;
          stopped = true;
        }
      }
    })();

    let result: T | undefined;
    let operationError: unknown = null;
    let operationFailed = false;
    try {
      result = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      stopHeartbeat();
      // Drain any already in-flight broker renewal before reporting dispatch
      // completion to the caller.
      await heartbeat;
    }
    if (operationFailed) throw operationError;
    if (heartbeatError) throw heartbeatError;
    return result as T;
  }

  private async dispatch(
    delivery: Delivery,
    replay: ReplaySnapshot | null,
    onProviderStart: () => void,
    deadline?: AbortSignal,
  ): Promise<ProviderDispatch> {
    const subscription = delivery.subscription;
    const adapter = this.adapters.get(subscription.provider);
    if (!adapter) throw new PreDispatchError("provider_adapter_missing");
    adapter.preflight?.(subscription);

    const live = this.live.get(delivery.actor, subscription.provider);
    if (live) {
      onProviderStart();
      // Codex live delivery waits for the exact app-server turn and lets the
      // edge relay its final assistant text. Claude live inbox delivery still
      // requires the agent-side reply because writing an inbox file is not a
      // provider completion signal.
      const outcomeReporter = subscription.provider === "codex" ? "edge" : "agent";
      return adapter.deliverLive(live, delivery, frameWakeInstruction(delivery, replay, outcomeReporter), deadline);
    }
    if (subscription.wakePolicy === "live_only") throw new PreDispatchError("live_ingress_unavailable");

    const workspace = subscription.edgeWorkspaces.find((item) => item.edgeId === this.broker.edgeId);
    if (!workspace) throw new PreDispatchError("workspace_not_mapped");
    const framed = frameWakeInstruction(delivery, replay, "edge");
    if (subscription.sessionId && this.broker.edgeId === subscription.homeEdge) {
      onProviderStart();
      return adapter.resume(subscription, workspace.cwd, framed, deadline);
    }
    if (subscription.wakePolicy === "resume") throw new PreDispatchError("resume_target_missing");
    if (!await this.broker.reserveSpawn(delivery)) throw new PreDispatchError("spawn_rate_limited");
    onProviderStart();
    return adapter.spawn(subscription, workspace.cwd, framed, deadline);
  }
}

type PreDispatchErrorCode =
  | "live_ingress_unavailable"
  | "resume_target_missing"
  | "workspace_not_mapped"
  | "provider_adapter_missing"
  | "spawn_rate_limited";

class PreDispatchError extends Error {
  constructor(readonly code: PreDispatchErrorCode) {
    super(code);
    this.name = "PreDispatchError";
  }
}

function classifyDeliveryFailure(error: unknown, providerStarted: boolean): Reason {
  if (error instanceof ProviderPreDispatchError) {
    return { code: error.code, detail: preDispatchDetail(error.code) };
  }
  if (error instanceof DispatchDeadlineError) {
    // Distinct from `provider_dispatch_unknown`: the edge did not lose track of
    // this turn, it ended it. Naming that in the thread notice is the whole
    // difference between a visible bound and a mystery retry (R-3).
    return {
      code: "dispatch_deadline_exceeded",
      detail: `the provider turn exceeded the edge's ${Math.round(MAX_DISPATCH_MS / 60_000)}-minute dispatch deadline and was terminated`,
    };
  }
  if (providerStarted) {
    return {
      code: "provider_dispatch_unknown",
      detail: "provider invocation began but its durable outcome was not confirmed",
    };
  }
  if (error instanceof PreDispatchError) {
    return { code: error.code, detail: preDispatchDetail(error.code) };
  }
  return {
    code: "edge_pre_dispatch_failed",
    detail: "edge delivery lifecycle failed before any provider invocation",
  };
}

function preDispatchDetail(code: string): string {
  switch (code) {
    case "live_ingress_unavailable": return "no admitted live ingress was available";
    case "resume_target_missing": return "the subscription had no resumable provider session";
    case "workspace_not_mapped": return "the claiming edge had no declared workspace mapping";
    case "provider_adapter_missing": return "the declared provider adapter was unavailable";
    case "spawn_rate_limited": return "the actor spawn window was exhausted";
    case "live_ingress_rejected": return "the live surface rejected dispatch before starting a provider turn";
    case "provider_permission_profile_invalid": return "the configured provider permission profile was invalid";
    case "account_profile_missing": return "the pinned account profile directory does not exist on this edge (ADR-0003 R-5: profile misbinding is a hard failure)";
    case "account_profile_mismatch": return "the foreground Codex Desktop account does not match the subscription's pinned account profile";
    default: return "provider dispatch was rejected before invocation";
  }
}

function safeEdgeErrorCode(error: unknown): string {
  if (error instanceof ProviderPreDispatchError) return error.code;
  if (error instanceof PreDispatchError) return error.code;
  if (error instanceof DispatchDeadlineError) return "dispatch_deadline_exceeded";
  const message = error instanceof Error ? error.message : String(error);
  return [
    BROKER_REQUEST_TIMEOUT_CODE,
    "live_ingress_unavailable",
    "resume_target_missing",
    "workspace_not_mapped",
    "provider_adapter_missing",
    "spawn_rate_limited",
    "account_profile_missing",
    "account_profile_mismatch",
    "stale lease",
  ].find((code) => message.includes(code)) ?? "edge_iteration_failed";
}
