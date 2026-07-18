import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import type {
	ActorOperatorStatus,
	BindingUpdate,
	BrokerOperatorStatus,
	Delivery,
	DeliveryOperatorSummary,
	DeliveryStatus,
	EgressPolicyUpdate,
	EdgeOperatorStatus,
	EdgeWorkspace,
	LeaseOperatorStatus,
	LivePresence,
	LivePresenceInput,
	OutboxReconciliation,
	OutboxReconciliationAudit,
	AutoBindingTarget,
	AutoBindingUpdate,
	IngressDiagnostic,
	Reason,
	SlackEventInput,
	Subscription,
	SubscriptionBinding,
	SlackOutboxState,
	SlackOutboxOperatorSummary,
  SubscriptionInput,
  TerminalDeliveryStatus,
} from "../domain.js";
import type { Clock } from "../time.js";
import { iso, systemClock } from "../time.js";
import { selectCompletionText } from "./egress.js";

interface Row { [key: string]: unknown }

const TERMINAL = new Set<DeliveryStatus>([
  "processed",
  "undeliverable",
  "ambiguous",
  "dead_letter",
]);

const DELIVERY_STATUSES: DeliveryStatus[] = [
	"pending",
	"claimed",
	"accepted_local",
	"dispatching",
	"dispatched",
	"processed",
	"undeliverable",
	"ambiguous",
	"dead_letter",
];

const OUTBOX_STATES: SlackOutboxState[] = ["pending", "sending", "sent", "ambiguous", "dead"];

const DELIVERY_OPERATOR_SELECT = `
	SELECT d.delivery_id, d.event_id, d.actor, d.status, d.reasons_json,
		d.lease_generation, d.claimed_by, d.attempts, d.available_at,
		d.subscription_snapshot_json, d.spawned_session_id, d.spawned_on_edge,
		d.created_at, d.updated_at,
		e.channel_id, e.thread_ts, e.message_ts,
		s.session_id AS current_session_id,
		s.binding_revision AS current_binding_revision,
		s.provider_surface AS current_provider_surface,
		s.provider_version AS current_provider_version,
		s.permission_profile AS current_permission_profile
	FROM deliveries d
	JOIN slack_events e ON e.event_id=d.event_id
	JOIN subscriptions s ON s.actor=d.actor
`;

export interface SlackOutboxClaim {
	id: number;
	idempotencyKey: string;
	kind: "ingress_diagnostic" | "delivery_completion" | "operator_alert";
	channelId: string;
	threadTs: string;
	text: string;
	metadata: Record<string, string>;
	attempts: number;
	claimToken: string;
	recovery: boolean;
}

