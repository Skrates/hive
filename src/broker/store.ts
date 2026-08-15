import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  CoalescedMessage,
  Delivery,
  DeliveryStatus,
  EdgeWorkspace,
  Reason,
  SeatWakeInput,
  SeatWakeReceipt,
  SlackEventInput,
  Subscription,
  SubscriptionInput,
  TerminalDeliveryStatus,
} from "../domain.js";
import { EVERYONE, isSlackMessageTs, retryBackoffMs } from "../domain.js";
import type { Clock } from "../time.js";
import { iso, systemClock } from "../time.js";

interface Row { [key: string]: unknown }

const TERMINAL = new Set<DeliveryStatus>([
  "processed",
  "undeliverable",
  "failed",
]);

const BROKER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * ADR-0003 R-8: there is no schema migration path across the v0.5 cutover — a
 * pre-v0.5 broker database is moved aside, never mutated in place. The stamp
 * turns a reused legacy file into a loud boot refusal instead of a
 * `no such column` crash on the first subscription upsert.
 */
const BROKER_SCHEMA_VERSION = 5;

/**
 * A `dispatched` delivery is waiting on its agent's outcome report (R-6). The
 * sweep leaves it open for this grace before treating the missing outcome as
 * ordinary uncertainty and requeueing — long enough for a live session to
 * drain its inbox and reply, short enough that a wake written to an inbox
 * nobody will ever drain becomes a visible retry instead of silent loss.
 */
export const DISPATCHED_OUTCOME_GRACE_MS = 15 * 60_000;

/** An outbox row that keeps failing is retried with backoff and finally abandoned (visibly logged). */
export const OUTBOX_MAX_ATTEMPTS = 50;

export class StaleLeaseError extends Error {}
export class InvalidTransitionError extends Error {}
export class LegacyDatabaseError extends Error {}

/**
 * KRA-1097 / ADR-0003 R-3: a seat's deliberate address that cannot be delivered
 * fails loudly back to the minting seat. The refusal carries a stable code so
 * the CLI can exit non-zero with the reason instead of rendering and vanishing.
 */
export class SeatWakeRefusedError extends Error {
  constructor(readonly code: SeatWakeRefusalCode, detail: string) {
    super(detail);
    this.name = "SeatWakeRefusedError";
  }
}

export type SeatWakeRefusalCode =
  | "unknown_source_delivery"
  | "unroutable_actor"
  | "self_mint_forbidden"
  | "broadcast_forbidden";

export interface OutboxEntry {
  outboxId: number;
  deliveryId: number | null;
  channelId: string;
  threadTs: string;
  text: string;
  /** Optional lifecycle stamp on the originating wake messages (emoji name, no colons). */
  reaction: string | null;
  /** Every wake message the stamp targets: the primary event plus any coalesced ones. */
  reactionTargets: string[];
  createdAt: string;
  sentAt: string | null;
  attempts: number;
}

/** Delivery-lifecycle reaction stamps: glanceable state on the wake message itself. */
export const REACTION_DISPATCHED = "eyes";
export const REACTION_PROCESSED = "white_check_mark";
export const REACTION_FAILED = "x";

export class BrokerStore {
  readonly db: Database.Database;
  readonly brokerUuid: string;

