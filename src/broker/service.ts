import type { Delivery, DeliveryResultInput, Reason, ReplaySnapshot, SlackEventInput, SubscriptionInput } from "../domain.js";
import { BrokerStore } from "./store.js";

export interface SlackTransport {
  replay(channelId: string, threadTs: string): Promise<ReplaySnapshot>;
  reply(channelId: string, threadTs: string, text: string, metadata?: Record<string, string>): Promise<string>;
  /** Stamp an emoji reaction on a message. Duplicate stamps must resolve, not throw. */
  react(channelId: string, messageTs: string, name: string): Promise<void>;
}

export class BrokerService {
  private outboxDrain: Promise<number> | null = null;

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

  /** Retire an actor after all of its deliveries have reached a terminal state. */
  deleteSubscription(actor: string): boolean {
    return this.store.deleteSubscription(actor);
  }

  ingest(event: SlackEventInput, initialSnapshot: unknown | null = null) {
    return this.store.ingestEvent(event, initialSnapshot);
  }

  /** True if any subscription is live — the deafness watchdog's arming gate. */
  hasActiveSubscription(): boolean {
    return this.store.hasActiveSubscription();
  }

  /** Every actor with a live subscription — the `everyone` broadcast target set. */
  liveActors(): string[] {
    return this.store.liveActors();
  }

  /** Actors already bound to a Slack thread — the target set for thread affinity. */
  boundActors(channelId: string, threadTs: string): string[] {
    return this.store.actorsBoundToThread(channelId, threadTs);
  }

  /**
   * Resolve the thread-affinity targets for a raw Slack event, freezing them on
   * first sight so a lost-ACK redelivery cannot expand the recipient set.
   */
  freezeAffinityTargets(rawEventId: string, channelId: string, threadTs: string): string[] {
    return this.store.freezeAffinityTargets(rawEventId, channelId, threadTs);
  }

  async claim(
    edgeId: string,
    after: number,
    waitMs: number,
    busyActors: readonly string[] = [],
    signal?: AbortSignal,
    stillLive?: () => boolean,
  ): Promise<Delivery | null> {
    const boundedWait = Math.min(Math.max(waitMs, 0), 30_000);
    const deadline = Date.now() + boundedWait;
    const gone = (): boolean => Boolean(signal?.aborted || stillLive?.() === false);
    do {
      if (gone()) return null;
      this.store.requeueExpiredLeases();
      await this.drainOutbox();
      // Drain is shared single-flight work and may outlive this caller. A
      // disconnected edge or an elapsed long-poll window must not take a
      // lease afterwards — the client will never see the response, and a
      // retry would leave that delivery silent until lease expiry.
      //
      // Abort events can land a tick after fetch's timeout closes only the
      // client side. Re-check the caller's liveness immediately before the
      // stateful claim, not just the wait deadline after it.
      if (gone()) return null;
      if (boundedWait > 0 && Date.now() >= deadline) return null;
      const delivery = this.store.claimNext(edgeId, after, busyActors);
      if (delivery) return delivery;
      if (Date.now() >= deadline) return null;
      await delay(Math.min(250, deadline - Date.now()), signal);
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
   * Deliver every unsent outbox row to Slack. Overlapping healthy callers
   * share one in-process pass; without that single-flight fence, every polling
   * edge plus housekeeping can post the same row before any caller marks it
   * sent. Crash/transport uncertainty still leaves the row unsent for the next
   * pass, preserving the required at-least-once semantics.
   */
  drainOutbox(): Promise<number> {
    if (this.outboxDrain) return this.outboxDrain;
    const active = this.drainOutboxOnce();
    this.outboxDrain = active;
    active.then(
      () => { if (this.outboxDrain === active) this.outboxDrain = null; },
      () => { if (this.outboxDrain === active) this.outboxDrain = null; },
    );
    return active;
  }

  private async drainOutboxOnce(): Promise<number> {
    const entries = this.store.listUnsentOutbox();
    let sent = 0;
    for (const entry of entries) {
      try {
        await this.slack.reply(entry.channelId, entry.threadTs, entry.text, entry.deliveryId === null
          ? {}
          : { delivery_id: String(entry.deliveryId) });
        // Reactions are glanceable annotation, not part of the two-events
        // contract, so they are never awaited: this drain is the single-flight
        // pass every claim() waits on, and one hung or rate-limit-held
        // reactions.add would stall wake delivery bus-wide. The row's sent
        // mark depends only on the text post; a failed stamp is logged and dropped.
        if (entry.reaction !== null) {
          for (const targetTs of entry.reactionTargets) {
            void this.slack.react(entry.channelId, targetTs, entry.reaction).catch((error) => {
              console.error("hive outbox reaction failed", entry.outboxId, entry.reaction, targetTs, error);
            });
          }
        }
        this.store.markOutboxSent(entry.outboxId);
        sent += 1;
      } catch {
        this.store.markOutboxAttempt(entry.outboxId);
      }
    }
    return sent;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
