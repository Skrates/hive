import type { Delivery, DeliveryResultInput, Reason, ReplaySnapshot, SlackEventInput, SubscriptionInput } from "../domain.js";
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

  /** True if any subscription is live — the deafness watchdog's arming gate. */
  hasActiveSubscription(): boolean {
    return this.store.hasActiveSubscription();
  }

  async claim(edgeId: string, after: number, waitMs: number): Promise<Delivery | null> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 30_000);
    do {
      this.store.requeueExpiredLeases();
      await this.drainOutbox();
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

  /**
   * ADR-0003 R-6: the thread shows delivery. The dispatched transition and the
   * sender-visible delivery receipt commit in one store transaction.
   */
  markDispatched(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.markDispatched(deliveryId, edgeId, generation);
  }

  renew(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.renewDeliveryLease(deliveryId, edgeId, generation);
  }

  reserveSpawn(deliveryId: number, edgeId: string, generation: number): boolean {
    return this.store.reserveSpawn(deliveryId, edgeId, generation);
  }

  finish(deliveryId: number, edgeId: string, result: DeliveryResultInput): Delivery {
    return this.store.finish(deliveryId, edgeId, result.generation, result.status, result.reasons, result.outcome);
  }

  /** ADR-0003 R-3: uncertainty releases the delivery for redelivery instead of declaring an outcome. */
  release(deliveryId: number, edgeId: string, generation: number, reason: Reason): Delivery {
    return this.store.release(deliveryId, edgeId, generation, reason);
  }

  /** ADR-0003 R-6: agent outcome reports are not lease-fenced and always reach the thread. */
  recordOutcome(deliveryId: number, text: string): Delivery {
    return this.store.recordOutcome(deliveryId, text);
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

  /**
   * Deliver every unsent outbox row to Slack. Failures leave the row unsent —
   * the next drain retries it. At-least-once with duplicates tolerated, same
   * as every other Hive lane.
   */
  async drainOutbox(): Promise<number> {
    const entries = this.store.listUnsentOutbox();
    let sent = 0;
    for (const entry of entries) {
      try {
        await this.slack.reply(entry.channelId, entry.threadTs, entry.text, entry.deliveryId === null
          ? {}
          : { delivery_id: String(entry.deliveryId) });
        this.store.markOutboxSent(entry.outboxId);
        sent += 1;
      } catch {
        this.store.markOutboxAttempt(entry.outboxId);
      }
    }
    return sent;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
