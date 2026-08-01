import { frameUntrustedSlack, type Delivery, type Provider, type Reason } from "../domain.js";
import { BrokerClient } from "./broker-client.js";
import {
  DispatchCapabilityError,
  DispatchCapabilityRegistry,
  type DispatchCapabilityBinding,
} from "./dispatch-capability.js";
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
    private readonly dispatchCapabilities = new DispatchCapabilityRegistry(),
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

  async recoverInterruptedDispatches(): Promise<number> {
    let recovered = 0;
    for (const local of this.store.listAmbiguousAfterRestart()) {
      const delivery = this.store.delivery(local.delivery_id);
      if (!delivery) continue;
      try {
        await this.broker.finish(delivery, {
          generation: local.generation,
          status: "ambiguous",
          reasons: [{ code: "edge_restarted_during_dispatch", detail: "local edge restarted before provider dispatch outcome was durably recorded" }],
          providerReceipt: local.provider_receipt,
        });
        this.store.setStatus(local.delivery_id, local.generation, "ambiguous", local.provider_receipt);
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
    const capabilityState: { current: ActiveDispatchCapability | null } = { current: null };
    try {
      // A successful claim extends the shared actor lease. Keep every ACK
      // capability governed by that exact actor/generation fence aligned with it.
      this.dispatchCapabilities.renewLeaseScope(
        delivery.actor,
        generation,
        delivery.subscription.leaseTtlMs,
      );
      const existing = this.store.receive(delivery, generation);
      if (["dispatched", "processed"].includes(existing.status)) return true;

      current = await this.broker.accept(delivery);
      const replay = await this.broker.replay(current);
      const framed = frameUntrustedSlack(current, replay);
      current = await this.broker.beginDispatch(current);
      this.store.setStatus(current.id, generation, "dispatching");

      const dispatch = await this.withLeaseHeartbeat(
        current,
        () => capabilityState.current,
        () => this.dispatch(
          current,
          framed,
          () => { providerStarted = true; },
          (capability) => { capabilityState.current = capability; },
          async (capability) => {
            // Live surfaces may acknowledge synchronously while accepting the
            // turn. Publish durable dispatched state and activate the bearer
            // before allowing the callback to emit anything.
            current = await this.broker.markDispatched(current);
            this.store.setStatus(current.id, generation, "dispatched");
            this.dispatchCapabilities.activate(capability.capability, capability.binding);
          },
        ),
      );
      if (capabilityState.current) {
        // Do not overwrite a synchronous live acknowledgement. Otherwise retain
        // the callback receipt as recovery evidence while awaiting explicit ACK.
        if (this.store.get(current.id)?.status === "dispatched") {
          this.store.setStatus(current.id, generation, "dispatched", dispatch.receipt);
        }
      } else {
        current = await this.broker.markDispatched(current);
        this.store.setStatus(current.id, generation, "dispatched", dispatch.receipt);
      }
      if (dispatch.processed) {
        if (capabilityState.current) {
          this.dispatchCapabilities.revoke(capabilityState.current.capability);
        }
        await this.broker.reply(current, headlessAcknowledgement(dispatch.receipt));
        await this.broker.finish(current, { generation, status: "processed", reasons: [], providerReceipt: dispatch.receipt });
        this.store.setStatus(current.id, generation, "processed", dispatch.receipt);
      }
      return true;
    } catch (error) {
      if (capabilityState.current) {
        this.dispatchCapabilities.revoke(capabilityState.current.capability);
      }
      await this.recordDeliveryFailure(current, generation, providerStarted, error);
      return true;
    }
  }

  private async recordDeliveryFailure(
    delivery: Delivery,
    generation: number,
    providerStarted: boolean,
    error: unknown,
  ): Promise<void> {
    const providerOutcomeUnknown = providerStarted && !(error instanceof ProviderPreDispatchError);
    const status = providerOutcomeUnknown ? "ambiguous" as const : "undeliverable" as const;
    const reason = classifyDeliveryFailure(error, providerOutcomeUnknown);
    console.error("hive edge delivery failed", delivery.id, generation, reason.code);
    try {
      await this.broker.finish(delivery, {
        generation,
        status,
        reasons: [reason],
        providerReceipt: null,
      });
    } catch (finishError) {
      // The broker lease-expiry sweep is the authority of last resort. Never let one
      // poisoned delivery terminate the edge loop merely because its disposition
      // could not be recorded during the same iteration.
      console.error("hive edge delivery disposition failed", safeEdgeErrorCode(finishError));
      return;
    }
    try {
      this.store.setStatus(delivery.id, generation, status);
    } catch (storeError) {
      // Broker state is already durable. A local journal write failure is isolated
      // to this delivery and will be reconciled by the broker fence after restart.
      console.error("hive edge local disposition failed", safeEdgeErrorCode(storeError));
    }
  }

  private async withLeaseHeartbeat<T>(
    delivery: Delivery,
    capability: () => ActiveDispatchCapability | null,
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
    const renewLeaseScope = async (): Promise<void> => {
      await this.broker.renew(delivery);
      this.dispatchCapabilities.renewLeaseScope(
        delivery.actor,
        requiredGeneration(delivery),
        delivery.subscription.leaseTtlMs,
      );
    };

    // Accept and replay may have consumed most of the TTL acquired by claim.
    // Refresh the broker fence synchronously before minting authority or invoking
    // any provider, then serialize all periodic renewals behind this one.
    await renewLeaseScope();
    const heartbeat = (async () => {
      while (!stopped) {
        await waitForInterval();
        if (stopped) return;
        try {
          // Renewals are intentionally serialized. A failed renewal is sticky and
          // terminates this loop, so no later success can resurrect stale authority.
          await renewLeaseScope();
        } catch (error) {
          heartbeatError = error;
          const active = capability();
          if (active) this.dispatchCapabilities.revoke(active.capability);
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

  async acknowledge(delivery: Delivery, text: string): Promise<void> {
    const generation = requiredGeneration(delivery);
    await this.broker.reply(delivery, text);
    await this.broker.finish(delivery, { generation, status: "processed", reasons: [], providerReceipt: text });
    try {
      this.store.setStatus(delivery.id, generation, "processed", text);
    } catch (error) {
      // Broker completion is authoritative. Never turn a successful ACK into an
      // apparent failure merely because the local journal could not catch up.
      console.error("hive edge local acknowledgement failed", safeEdgeErrorCode(error));
    }
  }

  async acknowledgeByCapability(deliveryId: number, capability: string, text: string): Promise<void> {
    const local = this.store.get(deliveryId);
    const delivery = this.store.delivery(deliveryId);
    if (local?.status !== "dispatched" || !delivery || delivery.leaseGeneration === null || delivery.attempts < 1) {
      throw new DispatchCapabilityError();
    }
    const generation = requiredGeneration(delivery);
    this.dispatchCapabilities.consume(capability, dispatchBinding(delivery));
    try {
      await this.acknowledge(delivery, text);
    } catch (error) {
      // Consumption is final. If the Slack reply or broker completion has an
      // uncertain outcome, promptly ask the broker to fence the delivery as
      // ambiguous without ever restoring the bearer.
      await this.recordDeliveryFailure(
        delivery,
        generation,
        true,
        new ProviderAcknowledgementUnknownError(),
      );
      throw error;
    }
  }

  private async dispatch(
    delivery: Delivery,
    framed: string,
    onProviderStart: () => void,
    onCapability: (capability: ActiveDispatchCapability) => void,
    prepareLive: (capability: ActiveDispatchCapability) => Promise<void>,
  ): Promise<ProviderDispatch> {
    const subscription = delivery.subscription;
    const adapter = this.adapters.get(subscription.provider);
    if (!adapter) throw new PreDispatchError("provider_adapter_missing");
    const live = this.live.get(delivery.actor, subscription.provider);
    if (live) {
      const binding = dispatchBinding(delivery);
      const minted = this.dispatchCapabilities.mint(binding, subscription.leaseTtlMs, delivery.actor);
      const capability = { capability: minted.capability, binding };
      onCapability(capability);
      await prepareLive(capability);
      onProviderStart();
      return adapter.deliverLive(live, delivery, framed, minted.capability);
    }
    if (subscription.wakePolicy === "live_only") throw new PreDispatchError("live_ingress_unavailable");

    const workspace = subscription.edgeWorkspaces.find((item) => item.edgeId === this.broker.edgeId);
    if (!workspace) throw new PreDispatchError("workspace_not_mapped");
    if (subscription.sessionId && this.broker.edgeId === subscription.homeEdge) {
      adapter.preflight?.(subscription);
      onProviderStart();
      return adapter.resume(subscription, workspace.cwd, framed);
    }
    if (subscription.wakePolicy === "resume") throw new PreDispatchError("resume_target_missing");
    adapter.preflight?.(subscription);
    if (!await this.broker.reserveSpawn(delivery)) throw new PreDispatchError("spawn_rate_limited");
    onProviderStart();
    return adapter.spawn(subscription, workspace.cwd, framed);
  }
}

interface ActiveDispatchCapability {
  capability: string;
  binding: DispatchCapabilityBinding;
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

class ProviderAcknowledgementUnknownError extends Error {
  constructor() {
    super("provider_acknowledgement_unknown");
    this.name = "ProviderAcknowledgementUnknownError";
  }
}

export function headlessAcknowledgement(receipt: string): string {
  let best = "Headless provider turn completed successfully.";
  for (const line of receipt.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "result" && typeof value.result === "string") best = value.result;
      const item = value.item as Record<string, unknown> | undefined;
      if (value.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        best = item.text;
      }
    } catch {
      // Provider receipts are JSONL on supported surfaces; non-JSON diagnostics are ignored.
    }
  }
  return best.length <= 2_500 ? best : `${best.slice(0, 2_497)}…`;
}

function requiredGeneration(delivery: Delivery): number {
  if (delivery.leaseGeneration === null) throw new Error("delivery has no lease generation");
  return delivery.leaseGeneration;
}

function dispatchBinding(delivery: Delivery): DispatchCapabilityBinding {
  return {
    deliveryId: delivery.id,
    generation: requiredGeneration(delivery),
    providerAttempt: delivery.attempts,
  };
}

function classifyDeliveryFailure(error: unknown, providerStarted: boolean): Reason {
  if (error instanceof ProviderAcknowledgementUnknownError) {
    return {
      code: "provider_acknowledgement_unknown",
      detail: "provider dispatch was accepted but the explicit acknowledgement outcome was not confirmed",
    };
  }
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
    case "live_ingress_rejected": return "the live callback rejected dispatch before starting a provider turn";
    case "provider_permission_profile_invalid": return "the configured provider permission profile was invalid";
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
    "stale lease",
  ].find((code) => message.includes(code)) ?? "edge_iteration_failed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
