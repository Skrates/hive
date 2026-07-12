import type { Delivery, DeliveryResultInput, ReplaySnapshot, SlackEventInput, SubscriptionInput } from "../domain.js";
import { BrokerStore } from "./store.js";

export interface SlackTransport {
  replay(channelId: string, threadTs: string): Promise<ReplaySnapshot>;
  reply(channelId: string, threadTs: string, text: string, metadata?: Record<string, string>): Promise<string>;
}

export class BrokerService {
  constructor(
    readonly store: BrokerStore,
    private readonly slack: SlackTransport,
  ) {}

  createEdge(edgeId: string): string {
    return this.store.createEdge(edgeId);
  }

  upsertSubscription(input: SubscriptionInput) {
    return this.store.upsertSubscription(input);
  }

  ingest(event: SlackEventInput, initialSnapshot: unknown | null = null) {
    return this.store.ingestEvent(event, initialSnapshot);
  }

  async claim(edgeId: string, after: number, waitMs: number): Promise<Delivery | null> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 30_000);
    do {
      this.store.markAmbiguousForExpiredDispatches();
      const delivery = this.store.claimNext(edgeId, after);
      if (delivery) return delivery;
      if (Date.now() >= deadline) return null;
      await delay(Math.min(250, deadline - Date.now()));
    } while (true);
  }

  accept(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.transition(deliveryId, edgeId, generation, "claimed", "accepted_local");
  }

  beginDispatch(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.transition(deliveryId, edgeId, generation, "accepted_local", "dispatching");
  }

  markDispatched(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.transition(deliveryId, edgeId, generation, "dispatching", "dispatched");
  }

  renew(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.renewDeliveryLease(deliveryId, edgeId, generation);
  }

  reserveSpawn(deliveryId: number, edgeId: string, generation: number): boolean {
    return this.store.reserveSpawn(deliveryId, edgeId, generation);
  }

  reconcile(deliveryId: number, disposition: "processed" | "requeue", detail: string): Delivery {
    return this.store.reconcile(deliveryId, disposition, detail);
  }

  finish(deliveryId: number, edgeId: string, result: DeliveryResultInput): Delivery {
    return this.store.finish(deliveryId, edgeId, result.generation, result.status, result.reasons);
  }

  replay(channelId: string, threadTs: string): Promise<ReplaySnapshot> {
    return this.slack.replay(channelId, threadTs);
  }

  async reply(deliveryId: number, edgeId: string, generation: number, text: string): Promise<string> {
    const delivery = this.store.getDelivery(deliveryId);
    this.store.assertLease(deliveryId, edgeId, generation);
    const correlated = `${text}\n\n[event_id=${delivery.eventId} delivery_id=${delivery.id}]`;
    return this.slack.reply(delivery.event.channelId, delivery.event.threadTs, correlated, {
      event_id: delivery.eventId,
      delivery_id: String(delivery.id),
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