  constructor(path: string, private readonly clock: Clock = systemClock) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // SQLite implements INSERT OR REPLACE as a delete followed by an insert.
    // Recursive triggers must be enabled for the immutable singleton's DELETE
    // guard to fire on that replacement path.
    this.db.pragma("recursive_triggers = ON");
    this.assertSchemaGeneration(path);
    this.migrate();
    this.db.pragma(`user_version = ${BROKER_SCHEMA_VERSION}`);
    this.brokerUuid = this.loadOrCreateBrokerUuid();
  }

  /** Refuse to boot on a pre-v0.5 database: no migration path, move it aside. */
  private assertSchemaGeneration(path: string): void {
    const hasTables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='deliveries'",
    ).get() !== undefined;
    const version = Number((this.db.pragma("user_version", { simple: true }) as number | bigint | undefined) ?? 0);
    if (hasTables && version < BROKER_SCHEMA_VERSION) {
      throw new LegacyDatabaseError(
        `broker database at ${path} predates hive v0.5 (schema generation ${version} < ${BROKER_SCHEMA_VERSION}); `
        + "there is no migration path across the ADR-0003 cutover — move the file aside and restart with a fresh store",
      );
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS broker_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        broker_uuid TEXT NOT NULL UNIQUE CHECK(length(broker_uuid) = 36),
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS broker_metadata_immutable_update
      BEFORE UPDATE ON broker_metadata
      BEGIN
        SELECT RAISE(ABORT, 'broker_metadata_immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS broker_metadata_immutable_delete
      BEFORE DELETE ON broker_metadata
      BEGIN
        SELECT RAISE(ABORT, 'broker_metadata_immutable');
      END;

      CREATE TABLE IF NOT EXISTS edges (
        edge_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        actor TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_surface TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        session_id TEXT,
        home_edge TEXT NOT NULL,
        workspace TEXT NOT NULL,
        edge_workspaces_json TEXT NOT NULL,
        wake_policy TEXT NOT NULL,
        permission_profile TEXT NOT NULL,
        account_profile TEXT NOT NULL,
        lease_ttl_ms INTEGER NOT NULL,
        delivery_ttl_ms INTEGER NOT NULL,
        home_grace_ms INTEGER NOT NULL,
        spawn_rate_limit INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        expires_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(home_edge) REFERENCES edges(edge_id)
      );

      CREATE TABLE IF NOT EXISTS slack_events (
        event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        text TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS actor_leases (
        actor TEXT PRIMARY KEY,
        edge_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(edge_id) REFERENCES edges(edge_id)
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        lease_generation INTEGER,
        claimed_by TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        coalesce_key TEXT NOT NULL,
        initial_snapshot_json TEXT,
        snapshot_ts TEXT,
        accepted_at TEXT,
        dispatch_started_at TEXT,
        dispatched_at TEXT,
        terminal_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(event_id, actor),
        FOREIGN KEY(event_id) REFERENCES slack_events(event_id),
        FOREIGN KEY(actor) REFERENCES subscriptions(actor),
        FOREIGN KEY(claimed_by) REFERENCES edges(edge_id)
      );

      CREATE INDEX IF NOT EXISTS deliveries_pending_idx
        ON deliveries(status, delivery_id);

      CREATE TABLE IF NOT EXISTS delivery_events (
        delivery_id INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY(delivery_id, event_id),
        FOREIGN KEY(delivery_id) REFERENCES deliveries(delivery_id),
        FOREIGN KEY(event_id) REFERENCES slack_events(event_id)
      );

      CREATE TABLE IF NOT EXISTS spawn_windows (
        actor TEXT NOT NULL,
        window_start TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY(actor, window_start)
      );

      CREATE TABLE IF NOT EXISTS spawn_reservations (
        delivery_id INTEGER PRIMARY KEY,
        actor TEXT NOT NULL,
        window_start TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(delivery_id) REFERENCES deliveries(delivery_id)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id INTEGER,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        text TEXT NOT NULL,
        reaction TEXT,
        reaction_targets_json TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        abandoned_at TEXT
      );

      CREATE INDEX IF NOT EXISTS outbox_unsent_idx
        ON outbox(sent_at, outbox_id);

      CREATE TABLE IF NOT EXISTS event_targets (
        raw_event_id TEXT PRIMARY KEY,
        actors_json TEXT NOT NULL,
        frozen_at TEXT NOT NULL
      );
    `);
    this.ensureOutboxReactionColumns();
  }

  /** Forward-only schema step: pre-reaction databases gain the two nullable columns in place. */
  private ensureOutboxReactionColumns(): void {
    const columns = (this.db.pragma("table_info(outbox)") as { name: string }[]).map((c) => c.name);
    if (!columns.includes("reaction")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN reaction TEXT");
    }
    if (!columns.includes("reaction_targets_json")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN reaction_targets_json TEXT");
    }
    // The single-timestamp shape never shipped past this branch; no dual readers survive it.
    if (columns.includes("reaction_target_ts")) {
      this.db.exec("ALTER TABLE outbox DROP COLUMN reaction_target_ts");
    }
  }

  private loadOrCreateBrokerUuid(): string {
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO broker_metadata(singleton, broker_uuid, created_at)
        VALUES (1, ?, ?)
      `).run(randomUUID(), iso(this.clock));
      const row = this.db.prepare(`
        SELECT broker_uuid FROM broker_metadata WHERE singleton = 1
      `).get() as Row | undefined;
      const value = row?.broker_uuid;
      if (typeof value !== "string" || !BROKER_UUID_PATTERN.test(value)) {
        throw new Error("invalid_broker_uuid_metadata");
      }
      return value;
    })();
  }

  createEdge(edgeId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare(`
      INSERT INTO edges(edge_id, token_hash, enabled, created_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(edge_id) DO UPDATE SET token_hash=excluded.token_hash, enabled=1
    `).run(edgeId, hashToken(token), iso(this.clock));
    return token;
  }

  authenticateEdge(edgeId: string, token: string): boolean {
    const row = this.db.prepare("SELECT token_hash, enabled FROM edges WHERE edge_id = ?").get(edgeId) as Row | undefined;
    if (!row || row.enabled !== 1) return false;
    const ok = row.token_hash === hashToken(token);
    if (ok) {
      this.db.prepare("UPDATE edges SET last_seen_at = ? WHERE edge_id = ?").run(iso(this.clock), edgeId);
    }
    return ok;
  }

  upsertSubscription(input: SubscriptionInput): Subscription {
    const now = iso(this.clock);
    this.db.prepare(`
      INSERT INTO subscriptions(
        actor, provider, provider_surface, provider_version, session_id, home_edge, workspace,
        edge_workspaces_json, wake_policy, permission_profile, account_profile, lease_ttl_ms,
        delivery_ttl_ms, home_grace_ms, spawn_rate_limit, max_attempts, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(actor) DO UPDATE SET
        provider=excluded.provider,
        provider_surface=excluded.provider_surface,
        provider_version=excluded.provider_version,
        session_id=excluded.session_id,
        home_edge=excluded.home_edge,
        workspace=excluded.workspace,
        edge_workspaces_json=excluded.edge_workspaces_json,
        wake_policy=excluded.wake_policy,
        permission_profile=excluded.permission_profile,
        account_profile=excluded.account_profile,
        lease_ttl_ms=excluded.lease_ttl_ms,
        delivery_ttl_ms=excluded.delivery_ttl_ms,
        home_grace_ms=excluded.home_grace_ms,
        spawn_rate_limit=excluded.spawn_rate_limit,
        max_attempts=excluded.max_attempts,
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at
    `).run(
      input.actor,
      input.provider,
      input.providerSurface,
      input.providerVersion,
      input.sessionId,
      input.homeEdge,
      input.workspace,
      JSON.stringify(input.edgeWorkspaces),
      input.wakePolicy,
      input.permissionProfile,
      input.accountProfile,
      input.leaseTtlMs,
      input.deliveryTtlMs,
      input.homeGraceMs,
      input.spawnRateLimit,
      input.maxAttempts,
      input.expiresAt,
      now,
    );
    return { ...input, updatedAt: now };
  }

  getSubscription(actor: string): Subscription | null {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE actor = ?").get(actor) as Row | undefined;
    return row ? subscriptionFromRow(row) : null;
  }

  /**
   * True if any subscription is currently live (no expiry, or an expiry still in
   * the future). The deafness watchdog only arms when the broker actually has an
   * agent that could be woken — a broker with no live subscriptions expects
   * silence, so silence is not evidence of a wedged Slack link.
   */
  hasActiveSubscription(): boolean {
    // Compare expiries by parsed instant, not by raw ISO string. `expiresAt` is a
    // z.string().datetime() value, whose fractional-second precision and offset can
    // vary, so a lexical SQL `expires_at > ?` can order two valid timestamps wrongly
    // near a boundary. `isExpired` normalises through Date.getTime(), matching the
    // eligibility check on the dispatch path.
    const now = this.clock.now();
    const rows = this.db.prepare("SELECT expires_at FROM subscriptions").all() as Array<{ expires_at: string | null }>;
    return rows.some((row) => !isExpired(row.expires_at, now));
  }

  /**
   * Every actor with a live (unexpired) subscription, in a stable order — the
   * fan-out target set for an `everyone` broadcast. Liveness is decided by the
   * same `isExpired` instant comparison as {@link hasActiveSubscription}, so a
   * lapsed seat is never broadcast to.
   */
  liveActors(): string[] {
    const now = this.clock.now();
    const rows = this.db.prepare("SELECT actor, expires_at FROM subscriptions ORDER BY actor")
      .all() as Array<{ actor: string; expires_at: string | null }>;
    return rows.filter((row) => !isExpired(row.expires_at, now)).map((row) => String(row.actor));
  }

  /**
   * The set of actors bound to a Slack thread: every actor that already has a
   * delivery whose originating event sits in this channel/thread. Thread
   * affinity routes an envelope-less admitted message to exactly this set, so a
   * conversation started with a `WAKE:` continues without re-addressing.
   *
   * Binding is derived from the persisted store (deliveries joined to their
   * events), never from process memory, so it survives a broker restart. Every
   * delivery counts regardless of status: a completed delivery still means the
   * actor is part of this thread's conversation.
   */
  actorsBoundToThread(channelId: string, threadTs: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT d.actor
      FROM deliveries d
      JOIN slack_events e ON e.event_id = d.event_id
      WHERE e.channel_id = ? AND e.thread_ts = ?
      ORDER BY d.actor
    `).all(channelId, threadTs) as Row[];
    return rows.map((row) => String(row.actor));
  }

  /**
   * Resolve — and permanently freeze — the thread-affinity target set for one raw
   * Slack event. The first call for a `rawEventId` computes the currently-bound
   * actors and records them atomically; every later call (a lost-ACK redelivery
   * of the same event) returns that frozen set verbatim, ignoring the live
   * bindings.
   *
   * Without this freeze, a redelivery would recompute `actorsBoundToThread` and
   * could pick up an actor that was bound to the thread *after* this message was
   * posted — waking it with an instruction issued before it joined. The freeze
   * is keyed by the raw Slack event ID (the identity Slack retries under) and
   * happens inside one transaction, so concurrent redeliveries can never expand
   * the recipient set. An empty set is frozen too: a message posted into an
   * unbound thread stays unbound on redelivery.
   */
  freezeAffinityTargets(rawEventId: string, channelId: string, threadTs: string): string[] {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT actors_json FROM event_targets WHERE raw_event_id = ?",
      ).get(rawEventId) as Row | undefined;
      if (existing) return JSON.parse(String(existing.actors_json)) as string[];
      const actors = this.actorsBoundToThread(channelId, threadTs);
      this.db.prepare(
        "INSERT INTO event_targets(raw_event_id, actors_json, frozen_at) VALUES (?, ?, ?)",
      ).run(rawEventId, JSON.stringify(actors), iso(this.clock));
      return actors;
    })();
  }

  /**
   * Retire an actor: delete its subscription and every row that keeps it
   * addressable or thread-bound — its deliveries (and their delivery_events,
   * spawn_reservations), the slack_events they originated from, its spawn windows
   * and lease. After this the actor is unaddressable (no subscription to dispatch
   * against) and unbound (no delivery joins it to any thread), closing the
   * rename-migration gap where a renamed actor's old row stayed live forever.
   *
   * A non-terminal delivery is a hard stop: it may already be crossing the
   * provider-effect boundary, so deleting it would erase the authoritative
   * receipt/outcome coordinate while the agent could still act. The operator
   * must let every delivery terminalize before retirement. Foreign keys are
   * enforced, so dependents are then removed in reference order inside one
   * transaction. Already-committed outbox posts remain durable and may still be
   * delivered to Slack. Returns true if a subscription was actually removed.
   */
  deleteSubscription(actor: string): boolean {
    return this.db.transaction(() => {
      const active = this.db.prepare(`
        SELECT delivery_id, status FROM deliveries
        WHERE actor = ? AND status NOT IN ('processed', 'undeliverable', 'failed')
        ORDER BY delivery_id LIMIT 1
      `).get(actor) as Row | undefined;
      if (active) {
        throw new InvalidTransitionError(
          `cannot retire ${actor}: delivery ${String(active.delivery_id)} is ${String(active.status)}`,
        );
      }
      this.db.prepare(`
        DELETE FROM spawn_reservations
        WHERE delivery_id IN (SELECT delivery_id FROM deliveries WHERE actor = ?)
      `).run(actor);
      this.db.prepare(`
        DELETE FROM delivery_events
        WHERE delivery_id IN (SELECT delivery_id FROM deliveries WHERE actor = ?)
      `).run(actor);
      this.db.prepare("DELETE FROM deliveries WHERE actor = ?").run(actor);
      this.db.prepare("DELETE FROM slack_events WHERE actor = ?").run(actor);
      this.db.prepare("DELETE FROM spawn_windows WHERE actor = ?").run(actor);
      this.db.prepare("DELETE FROM actor_leases WHERE actor = ?").run(actor);
      const result = this.db.prepare("DELETE FROM subscriptions WHERE actor = ?").run(actor);
      return result.changes > 0;
    })();
  }

  ingestEvent(event: SlackEventInput, initialSnapshot: unknown | null = null): { created: boolean; deliveryId: number | null } {
    return this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO slack_events(
          event_id, workspace_id, channel_id, thread_ts, message_ts, sender_id, sender_kind,
          actor, text, raw_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.workspaceId,
        event.channelId,
        event.threadTs,
        event.messageTs,
        event.senderId,
        event.senderKind,
        event.actor,
        event.text,
        JSON.stringify(event.raw),
        event.receivedAt,
      );
      if (inserted.changes === 0) return { created: false, deliveryId: null };

      const subscription = this.getSubscription(event.actor);
      if (!subscription || isExpired(subscription.expiresAt, this.clock.now())) {
        return { created: true, deliveryId: null };
      }
      const now = iso(this.clock);
      const coalesceKey = `${event.actor}:${event.channelId}:${event.threadTs}`;
      const pending = this.db.prepare(`
        SELECT delivery_id FROM deliveries
        WHERE coalesce_key=? AND status='pending'
        ORDER BY delivery_id LIMIT 1
      `).get(coalesceKey) as Row | undefined;
      if (pending) {
        const deliveryId = Number(pending.delivery_id);
        this.db.prepare(`
          INSERT OR IGNORE INTO delivery_events(delivery_id, event_id, relation) VALUES (?, ?, 'coalesced')
        `).run(deliveryId, event.eventId);
        return { created: true, deliveryId };
      }
      const result = this.db.prepare(`
        INSERT INTO deliveries(
          event_id, actor, status, coalesce_key, initial_snapshot_json, snapshot_ts,
          created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.actor,
        coalesceKey,
        initialSnapshot === null ? null : JSON.stringify(initialSnapshot),
        initialSnapshot === null ? null : now,
        now,
        now,
      );
      const deliveryId = Number(result.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO delivery_events(delivery_id, event_id, relation) VALUES (?, ?, 'primary')
      `).run(deliveryId, event.eventId);
      return { created: true, deliveryId };
    })();
  }

  /**
   * KRA-1097: mint a wake from one seat to another as a first-class act.
   *
   * Slack admission drops every `hive_*`-stamped message before the envelope is
   * parsed, so a completing seat's outcome — human-visible in the thread — can
   * never address a peer. That drop stays total; deliberate address lives here
   * instead, where intent is an explicit act rather than the position of text.
   *
   * Three properties this transaction is responsible for:
   *
   * - **Attribution is ledger-derived.** The minting seat is whoever owns the
   *   source delivery, read from this store. A caller cannot name a sender.
   * - **INV-48 spirit: the ledger commits before any Slack render.** The
   *   delivery row and the commons post are one transaction, and the post is
   *   an outbox row stamped `hive_*` on the way out — visible to humans,
   *   ignored by admission, never re-ingested as a wake.
   * - **R-3: an undeliverable mint throws.** No silent dead-letter; the CLI
   *   turns the refusal into a non-zero exit.
   *
   * The mint is idempotent over (source delivery, target, thread, text): a
   * replayed command returns the original delivery and posts nothing new.
   */
  mintSeatWake(input: SeatWakeInput): SeatWakeReceipt {
    return this.db.transaction(() => {
      const sourceRow = this.db.prepare("SELECT delivery_id FROM deliveries WHERE delivery_id=?")
        .get(input.sourceDeliveryId) as Row | undefined;
      if (!sourceRow) {
        throw new SeatWakeRefusedError(
          "unknown_source_delivery",
          `delivery ${input.sourceDeliveryId} is not in the broker ledger, so no minting seat can be resolved`,
        );
      }
      const source = this.getDelivery(input.sourceDeliveryId);
      const from = source.actor;
      const target = input.actor;
      // A seat never fans out: `everyone` expansion is reserved for a human
      // sender (the same rule that keeps a quoted "WAKE: everyone" in an agent
      // reply from chain-waking the fleet).
      if (target === EVERYONE) {
        throw new SeatWakeRefusedError(
          "broadcast_forbidden",
          "`everyone` is a human-only broadcast target; a seat addresses peers by name",
        );
      }
      // A seat that can wake itself can wake itself forever: each minted run is
      // free to mint again, with no operator in the loop. That is precisely the
      // recursion the admission drop exists to prevent, so it is refused here
      // rather than bounded by a depth counter.
      if (target === from) {
        throw new SeatWakeRefusedError(
          "self_mint_forbidden",
          `${from} cannot mint a wake to itself — a self-directed mint is an unbounded loop`,
        );
      }
      const subscription = this.getSubscription(target);
      if (!subscription || isExpired(subscription.expiresAt, this.clock.now())) {
        throw new SeatWakeRefusedError(
          "unroutable_actor",
          `no live subscription for actor \`${target}\` — this wake would reach no one`,
        );
      }

      const channelId = source.event.channelId;
      const threadTs = input.threadTs ?? source.event.threadTs;
      const digest = createHash("sha256")
        .update([input.sourceDeliveryId, from, target, channelId, threadTs, input.text].join("\n"))
        .digest("hex")
        .slice(0, 16);
      const eventId = `mint:${input.sourceDeliveryId}:${digest}`;
      const ingest = this.ingestEvent({
        eventId,
        workspaceId: source.event.workspaceId,
        channelId,
        threadTs,
        // No Slack message exists yet — the commons render is enqueued below and
        // learns its `ts` only when the outbox drains. See isSlackMessageTs.
        messageTs: `mint:${digest}`,
        senderId: from,
        senderKind: "seat",
        actor: target,
        text: input.text,
        raw: { type: "seat_wake", sourceDeliveryId: input.sourceDeliveryId, from },
        receivedAt: iso(this.clock),
      });
      const deliveryId = ingest.deliveryId ?? this.deliveryIdForEvent(eventId);
      if (deliveryId === null) {
        // The subscription check above already proved the actor routable, so
        // reaching here means the ledger disagreed with itself mid-transaction.
        // Throwing rolls the whole mint back — the event row included.
        throw new SeatWakeRefusedError(
          "unroutable_actor",
          `mint for \`${target}\` produced no delivery`,
        );
      }
      const delivery = this.getDelivery(deliveryId);
      if (ingest.created) {
        this.enqueueOutbox(delivery, seatWakeRender(from, target, deliveryId, input.text));
      }
      return { deliveryId, actor: target, from, channelId, threadTs, created: ingest.created };
    })();
  }

  /** The delivery an event belongs to, whether it opened one or coalesced into one. */
  private deliveryIdForEvent(eventId: string): number | null {
    const row = this.db.prepare("SELECT delivery_id FROM delivery_events WHERE event_id=?")
      .get(eventId) as Row | undefined;
    return row ? Number(row.delivery_id) : null;
  }

  claimNext(edgeId: string, _after: number, busyActors: readonly string[] = []): Delivery | null {
    return this.db.transaction(() => {
      // `after` remains a v1 compatibility hint only: broker-side eligibility
      // can change over time, so every pending delivery must remain visible.
      const rows = this.db.prepare(`
        SELECT d.delivery_id, d.actor, d.created_at, d.next_attempt_at
        FROM deliveries d
        WHERE d.status = 'pending'
        ORDER BY d.delivery_id
      `).all() as Row[];

      for (const row of rows) {
        const actor = String(row.actor);
        // The claiming edge declares actors whose dispatches it is still
        // running. acquireLease cannot serialize these: a same-edge claim on a
        // live lease shares the generation by design (a sequential edge's next
        // claim after a finished turn), so only the edge's own declaration
        // prevents two concurrent turns for one actor (multi-actor edge,
        // 2026-08-11).
        if (busyActors.includes(actor)) continue;
        const subscription = this.getSubscription(actor);
        if (!subscription) continue;
        const now = this.clock.now().getTime();
        if (row.next_attempt_at !== null && new Date(String(row.next_attempt_at)).getTime() > now) {
          continue;
        }
        const age = now - new Date(String(row.created_at)).getTime();
        if (age >= subscription.deliveryTtlMs) {
          this.terminalizeUnclaimed(Number(row.delivery_id), "undeliverable", [{
            code: "delivery_ttl_expired",
            detail: "delivery expired before an eligible edge claimed it",
          }]);
          continue;
        }
        const eligible = this.edgeEligibility(subscription, edgeId, String(row.created_at));
        if (eligible !== "eligible") {
          if (eligible.disposition === "terminal") {
            this.terminalizeUnclaimed(Number(row.delivery_id), "undeliverable", [{ code: eligible.code, detail: eligibilityDetail(eligible.code) }]);
          }
          continue;
        }

        const generation = this.acquireLease(actor, edgeId, subscription.leaseTtlMs);
        if (generation === null) continue;
        const nowIso = iso(this.clock);
        const claimed = this.db.prepare(`
          UPDATE deliveries
          SET status='claimed', lease_generation=?, claimed_by=?, attempts=attempts+1, updated_at=?
          WHERE delivery_id=? AND status='pending'
        `).run(generation, edgeId, nowIso, Number(row.delivery_id));
        if (claimed.changes === 1) return this.getDelivery(Number(row.delivery_id));
      }
      return null;
    })();
  }

  private edgeEligibility(
    subscription: Subscription,
    edgeId: string,
    createdAt: string,
  ): "eligible" | { disposition: "skip" | "terminal"; code: string } {
    const workspace = subscription.edgeWorkspaces.find((item) => item.edgeId === edgeId);
    if (!workspace) return { disposition: "skip", code: "workspace_not_mapped" };
    const age = this.clock.now().getTime() - new Date(createdAt).getTime();

    if (subscription.wakePolicy === "live_only") {
      return edgeId === subscription.homeEdge
        ? "eligible"
        : { disposition: "skip", code: "live_ingress_unavailable" };
    }
    if (subscription.wakePolicy === "resume") {
      if (edgeId !== subscription.homeEdge) return { disposition: "skip", code: "foreign_resume_forbidden" };
      return subscription.sessionId
        ? "eligible"
        : { disposition: "terminal", code: "resume_target_missing" };
    }
    if (edgeId === subscription.homeEdge) return "eligible";
    return age >= subscription.homeGraceMs
      ? "eligible"
      : { disposition: "skip", code: "home_grace_active" };
  }

  private acquireLease(actor: string, edgeId: string, ttlMs: number): number | null {
    const now = this.clock.now();
    const row = this.db.prepare("SELECT * FROM actor_leases WHERE actor = ?").get(actor) as Row | undefined;
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    if (!row) {
      this.db.prepare(`
        INSERT INTO actor_leases(actor, edge_id, generation, expires_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(actor, edgeId, expiresAt, now.toISOString());
      return 1;
    }
    const currentEdge = String(row.edge_id);
    const expired = new Date(String(row.expires_at)).getTime() <= now.getTime();
    if (currentEdge !== edgeId && !expired) return null;
    const generation = currentEdge === edgeId && !expired ? Number(row.generation) : Number(row.generation) + 1;
    this.db.prepare(`
      UPDATE actor_leases SET edge_id=?, generation=?, expires_at=?, updated_at=? WHERE actor=?
    `).run(edgeId, generation, expiresAt, now.toISOString(), actor);
    return generation;
  }

  renewLease(actor: string, edgeId: string, generation: number, ttlMs: number): boolean {
    const now = this.clock.now();
    const result = this.db.prepare(`
      UPDATE actor_leases SET expires_at=?, updated_at=?
      WHERE actor=? AND edge_id=? AND generation=? AND expires_at>?
    `).run(
      new Date(now.getTime() + ttlMs).toISOString(),
      now.toISOString(),
      actor,
      edgeId,
      generation,
      now.toISOString(),
    );
    return result.changes === 1;
  }

  renewDeliveryLease(deliveryId: number, edgeId: string, generation: number): Delivery {
    this.assertLease(deliveryId, edgeId, generation);
    const delivery = this.getDelivery(deliveryId);
    if (TERMINAL.has(delivery.status)) throw new InvalidTransitionError("terminal delivery has no renewable lease");
    if (!this.renewLease(delivery.actor, edgeId, generation, delivery.subscription.leaseTtlMs)) {
      throw new StaleLeaseError(`stale lease for delivery ${deliveryId}`);
    }
    return this.getDelivery(deliveryId);
  }

  reserveSpawn(deliveryId: number, edgeId: string, generation: number): boolean {
    return this.db.transaction(() => {
      this.assertLease(deliveryId, edgeId, generation);
      const delivery = this.getDelivery(deliveryId);
      if (delivery.subscription.wakePolicy !== "spawn") throw new InvalidTransitionError("spawn not allowed by subscription");
      if (delivery.status !== "dispatching") throw new InvalidTransitionError("spawn reservation requires dispatching state");
      const existing = this.db.prepare("SELECT delivery_id FROM spawn_reservations WHERE delivery_id=?").get(deliveryId);
      if (existing) return true;
      const now = this.clock.now();
      const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
      const row = this.db.prepare(`
        SELECT count FROM spawn_windows WHERE actor=? AND window_start=?
      `).get(delivery.actor, windowStart) as Row | undefined;
      const count = row ? Number(row.count) : 0;
      if (count >= delivery.subscription.spawnRateLimit) return false;
      this.db.prepare(`
        INSERT INTO spawn_windows(actor, window_start, count) VALUES (?, ?, 1)
        ON CONFLICT(actor, window_start) DO UPDATE SET count=count+1
      `).run(delivery.actor, windowStart);
      this.db.prepare(`
        INSERT INTO spawn_reservations(delivery_id, actor, window_start, created_at) VALUES (?, ?, ?, ?)
      `).run(deliveryId, delivery.actor, windowStart, now.toISOString());
      return true;
    })();
  }

  transition(
    deliveryId: number,
    edgeId: string,
    generation: number,
    expected: DeliveryStatus,
    next: DeliveryStatus,
  ): Delivery {
    if (TERMINAL.has(expected)) throw new InvalidTransitionError("terminal delivery cannot transition");
    this.assertLease(deliveryId, edgeId, generation);
    const now = iso(this.clock);
    const columns: Record<string, string> = {
      accepted_local: "accepted_at",
      dispatching: "dispatch_started_at",
      dispatched: "dispatched_at",
    };
    const stamp = columns[next];
    const sql = stamp
      ? `UPDATE deliveries SET status=?, ${stamp}=?, updated_at=? WHERE delivery_id=? AND status=?`
      : "UPDATE deliveries SET status=?, updated_at=? WHERE delivery_id=? AND status=?";
    const args = stamp ? [next, now, now, deliveryId, expected] : [next, now, deliveryId, expected];
    const result = this.db.prepare(sql).run(...args);
    if (result.changes !== 1) throw new InvalidTransitionError(`${expected} -> ${next} rejected`);
    return this.getDelivery(deliveryId);
  }

  /**
   * The dispatched transition and its sender-visible delivery receipt commit
   * in ONE transaction: a broker crash between them could otherwise leave a
   * delivery whose thread never shows it was delivered.
   */
  markDispatched(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.db.transaction(() => {
      const delivery = this.transition(deliveryId, edgeId, generation, "dispatching", "dispatched");
      this.enqueueOutbox(
        delivery,
        `→ delivered to ${delivery.actor} (delivery ${delivery.id}, attempt ${delivery.attempts}/${delivery.subscription.maxAttempts})`,
        REACTION_DISPATCHED,
      );
      return delivery;
    })();
  }

  finish(
    deliveryId: number,
    edgeId: string,
    generation: number,
    status: TerminalDeliveryStatus,
    reasons: Reason[],
    outcomeText: string | null = null,
  ): Delivery {
    return this.db.transaction(() => {
      this.assertLease(deliveryId, edgeId, generation);
      const current = this.getDelivery(deliveryId);
      if (TERMINAL.has(current.status)) throw new InvalidTransitionError("delivery already terminal");
      const now = iso(this.clock);
      this.db.prepare(`
        UPDATE deliveries SET status=?, reasons_json=?, terminal_at=?, updated_at=? WHERE delivery_id=?
      `).run(status, JSON.stringify(reasons), now, now, deliveryId);
      if (status !== "processed") {
        this.enqueueOutbox(current, failureNotice(current, status, reasons), REACTION_FAILED);
      } else if (outcomeText !== null) {
        // R-6: a headless outcome commits with the terminal transition so a
        // Slack outage can neither lose it nor rerun the trusted instruction.
        this.enqueueOutbox(current, outcomePost(current, outcomeText), REACTION_PROCESSED);
      }
      return this.getDelivery(deliveryId);
    })();
  }

  /**
   * ADR-0003 R-3: an edge that hit uncertainty (crash-adjacent failure, lost
   * provider outcome) releases the delivery for another attempt instead of
   * declaring it. Exhausted attempts terminalize as `failed` with a
   * thread-visible notice; otherwise the delivery requeues behind exponential
   * backoff and the retry is announced in the thread.
   */
  release(deliveryId: number, edgeId: string, generation: number, reason: Reason): Delivery {
    return this.db.transaction(() => {
      this.assertLease(deliveryId, edgeId, generation);
      const current = this.getDelivery(deliveryId);
      if (TERMINAL.has(current.status)) throw new InvalidTransitionError("terminal delivery cannot be released");
      this.requeueOrFail(current, reason);
      return this.getDelivery(deliveryId);
    })();
  }

  /**
   * Lease-expiry sweep. Any non-terminal claimed delivery whose actor lease has
   * expired goes back to `pending` for redelivery — including deliveries that
   * were mid-dispatch. The worst case this permits is a duplicate instruction
   * to a trusted agent, which ADR-0003 accepts by design; the dedupe key makes
   * the duplicate self-identifying.
   *
   * A `dispatched` delivery is different: dispatch was durably confirmed and
   * the agent's outcome report (R-6) is the expected closer, so it gets
   * DISPATCHED_OUTCOME_GRACE_MS beyond its dispatch stamp before the missing
   * outcome is treated as uncertainty and requeued. Exhausted attempts still
   * terminalize as `failed` with a thread notice — delivered-but-never-
   * answered is visible loss, never silence.
   */
  requeueExpiredLeases(): number {
    return this.db.transaction(() => {
      const now = iso(this.clock);
      const dispatchedDeadline = new Date(this.clock.now().getTime() - DISPATCHED_OUTCOME_GRACE_MS).toISOString();
      const rows = this.db.prepare(`
        SELECT d.delivery_id
        FROM deliveries d
        JOIN actor_leases l ON l.actor=d.actor
        WHERE l.expires_at<=?
          AND (
            d.status IN ('claimed', 'accepted_local', 'dispatching')
            OR (d.status='dispatched' AND d.dispatched_at<=?)
          )
      `).all(now, dispatchedDeadline) as Row[];
      for (const row of rows) {
        const delivery = this.getDelivery(Number(row.delivery_id));
        this.requeueOrFail(delivery, {
          code: "lease_expired",
          detail: "the claiming edge lost its lease before reporting a durable outcome",
        });
      }
      return rows.length;
    })();
  }

  private requeueOrFail(delivery: Delivery, reason: Reason): void {
    const now = iso(this.clock);
    if (delivery.attempts >= delivery.subscription.maxAttempts) {
      this.db.prepare(`
        UPDATE deliveries SET status='failed', reasons_json=?, terminal_at=?, updated_at=?
        WHERE delivery_id=? AND status IN ('claimed', 'accepted_local', 'dispatching', 'dispatched')
      `).run(JSON.stringify([reason]), now, now, delivery.id);
      this.enqueueOutbox(delivery, failureNotice(delivery, "failed", [reason]), REACTION_FAILED);
      return;
    }
    const nextAttemptAt = new Date(this.clock.now().getTime() + retryBackoffMs(delivery.attempts)).toISOString();
    this.db.prepare(`
      UPDATE deliveries
      SET status='pending', lease_generation=NULL, claimed_by=NULL, next_attempt_at=?,
          accepted_at=NULL, dispatch_started_at=NULL, dispatched_at=NULL, updated_at=?
      WHERE delivery_id=? AND status IN ('claimed', 'accepted_local', 'dispatching', 'dispatched')
    `).run(nextAttemptAt, now, delivery.id);
    this.enqueueOutbox(
      delivery,
      `⟳ retrying delivery ${delivery.id} to ${delivery.actor} (attempt ${delivery.attempts}/${delivery.subscription.maxAttempts} did not confirm: ${reason.code})`,
    );
  }

  /**
   * ADR-0003 R-6: an agent's outcome report closes the loop. It is
   * deliberately not lease-fenced — the agent may finish long after its edge's
   * lease expired, and a duplicate outcome post is permitted and
   * self-identifying. A non-terminal delivery becomes `processed`; a terminal
   * one keeps its recorded truth and the outcome still reaches the thread.
   */
  recordOutcome(deliveryId: number, text: string): Delivery {
    return this.db.transaction(() => {
      const current = this.getDelivery(deliveryId);
      const now = iso(this.clock);
      if (!TERMINAL.has(current.status)) {
        this.db.prepare(`
          UPDATE deliveries SET status='processed', reasons_json=?, terminal_at=?, updated_at=?
          WHERE delivery_id=?
        `).run(JSON.stringify([{ code: "agent_outcome_reported", detail: "the agent reported its outcome" }]), now, now, deliveryId);
      }
      this.enqueueOutbox(current, outcomePost(current, text), REACTION_PROCESSED);
      return this.getDelivery(deliveryId);
    })();
  }

  enqueueThreadNotice(channelId: string, threadTs: string, text: string): void {
    this.db.prepare(`
      INSERT INTO outbox(delivery_id, channel_id, thread_ts, text, created_at)
      VALUES (NULL, ?, ?, ?, ?)
    `).run(channelId, threadTs, text, iso(this.clock));
  }

  enqueueOutbox(delivery: Delivery, text: string, reaction: string | null = null): void {
    // A coalesced delivery answers several wake messages at once; the stamp
    // must land on every one of them, not only the primary event's. A
    // seat-minted wake contributes no stampable message — its ledger row
    // predates the commons render — so it is filtered out rather than sent to
    // Slack as a `ts` that names nothing. A delivery left with no stampable
    // message drops the reaction entirely: the text post is the durable event.
    const stampable = [...new Set([
      delivery.event.messageTs,
      ...delivery.coalescedMessages.map((message) => message.messageTs),
    ])].filter(isSlackMessageTs);
    const effectiveReaction = reaction !== null && stampable.length > 0 ? reaction : null;
    const targets = effectiveReaction === null ? null : JSON.stringify(stampable);
    this.db.prepare(`
      INSERT INTO outbox(delivery_id, channel_id, thread_ts, text, reaction, reaction_targets_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.id,
      delivery.event.channelId,
      delivery.event.threadTs,
      text,
      effectiveReaction,
      targets,
      iso(this.clock),
    );
  }

  /**
   * Rows failing repeatedly retry behind per-row exponential backoff so a
   * poisoned page (e.g. an archived channel) cannot starve later receipts and
   * outcomes; a row past OUTBOX_MAX_ATTEMPTS is abandoned, visibly logged, and
   * never occupies the page again.
   */
  listUnsentOutbox(limit = 32): OutboxEntry[] {
    const now = iso(this.clock);
    const rows = this.db.prepare(`
      SELECT * FROM outbox
      WHERE sent_at IS NULL AND abandoned_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY outbox_id LIMIT ?
    `).all(now, limit) as Row[];
    return rows.map(outboxFromRow);
  }

  markOutboxSent(outboxId: number): void {
    this.db.prepare("UPDATE outbox SET sent_at=?, attempts=attempts+1 WHERE outbox_id=?")
      .run(iso(this.clock), outboxId);
  }

  markOutboxAttempt(outboxId: number): void {
    const row = this.db.prepare("SELECT attempts FROM outbox WHERE outbox_id=?").get(outboxId) as Row | undefined;
    if (!row) return;
    const attempts = Number(row.attempts) + 1;
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      this.db.prepare("UPDATE outbox SET attempts=?, abandoned_at=? WHERE outbox_id=?")
        .run(attempts, iso(this.clock), outboxId);
      console.error("hive outbox row abandoned after max attempts", outboxId);
      return;
    }
    const nextAttemptAt = new Date(this.clock.now().getTime() + retryBackoffMs(attempts)).toISOString();
    this.db.prepare("UPDATE outbox SET attempts=?, next_attempt_at=? WHERE outbox_id=?")
      .run(attempts, nextAttemptAt, outboxId);
  }

  getDelivery(deliveryId: number): Delivery {
    const row = this.db.prepare(`
      SELECT d.*, e.workspace_id, e.channel_id, e.thread_ts, e.message_ts, e.sender_id,
             e.sender_kind, e.text, e.raw_json, e.received_at,
             s.provider, s.provider_surface, s.provider_version, s.session_id, s.home_edge,
             s.workspace, s.edge_workspaces_json, s.wake_policy, s.permission_profile,
             s.account_profile, s.lease_ttl_ms, s.delivery_ttl_ms, s.home_grace_ms,
             s.spawn_rate_limit, s.max_attempts, s.expires_at, s.updated_at AS subscription_updated_at
      FROM deliveries d
      JOIN slack_events e ON e.event_id=d.event_id
      JOIN subscriptions s ON s.actor=d.actor
      WHERE d.delivery_id=?
    `).get(deliveryId) as Row | undefined;
    if (!row) throw new Error(`delivery ${deliveryId} not found`);
    const delivery = deliveryFromRow(row);
    const events = this.db.prepare(`
      SELECT de.event_id, de.relation, e.sender_id, e.message_ts, e.text
      FROM delivery_events de JOIN slack_events e ON e.event_id=de.event_id
      WHERE de.delivery_id=? ORDER BY de.rowid
    `).all(deliveryId) as Row[];
    const coalescedMessages: CoalescedMessage[] = events
      .filter((event) => String(event.relation) === "coalesced")
      .map((event) => ({
        senderId: String(event.sender_id),
        messageTs: String(event.message_ts),
        text: String(event.text),
      }));
    return {
      ...delivery,
      coalescedEventIds: events.map((event) => String(event.event_id)),
      coalescedMessages,
    };
  }

  listDeliveries(): Delivery[] {
    const ids = this.db.prepare("SELECT delivery_id FROM deliveries ORDER BY delivery_id").all() as Row[];
    return ids.map((row) => this.getDelivery(Number(row.delivery_id)));
  }

  assertLease(deliveryId: number, edgeId: string, generation: number): void {
    const row = this.db.prepare(`
      SELECT d.claimed_by, d.lease_generation, l.edge_id, l.generation, l.expires_at
      FROM deliveries d JOIN actor_leases l ON l.actor=d.actor
      WHERE d.delivery_id=?
    `).get(deliveryId) as Row | undefined;
    const now = this.clock.now().getTime();
    if (
      !row ||
      row.claimed_by !== edgeId ||
      Number(row.lease_generation) !== generation ||
      row.edge_id !== edgeId ||
      Number(row.generation) !== generation ||
      new Date(String(row.expires_at)).getTime() <= now
    ) {
      throw new StaleLeaseError(`stale lease for delivery ${deliveryId}`);
    }
  }

  private terminalizeUnclaimed(deliveryId: number, status: "undeliverable", reasons: Reason[]): void {
    const delivery = this.getDelivery(deliveryId);
    const now = iso(this.clock);
    const result = this.db.prepare(`
      UPDATE deliveries SET status=?, reasons_json=?, terminal_at=?, updated_at=?
      WHERE delivery_id=? AND status='pending'
    `).run(status, JSON.stringify(reasons), now, now, deliveryId);
    if (result.changes === 1) {
      this.enqueueOutbox(delivery, failureNotice(delivery, status, reasons), REACTION_FAILED);
    }
  }
}

