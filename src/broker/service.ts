import type {
  BusySlot,
  Delivery,
  DeliveryResultInput,
  Reason,
  ReplaySnapshot,
  SeatWakeMint,
  SeatWakeReceipt,
  SlackEventInput,
  SubscriptionInput,
} from "../domain.js";
import { isSlackMessageTs } from "../domain.js";
import { BrokerStore, SeatWakeRefusedError } from "./store.js";

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

  /**
   * KRA-1097: a seat's explicit address to a peer. The ledger row and the
   * commons render commit together; the render goes out through the ordinary
   * `hive_*`-stamped outbox, so Slack admission ignores it exactly as it
   * ignores every other Hive post. An undeliverable mint throws (R-3).
   *
   * An alternate `--thread` is proven against Slack in this channel before
   * the ledger commits, so the CLI cannot report success for a coordinate
   * the edge will then fail to replay.
   */
  async mintSeatWake(input: SeatWakeMint, edgeId: string): Promise<SeatWakeReceipt> {
    // An identical retry answers from the ledger before any Slack probe: the
    // idempotence guarantee must hold precisely when the response was lost,
    // and Slack being down at retry time is part of that failure mode.
    const replayed = this.store.resolveSeatWakeReplay(input);
    if (replayed) return replayed;
    if (input.threadTs !== null) {
      if (!isSlackMessageTs(input.threadTs)) {
        throw new SeatWakeRefusedError(
          "invalid_thread",
          `thread coordinate \`${input.threadTs}\` is not a Slack message timestamp`,
        );
      }
      let source: Delivery | null = null;
      try {
        source = this.store.getDelivery(input.sourceDeliveryId);
      } catch {
        source = null;
      }
      if (source && input.threadTs !== source.event.threadTs) {
        try {
          await this.slack.replay(source.event.channelId, input.threadTs);
        } catch {
          throw new SeatWakeRefusedError(
            "invalid_thread",
            `thread \`${input.threadTs}\` is not a valid thread in channel ${source.event.channelId}`,
          );
        }
      }
    }
    return this.store.mintSeatWake(input, edgeId);
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

  async claim(edgeId: string, after: number, waitMs: number, busy: readonly BusySlot[] = []): Promise<Delivery | null> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 30_000);
    do {
      this.store.requeueExpiredLeases();
      await this.drainOutbox();
      const delivery = this.store.claimNext(edgeId, after, busy);
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
        const messageTs = await this.slack.reply(entry.channelId, entry.threadTs, entry.text, entry.deliveryId === null
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
        this.store.markOutboxSent(entry.outboxId, messageTs);
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

/**
 * The broker's periodic housekeeping, as one testable unit (module map §8). `publish` is the
 * review publisher's pass; everything else is core broker work that has nothing to do with
 * review.
 */
export interface HousekeepingTickDeps {
  /** R-3: return expired leases so loss stays visible. */
  sweep(): void;
  /** §8.1: one review publication pass. */
  publish(): Promise<unknown>;
  /** R-6: deliver every unsent outbox row — every Hive wake, review or not. */
  drainOutbox(): Promise<unknown>;
  log(what: string, error: unknown): void;
}

/**
 * Run the three jobs of one tick with no job waiting on another. Publication used to run
 * first and the outbox drain only after it, which made GitHub availability a prerequisite for
 * unrelated Hive delivery: a publisher pass held up by a slow or hung GitHub port delayed
 * every wake in the outbox for as long as it was held. They are independent concerns, so they
 * run independently, each with its own error handling; both are single-flight in their own
 * right (`ReviewPublisher.drainOnce`, `BrokerService.drainOutbox`), so a tick arriving while
 * either is still running joins that pass rather than racing it.
 *
 * The publisher's own Slack rows still land in this outbox and still go out through this
 * drain — this tick's if they were minted before the drain listed the unsent rows, the next
 * tick's (≤5s later) otherwise. No second timer: one tick, two independent jobs.
 *
 * The returned promise settles when both have; callers that only want the tick fired discard it.
 */
export function housekeepingTick(deps: HousekeepingTickDeps): Promise<void> {
  try {
    deps.sweep();
  } catch (error) {
    deps.log("hive broker sweep failed", error);
  }
  // Both are started here, synchronously, so neither is even scheduled behind the other.
  const publication = launch(() => deps.publish(), "hive review publish failed", deps.log);
  const outbox = launch(() => deps.drainOutbox(), "hive broker outbox drain failed", deps.log);
  return Promise.all([publication, outbox]).then(() => undefined);
}

function launch(run: () => Promise<unknown>, what: string, log: (what: string, error: unknown) => void): Promise<void> {
  try {
    return run().then(() => undefined, (error: unknown) => log(what, error));
  } catch (error) {
    // A job that throws before it returns a promise is the same failure, reported the same way.
    log(what, error);
    return Promise.resolve();
  }
}