export class StaleLeaseError extends Error {}
export class InvalidTransitionError extends Error {}
export class ReconciliationError extends Error {}
export class BindingBusyError extends Error {}

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
		binding_mode TEXT NOT NULL DEFAULT 'pinned',
		binding_source TEXT NOT NULL DEFAULT 'provisioned',
		binding_revision INTEGER NOT NULL DEFAULT 1,
		egress_policy TEXT NOT NULL DEFAULT 'receipt_only',
		egress_channel_ids_json TEXT NOT NULL DEFAULT '[]',
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
			result_fingerprint TEXT,
			available_at TEXT,
			subscription_snapshot_json TEXT,
			spawned_session_id TEXT,
			spawned_on_edge TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(event_id, actor),
        FOREIGN KEY(event_id) REFERENCES slack_events(event_id),
        FOREIGN KEY(actor) REFERENCES subscriptions(actor),
        FOREIGN KEY(claimed_by) REFERENCES edges(edge_id)
      );

      CREATE INDEX IF NOT EXISTS deliveries_pending_idx
        ON deliveries(status, delivery_id);

      CREATE INDEX IF NOT EXISTS deliveries_actor_status_id_idx
        ON deliveries(actor, status, delivery_id DESC);

      CREATE INDEX IF NOT EXISTS deliveries_status_id_idx
        ON deliveries(status, delivery_id DESC);

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
		lease_generation INTEGER NOT NULL,
		edge_id TEXT NOT NULL,
		dispatch_path TEXT NOT NULL DEFAULT 'spawn',
        window_start TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(delivery_id) REFERENCES deliveries(delivery_id)
      );

			CREATE TABLE IF NOT EXISTS ingress_diagnostics (
				diagnostic_id INTEGER PRIMARY KEY AUTOINCREMENT,
				event_id TEXT,
				channel_id TEXT NOT NULL,
				thread_ts TEXT NOT NULL,
				reason TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS slack_outbox (
				outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
				idempotency_key TEXT NOT NULL UNIQUE,
				kind TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				thread_ts TEXT NOT NULL,
				text TEXT NOT NULL,
				metadata_json TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'pending',
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TEXT NOT NULL,
				claim_token TEXT,
				claim_expires_at TEXT,
				slack_ts TEXT,
				error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				sent_at TEXT
			);

			CREATE INDEX IF NOT EXISTS slack_outbox_ready_idx
				ON slack_outbox(state, next_attempt_at, outbox_id);

			CREATE TABLE IF NOT EXISTS slack_outbox_reconciliations (
				reconciliation_id INTEGER PRIMARY KEY AUTOINCREMENT,
				outbox_id INTEGER NOT NULL,
				disposition TEXT NOT NULL,
				detail TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY(outbox_id) REFERENCES slack_outbox(outbox_id)
			);

			CREATE TABLE IF NOT EXISTS live_presence (
				actor TEXT PRIMARY KEY,
				edge_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				provider_surface TEXT NOT NULL,
				provider_version TEXT NOT NULL,
				session_id TEXT,
				binding_revision INTEGER NOT NULL,
				transport TEXT NOT NULL,
				owner_loaded INTEGER NOT NULL,
				reason TEXT,
				updated_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				FOREIGN KEY(actor) REFERENCES subscriptions(actor),
				FOREIGN KEY(edge_id) REFERENCES edges(edge_id)
			);
    `);
		this.ensureColumn("subscriptions", "binding_mode", "TEXT NOT NULL DEFAULT 'pinned'");
		this.ensureColumn("subscriptions", "binding_source", "TEXT NOT NULL DEFAULT 'provisioned'");
		this.ensureColumn("subscriptions", "binding_revision", "INTEGER NOT NULL DEFAULT 1");
		this.ensureColumn("subscriptions", "egress_policy", "TEXT NOT NULL DEFAULT 'receipt_only'");
		this.ensureColumn("subscriptions", "egress_channel_ids_json", "TEXT NOT NULL DEFAULT '[]'");
		this.ensureColumn("live_presence", "binding_revision", "INTEGER NOT NULL DEFAULT 1");
		this.ensureColumn("deliveries", "result_fingerprint", "TEXT");
		this.ensureColumn("deliveries", "available_at", "TEXT");
		this.ensureColumn("deliveries", "subscription_snapshot_json", "TEXT");
		this.ensureColumn("deliveries", "spawned_session_id", "TEXT");
		this.ensureColumn("deliveries", "spawned_on_edge", "TEXT");
		this.ensureColumn("spawn_reservations", "lease_generation", "INTEGER");
		this.ensureColumn("spawn_reservations", "edge_id", "TEXT");
		this.ensureColumn("spawn_reservations", "dispatch_path", "TEXT NOT NULL DEFAULT 'spawn'");
		this.ensureColumn("ingress_diagnostics", "event_id", "TEXT");
		this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ingress_diagnostics_event_idx
			ON ingress_diagnostics(event_id) WHERE event_id IS NOT NULL`);
  }

	private ensureColumn(table: string, column: string, definition: string): void {
		const columns = this.db.pragma(`table_info(${table})`) as Row[];
		if (columns.some((item) => item.name === column)) return;
		this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
	this.markAmbiguousForExpiredDispatches();
    return this.db.transaction(() => {
		const existing = this.getSubscription(input.actor);
		if (existing) this.assertBindingMutable(input.actor);
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
        updated_at=excluded.updated_at,
		binding_mode='pinned',
		binding_source='provisioned',
		binding_revision=subscriptions.binding_revision+1
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
		if (existing) this.invalidatePreDispatchBinding(input.actor, now);
		else this.db.prepare("DELETE FROM live_presence WHERE actor=?").run(input.actor);
    return this.getSubscription(input.actor)!;
		})();
  }

  getSubscription(actor: string): Subscription | null {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE actor = ?").get(actor) as Row | undefined;
    return row ? subscriptionFromRow(row) : null;
  }

	listSubscriptions(): Subscription[] {
		const rows = this.db.prepare("SELECT * FROM subscriptions ORDER BY actor").all() as Row[];
		return rows.map(subscriptionFromRow);
	}

	setEgressPolicy(actor: string, update: EgressPolicyUpdate): Subscription {
		const subscription = this.getSubscription(actor);
		if (!subscription) throw new Error(`subscription ${actor} not found`);
		this.db.prepare(`
			UPDATE subscriptions
			SET egress_policy=?, egress_channel_ids_json=?
			WHERE actor=?
		`).run(update.policy, JSON.stringify(update.channelIds), actor);
		return this.getSubscription(actor)!;
	}

		updateBinding(actor: string, update: BindingUpdate): Subscription {
			this.markAmbiguousForExpiredDispatches();
			return this.db.transaction(() => {
			if (!this.getSubscription(actor)) throw new Error(`subscription ${actor} not found`);
			const busy = this.db.prepare(`
				SELECT delivery_id FROM deliveries
					WHERE actor=? AND status IN ('dispatching', 'dispatched', 'ambiguous') LIMIT 1
			`).get(actor);
			if (busy) throw new BindingBusyError("binding change rejected while provider dispatch is in flight");
			const assignments: string[] = [];
			const values: unknown[] = [];
			if (update.sessionId !== undefined) {
				assignments.push("session_id=?");
				values.push(update.sessionId);
			}
			if (update.providerSurface !== undefined) {
				assignments.push("provider_surface=?");
				values.push(update.providerSurface);
			}
			if (update.providerVersion !== undefined) {
				assignments.push("provider_version=?");
				values.push(update.providerVersion);
			}
			if (assignments.length === 0) throw new Error("binding update must include at least one field");
			const now = iso(this.clock);
			assignments.push("updated_at=?");
			assignments.push("binding_mode='pinned'");
			assignments.push("binding_source='operator'");
			assignments.push("binding_revision=binding_revision+1");
			values.push(now, actor);
			this.db.prepare(`UPDATE subscriptions SET ${assignments.join(", ")} WHERE actor=?`).run(...values);
			this.db.prepare("DELETE FROM live_presence WHERE actor=?").run(actor);
			this.db.prepare(`
				UPDATE deliveries
				SET status='pending', lease_generation=NULL, claimed_by=NULL,
						accepted_at=NULL, subscription_snapshot_json=NULL, updated_at=?
				WHERE actor=? AND status IN ('claimed', 'accepted_local')
			`).run(now, actor);
			this.db.prepare(`
				UPDATE actor_leases
				SET generation=generation+1, expires_at=?, updated_at=?
				WHERE actor=?
			`).run(now, now, actor);
			return this.getSubscription(actor)!;
		})();
	}

	subscriptionBindingForHomeEdge(actor: string, edgeId: string): SubscriptionBinding | null {
		const subscription = this.getSubscription(actor);
		if (!subscription || subscription.homeEdge !== edgeId || isExpired(subscription.expiresAt, this.clock.now())) {
			return null;
		}
		return {
			actor: subscription.actor,
			provider: subscription.provider,
			providerSurface: subscription.providerSurface,
			providerVersion: subscription.providerVersion,
			sessionId: subscription.sessionId,
			homeEdge: subscription.homeEdge,
				workspace: subscription.workspace,
				wakePolicy: subscription.wakePolicy,
				permissionProfile: subscription.permissionProfile,
				updatedAt: subscription.updatedAt,
			bindingMode: subscription.bindingMode,
			bindingSource: subscription.bindingSource,
			bindingRevision: subscription.bindingRevision,
		};
	}

	autoBindingTargetForHomeEdge(actor: string, edgeId: string): AutoBindingTarget | null {
		const binding = this.subscriptionBindingForHomeEdge(actor, edgeId);
		const subscription = this.getSubscription(actor);
		const edgeCwd = subscription?.edgeWorkspaces.find((item) => item.edgeId === edgeId)?.cwd;
		return binding && edgeCwd ? { ...binding, edgeCwd } : null;
	}

		setBindingMode(actor: string, mode: "auto" | "pinned"): Subscription {
			this.markAmbiguousForExpiredDispatches();
			return this.db.transaction(() => {
			if (!this.getSubscription(actor)) throw new Error(`subscription ${actor} not found`);
			this.assertBindingMutable(actor);
			const now = iso(this.clock);
			this.db.prepare(`
				UPDATE subscriptions
				SET binding_mode=?, binding_source='operator', binding_revision=binding_revision+1, updated_at=?
				WHERE actor=?
			`).run(mode, now, actor);
			this.invalidatePreDispatchBinding(actor, now);
			return this.getSubscription(actor)!;
		})();
	}

		autoBindForHomeEdge(actor: string, edgeId: string, input: AutoBindingUpdate): SubscriptionBinding {
			this.markAmbiguousForExpiredDispatches();
			return this.db.transaction(() => {
			const subscription = this.getSubscription(actor);
			if (!subscription || subscription.homeEdge !== edgeId) throw new Error("auto_binding_not_home_edge");
			if (subscription.bindingMode !== "auto") throw new Error("auto_binding_not_enabled");
			if (subscription.bindingRevision !== input.expectedBindingRevision) {
				throw new Error("auto_binding_stale_revision");
			}
			const workspace = subscription.edgeWorkspaces.find((item) => item.edgeId === edgeId);
			if (!workspace || workspace.cwd !== input.cwd) throw new Error("auto_binding_cwd_mismatch");
			if (input.threadSource !== "user" || input.parentThreadId !== null) {
				throw new Error("auto_binding_thread_not_primary_user");
			}
			this.assertBindingMutable(actor);
			const now = iso(this.clock);
			this.db.prepare(`
				UPDATE subscriptions
				SET session_id=?, provider_surface=?, provider_version=?,
					binding_source='edge-discovery', binding_revision=binding_revision+1, updated_at=?
				WHERE actor=? AND binding_mode='auto' AND binding_revision=?
			`).run(
				input.sessionId,
				input.providerSurface,
				input.providerVersion,
				now,
				actor,
				input.expectedBindingRevision,
			);
			this.invalidatePreDispatchBinding(actor, now);
			return this.subscriptionBindingForHomeEdge(actor, edgeId)!;
		})();
	}

		private assertBindingMutable(actor: string): void {
		const busy = this.db.prepare(`
			SELECT delivery_id FROM deliveries
			WHERE actor=? AND status IN ('dispatching', 'dispatched', 'ambiguous') LIMIT 1
		`).get(actor);
		if (busy) throw new BindingBusyError("binding change rejected while provider dispatch is in flight");
	}

	private invalidatePreDispatchBinding(actor: string, now: string): void {
		this.db.prepare("DELETE FROM live_presence WHERE actor=?").run(actor);
		this.db.prepare(`
			UPDATE deliveries
				SET status='pending', lease_generation=NULL, claimed_by=NULL,
					accepted_at=NULL, subscription_snapshot_json=NULL, updated_at=?
			WHERE actor=? AND status IN ('claimed', 'accepted_local')
		`).run(now, actor);
		this.db.prepare(`
			UPDATE actor_leases
			SET generation=generation+1, expires_at=?, updated_at=?
			WHERE actor=?
		`).run(now, now, actor);
	}

	reportLivePresence(edgeId: string, input: LivePresenceInput): LivePresence {
		const subscription = this.getSubscription(input.actor);
		if (!subscription || subscription.homeEdge !== edgeId) throw new Error("live_presence_not_home_edge");
		if (isExpired(subscription.expiresAt, this.clock.now())) throw new Error("subscription_expired");
		if (subscription.provider !== input.provider
			|| subscription.providerSurface !== input.providerSurface
			|| subscription.providerVersion !== input.providerVersion
			|| subscription.sessionId !== input.sessionId
			|| subscription.bindingRevision !== input.bindingRevision) {
			throw new Error("live_presence_binding_mismatch");
		}
		const now = this.clock.now();
		const updatedAt = now.toISOString();
		const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
		const reason = input.reason === null ? null : safeOperatorCode(input.reason);
		this.db.prepare(`
			INSERT INTO live_presence(
				actor, edge_id, provider, provider_surface, provider_version, session_id, binding_revision,
				transport, owner_loaded, reason, updated_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(actor) DO UPDATE SET
				edge_id=excluded.edge_id,
				provider=excluded.provider,
				provider_surface=excluded.provider_surface,
				provider_version=excluded.provider_version,
				session_id=excluded.session_id,
				binding_revision=excluded.binding_revision,
				transport=excluded.transport,
				owner_loaded=excluded.owner_loaded,
				reason=excluded.reason,
				updated_at=excluded.updated_at,
				expires_at=excluded.expires_at
		`).run(
			input.actor,
			edgeId,
			input.provider,
			input.providerSurface,
			input.providerVersion,
			input.sessionId,
			input.bindingRevision,
			input.transport,
			input.ownerLoaded ? 1 : 0,
			reason,
			updatedAt,
			expiresAt,
		);
		return {
			actor: input.actor,
			provider: input.provider,
			providerSurface: input.providerSurface,
			providerVersion: input.providerVersion,
			sessionId: input.sessionId,
			bindingRevision: input.bindingRevision,
			transport: input.transport,
			ownerLoaded: input.ownerLoaded,
			reason,
			edgeId,
			updatedAt,
			expiresAt,
		};
	}

	getLivePresence(actor: string, now = this.clock.now()): LivePresence | null {
		const row = this.db.prepare("SELECT * FROM live_presence WHERE actor=?").get(actor) as Row | undefined;
		if (!row || new Date(String(row.expires_at)).getTime() <= now.getTime()) return null;
		const presence = livePresenceFromRow(row);
		const subscription = this.getSubscription(actor);
		if (!subscription
			|| presence.edgeId !== subscription.homeEdge
			|| presence.provider !== subscription.provider
			|| presence.sessionId !== subscription.sessionId
			|| presence.providerSurface !== subscription.providerSurface
			|| presence.providerVersion !== subscription.providerVersion
			|| presence.bindingRevision !== subscription.bindingRevision) return null;
		return presence;
	}

	recordIngressDiagnostic(
		eventId: string,
		channelId: string,
		threadTs: string,
		reason: string,
		text: string,
	): { created: boolean; diagnostic: IngressDiagnostic | null } {
		return this.db.transaction(() => {
			const createdAt = iso(this.clock);
			const safeReason = safeOperatorCode(reason);
			const result = this.db.prepare(`
				INSERT OR IGNORE INTO ingress_diagnostics(event_id, channel_id, thread_ts, reason, created_at)
				VALUES (?, ?, ?, ?, ?)
			`).run(eventId, channelId, threadTs, safeReason, createdAt);
			if (result.changes === 0) return { created: false, diagnostic: null };
			this.enqueueOutbox(
				`ingress:${eventId}:${safeReason}`,
				"ingress_diagnostic",
				channelId,
				threadTs,
				text,
				{ ingress_reason: safeReason },
				createdAt,
			);
			return {
				created: true,
				diagnostic: {
					id: Number(result.lastInsertRowid),
					channelId,
					threadTs,
					reason: safeReason,
					createdAt,
				},
			};
		})();
	}

	listIngressDiagnostics(limit = 20): IngressDiagnostic[] {
		const rows = this.db.prepare(`
			SELECT diagnostic_id, channel_id, thread_ts, reason, created_at
			FROM ingress_diagnostics ORDER BY diagnostic_id DESC LIMIT ?
		`).all(Math.min(Math.max(limit, 1), 100)) as Row[];
		return rows.map((row) => ({
			id: Number(row.diagnostic_id),
			channelId: String(row.channel_id),
			threadTs: String(row.thread_ts),
			reason: String(row.reason),
			createdAt: String(row.created_at),
		}));
	}

		operatorStatus(staleAfterMs = 60_000, actor?: string): Omit<BrokerOperatorStatus, "slack"> {
		const now = this.clock.now();
		const edges = this.listEdgeOperatorStatus(now, staleAfterMs);
		const edgeById = new Map(edges.map((edge) => [edge.edgeId, edge]));
		const deliveryCounts = this.deliveryCounts(actor);
		const deliveryCountsByActor = this.deliveryCountsByActor(actor);
		const latestDeliveries = new Map(
			this.latestDeliveryOperatorSummaries(actor).map((delivery) => [delivery.actor, delivery]),
		);
		const subscriptions = this.listSubscriptions()
			.filter((subscription) => actor === undefined || subscription.actor === actor);
		const actors: ActorOperatorStatus[] = subscriptions.map((subscription) => {
			const actorDeliveryCounts = deliveryCountsByActor.get(subscription.actor) ?? emptyDeliveryCounts();
			const lease = this.leaseOperatorStatus(subscription.actor, now);
			const livePresence = this.getLivePresence(subscription.actor, now);
			const warnings: string[] = [];
			const homeEdge = edgeById.get(subscription.homeEdge);
			if (isExpired(subscription.expiresAt, now)) warnings.push("subscription_expired");
			if (!homeEdge) warnings.push("home_edge_missing");
			else if (!homeEdge.enabled) warnings.push("home_edge_disabled");
			else if (!homeEdge.connected) warnings.push("home_edge_stale");
			if (subscription.wakePolicy === "resume" && !subscription.sessionId) {
				warnings.push("resume_session_missing");
			}
			if (expectsLivePresence(subscription)) {
				if (!livePresence) warnings.push("live_surface_stale_or_missing");
				else if (!livePresence.ownerLoaded) warnings.push(livePresence.reason ?? "live_owner_not_loaded");
			}
			if (actorDeliveryCounts.ambiguous > 0) {
				warnings.push("ambiguous_delivery_requires_reconciliation");
			}
			return {
				subscription,
				livePresence,
				lease,
				deliveryCounts: actorDeliveryCounts,
				latestDelivery: latestDeliveries.get(subscription.actor) ?? null,
				warnings,
			};
		});
			return {
				generatedAt: now.toISOString(),
				staleAfterMs,
				edges,
				actors,
				deliveryCounts,
				outboxCounts: this.outboxCounts(),
				recentOutbox: this.listOutboxOperatorSummaries({ limit: 20 }),
				recentDeliveries: this.listDeliveryOperatorSummaries({
					...(actor === undefined ? {} : { actor }),
					limit: 20,
				}),
				recentIngressDiagnostics: this.listIngressDiagnostics(),
			};
	}

	listDeliveryOperatorSummaries(filters: {
		actor?: string;
		status?: DeliveryStatus;
		limit?: number;
	} = {}): DeliveryOperatorSummary[] {
		const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
		const clauses: string[] = [];
		const values: unknown[] = [];
		if (filters.actor !== undefined) {
			clauses.push("d.actor=?");
			values.push(filters.actor);
		}
		if (filters.status !== undefined) {
			clauses.push("d.status=?");
			values.push(filters.status);
		}
		const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
		const rows = this.db.prepare(`
			${DELIVERY_OPERATOR_SELECT}
			${where}
			ORDER BY d.delivery_id DESC LIMIT ?
		`).all(...values, limit) as Row[];
		return rows.map(deliveryOperatorSummaryFromRow);
	}

	private deliveryCounts(actor?: string): Record<DeliveryStatus, number> {
		const rows = this.db.prepare(`
			SELECT status, COUNT(*) AS delivery_count FROM deliveries
			${actor === undefined ? "" : "WHERE actor=?"}
			GROUP BY status
		`).all(...(actor === undefined ? [] : [actor])) as Row[];
		const counts = emptyDeliveryCounts();
		for (const row of rows) counts[String(row.status) as DeliveryStatus] = Number(row.delivery_count);
		return counts;
	}

	private deliveryCountsByActor(actor?: string): Map<string, Record<DeliveryStatus, number>> {
		const rows = this.db.prepare(`
			SELECT actor, status, COUNT(*) AS delivery_count FROM deliveries
			${actor === undefined ? "" : "WHERE actor=?"}
			GROUP BY actor, status
		`).all(...(actor === undefined ? [] : [actor])) as Row[];
		const countsByActor = new Map<string, Record<DeliveryStatus, number>>();
		for (const row of rows) {
			const actorName = String(row.actor);
			const counts = countsByActor.get(actorName) ?? emptyDeliveryCounts();
			counts[String(row.status) as DeliveryStatus] = Number(row.delivery_count);
			countsByActor.set(actorName, counts);
		}
		return countsByActor;
	}

	private latestDeliveryOperatorSummaries(actor?: string): DeliveryOperatorSummary[] {
		const rows = this.db.prepare(`
			${DELIVERY_OPERATOR_SELECT}
			JOIN (
				SELECT actor, MAX(delivery_id) AS delivery_id FROM deliveries
				${actor === undefined ? "" : "WHERE actor=?"}
				GROUP BY actor
			) latest ON latest.delivery_id=d.delivery_id
			ORDER BY d.actor
		`).all(...(actor === undefined ? [] : [actor])) as Row[];
		return rows.map(deliveryOperatorSummaryFromRow);
	}

	listOutboxOperatorSummaries(filters: { state?: SlackOutboxState; limit?: number } = {}): SlackOutboxOperatorSummary[] {
		const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
		const rows = this.db.prepare(`
			SELECT outbox_id, idempotency_key, kind, state, attempts, channel_id, thread_ts,
				error_code, created_at, updated_at
			FROM slack_outbox
			WHERE (? IS NULL OR state=?)
			ORDER BY outbox_id DESC LIMIT ?
		`).all(filters.state ?? null, filters.state ?? null, limit) as Row[];
		return rows.map(outboxOperatorSummaryFromRow);
	}

	private listEdgeOperatorStatus(now: Date, staleAfterMs: number): EdgeOperatorStatus[] {
		const rows = this.db.prepare(`
			SELECT edge_id, enabled, created_at, last_seen_at FROM edges ORDER BY edge_id
		`).all() as Row[];
		return rows.map((row) => {
			const lastSeenAt = row.last_seen_at === null ? null : String(row.last_seen_at);
			return {
				edgeId: String(row.edge_id),
				enabled: row.enabled === 1,
				createdAt: String(row.created_at),
				lastSeenAt,
				connected: row.enabled === 1 && lastSeenAt !== null
					&& now.getTime() - new Date(lastSeenAt).getTime() <= staleAfterMs,
			};
		});
	}

	private leaseOperatorStatus(actor: string, now: Date): LeaseOperatorStatus | null {
		const row = this.db.prepare(`
			SELECT edge_id, generation, expires_at FROM actor_leases WHERE actor=?
		`).get(actor) as Row | undefined;
		if (!row) return null;
		const expiresAt = String(row.expires_at);
		return {
			edgeId: String(row.edge_id),
			generation: Number(row.generation),
			expiresAt,
			active: new Date(expiresAt).getTime() > now.getTime(),
		};
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
			const actor = safeActorLabel(event.actor);
			const reason = "no_active_subscription";
			const createdAt = iso(this.clock);
			this.db.prepare(`
				INSERT OR IGNORE INTO ingress_diagnostics(event_id, channel_id, thread_ts, reason, created_at)
				VALUES (?, ?, ?, ?, ?)
			`).run(event.eventId, event.channelId, event.threadTs, reason, createdAt);
			this.enqueueOutbox(
				`ingress:${event.eventId}:${reason}`,
				"ingress_diagnostic",
				event.channelId,
				event.threadTs,
				`Hive could not route this wake to \`${actor}\`: that actor has no active subscription. No agent was dispatched.`,
				{ ingress_reason: reason },
				createdAt,
			);
	        return { created: true, deliveryId: null };
	      }
      const now = iso(this.clock);
      const coalesceKey = `${event.actor}:${event.channelId}:${event.threadTs}`;
	      const pending = this.db.prepare(`
	        SELECT delivery_id, created_at FROM deliveries
	        WHERE coalesce_key=? AND status='pending'
	        ORDER BY delivery_id LIMIT 1
	      `).get(coalesceKey) as Row | undefined;
	      const coalesceWindowMs = Math.min(2_000, Math.max(100, Math.floor(subscription.deliveryTtlMs / 10)));
	      if (pending && this.clock.now().getTime() - new Date(String(pending.created_at)).getTime() <= coalesceWindowMs) {
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

  claimNext(edgeId: string, after: number): Delivery | null {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT d.delivery_id, d.actor, d.created_at
        FROM deliveries d
	        WHERE d.status = 'pending'
			  AND (d.available_at IS NULL OR d.available_at<=?)
		  AND NOT EXISTS (
			SELECT 1 FROM deliveries active
			WHERE active.actor=d.actor
				  AND active.status IN ('claimed', 'accepted_local', 'dispatching', 'dispatched', 'ambiguous')
		  )
        ORDER BY d.delivery_id
	      `).all(iso(this.clock)) as Row[];

      for (const row of rows) {
        const actor = String(row.actor);
        const subscription = this.getSubscription(actor);
        if (!subscription) continue;
		if (isExpired(subscription.expiresAt, this.clock.now())) {
		  this.markUndeliverable(Number(row.delivery_id), [{
			code: "subscription_expired",
			detail: "subscription authority expired before provider dispatch",
		  }]);
		  continue;
		}
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
		  SET status='claimed', lease_generation=?, claimed_by=?, attempts=attempts+1,
			subscription_snapshot_json=?, updated_at=?
          WHERE delivery_id=? AND status='pending'
		`).run(generation, edgeId, JSON.stringify(subscription), now, Number(row.delivery_id));
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
	if (isExpired(delivery.subscription.expiresAt, this.clock.now())) {
	  throw new InvalidTransitionError("subscription_expired");
	}
	if (remainingDeliveryTtl(delivery, this.clock.now()) <= 0) {
	  throw new InvalidTransitionError("delivery_ttl_expired");
	}
    if (!this.renewLease(delivery.actor, edgeId, generation, delivery.subscription.leaseTtlMs)) {
      throw new StaleLeaseError(`stale lease for delivery ${deliveryId}`);
    }
	    return this.getDelivery(deliveryId);
	  }

	releasePreProvider(
		deliveryId: number,
		edgeId: string,
		generation: number,
		reason: Reason,
	): Delivery {
		return this.db.transaction(() => {
			this.assertLease(deliveryId, edgeId, generation);
			const delivery = this.getDelivery(deliveryId);
			if (!["claimed", "accepted_local", "dispatching"].includes(delivery.status)) {
				throw new InvalidTransitionError("pre-provider release requires a pre-provider state");
			}
			const now = this.clock.now();
			const subscriptionExpired = isExpired(delivery.subscription.expiresAt, now);
			const deliveryDeadline = new Date(delivery.createdAt).getTime() + delivery.subscription.deliveryTtlMs;
			const backoffMs = Math.min(30_000, 500 * (2 ** Math.max(0, delivery.attempts - 1)));
			const nextAttemptAt = now.getTime() + backoffMs;
			const terminal = subscriptionExpired || nextAttemptAt >= deliveryDeadline;
			const terminalReason = subscriptionExpired
				? { code: "subscription_expired", detail: "subscription authority expired before provider dispatch" }
				: reason;
			const result = this.db.prepare(`
				UPDATE deliveries
				SET status=?, reasons_json=?, lease_generation=NULL, claimed_by=NULL,
					accepted_at=NULL, dispatch_started_at=NULL, available_at=?, terminal_at=?,
					subscription_snapshot_json=CASE WHEN ? THEN subscription_snapshot_json ELSE NULL END,
					updated_at=?
				WHERE delivery_id=? AND status IN ('claimed', 'accepted_local', 'dispatching')
			`).run(
				terminal ? "undeliverable" : "pending",
				JSON.stringify([terminalReason]),
					terminal ? null : new Date(nextAttemptAt).toISOString(),
					terminal ? now.toISOString() : null,
					terminal ? 1 : 0,
				now.toISOString(),
				deliveryId,
			);
			if (result.changes !== 1) throw new InvalidTransitionError("pre-provider release lost its state fence");
			this.db.prepare("DELETE FROM spawn_reservations WHERE delivery_id=?").run(deliveryId);
			this.db.prepare(`
				UPDATE actor_leases SET expires_at=?, updated_at=?
				WHERE actor=? AND edge_id=? AND generation=?
			`).run(now.toISOString(), now.toISOString(), delivery.actor, edgeId, generation);
			if (terminal) {
				this.enqueueOutbox(
					`delivery-alert:${delivery.id}:pre-provider-terminal`,
					"operator_alert",
					delivery.event.channelId,
					delivery.event.threadTs,
					`Hive: ${safeActorLabel(delivery.actor)} could not receive delivery ${delivery.id} before its authority or delivery deadline. No agent was dispatched.`,
					{ event_id: delivery.eventId, delivery_id: String(delivery.id), delivery_status: "undeliverable" },
					now.toISOString(),
				);
			}
			return this.getDelivery(deliveryId);
		})();
	}

  reserveSpawn(deliveryId: number, edgeId: string, generation: number): boolean {
    return this.db.transaction(() => {
      this.assertLease(deliveryId, edgeId, generation);
      const delivery = this.getDelivery(deliveryId);
      if (delivery.subscription.wakePolicy !== "spawn") throw new InvalidTransitionError("spawn not allowed by subscription");
      if (delivery.status !== "dispatching") throw new InvalidTransitionError("spawn reservation requires dispatching state");
	  const existing = this.db.prepare(`
		SELECT actor, lease_generation, edge_id, dispatch_path
		FROM spawn_reservations WHERE delivery_id=?
	  `).get(deliveryId) as Row | undefined;
	  if (existing?.actor === delivery.actor
		&& Number(existing.lease_generation) === generation
		&& existing.edge_id === edgeId
		&& existing.dispatch_path === "spawn") return true;
	  if (existing) this.db.prepare("DELETE FROM spawn_reservations WHERE delivery_id=?").run(deliveryId);
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
		INSERT INTO spawn_reservations(
		  delivery_id, actor, lease_generation, edge_id, dispatch_path, window_start, created_at
		) VALUES (?, ?, ?, ?, 'spawn', ?, ?)
	  `).run(deliveryId, delivery.actor, generation, edgeId, windowStart, now.toISOString());
      return true;
    })();
  }

		reconcile(deliveryId: number, disposition: "processed" | "requeue", detail: string): Delivery {
		return this.db.transaction(() => {
			const delivery = this.getDelivery(deliveryId);
			if (delivery.status === "processed" && disposition === "processed"
				&& delivery.reasons[0]?.code === "operator_reconciled_processed") return delivery;
			if (delivery.status !== "ambiguous") {
				throw new ReconciliationError("only ambiguous deliveries may be reconciled");
			}
			const now = iso(this.clock);
			if (disposition === "processed") {
				this.db.prepare(`
					UPDATE deliveries SET status='processed', reasons_json=?, terminal_at=?, updated_at=?
					WHERE delivery_id=? AND status='ambiguous'
				`).run(JSON.stringify([{ code: "operator_reconciled_processed", detail }]), now, now, deliveryId);
					this.enqueueOutbox(
						`reconciliation:${delivery.id}:processed`,
						"operator_alert",
						delivery.event.channelId,
						delivery.event.threadTs,
						`Hive: delivery ${delivery.id} was marked processed after operator reconciliation.`,
						{ event_id: delivery.eventId, delivery_id: String(delivery.id), reconciliation: "processed" },
						now,
					);
			} else {
				this.db.prepare(`
					UPDATE deliveries
					SET status='pending', reasons_json='[]', lease_generation=NULL, claimed_by=NULL,
						accepted_at=NULL, dispatch_started_at=NULL, dispatched_at=NULL, terminal_at=NULL,
						available_at=NULL, subscription_snapshot_json=NULL, updated_at=?
					WHERE delivery_id=? AND status='ambiguous'
					`).run(now, deliveryId);
					this.db.prepare("DELETE FROM spawn_reservations WHERE delivery_id=?").run(deliveryId);
					if (delivery.claimedBy !== null && delivery.leaseGeneration !== null) {
						this.db.prepare(`
							UPDATE actor_leases SET expires_at=?, updated_at=?
							WHERE actor=? AND edge_id=? AND generation=?
						`).run(
							now,
							now,
							delivery.actor,
							delivery.claimedBy,
							delivery.leaseGeneration,
						);
					}
					this.enqueueOutbox(
						`reconciliation:${delivery.id}:requeue:${delivery.attempts}`,
						"operator_alert",
						delivery.event.channelId,
						delivery.event.threadTs,
						`Hive: delivery ${delivery.id} was safely requeued after operator reconciliation.`,
						{ event_id: delivery.eventId, delivery_id: String(delivery.id), reconciliation: "requeue" },
						now,
					);
			}
			return this.getDelivery(deliveryId);
		})();
		}

	reconcileForOperator(
		deliveryId: number,
		disposition: "processed" | "requeue",
		detail: string,
	): DeliveryOperatorSummary {
		return deliveryOperatorSummary(this.reconcile(deliveryId, disposition, detail));
	}

  transition(
    deliveryId: number,
    edgeId: string,
    generation: number,
    expected: DeliveryStatus,
    next: DeliveryStatus,
  ): Delivery {
	return this.db.transaction(() => {
	  if (TERMINAL.has(expected)) throw new InvalidTransitionError("terminal delivery cannot transition");
	  this.assertLease(deliveryId, edgeId, generation);
	  const current = this.getDelivery(deliveryId);
	  const nowDate = this.clock.now();
	  const authorityReason = isExpired(current.subscription.expiresAt, nowDate)
		? { code: "subscription_expired", detail: "subscription authority expired before provider dispatch" }
		: remainingDeliveryTtl(current, nowDate) <= 0
			? { code: "delivery_ttl_expired", detail: "delivery expired before provider dispatch" }
			: null;
	  if (authorityReason && ["claimed", "accepted_local"].includes(current.status)) {
		const now = nowDate.toISOString();
		this.db.prepare(`
		  UPDATE deliveries SET status='undeliverable', reasons_json=?, terminal_at=?, updated_at=?
		  WHERE delivery_id=? AND status IN ('claimed', 'accepted_local')
		`).run(JSON.stringify([authorityReason]), now, now, deliveryId);
		this.db.prepare(`UPDATE actor_leases SET expires_at=?, updated_at=? WHERE actor=? AND generation=?`)
		  .run(now, now, current.actor, generation);
		this.enqueueOutbox(
		  `delivery-alert:${current.id}:authority-expired`,
		  "operator_alert",
		  current.event.channelId,
		  current.event.threadTs,
		  `Hive: ${safeActorLabel(current.actor)} could not receive delivery ${current.id} before its authority or delivery deadline. No agent was dispatched.`,
		  { event_id: current.eventId, delivery_id: String(current.id), delivery_status: "undeliverable" },
		  now,
		);
		return this.getDelivery(deliveryId);
	  }
	  const now = nowDate.toISOString();
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
	})();
  }

  finish(
    deliveryId: number,
    edgeId: string,
    generation: number,
    status: TerminalDeliveryStatus,
    reasons: Reason[],
		providerReceipt: string | null = null,
		spawnedSessionId: string | null = null,
  ): Delivery {
		return this.db.transaction(() => {
			if (spawnedSessionId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(spawnedSessionId)) {
				throw new InvalidTransitionError("invalid spawned session id");
			}
			const current = this.getDelivery(deliveryId);
			const reservation = this.db.prepare(`
				SELECT actor, lease_generation, edge_id, dispatch_path
				FROM spawn_reservations WHERE delivery_id=?
			`).get(deliveryId) as Row | undefined;
			const hasSpawnReservation = reservation?.actor === current.actor
				&& Number(reservation.lease_generation) === generation
				&& reservation.edge_id === edgeId
				&& reservation.dispatch_path === "spawn";
			if (spawnedSessionId !== null
				&& ((status !== "processed" && status !== "ambiguous") || !hasSpawnReservation)) {
				throw new InvalidTransitionError(
					"spawned session result requires this delivery's durable spawn reservation",
				);
			}
			if (status === "processed" && hasSpawnReservation && spawnedSessionId === null) {
				throw new InvalidTransitionError("processed spawn result requires an unambiguous session id");
			}
			const fingerprint = resultFingerprint(status, reasons, providerReceipt, spawnedSessionId);
			if (TERMINAL.has(current.status)) {
			const row = this.db.prepare(`
				SELECT result_fingerprint FROM deliveries WHERE delivery_id=?
			`).get(deliveryId) as Row | undefined;
			if (current.claimedBy === edgeId
				&& current.leaseGeneration === generation
				&& row?.result_fingerprint === fingerprint) return current;
			throw new InvalidTransitionError("delivery already terminal with a different result");
		}
		this.assertLease(deliveryId, edgeId, generation);
		const now = iso(this.clock);
		this.db.prepare(`
			UPDATE deliveries
				SET status=?, reasons_json=?, result_fingerprint=?, spawned_session_id=?, spawned_on_edge=?,
					terminal_at=?, updated_at=?
				WHERE delivery_id=?
			`).run(
				status,
				JSON.stringify(reasons),
				fingerprint,
				spawnedSessionId,
				spawnedSessionId === null ? null : edgeId,
				now,
				now,
				deliveryId,
			);
			if (status === "processed" && spawnedSessionId !== null
				&& !this.bindSpawnedSessionIfAuthorized(current, edgeId, spawnedSessionId, now)) {
				throw new InvalidTransitionError("spawned session authority changed before binding");
			}
			if (status === "processed") {
				const egressAuthority = this.getSubscription(current.actor) ?? current.subscription;
				const text = selectCompletionText(
					egressAuthority,
				current.event.channelId,
				current.id,
				providerReceipt,
			);
			this.enqueueOutbox(
				`completion:${current.id}`,
				"delivery_completion",
				current.event.channelId,
				current.event.threadTs,
				text,
				{ event_id: current.eventId, delivery_id: String(current.id) },
				now,
			);
		}
			return this.getDelivery(deliveryId);
		})();
  }

	private bindSpawnedSessionIfAuthorized(
		delivery: Delivery,
		edgeId: string,
		sessionId: string,
		now: string,
	): boolean {
		const authority = delivery.subscription;
		if (authority.wakePolicy !== "spawn" || authority.sessionId !== null) {
			return false;
		}
		const current = this.getSubscription(delivery.actor);
		if (!current || current.wakePolicy !== "spawn" || current.sessionId !== null
			|| current.homeEdge !== authority.homeEdge
			|| current.bindingRevision !== authority.bindingRevision
			|| current.provider !== authority.provider
			|| current.providerSurface !== authority.providerSurface
			|| current.providerVersion !== authority.providerVersion
			|| current.permissionProfile !== authority.permissionProfile) return false;
		// A mapped foreign edge may spawn after home grace. Its session is durable delivery evidence,
		// but only the home edge is allowed to promote that evidence into the resumable binding.
		if (authority.homeEdge !== edgeId) return true;
		const result = this.db.prepare(`
			UPDATE subscriptions
			SET session_id=?, binding_source='edge-discovery', binding_revision=binding_revision+1, updated_at=?
			WHERE actor=? AND session_id IS NULL AND binding_revision=? AND wake_policy='spawn' AND home_edge=?
		`).run(sessionId, now, delivery.actor, authority.bindingRevision, edgeId);
		if (result.changes !== 1) return false;
		this.db.prepare("DELETE FROM live_presence WHERE actor=?").run(delivery.actor);
		return true;
	}

	claimOutbox(claimTtlMs = 30_000): SlackOutboxClaim | null {
		return this.db.transaction(() => {
			const now = this.clock.now();
			const nowIso = now.toISOString();
			const row = this.db.prepare(`
				SELECT * FROM slack_outbox
				WHERE (state='pending' AND next_attempt_at<=?)
					OR (state='sending' AND claim_expires_at IS NOT NULL AND claim_expires_at<=?)
				ORDER BY outbox_id LIMIT 1
			`).get(nowIso, nowIso) as Row | undefined;
			if (!row) return null;
			const recovery = row.state === "sending";
			const claimToken = randomBytes(24).toString("base64url");
			const claimExpiresAt = new Date(now.getTime() + claimTtlMs).toISOString();
			const result = recovery
				? this.db.prepare(`
					UPDATE slack_outbox SET claim_token=?, claim_expires_at=?, updated_at=?
					WHERE outbox_id=? AND state='sending' AND claim_expires_at<=?
				`).run(claimToken, claimExpiresAt, nowIso, row.outbox_id, nowIso)
				: this.db.prepare(`
					UPDATE slack_outbox
					SET state='sending', attempts=attempts+1, claim_token=?, claim_expires_at=?, updated_at=?
					WHERE outbox_id=? AND state='pending' AND next_attempt_at<=?
				`).run(claimToken, claimExpiresAt, nowIso, row.outbox_id, nowIso);
			if (result.changes !== 1) return null;
			const claimed = this.db.prepare("SELECT * FROM slack_outbox WHERE outbox_id=?")
				.get(row.outbox_id) as Row;
			return outboxClaimFromRow(claimed, claimToken, recovery);
		})();
	}

	completeOutbox(
		outboxId: number,
		claimToken: string,
		state: "sent" | "ambiguous" | "dead",
		options: { slackTs?: string; errorCode?: string } = {},
	): void {
		const now = iso(this.clock);
		const result = this.db.prepare(`
			UPDATE slack_outbox
			SET state=?, slack_ts=?, error_code=?, claim_token=NULL, claim_expires_at=NULL,
				updated_at=?, sent_at=?
			WHERE outbox_id=? AND state='sending' AND claim_token=?
		`).run(
			state,
			options.slackTs ?? null,
			options.errorCode ? safeOperatorCode(options.errorCode) : null,
			now,
			state === "sent" ? now : null,
			outboxId,
			claimToken,
		);
		if (result.changes !== 1) throw new InvalidTransitionError("stale Slack outbox claim");
	}

	retryOutbox(
		outboxId: number,
		claimToken: string,
		errorCode: string,
		retryAfterMs: number,
		maxAttempts = 5,
	): void {
		const row = this.db.prepare(`
			SELECT attempts FROM slack_outbox
			WHERE outbox_id=? AND state='sending' AND claim_token=?
		`).get(outboxId, claimToken) as Row | undefined;
		if (!row) throw new InvalidTransitionError("stale Slack outbox claim");
		const attempts = Number(row.attempts);
		const now = this.clock.now();
		const dead = attempts >= maxAttempts;
		const result = this.db.prepare(`
			UPDATE slack_outbox
			SET state=?, error_code=?, next_attempt_at=?, claim_token=NULL, claim_expires_at=NULL,
				updated_at=?
			WHERE outbox_id=? AND state='sending' AND claim_token=?
		`).run(
			dead ? "dead" : "pending",
			safeOperatorCode(errorCode),
			new Date(now.getTime() + Math.max(0, retryAfterMs)).toISOString(),
			now.toISOString(),
			outboxId,
			claimToken,
		);
		if (result.changes !== 1) throw new InvalidTransitionError("stale Slack outbox claim");
	}

	reconcileOutboxForOperator(outboxId: number, input: OutboxReconciliation): SlackOutboxOperatorSummary {
		return this.db.transaction(() => {
			const row = this.db.prepare("SELECT * FROM slack_outbox WHERE outbox_id=?").get(outboxId) as Row | undefined;
			if (!row) throw new ReconciliationError(`Slack outbox ${outboxId} not found`);
			if (row.state !== "ambiguous" && row.state !== "dead") {
				throw new ReconciliationError("only ambiguous or dead Slack outbox rows may be reconciled");
			}
			const now = iso(this.clock);
			this.db.prepare(`
				INSERT INTO slack_outbox_reconciliations(outbox_id, disposition, detail, created_at)
				VALUES (?, ?, ?, ?)
			`).run(outboxId, input.disposition, input.detail, now);
			if (input.disposition === "retry") {
				this.db.prepare(`
					UPDATE slack_outbox
					SET state='pending', next_attempt_at=?, claim_token=NULL, claim_expires_at=NULL,
						error_code='operator_requeued', updated_at=?
					WHERE outbox_id=?
				`).run(now, now, outboxId);
			} else {
				this.db.prepare(`
					UPDATE slack_outbox
					SET state=?, slack_ts=?, error_code=?, sent_at=?, updated_at=?
					WHERE outbox_id=?
				`).run(
					input.disposition,
					input.slackTs ?? null,
					input.disposition === "sent" ? "operator_reconciled_sent" : "operator_marked_dead",
					input.disposition === "sent" ? now : null,
					now,
					outboxId,
				);
			}
			const updated = this.db.prepare(`
				SELECT outbox_id, idempotency_key, kind, state, attempts, channel_id, thread_ts,
					error_code, created_at, updated_at
				FROM slack_outbox WHERE outbox_id=?
			`).get(outboxId) as Row;
			return outboxOperatorSummaryFromRow(updated);
		})();
	}

	listOutboxReconciliationAudit(outboxId: number): OutboxReconciliationAudit[] {
		const rows = this.db.prepare(`
			SELECT reconciliation_id, outbox_id, disposition, detail, created_at
			FROM slack_outbox_reconciliations WHERE outbox_id=? ORDER BY reconciliation_id
		`).all(outboxId) as Row[];
		return rows.map((row) => ({
			id: Number(row.reconciliation_id),
			outboxId: Number(row.outbox_id),
			disposition: String(row.disposition) as OutboxReconciliationAudit["disposition"],
			detail: String(row.detail),
			createdAt: String(row.created_at),
		}));
	}

	outboxCounts(): Record<SlackOutboxState, number> {
		const counts = Object.fromEntries(OUTBOX_STATES.map((state) => [state, 0])) as Record<SlackOutboxState, number>;
		const rows = this.db.prepare(`SELECT state, COUNT(*) AS count FROM slack_outbox GROUP BY state`).all() as Row[];
		for (const row of rows) {
			const state = String(row.state) as SlackOutboxState;
			if (state in counts) counts[state] = Number(row.count);
		}
		return counts;
	}

	private enqueueOutbox(
		idempotencyKey: string,
		kind: SlackOutboxClaim["kind"],
		channelId: string,
		threadTs: string,
		text: string,
		metadata: Record<string, string>,
		now: string,
	): void {
		this.db.prepare(`
			INSERT OR IGNORE INTO slack_outbox(
				idempotency_key, kind, channel_id, thread_ts, text, metadata_json,
				state, attempts, next_attempt_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
		`).run(
			idempotencyKey,
			kind,
			channelId,
			threadTs,
			text,
			JSON.stringify({
				...metadata,
				outbox_key: idempotencyKey,
				outbox_nonce: randomBytes(18).toString("base64url"),
			}),
			now,
			now,
			now,
		);
	}

	sweepExpiredDeliveries(limit = 200): {
		terminalizedPending: number;
		requeuedPreDispatch: number;
		ambiguous: number;
	} {
		return this.db.transaction(() => {
			const boundedLimit = Math.min(Math.max(limit, 1), 500);
			const nowDate = this.clock.now();
			const now = nowDate.toISOString();
			const pending = this.db.prepare(`
				SELECT d.delivery_id, s.expires_at
				FROM deliveries d JOIN subscriptions s ON s.actor=d.actor
				WHERE d.status='pending' AND (
					(s.expires_at IS NOT NULL AND s.expires_at<=?)
					OR ((julianday(d.created_at) - 2440587.5) * 86400000 + s.delivery_ttl_ms)<=?
				)
				ORDER BY d.delivery_id LIMIT ?
			`).all(now, nowDate.getTime(), boundedLimit) as Row[];
			let terminalizedPending = 0;
			for (const row of pending) {
				const subscriptionExpired = row.expires_at !== null
					&& new Date(String(row.expires_at)).getTime() <= nowDate.getTime();
				terminalizedPending += this.markUndeliverable(Number(row.delivery_id), [{
					code: subscriptionExpired ? "subscription_expired" : "delivery_ttl_expired",
					detail: subscriptionExpired
						? "subscription authority expired before provider dispatch"
						: "delivery expired before an eligible edge claimed it",
				}]);
			}

			const preDispatch = this.db.prepare(`
				SELECT d.delivery_id FROM deliveries d
				JOIN actor_leases l ON l.actor=d.actor
				WHERE d.status IN ('claimed', 'accepted_local') AND l.expires_at<=?
				ORDER BY d.delivery_id LIMIT ?
			`).all(now, boundedLimit) as Row[];
			const requeue = this.db.prepare(`
				UPDATE deliveries
				SET status='pending', reasons_json='[]', lease_generation=NULL, claimed_by=NULL,
					accepted_at=NULL, subscription_snapshot_json=NULL, updated_at=?
				WHERE delivery_id=? AND status IN ('claimed', 'accepted_local')
			`);
			let requeuedPreDispatch = 0;
			for (const row of preDispatch) {
				requeuedPreDispatch += requeue.run(now, row.delivery_id).changes;
				this.db.prepare("DELETE FROM spawn_reservations WHERE delivery_id=?").run(row.delivery_id);
			}

			const dispatching = this.db.prepare(`
				SELECT d.delivery_id FROM deliveries d
				JOIN actor_leases l ON l.actor=d.actor
				WHERE d.status IN ('dispatching', 'dispatched') AND l.expires_at<=?
				ORDER BY d.delivery_id LIMIT ?
			`).all(now, boundedLimit) as Row[];
			const makeAmbiguous = this.db.prepare(`
				UPDATE deliveries SET status='ambiguous', reasons_json=?, terminal_at=?, updated_at=?
				WHERE delivery_id=? AND status IN ('dispatching', 'dispatched')
			`);
			let ambiguous = 0;
			for (const row of dispatching) {
				ambiguous += makeAmbiguous.run(
					JSON.stringify([{
						code: "dispatch_outcome_unknown",
						detail: "lease expired after provider dispatch began and before durable completion or acknowledgement",
					}]),
					now,
					now,
					row.delivery_id,
				).changes;
			}
			return { terminalizedPending, requeuedPreDispatch, ambiguous };
		})();
	}

	markAmbiguousForExpiredDispatches(): number {
		return this.sweepExpiredDeliveries().ambiguous;
	}

  getDelivery(deliveryId: number): Delivery {
    const row = this.db.prepare(`
      SELECT d.*, e.workspace_id, e.channel_id, e.thread_ts, e.message_ts, e.sender_id,
             e.sender_kind, e.text, e.raw_json, e.received_at,
             s.provider, s.provider_surface, s.provider_version, s.session_id, s.home_edge,
             s.workspace, s.edge_workspaces_json, s.wake_policy, s.permission_profile,
	             s.lease_ttl_ms, s.delivery_ttl_ms, s.home_grace_ms, s.spawn_rate_limit,
	             s.expires_at, s.updated_at AS subscription_updated_at
			 , s.binding_mode, s.binding_source, s.binding_revision,
			 s.egress_policy, s.egress_channel_ids_json
      FROM deliveries d
      JOIN slack_events e ON e.event_id=d.event_id
      JOIN subscriptions s ON s.actor=d.actor
      WHERE d.delivery_id=?
    `).get(deliveryId) as Row | undefined;
    if (!row) throw new Error(`delivery ${deliveryId} not found`);
    const delivery = deliveryFromRow(row);
	const events = this.db.prepare(`
	  SELECT e.* FROM delivery_events de
	  JOIN slack_events e ON e.event_id=de.event_id
	  WHERE de.delivery_id=? ORDER BY de.rowid
	`).all(deliveryId) as Row[];
	const durableEvents = events.map(slackEventFromRow);
	return {
		...delivery,
		coalescedEventIds: durableEvents.map((event) => event.eventId),
		durableEvents,
		remainingTtlMs: remainingDeliveryTtl(delivery, this.clock.now()),
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

	private markUndeliverable(deliveryId: number, reasons: Reason[]): number {
    const now = iso(this.clock);
	const result = this.db.prepare(`
      UPDATE deliveries SET status='undeliverable', reasons_json=?, terminal_at=?, updated_at=?
      WHERE delivery_id=? AND status='pending'
    `).run(JSON.stringify(reasons), now, now, deliveryId);
	if (result.changes !== 1) return 0;
	const delivery = this.getDelivery(deliveryId);
	this.enqueueOutbox(
		`delivery-alert:${delivery.id}:no-dispatch`,
		"operator_alert",
		delivery.event.channelId,
		delivery.event.threadTs,
		`Hive: ${safeActorLabel(delivery.actor)} could not receive delivery ${delivery.id}. No agent was dispatched.`,
		{
			event_id: delivery.eventId,
			delivery_id: String(delivery.id),
			delivery_status: "undeliverable",
		},
		now,
	);
	return 1;
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
	permissionProfile: String(row.permission_profile) as Subscription["permissionProfile"],
    leaseTtlMs: Number(row.lease_ttl_ms),
    deliveryTtlMs: Number(row.delivery_ttl_ms),
    homeGraceMs: Number(row.home_grace_ms),
    spawnRateLimit: Number(row.spawn_rate_limit),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    updatedAt: String(row.updated_at),
		bindingMode: String(row.binding_mode) as Subscription["bindingMode"],
		bindingSource: String(row.binding_source) as Subscription["bindingSource"],
		bindingRevision: Number(row.binding_revision),
		egressPolicy: String(row.egress_policy) as Subscription["egressPolicy"],
		egressChannelIds: JSON.parse(String(row.egress_channel_ids_json)) as string[],
  };
}

function livePresenceFromRow(row: Row): LivePresence {
	return {
		actor: String(row.actor),
		edgeId: String(row.edge_id),
		provider: String(row.provider) as LivePresence["provider"],
		providerSurface: String(row.provider_surface),
		providerVersion: String(row.provider_version),
		sessionId: row.session_id === null ? null : String(row.session_id),
		bindingRevision: Number(row.binding_revision),
		transport: String(row.transport) as LivePresence["transport"],
		ownerLoaded: row.owner_loaded === 1,
		reason: row.reason === null ? null : String(row.reason),
		updatedAt: String(row.updated_at),
		expiresAt: String(row.expires_at),
	};
}

function deliveryFromRow(row: Row): Delivery {
	const currentSubscription = subscriptionFromRow({
    ...row,
    actor: row.actor,
    updated_at: row.subscription_updated_at,
  });
	const subscription = row.subscription_snapshot_json === null
		? currentSubscription
		: JSON.parse(String(row.subscription_snapshot_json)) as Subscription;
	const event = slackEventFromRow(row);
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
		availableAt: row.available_at === null ? null : String(row.available_at),
		spawnedSessionId: row.spawned_session_id === null ? null : String(row.spawned_session_id),
		spawnedOnEdge: row.spawned_on_edge === null ? null : String(row.spawned_on_edge),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    subscription,
    event,
  };
}

function slackEventFromRow(row: Row): SlackEventInput {
	return {
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
}

function isExpired(value: string | null, now: Date): boolean {
  return value !== null && new Date(value).getTime() <= now.getTime();
}

function remainingDeliveryTtl(delivery: Pick<Delivery, "createdAt" | "subscription">, now: Date): number {
	return Math.max(
		0,
		new Date(delivery.createdAt).getTime() + delivery.subscription.deliveryTtlMs - now.getTime(),
	);
}

function expectsLivePresence(subscription: Subscription): boolean {
	return subscription.wakePolicy === "live_only"
		|| ["desktop-ipc", "codex-desktop-ipc", "claude-channel", "mcp-channel"]
			.includes(subscription.providerSurface);
}

function eligibilityDetail(code: string): string {
  const details: Record<string, string> = {
    workspace_not_mapped: "edge has no registered mapping for the subscription workspace",
    live_ingress_unavailable: "live_only subscription has no eligible live ingress",
    resume_target_missing: "resume subscription has no mapped provider session",
  };
  return details[code] ?? code;
}

function emptyDeliveryCounts(): Record<DeliveryStatus, number> {
	return Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0])) as Record<DeliveryStatus, number>;
}

function deliveryOperatorSummary(delivery: Delivery): DeliveryOperatorSummary {
	return {
		id: delivery.id,
		eventId: delivery.eventId,
		actor: delivery.actor,
		status: delivery.status,
		reasons: delivery.reasons.map((reason) => ({ code: safeOperatorCode(reason.code) })),
		leaseGeneration: delivery.leaseGeneration,
		claimedBy: delivery.claimedBy,
			attempts: delivery.attempts,
			availableAt: delivery.availableAt ?? null,
			binding: {
				sessionId: delivery.subscription.sessionId,
				revision: delivery.subscription.bindingRevision,
				providerSurface: delivery.subscription.providerSurface,
				providerVersion: delivery.subscription.providerVersion,
				permissionProfile: delivery.subscription.permissionProfile,
			},
			spawnedSessionId: delivery.spawnedSessionId ?? null,
			spawnedOnEdge: delivery.spawnedOnEdge ?? null,
		channelId: delivery.event.channelId,
		threadTs: delivery.event.threadTs,
		messageTs: delivery.event.messageTs,
		createdAt: delivery.createdAt,
		updatedAt: delivery.updatedAt,
	};
}

function deliveryOperatorSummaryFromRow(row: Row): DeliveryOperatorSummary {
	const snapshot = row.subscription_snapshot_json === null
		? null
		: JSON.parse(String(row.subscription_snapshot_json)) as Subscription;
	const reasons = JSON.parse(String(row.reasons_json)) as Reason[];
	const binding = snapshot === null
		? {
			sessionId: row.current_session_id === null ? null : String(row.current_session_id),
			revision: Number(row.current_binding_revision),
			providerSurface: String(row.current_provider_surface),
			providerVersion: String(row.current_provider_version),
			permissionProfile: String(row.current_permission_profile),
		}
		: {
			sessionId: snapshot.sessionId,
			revision: snapshot.bindingRevision,
			providerSurface: snapshot.providerSurface,
			providerVersion: snapshot.providerVersion,
			permissionProfile: snapshot.permissionProfile,
		};
	return {
		id: Number(row.delivery_id),
		eventId: String(row.event_id),
		actor: String(row.actor),
		status: String(row.status) as DeliveryStatus,
		reasons: reasons.map((reason) => ({ code: safeOperatorCode(reason.code) })),
		leaseGeneration: row.lease_generation === null ? null : Number(row.lease_generation),
		claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
		attempts: Number(row.attempts),
		availableAt: row.available_at === null ? null : String(row.available_at),
		binding,
		spawnedSessionId: row.spawned_session_id === null ? null : String(row.spawned_session_id),
		spawnedOnEdge: row.spawned_on_edge === null ? null : String(row.spawned_on_edge),
		channelId: String(row.channel_id),
		threadTs: String(row.thread_ts),
		messageTs: String(row.message_ts),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function safeOperatorCode(value: string): string {
	return SAFE_OPERATOR_CODES.has(value) ? value : "unclassified_reason";
}

const SAFE_OPERATOR_CODES = new Set([
	"ambiguous_delivery_requires_reconciliation",
	"auto_binding_stale_revision",
	"delivery_deadline_exceeded",
	"delivery_ttl_expired",
	"dispatch_outcome_unknown",
	"edge_restarted_during_dispatch",
	"home_edge_disabled",
	"home_edge_missing",
	"home_edge_stale",
	"live_binding_changed",
	"live_ingress_unavailable",
	"live_owner_not_loaded",
	"live_surface_stale_or_missing",
	"malformed_explicit_envelope",
	"no_active_subscription",
	"operator_reconciled_processed",
	"operator_reconciled_sent",
	"operator_requeued",
	"operator_marked_dead",
	"provider_adapter_missing",
	"provider_dispatch_unknown",
	"provider_surface_unsupported",
	"provider_unavailable",
	"resume_session_missing",
	"resume_target_missing",
	"slack_outbox_send_uncertain",
	"slack_permanent_rejection",
	"slack_platform_rejected",
	"slack_rate_limited",
	"slack_send_uncertain",
	"spawn_rate_limited",
	"spawn_session_unconfirmed",
	"subscription_expired",
	"workspace_not_mapped",
]);

function resultFingerprint(
	status: TerminalDeliveryStatus,
	reasons: Reason[],
	providerReceipt: string | null,
	spawnedSessionId: string | null,
): string {
	return createHash("sha256")
			.update(JSON.stringify({ status, reasons, providerReceipt, spawnedSessionId }))
		.digest("hex");
}

function outboxClaimFromRow(row: Row, claimToken: string, recovery: boolean): SlackOutboxClaim {
	return {
		id: Number(row.outbox_id),
		idempotencyKey: String(row.idempotency_key),
		kind: String(row.kind) as SlackOutboxClaim["kind"],
		channelId: String(row.channel_id),
		threadTs: String(row.thread_ts),
		text: String(row.text),
		metadata: JSON.parse(String(row.metadata_json)) as Record<string, string>,
		attempts: Number(row.attempts),
		claimToken,
		recovery,
	};
}

function outboxOperatorSummaryFromRow(row: Row): SlackOutboxOperatorSummary {
	const key = String(row.idempotency_key);
		const deliveryMatch = /^(?:completion|reconciliation|delivery-alert):(\d+)(?::|$)/.exec(key);
	return {
		id: Number(row.outbox_id),
		idempotencyKey: key,
		kind: String(row.kind) as SlackOutboxOperatorSummary["kind"],
		state: String(row.state) as SlackOutboxState,
		attempts: Number(row.attempts),
		channelId: String(row.channel_id),
		threadTs: String(row.thread_ts),
		deliveryId: deliveryMatch?.[1] ? Number(deliveryMatch[1]) : null,
		errorCode: row.error_code === null ? null : safeOperatorCode(String(row.error_code)),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function safeActorLabel(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "actor";
}