/** ADR-0003 R-6: the thread-visible outcome format — self-identifying via delivery id, dedupe key, and actor. */
/**
 * The commons render of a seat-minted wake. Humans see who addressed whom and
 * with what; Slack admission ignores it (the outbox stamps every post `hive_*`)
 * and the ledger — not this text — is what delivers.
 */
function seatWakeRender(from: string, target: string, deliveryId: number, text: string): string {
  return `🐝 wake minted by ${from} → ${target} (delivery ${deliveryId})\n\n${text}`;
}

function outcomePost(delivery: Delivery, text: string): string {
  return `${text}\n\n[delivery ${delivery.id} · dedupe ${delivery.event.messageTs}:${delivery.id} · ${delivery.actor}]`;
}

function failureNotice(delivery: Delivery, status: "failed" | "undeliverable", reasons: Reason[]): string {
  const cause = reasons[0] ? `${reasons[0].code}: ${reasons[0].detail}` : "unknown cause";
  const label = status === "failed"
    ? `✗ delivery ${delivery.id} to ${delivery.actor} failed after ${delivery.attempts} attempt(s)`
    : `✗ delivery ${delivery.id} to ${delivery.actor} was undeliverable`;
  return `${label} — ${cause}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function subscriptionFromRow(row: Row): Subscription {
  return {
    actor: String(row.actor),
    provider: String(row.provider) as Subscription["provider"],
    providerSurface: String(row.provider_surface),
    providerVersion: String(row.provider_version),
    sessionId: row.session_id === null ? null : String(row.session_id),
    homeEdge: String(row.home_edge),
    workspace: String(row.workspace),
    edgeWorkspaces: JSON.parse(String(row.edge_workspaces_json)) as EdgeWorkspace[],
    wakePolicy: String(row.wake_policy) as Subscription["wakePolicy"],
    permissionProfile: String(row.permission_profile),
    accountProfile: String(row.account_profile),
    leaseTtlMs: Number(row.lease_ttl_ms),
    deliveryTtlMs: Number(row.delivery_ttl_ms),
    homeGraceMs: Number(row.home_grace_ms),
    spawnRateLimit: Number(row.spawn_rate_limit),
    maxAttempts: Number(row.max_attempts),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    updatedAt: String(row.updated_at),
  };
}

function deliveryFromRow(row: Row): Delivery {
  const subscription = subscriptionFromRow({
    ...row,
    actor: row.actor,
    updated_at: row.subscription_updated_at,
  });
  const event: SlackEventInput = {
    eventId: String(row.event_id),
    workspaceId: String(row.workspace_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    messageTs: String(row.message_ts),
    senderId: String(row.sender_id),
    senderKind: String(row.sender_kind) as SlackEventInput["senderKind"],
    actor: String(row.actor),
    text: String(row.text),
    raw: JSON.parse(String(row.raw_json)),
    receivedAt: String(row.received_at),
  };
  return {
    id: Number(row.delivery_id),
    eventId: String(row.event_id),
    actor: String(row.actor),
    status: String(row.status) as DeliveryStatus,
    reasons: JSON.parse(String(row.reasons_json)) as Reason[],
    leaseGeneration: row.lease_generation === null ? null : Number(row.lease_generation),
    claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    coalesceKey: String(row.coalesce_key),
    coalescedEventIds: [],
    coalescedMessages: [],
    initialSnapshot: row.initial_snapshot_json === null ? null : JSON.parse(String(row.initial_snapshot_json)),
    snapshotTs: row.snapshot_ts === null ? null : String(row.snapshot_ts),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    subscription,
    event,
  };
}

function isExpired(value: string | null, now: Date): boolean {
  return value !== null && new Date(value).getTime() <= now.getTime();
}

function eligibilityDetail(code: string): string {
  const details: Record<string, string> = {
    workspace_not_mapped: "edge has no registered mapping for the subscription workspace",
    live_ingress_unavailable: "live_only subscription has no eligible live ingress",
    resume_target_missing: "resume subscription has no mapped provider session",
  };
  return details[code] ?? code;
}

function outboxFromRow(row: Row): OutboxEntry {
  return {
    outboxId: Number(row.outbox_id),
    deliveryId: row.delivery_id === null ? null : Number(row.delivery_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    text: String(row.text),
    reaction: row.reaction === null || row.reaction === undefined ? null : String(row.reaction),
    reactionTargets: row.reaction_targets_json === null || row.reaction_targets_json === undefined
      ? []
      : (JSON.parse(String(row.reaction_targets_json)) as string[]),
    createdAt: String(row.created_at),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    attempts: Number(row.attempts),
  };
}
