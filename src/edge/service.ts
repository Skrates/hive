import { frameWakeInstruction, type Delivery, type Provider, type Reason } from "../domain.js";
import { BrokerClient } from "./broker-client.js";
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
}

const systemEdgeTimers: EdgeTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class EdgeService {
  private after = 0;
  private running = false;

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

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("edge service already running");
    this.running = true;
    try {
      await this.recoverInterruptedDispatches();
      while (!signal?.aborted) {
        try {
          const worked = await this.processOne(25_000);
          if (!worked) await delay(100);
        } catch (error) {
          if (signal?.aborted) break;
          console.error("hive edge iteration failed", safeEdgeErrorCode(error));
          await delay(100);
        }
      }
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

  async processOne(waitMs = 0): Promise<boolean> {
    const delivery = await this.broker.claim(this.after, waitMs);
    if (!delivery) return false;
    this.after = Math.max(this.after, delivery.id);
    const generation = delivery.leaseGeneration;
    if (generation === null) {
      console.error("hive edge delivery rejected", "claimed_delivery_missing_generation");
      return true;
    }

    let current = delivery;
    let providerStarted = false;
    try {
      const existing = this.store.receive(delivery, generation);
      if (["dispatched", "processed"].includes(existing.status)) return true;

      current = await this.broker.accept(delivery);
      const replay = await this.broker.replay(current);
      const framed = frameWakeInstruction(current, replay);
      current = await this.broker.beginDispatch(current);
      this.store.setStatus(current.id, generation, "dispatching");

      const dispatch = await this.withLeaseHeartbeat(
        current,
        () => this.dispatch(current, framed, () => { providerStarted = true; }),
      );
      current = await this.broker.markDispatched(current);
      this.store.setStatus(current.id, generation, "dispatched", dispatch.receipt);
      if (dispatch.processed) {
        // Headless run: the provider turn completed and its receipt IS the
        // agent's outcome. The outcome travels inside the terminal transition
        // so the broker commits `processed` and the durable thread post
        // together — a Slack outage can neither lose the outcome nor cause
        // this trusted instruction to rerun.
        await this.broker.finish(current, {
          generation,
          status: "processed",
          reasons: [],
          providerReceipt: dispatch.receipt,
          outcome: headlessAcknowledgement(dispatch.receipt),
        });
        this.store.setStatus(current.id, generation, "processed", dispatch.receipt);
        return true;
      }
      // Live delivery (Codex steer accepted / Claude inbox written): dispatch
      // is durable but the agent has not answered yet. The delivery stays
      // `dispatched` until the agent's `hive reply` closes it (R-6); if no
      // outcome ever arrives, the broker sweep requeues it after the
      // dispatched-outcome grace and exhaustion becomes a visible `failed` —
      // never a silent `processed` with no answer.
      return true;
    } catch (error) {
      await this.recordDeliveryFailure(current, generation, providerStarted, error);
      return true;
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
    const deterministic = error instanceof ProviderPreDispatchError
      || (error instanceof PreDispatchError && !providerStarted);
    console.error("hive edge delivery failed", delivery.id, generation, reason.code);
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
    framed: string,
    onProviderStart: () => void,
  ): Promise<ProviderDispatch> {
    const subscription = delivery.subscription;
    const adapter = this.adapters.get(subscription.provider);
    if (!adapter) throw new PreDispatchError("provider_adapter_missing");
    adapter.preflight?.(subscription);

    const live = this.live.get(delivery.actor, subscription.provider);
    if (live) {
      onProviderStart();
      return adapter.deliverLive(live, delivery, framed);
    }
    if (subscription.wakePolicy === "live_only") throw new PreDispatchError("live_ingress_unavailable");

    const workspace = subscription.edgeWorkspaces.find((item) => item.edgeId === this.broker.edgeId);
    if (!workspace) throw new PreDispatchError("workspace_not_mapped");
    if (subscription.sessionId && this.broker.edgeId === subscription.homeEdge) {
      onProviderStart();
      return adapter.resume(subscription, workspace.cwd, framed);
    }
    if (subscription.wakePolicy === "resume") throw new PreDispatchError("resume_target_missing");
    if (!await this.broker.reserveSpawn(delivery)) throw new PreDispatchError("spawn_rate_limited");
    onProviderStart();
    return adapter.spawn(subscription, workspace.cwd, framed);
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

export function headlessAcknowledgement(receipt: string): string {
  // Three sources in precedence order. Claude's terminal `result` line is the
  // clean-run outcome; Codex's `item.completed`/`agent_message` is its
  // equivalent. But when a run is disturbed — e.g. a hook_non_blocking_error
  // aborts the clean result — Claude may emit no usable `result`, leaving only
  // the assistant turns. Falling back to the last assistant message keeps the
  // real final text out of the empty-summary hole instead of surfacing the
  // "completed successfully" placeholder.
  let resultText: string | null = null;
  let agentMessageText: string | null = null;
  let lastAssistantText: string | null = null;
  for (const line of receipt.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "result" && typeof value.result === "string" && value.result.length > 0) {
        resultText = value.result;
      }
      const item = value.item as Record<string, unknown> | undefined;
      if (value.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        agentMessageText = item.text;
      }
      if (value.type === "assistant") {
        const text = assistantMessageText(value.message);
        if (text) lastAssistantText = text;
      }
    } catch {
      // Provider receipts are JSONL on supported surfaces; non-JSON diagnostics are ignored.
    }
  }
  const best = resultText ?? agentMessageText ?? lastAssistantText ?? "Headless provider turn completed successfully.";
  return best.length <= 2_500 ? best : `${best.slice(0, 2_497)}…`;
}

/** Concatenate the text blocks of a Claude `assistant` stream-json message. */
function assistantMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

function classifyDeliveryFailure(error: unknown, providerStarted: boolean): Reason {
  if (error instanceof ProviderPreDispatchError) {
    return { code: error.code, detail: preDispatchDetail(error.code) };
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
    default: return "provider dispatch was rejected before invocation";
  }
}

function safeEdgeErrorCode(error: unknown): string {
  if (error instanceof ProviderPreDispatchError) return error.code;
  if (error instanceof PreDispatchError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return [
    "live_ingress_unavailable",
    "resume_target_missing",
    "workspace_not_mapped",
    "provider_adapter_missing",
    "spawn_rate_limited",
    "account_profile_missing",
    "stale lease",
  ].find((code) => message.includes(code)) ?? "edge_iteration_failed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
