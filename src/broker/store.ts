import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import type {
  Delivery,
  DeliveryStatus,
  EdgeWorkspace,
  Reason,
  SlackEventInput,
  Subscription,
  SubscriptionInput,
  TerminalDeliveryStatus,
} from "../domain.js";
import type { Clock } from "../time.js";
import { iso, systemClock } from "../time.js";

interface Row { [key: string]: unknown }

const TERMINAL = new Set<DeliveryStatus>([
  "processed",
  "undeliverable",
  "ambiguous",
  "dead_letter",
]);

export class StaleLeaseError extends Error {}
export class InvalidTransitionError extends Error {}
export class ReconciliationError extends Error {}

export class BrokerStore {
  readonly db: Database.Database;

  constructor(path: string, private readonly clock: Clock = systemClock) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
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
        lease_ttl_ms INTEGER NOT NULL,
        delivery_ttl_ms INTEGER NOT NULL,
        home_grace_ms INTEGER NOT NULL,
        spawn_rate_limit INTEGER NOT NULL,
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
    `);
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
        edge_workspaces_json, wake_policy, permission_profile, lease_ttl_ms, delivery_ttl_ms,
        home_grace_ms, spawn_rate_limit, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        lease_ttl_ms=excluded.lease_ttl_ms,
        delivery_ttl_ms=excluded.delivery_ttl_ms,
        home_grace_ms=excluded.home_grace_ms,
        spawn_rate_limit=excluded.spawn_rate_limit,
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
      input.leaseTtlMs,
      input.deliveryTtlMs,
      input.homeGraceMs,
      input.spawnRateLimit,
      input.expiresAt,
      now,
    );
    return { ...input, updatedAt: now };
  }

  getSubscription(actor: string): Subscription | null {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE actor = ?").get(actor) as Row | undefined;
    return row ? subscriptionFromRow(row) : null;
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

  claimNext(edgeId: string, _after: number): Delivery | null {
    return this.db.transaction(() => {
      // `after` remains a v1 compatibility hint only: broker-side eligibility
      // can change over time, so every pending delivery must remain visible.
      const rows = this.db.prepare(`
        SELECT d.delivery_id, d.actor, d.created_at
        FROM deliveries d
        WHERE d.status = 'pending'
        ORDER BY d.delivery_id
      `).all() as Row[];

      for (const row of rows) {
        const actor = String(row.actor);
        const subscription = this.getSubscription(actor);
        if (!subscription) continue;
        const age = this.clock.now().getTime() - new Date(String(row.created_at)).getTime();
        if (age >= subscription.deliveryTtlMs) {
          this.markUndeliverable(Number(row.delivery_id), [{
            code: "delivery_ttl_expired",
            detail: "delivery expired before an eligible edge claimed it",
          }]);
          continue;
        }
        const eligible = this.edgeEligibility(subscription, edgeId, String(row.created_at));
        if (eligible !== "eligible") {
          if (eligible.disposition === "terminal") {
            this.markUndeliverable(Number(row.delivery_id), [{ code: eligible.code, detail: eligibilityDetail(eligible.code) }]);
          }
          continue;
        }

        const generation = this.acquireLease(actor, edgeId, subscription.leaseTtlMs);
        if (generation === null) continue;
        const now = iso(this.clock);
        const claimed = this.db.prepare(`
          UPDATE deliveries
          SET status='claimed', lease_generation=?, claimed_by=?, attempts=attempts+1, updated_at=?
          WHERE delivery_id=? AND status='pending'
        `).run(generation, edgeId, now, Number(row.delivery_id));
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

  reconcile(deliveryId: number, disposition: "processed" | "requeue", detail: string): Delivery {
    const delivery = this.getDelivery(deliveryId);
    if (delivery.status !== "ambiguous") throw new ReconciliationError("only ambiguous deliveries may be reconciled");
    const now = iso(this.clock);
    if (disposition === "processed") {
      this.db.prepare(`
        UPDATE deliveries SET status='processed', reasons_json=?, terminal_at=?, updated_at=?
        WHERE delivery_id=? AND status='ambiguous'
      `).run(JSON.stringify([{ code: "operator_reconciled_processed", detail }]), now, now, deliveryId);
    } else {
      this.db.prepare(`
        UPDATE deliveries
        SET status='pending', reasons_json='[]', lease_generation=NULL, claimed_by=NULL,
            accepted_at=NULL, dispatch_started_at=NULL, dispatched_at=NULL, terminal_at=NULL, updated_at=?
        WHERE delivery_id=? AND status='ambiguous'
      `).run(now, deliveryId);
    }
    return this.getDelivery(deliveryId);
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

  finish(
    deliveryId: number,
    edgeId: string,
    generation: number,
    status: TerminalDeliveryStatus,
    reasons: Reason[],
  ): Delivery {
    this.assertLease(deliveryId, edgeId, generation);
    const current = this.getDelivery(deliveryId);
    if (TERMINAL.has(current.status)) throw new InvalidTransitionError("delivery already terminal");
    const now = iso(this.clock);
    this.db.prepare(`
      UPDATE deliveries SET status=?, reasons_json=?, terminal_at=?, updated_at=? WHERE delivery_id=?
    `).run(status, JSON.stringify(reasons), now, now, deliveryId);
    return this.getDelivery(deliveryId);
  }

  markAmbiguousForExpiredDispatches(): number {
    const now = iso(this.clock);
    this.db.prepare(`
      UPDATE deliveries
      SET status='pending', reasons_json='[]', lease_generation=NULL, claimed_by=NULL,
          accepted_at=NULL, updated_at=?
      WHERE status IN ('claimed', 'accepted_local')
        AND actor IN (SELECT actor FROM actor_leases WHERE expires_at<=?)
    `).run(now, now);
    const rows = this.db.prepare(`
      SELECT d.delivery_id
      FROM deliveries d
      JOIN actor_leases l ON l.actor=d.actor
      WHERE d.status IN ('dispatching', 'dispatched') AND l.expires_at<=?
    `).all(now) as Row[];
    const update = this.db.prepare(`
      UPDATE deliveries SET status='ambiguous', reasons_json=?, terminal_at=?, updated_at=?
      WHERE delivery_id=? AND status IN ('dispatching', 'dispatched')
    `);
    for (const row of rows) {
      update.run(
        JSON.stringify([{ code: "dispatch_outcome_unknown", detail: "lease expired after provider dispatch began and before durable completion or acknowledgement" }]),
        now,
        now,
        Number(row.delivery_id),
      );
    }
    return rows.length;
  }

  getDelivery(deliveryId: number): Delivery {
    const row = this.db.prepare(`
      SELECT d.*, e.workspace_id, e.channel_id, e.thread_ts, e.message_ts, e.sender_id,
             e.sender_kind, e.text, e.raw_json, e.received_at,
             s.provider, s.provider_surface, s.provider_version, s.session_id, s.home_edge,
             s.workspace, s.edge_workspaces_json, s.wake_policy, s.permission_profile,
             s.lease_ttl_ms, s.delivery_ttl_ms, s.home_grace_ms, s.spawn_rate_limit,
             s.expires_at, s.updated_at AS subscription_updated_at
      FROM deliveries d
      JOIN slack_events e ON e.event_id=d.event_id
      JOIN subscriptions s ON s.actor=d.actor
      WHERE d.delivery_id=?
    `).get(deliveryId) as Row | undefined;
    if (!row) throw new Error(`delivery ${deliveryId} not found`);
    const delivery = deliveryFromRow(row);
    const events = this.db.prepare(`
      SELECT event_id FROM delivery_events WHERE delivery_id=? ORDER BY rowid
    `).all(deliveryId) as Row[];
    return { ...delivery, coalescedEventIds: events.map((event) => String(event.event_id)) };
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

  private markUndeliverable(deliveryId: number, reasons: Reason[]): void {
    const now = iso(this.clock);
    this.db.prepare(`
      UPDATE deliveries SET status='undeliverable', reasons_json=?, terminal_at=?, updated_at=?
      WHERE delivery_id=? AND status='pending'
    `).run(JSON.stringify(reasons), now, now, deliveryId);
  }
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
    leaseTtlMs: Number(row.lease_ttl_ms),
    deliveryTtlMs: Number(row.delivery_ttl_ms),
    homeGraceMs: Number(row.home_grace_ms),
    spawnRateLimit: Number(row.spawn_rate_limit),
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
    coalesceKey: String(row.coalesce_key),
    coalescedEventIds: [],
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
