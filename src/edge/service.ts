import { frameUntrustedSlack, type Delivery, type Provider, type Reason } from "../domain.js";
import { BrokerClient } from "./broker-client.js";
import { LiveIngressRegistry } from "./live-registry.js";
import type { ProviderAdapter, ProviderDispatch } from "./providers.js";
import { EdgeStore } from "./store.js";

export class EdgeService {
  private after = 0;
  private running = false;

  constructor(
    readonly broker: BrokerClient,
    readonly store: EdgeStore,
    readonly live: LiveIngressRegistry,
    adapters: ProviderAdapter[],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  private readonly adapters: Map<Provider, ProviderAdapter>;

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("edge service already running");
    this.running = true;
    try {
      while (!signal?.aborted) {
        const worked = await this.processOne(25_000);
        if (!worked) await delay(100);
      }
    } finally {
      this.running = false;
    }
  }

  async processOne(waitMs = 0): Promise<boolean> {
    const delivery = await this.broker.claim(this.after, waitMs);
    if (!delivery) return false;
    this.after = Math.max(this.after, delivery.id);
    const generation = requiredGeneration(delivery);
    const existing = this.store.receive(delivery, generation);
    if (["dispatched", "processed"].includes(existing.status)) return true;

    let current = await this.broker.accept(delivery);
    const replay = await this.broker.replay(current);
    const framed = frameUntrustedSlack(current, replay);
    current = await this.broker.beginDispatch(current);
    this.store.setStatus(current.id, generation, "dispatching");

    try {
      const dispatch = await this.withLeaseHeartbeat(current, () => this.dispatch(current, framed));
      this.store.setStatus(current.id, generation, "dispatched", dispatch.receipt);
      current = await this.broker.markDispatched(current);
      if (dispatch.processed) {
        await this.broker.finish(current, { generation, status: "processed", reasons: [], providerReceipt: dispatch.receipt });
        this.store.setStatus(current.id, generation, "processed", dispatch.receipt);
      }
      return true;
    } catch (error) {
      const reason = classifyProviderError(error);
      const status = reason.code === "live_ingress_unavailable" || reason.code === "resume_target_missing"
        ? "undeliverable"
        : "ambiguous";
      await this.broker.finish(current, { generation, status, reasons: [reason], providerReceipt: null });
      this.store.setStatus(current.id, generation, status);
      return true;
    }
  }

  private async withLeaseHeartbeat<T>(delivery: Delivery, operation: () => Promise<T>): Promise<T> {
    const intervalMs = Math.max(250, Math.floor(delivery.subscription.leaseTtlMs / 3));
    let heartbeatError: unknown = null;
    const timer = setInterval(() => {
      void this.broker.renew(delivery).catch((error: unknown) => { heartbeatError = error; });
    }, intervalMs);
    try {
      const result = await operation();
      if (heartbeatError) throw heartbeatError;
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  async acknowledge(delivery: Delivery, text: string): Promise<void> {
    const generation = requiredGeneration(delivery);
    await this.broker.reply(delivery, text);
    await this.broker.finish(delivery, { generation, status: "processed", reasons: [], providerReceipt: text });
    this.store.setStatus(delivery.id, generation, "processed", text);
  }


  async acknowledgeById(deliveryId: number, text: string): Promise<void> {
    const delivery = this.store.delivery(deliveryId);
    if (!delivery) throw new Error(`local delivery ${deliveryId} not found`);
    await this.acknowledge(delivery, text);
  }

  private async dispatch(delivery: Delivery, framed: string): Promise<ProviderDispatch> {
    const subscription = delivery.subscription;
    const adapter = this.adapters.get(subscription.provider);
    if (!adapter) throw new Error(`provider_adapter_missing:${subscription.provider}`);
    const live = this.live.get(delivery.actor, subscription.provider);
    if (live) return adapter.deliverLive(live, delivery, framed);
    if (subscription.wakePolicy === "live_only") throw new Error("live_ingress_unavailable");

    const workspace = subscription.edgeWorkspaces.find((item) => item.edgeId === this.broker.edgeId);
    if (!workspace) throw new Error("workspace_not_mapped");
    if (subscription.sessionId && this.broker.edgeId === subscription.homeEdge) {
      return adapter.resume(subscription, workspace.cwd, framed);
    }
    if (subscription.wakePolicy === "resume") throw new Error("resume_target_missing");
    return adapter.spawn(subscription, workspace.cwd, framed);
  }
}

function requiredGeneration(delivery: Delivery): number {
  if (delivery.leaseGeneration === null) throw new Error("delivery has no lease generation");
  return delivery.leaseGeneration;
}

function classifyProviderError(error: unknown): Reason {
  const detail = error instanceof Error ? error.message : String(error);
  const known = [
    "live_ingress_unavailable",
    "resume_target_missing",
    "workspace_not_mapped",
    "provider_adapter_missing",
  ].find((code) => detail.includes(code));
  return { code: known ?? "provider_dispatch_unknown", detail };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
