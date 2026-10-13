import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { StaleLeaseError, type BrokerStore } from "../broker/store.js";
import { canonicalActor, isSlackMessageTs, type Subscription } from "../domain.js";
import type { Clock } from "../time.js";
import {
  canonicalInstant,
  validateInterventionPacket,
  type AttentionCommand,
  type AttentionContinuationTarget,
  type EventView,
  type InterventionPacket,
  type ItemRef,
  type ItemState,
  type ItemView,
  type QueuePage,
  type QueueStatus,
  type Receipt,
  type ReceiptResult,
  type ReturnGuard,
  type ReturnMode,
  type ReturnPhase,
  type ReturnRef,
  type ReturnView,
  type Selection,
  type SourceBindCommand,
  type SourceView,
  type TransportStatus,
} from "./contract.js";
import { decide, type ActCaller, type ItemAct } from "./reducer.js";
import { renderBrief } from "./render.js";
import { profileFingerprint } from "./route.js";
import { duePromotions, selectNext } from "./selector.js";

/**
 * The attention module's own schema generation, independent of the broker's
 * `PRAGMA user_version` (which stays at 5). A database written by a newer attention module
 * is refused at boot rather than guessed at.
 */
export const ATTENTION_STORE_VERSION = 1;
export const ATTENTION_PAGE_DEFAULT = 25;
export const ATTENTION_PAGE_MAX = 100;
/** Bounded drain batches (ADR-0004 §10). */
export const ATTENTION_RETURN_BATCH = 25;

export class AttentionSchemaError extends Error {}

/**
 * A refused attention command or read. Nothing a refusal touches is committed: it is thrown
 * inside the command transaction, which rolls back whole.
 */
export class AttentionRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    detail: string,
    readonly current: ItemRef | null = null,
  ) {
    super(detail);
    this.name = "AttentionRefusal";
  }
}

/** Who is acting, as the HTTP adapter authenticated it. Never read from a body. */
export type AttentionPrincipal =
  | { kind: "operator" }
  | { kind: "edge"; edgeId: string }
  | { kind: "source"; edgeId: string; sourceId: string };

export function principalKey(principal: AttentionPrincipal): string {
  switch (principal.kind) {
    case "operator": return "operator";
    case "edge": return `edge:${principal.edgeId}`;
    // The edge is part of the identity, so another edge presenting the same source id can
    // never be answered a replayed receipt.
    case "source": return `source:${principal.edgeId}/${principal.sourceId}`;
  }
}

function issuerEdge(principal: AttentionPrincipal): string | null {
  return principal.kind === "operator" ? null : principal.edgeId;
}

export interface CommandOutcome {
  status: 200 | 201;
  receipt: Receipt;
}

export interface AttentionStoreDeps {
  broker: BrokerStore;
  clock: Clock;
  humanId: string;
  enabled: boolean;
}

interface Row { [key: string]: unknown }

interface ItemRow {
  item_id: number;
  human_id: string;
  owner_principal: string;
  project_id: string;
  work_id: string;
  intervention_key: string;
  origin: "seat" | "human";
  source_id: string | null;
  state: ItemState;
  revision: number;
  packet_json: string;
  packet_hash: string;
  submitted_hash: string;
  ready_sequence: number | null;
  deferred_until: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  outcome: ItemView["outcome"];
  response: string | null;
  terminal_reason: string | null;
}

interface SourceRow {
  source_id: string;
  provenance: SourceView["provenance"];
  edge_id: string;
  issuer_principal: string;
  owner_principal: string;
  actor: string;
  provider: SourceView["provider"];
  project_id: string;
  work_id: string;
  return_mode: ReturnMode;
  session_id: string | null;
  session_absence: string | null;
  cwd: string | null;
  account_profile_fingerprint: string;
  source_delivery_id: number | null;
  source_generation: number | null;
  channel_id: string | null;
  thread_ts: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface ReturnRow {
  return_id: number;
  item_id: number;
  resolution_command_id: string;
  generation: number;
  source_id: string;
  mode: "pinned_session" | "actor_context";
  target_json: string;
  packet_revision: number;
  phase: ReturnPhase;
  reason: string | null;
  next_attempt_at: string | null;
  delivery_id: number | null;
  transport_status: TransportStatus | null;
  transport_json: string | null;
  created_at: string;
  updated_at: string;
}

const TERMINAL_TRANSPORT = new Set(["processed", "undeliverable", "failed"]);

export class AttentionStore {
  readonly db: Database.Database;
  private readonly broker: BrokerStore;
  private readonly clock: Clock;
  readonly humanId: string;
  enabled: boolean;

  constructor(deps: AttentionStoreDeps) {
    this.broker = deps.broker;
    this.db = deps.broker.db;
    this.clock = deps.clock;
    this.humanId = deps.humanId;
    this.enabled = deps.enabled;
    this.migrate();
  }

  get brokerUuid(): string {
    return this.broker.brokerUuid;
  }

  // ───────────────────────────── schema ─────────────────────────────

  private migrate(): void {
    const present = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_schema'").get();
    if (present) {
      const row = this.db.prepare("SELECT version FROM attention_schema WHERE singleton=1").get() as Row | undefined;
      const version = Number(row?.version ?? 0);
      if (version > ATTENTION_STORE_VERSION) {
        throw new AttentionSchemaError(
          `attention store schema ${version} is newer than this broker understands (${ATTENTION_STORE_VERSION}); `
          + "upgrade hive rather than run an older broker against it",
        );
      }
    }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS attention_schema (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          version INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attention_sources (
          source_id TEXT PRIMARY KEY CHECK(source_id GLOB 'src_*'),
          provenance TEXT NOT NULL CHECK(provenance IN ('dispatch', 'live_registration', 'operator_binding')),
          edge_id TEXT NOT NULL,
          issuer_principal TEXT NOT NULL,
          owner_principal TEXT NOT NULL,
          actor TEXT NOT NULL,
          provider TEXT NOT NULL,
          project_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          return_mode TEXT NOT NULL CHECK(return_mode IN ('pinned_session', 'actor_context', 'none')),
          session_id TEXT,
          session_absence TEXT,
          cwd TEXT,
          account_profile_fingerprint TEXT NOT NULL,
          source_delivery_id INTEGER,
          source_generation INTEGER,
          channel_id TEXT,
          thread_ts TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          revoked_reason TEXT,
          revoked_by TEXT,
          CHECK(return_mode != 'pinned_session' OR (session_id IS NOT NULL AND cwd IS NOT NULL)),
          CHECK(return_mode = 'none' OR (channel_id IS NOT NULL AND thread_ts IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS attention_sources_owner ON attention_sources(edge_id, actor);

        CREATE TABLE IF NOT EXISTS attention_items (
          item_id INTEGER PRIMARY KEY AUTOINCREMENT,
          human_id TEXT NOT NULL,
          owner_principal TEXT NOT NULL,
          project_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          intervention_key TEXT NOT NULL,
          origin TEXT NOT NULL CHECK(origin IN ('seat', 'human')),
          source_id TEXT REFERENCES attention_sources(source_id) ON DELETE RESTRICT,
          state TEXT NOT NULL CHECK(state IN ('queued', 'active', 'deferred', 'resolved', 'cancelled')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          packet_json TEXT NOT NULL,
          packet_hash TEXT NOT NULL,
          submitted_hash TEXT NOT NULL,
          ready_sequence INTEGER,
          deferred_until TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          claimed_at TEXT,
          resolved_at TEXT,
          outcome TEXT,
          response TEXT,
          terminal_reason TEXT,
          CHECK(state != 'queued' OR ready_sequence IS NOT NULL),
          CHECK(state != 'resolved' OR (outcome IS NOT NULL AND response IS NOT NULL))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS attention_one_active_per_human
          ON attention_items(human_id) WHERE state = 'active';
        CREATE UNIQUE INDEX IF NOT EXISTS attention_semantic_identity
          ON attention_items(human_id, owner_principal, project_id, work_id, intervention_key);
        CREATE INDEX IF NOT EXISTS attention_ready_order
          ON attention_items(human_id, state, ready_sequence, item_id);
        CREATE INDEX IF NOT EXISTS attention_deferred_due
          ON attention_items(human_id, state, deferred_until, item_id);
        CREATE INDEX IF NOT EXISTS attention_items_source ON attention_items(source_id);

        CREATE TABLE IF NOT EXISTS attention_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER REFERENCES attention_items(item_id) ON DELETE RESTRICT,
          source_id TEXT,
          command_id TEXT,
          principal TEXT NOT NULL,
          event_type TEXT NOT NULL,
          revision INTEGER,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS attention_events_item ON attention_events(item_id, event_id);

        CREATE TABLE IF NOT EXISTS attention_commands (
          command_id TEXT PRIMARY KEY,
          principal TEXT NOT NULL,
          issuer_edge TEXT,
          action TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          status INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attention_returns (
          return_id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL REFERENCES attention_items(item_id) ON DELETE RESTRICT,
          resolution_command_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          source_id TEXT NOT NULL REFERENCES attention_sources(source_id) ON DELETE RESTRICT,
          mode TEXT NOT NULL CHECK(mode IN ('pinned_session', 'actor_context')),
          target_json TEXT NOT NULL,
          packet_revision INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('pending', 'blocked', 'minted', 'processed', 'failed', 'superseded')),
          reason TEXT,
          next_attempt_at TEXT,
          delivery_id INTEGER,
          transport_status TEXT,
          transport_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(resolution_command_id, generation),
          CHECK(phase NOT IN ('minted', 'processed') OR delivery_id IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS attention_one_current_return
          ON attention_returns(item_id) WHERE phase != 'superseded';
        CREATE INDEX IF NOT EXISTS attention_returns_due ON attention_returns(phase, next_attempt_at, return_id);

        -- I11: history is never deleted, and a source's identity never changes.
        CREATE TRIGGER IF NOT EXISTS attention_events_immutable BEFORE UPDATE ON attention_events
        BEGIN SELECT RAISE(ABORT, 'attention_history_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS attention_events_kept BEFORE DELETE ON attention_events
        BEGIN SELECT RAISE(ABORT, 'attention_history_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS attention_commands_immutable BEFORE UPDATE ON attention_commands
        BEGIN SELECT RAISE(ABORT, 'attention_history_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS attention_commands_kept BEFORE DELETE ON attention_commands
        BEGIN SELECT RAISE(ABORT, 'attention_history_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS attention_items_kept BEFORE DELETE ON attention_items
        BEGIN SELECT RAISE(ABORT, 'attention_history_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS attention_returns_kept BEFORE DELETE ON attention_returns
        BEGIN SELECT RAISE(ABORT, 'attention_history_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS attention_sources_kept BEFORE DELETE ON attention_sources
        BEGIN SELECT RAISE(ABORT, 'attention_history_immutable'); END;
        CREATE TRIGGER IF NOT EXISTS attention_sources_immutable BEFORE UPDATE ON attention_sources
        WHEN OLD.revoked_at IS NOT NULL
          OR NEW.source_id IS NOT OLD.source_id OR NEW.provenance IS NOT OLD.provenance
          OR NEW.edge_id IS NOT OLD.edge_id OR NEW.issuer_principal IS NOT OLD.issuer_principal
          OR NEW.owner_principal IS NOT OLD.owner_principal OR NEW.actor IS NOT OLD.actor
          OR NEW.provider IS NOT OLD.provider OR NEW.project_id IS NOT OLD.project_id
          OR NEW.work_id IS NOT OLD.work_id OR NEW.return_mode IS NOT OLD.return_mode
          OR NEW.session_id IS NOT OLD.session_id OR NEW.session_absence IS NOT OLD.session_absence
          OR NEW.cwd IS NOT OLD.cwd OR NEW.account_profile_fingerprint IS NOT OLD.account_profile_fingerprint
          OR NEW.source_delivery_id IS NOT OLD.source_delivery_id OR NEW.source_generation IS NOT OLD.source_generation
          OR NEW.channel_id IS NOT OLD.channel_id OR NEW.thread_ts IS NOT OLD.thread_ts
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'attention_source_immutable'); END;
      `);
      this.db.prepare("INSERT OR IGNORE INTO attention_schema(singleton, version, created_at) VALUES (1, ?, ?)")
        .run(ATTENTION_STORE_VERSION, this.nowIso());
    // Immediate: a deferred migration that reads the schema and then writes cannot wait out a
    // concurrent writer (SQLITE_BUSY_SNAPSHOT); taking the write lock first lets the busy
    // timeout do its job.
    }).immediate();
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  // ───────────────────────────── commands ─────────────────────────────

  /**
   * One mutation, one `BEGIN IMMEDIATE` transaction holding the state change, its events and
   * the receipt (I03). An exact replay is answered first — before liveness, revision or route
   * checks — so a lost response is recovered even after the source was revoked or the item
   * moved on.
   */
  execute(principal: AttentionPrincipal, command: AttentionCommand): CommandOutcome {
    const normalized = normalizeCommand(command);
    const hash = contentHash(normalized);
    const run = this.db.transaction((): CommandOutcome => {
      const replay = this.replay(command.command_id, principal, hash);
      if (replay) return replay;
      if (!this.enabled) throw disabled();
      authorizeAction(principal, normalized.action);
      const now = this.clock.now();
      const outcome = this.apply(principal, normalized, now);
      this.recordCommand(principal, normalized, hash, outcome, now);
      return outcome;
    });
    return run.immediate();
  }

  /**
   * Source enrollment under the same UUID/receipt discipline. The edge supplied the evidence it
   * verified locally; this resolves it against the broker's own ledger and enrollment.
   */
  bindSource(caller: { edgeId: string; operator: boolean }, command: SourceBindCommand, options: { recoverOnly?: boolean } = {}): CommandOutcome {
    const principal: AttentionPrincipal = caller.operator ? { kind: "operator" } : { kind: "edge", edgeId: caller.edgeId };
    const hash = contentHash(command);
    const run = this.db.transaction((): CommandOutcome => {
      // The operator may recover any bind this same edge committed, its own or a seat's.
      const replay = options.recoverOnly === true && caller.operator
        ? this.recoverForOperator(command.command_id, caller.edgeId, hash)
        : this.replay(command.command_id, principal, hash);
      if (replay) return replay;
      // Recovery replays an edge's own retained evidence after the dispatch or registration it
      // came from has ended. That evidence is no longer live, so it may only find a committed
      // receipt — never enroll a new source.
      if (options.recoverOnly === true) {
        throw new AttentionRefusal(404, "bind_not_committed", `no committed source binding ${command.command_id} to recover`);
      }
      if (!this.enabled) throw disabled();
      const now = this.clock.now();
      const source = this.resolveBinding(caller, command, now);
      const nowIso = now.toISOString();
      this.db.prepare(`
        INSERT INTO attention_sources(
          source_id, provenance, edge_id, issuer_principal, owner_principal, actor, provider, project_id, work_id,
          return_mode, session_id, session_absence, cwd, account_profile_fingerprint, source_delivery_id,
          source_generation, channel_id, thread_ts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        source.source_id, source.provenance, source.edge_id, source.issuer_principal, source.owner_principal,
        source.actor, source.provider, source.project_id, source.work_id, source.return_mode, source.session_id,
        source.session_absence, source.cwd, source.account_profile_fingerprint, source.source_delivery_id,
        source.source_generation, source.channel_id, source.thread_ts, nowIso,
      );
      this.appendEvent({
        itemId: null, sourceId: source.source_id, commandId: command.command_id, principal: principalKey(principal),
        type: "source_bound", revision: null, payload: { provenance: source.provenance, actor: source.actor, return_mode: source.return_mode },
      });
      const view = this.sourceView(this.sourceRow(source.source_id)!);
      const outcome: CommandOutcome = {
        status: 201,
        receipt: this.receipt(command.command_id, "source_bind", "source_bound", now, { source: view }),
      };
      this.db.prepare(`
        INSERT INTO attention_commands(command_id, principal, issuer_edge, action, payload_hash, status, receipt_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(command.command_id, principalKey(principal), caller.edgeId, "source_bind", hash, outcome.status, JSON.stringify(outcome.receipt), nowIso);
      return outcome;
    });
    return run.immediate();
  }

  private replay(commandId: string, principal: AttentionPrincipal, hash: string): CommandOutcome | null {
    const prior = this.db.prepare("SELECT principal, payload_hash, status, receipt_json FROM attention_commands WHERE command_id=?")
      .get(commandId) as Row | undefined;
    if (!prior) return null;
    if (prior.principal !== principalKey(principal) || prior.payload_hash !== hash) {
      throw new AttentionRefusal(409, "command_id_conflict", `command ${commandId} was already committed with different content or by a different principal`);
    }
    const receipt = JSON.parse(String(prior.receipt_json)) as Receipt;
    return { status: Number(prior.status) as 200 | 201, receipt: { ...receipt, replayed: true } };
  }

  private recoverForOperator(commandId: string, edgeId: string, hash: string): CommandOutcome | null {
    const prior = this.db.prepare("SELECT principal, issuer_edge, payload_hash, status, receipt_json FROM attention_commands WHERE command_id=?")
      .get(commandId) as Row | undefined;
    if (!prior) return null;
    const ownEdge = prior.issuer_edge === edgeId && (prior.principal === "operator" || prior.principal === `edge:${edgeId}`);
    if (!ownEdge || prior.payload_hash !== hash) {
      throw new AttentionRefusal(409, "command_id_conflict", `command ${commandId} was already committed with different content or on another edge`);
    }
    const receipt = JSON.parse(String(prior.receipt_json)) as Receipt;
    return { status: Number(prior.status) as 200 | 201, receipt: { ...receipt, replayed: true } };
  }

  private recordCommand(principal: AttentionPrincipal, command: AttentionCommand, hash: string, outcome: CommandOutcome, now: Date): void {
    this.db.prepare(`
      INSERT INTO attention_commands(command_id, principal, issuer_edge, action, payload_hash, status, receipt_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(command.command_id, principalKey(principal), issuerEdge(principal), command.action, hash, outcome.status, JSON.stringify(outcome.receipt), now.toISOString());
  }

  private apply(principal: AttentionPrincipal, command: AttentionCommand, now: Date): CommandOutcome {
    switch (command.action) {
      case "summon": return this.summon(principal as Extract<AttentionPrincipal, { kind: "source" }>, command.command_id, command.payload, now);
      case "add": return this.addHuman(command.command_id, "add", command.payload.packet, command.payload.return_source_id, now);
      case "start": return this.addHuman(command.command_id, "start", command.payload.packet, command.payload.return_source_id, now);
      case "amend": return this.amend(principal, command.command_id, command.payload, now);
      case "withdraw": return this.itemAct(principal, command.command_id, "withdraw", command.payload, { kind: "withdraw" }, now, { reason: command.payload.reason });
      case "next": return this.next(command.command_id, command.payload.human_id, command.payload.item_id, now);
      case "resolve": return this.resolve(command.command_id, command.payload, now);
      case "defer": return this.itemAct(principal, command.command_id, "defer", command.payload,
        { kind: "defer", until: command.payload.until, now: now.toISOString() }, now,
        { reason: command.payload.reason, until: command.payload.until }, command.payload.select_next);
      case "requeue": return this.itemAct(principal, command.command_id, "requeue", command.payload, { kind: "requeue" }, now, { reason: command.payload.reason });
      case "cancel": return this.itemAct(principal, command.command_id, "cancel", command.payload, { kind: "cancel" }, now,
        { reason: command.payload.reason }, command.payload.select_next);
      case "retry_return": return this.retryReturn(command.command_id, command.payload, null, now);
      case "reroute_return": return this.retryReturn(command.command_id, command.payload, { sourceId: command.payload.source_id, reason: command.payload.reason }, now);
      case "source_revoke": return this.revokeSource(command.command_id, command.payload.source_id, command.payload.reason, now);
    }
  }

  private summon(principal: Extract<AttentionPrincipal, { kind: "source" }>, commandId: string, packet: InterventionPacket, now: Date): CommandOutcome {
    const source = this.writableSource(principal);
    if (packet.project_id !== source.project_id || packet.work_id !== source.work_id) {
      throw new AttentionRefusal(403, "source_scope_mismatch",
        `this source is bound to ${source.project_id}/${source.work_id}; the packet names ${packet.project_id}/${packet.work_id}`);
    }
    return this.create(commandId, "summon", packet, { owner: source.owner_principal, origin: "seat", sourceId: source.source_id, startActive: false }, now);
  }

  private addHuman(commandId: string, action: "add" | "start", packet: InterventionPacket, returnSourceId: string | null, now: Date): CommandOutcome {
    if (returnSourceId !== null) {
      const source = this.sourceRow(returnSourceId);
      if (!source) throw new AttentionRefusal(404, "source_not_found", `no attention source ${returnSourceId}`);
      if (source.revoked_at !== null) throw new AttentionRefusal(403, "source_revoked", `source ${returnSourceId} was revoked`);
      if (source.project_id !== packet.project_id || source.work_id !== packet.work_id) {
        throw new AttentionRefusal(403, "source_scope_mismatch", `return source is bound to ${source.project_id}/${source.work_id}`);
      }
      // A return source is where the response goes; one that returns nowhere would
      // silently swallow it.
      if (source.return_mode === "none") throw new AttentionRefusal(422, "source_has_no_return", `source ${returnSourceId} has return mode none`);
    }
    return this.create(commandId, action, packet, {
      owner: `human:${packet.human_id}`, origin: "human", sourceId: returnSourceId, startActive: action === "start",
    }, now);
  }

  private create(
    commandId: string,
    action: "summon" | "add" | "start",
    packet: InterventionPacket,
    origin: { owner: string; origin: "seat" | "human"; sourceId: string | null; startActive: boolean },
    now: Date,
  ): CommandOutcome {
    this.assertHuman(packet.human_id);
    const hash = contentHash(packet);
    const existing = this.db.prepare(`
      SELECT * FROM attention_items
      WHERE human_id=? AND owner_principal=? AND project_id=? AND work_id=? AND intervention_key=?
    `).get(packet.human_id, origin.owner, packet.project_id, packet.work_id, packet.intervention_key) as ItemRow | undefined;
    if (existing) {
      // I04/F08: the same round, notified again, is the same item — in any state, never reopened.
      if (existing.packet_hash === hash || existing.submitted_hash === hash) {
        return { status: 200, receipt: this.receipt(commandId, action, "existing", now, { item: itemRef(existing), active: this.activeRef(packet.human_id) }) };
      }
      throw new AttentionRefusal(409, "item_exists_use_amend",
        `${packet.project_id}/${packet.work_id}/${packet.intervention_key} already exists as item ${existing.item_id} with different content; amend it, or use a new intervention key for a new round`,
        itemRef(existing));
    }
    if (packet.predecessor_item_id !== null) {
      const predecessor = this.db.prepare("SELECT item_id FROM attention_items WHERE item_id=?").get(packet.predecessor_item_id);
      if (!predecessor) throw new AttentionRefusal(422, "unknown_predecessor", `predecessor item ${packet.predecessor_item_id} does not exist`);
    }
    const nowIso = now.toISOString();
    if (origin.startActive) {
      const active = this.activeRow(packet.human_id);
      if (active) {
        throw new AttentionRefusal(409, "active_item_exists",
          `item ${active.item_id} is active; resolve, defer or cancel it before starting new work`, itemRef(active));
      }
    }
    const inserted = this.db.prepare(`
      INSERT INTO attention_items(
        human_id, owner_principal, project_id, work_id, intervention_key, origin, source_id, state, revision,
        packet_json, packet_hash, submitted_hash, ready_sequence, created_at, updated_at, claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      packet.human_id, origin.owner, packet.project_id, packet.work_id, packet.intervention_key, origin.origin,
      origin.sourceId, origin.startActive ? "active" : "queued", JSON.stringify(packet), hash, hash,
      origin.startActive ? null : 0, nowIso, nowIso, origin.startActive ? nowIso : null,
    );
    const itemId = Number(inserted.lastInsertRowid);
    const eventId = this.appendEvent({
      itemId, sourceId: origin.sourceId, commandId, principal: origin.origin === "seat" ? `source:${origin.sourceId}` : "operator",
      type: action === "summon" ? "summoned" : action === "start" ? "started" : "added", revision: 1,
      payload: { kind: packet.kind, project_id: packet.project_id, work_id: packet.work_id, intervention_key: packet.intervention_key },
    });
    if (!origin.startActive) this.markReady(itemId, eventId);
    const row = this.itemRow(itemId)!;
    const result: ReceiptResult = origin.startActive ? "started" : "created";
    return { status: 201, receipt: this.receipt(commandId, action, result, now, { item: itemRef(row), active: this.activeRef(packet.human_id) }) };
  }

  private amend(principal: AttentionPrincipal, commandId: string, payload: Extract<AttentionCommand, { action: "amend" }>["payload"], now: Date): CommandOutcome {
    const item = this.requireItem(payload.item_id);
    const caller = this.actCaller(principal);
    const decision = decide(itemFacts(item), { kind: "amend" }, caller, payload.expected_revision);
    if (!decision.ok) throw new AttentionRefusal(decision.status, decision.error, decision.detail, itemRef(item));
    const packet = { ...(JSON.parse(item.packet_json) as InterventionPacket), ...payload.fields };
    const valid = validateInterventionPacket(packet);
    if (!valid.ok) throw new AttentionRefusal(422, "schema_rejected", valid.detail);
    const revision = item.revision + 1;
    this.db.prepare(`
      UPDATE attention_items SET packet_json=?, packet_hash=?, revision=?, updated_at=? WHERE item_id=? AND revision=?
    `).run(JSON.stringify(packet), contentHash(packet), revision, now.toISOString(), item.item_id, item.revision);
    // Amendments never touch ready_sequence (F08): the item keeps its place.
    this.appendEvent({
      itemId: item.item_id, sourceId: item.source_id, commandId, principal: principalKey(principal), type: "amended",
      revision, payload: { fields: Object.keys(payload.fields).sort() },
    });
    const row = this.itemRow(item.item_id)!;
    return { status: 200, receipt: this.receipt(commandId, "amend", "amended", now, { item: itemRef(row), active: this.activeRef(item.human_id) }) };
  }

  /** withdraw / defer / requeue / cancel: decide, apply, and optionally select the next item in the same transaction. */
  private itemAct(
    principal: AttentionPrincipal,
    commandId: string,
    action: "withdraw" | "defer" | "requeue" | "cancel",
    payload: { item_id: number; expected_revision: number },
    act: ItemAct,
    now: Date,
    detail: Record<string, unknown>,
    selectAfter = false,
  ): CommandOutcome {
    const item = this.requireItem(payload.item_id);
    if (principal.kind === "source") this.writableSource(principal);
    const decision = decide(itemFacts(item), act, this.actCaller(principal), payload.expected_revision);
    if (!decision.ok) throw new AttentionRefusal(decision.status, decision.error, decision.detail, itemRef(item));
    const nowIso = now.toISOString();
    const revision = item.revision + 1;
    const reason = typeof detail.reason === "string" ? detail.reason : null;
    if (decision.to === "deferred") {
      this.db.prepare(`
        UPDATE attention_items SET state='deferred', deferred_until=?, revision=?, updated_at=?, terminal_reason=? WHERE item_id=? AND revision=?
      `).run(act.kind === "defer" ? act.until : null, revision, nowIso, reason, item.item_id, item.revision);
    } else if (decision.to === "cancelled") {
      this.db.prepare(`
        UPDATE attention_items SET state='cancelled', revision=?, updated_at=?, terminal_reason=? WHERE item_id=? AND revision=?
      `).run(revision, nowIso, reason, item.item_id, item.revision);
    } else {
      this.db.prepare(`
        UPDATE attention_items SET state='queued', deferred_until=NULL, revision=?, updated_at=?, terminal_reason=NULL WHERE item_id=? AND revision=?
      `).run(revision, nowIso, item.item_id, item.revision);
    }
    const eventId = this.appendEvent({
      itemId: item.item_id, sourceId: item.source_id, commandId, principal: principalKey(principal), type: decision.event, revision, payload: detail,
    });
    if (decision.to === "queued") this.markReady(item.item_id, eventId);
    const result: ReceiptResult = action === "withdraw" ? "withdrawn" : action === "defer" ? "deferred" : action === "requeue" ? "requeued" : "cancelled";
    const selection = selectAfter ? this.select(item.human_id, null, commandId, now).selection : null;
    const row = this.itemRow(item.item_id)!;
    return { status: 200, receipt: this.receipt(commandId, action, result, now, { item: itemRef(row), active: this.activeRef(item.human_id), selection }) };
  }

  private next(commandId: string, humanId: string, pick: number | null, now: Date): CommandOutcome {
    this.assertHuman(humanId);
    const { selection, claimed } = this.select(humanId, pick, commandId, now);
    const result: ReceiptResult = selection.selection_reason === "already_active"
      ? "already_active"
      : selection.selection_reason === "empty" ? "empty" : "claimed";
    const item = claimed ?? (selection.item === null ? null : refOfView(selection.item));
    return { status: 200, receipt: this.receipt(commandId, "next", result, now, { item, active: this.activeRef(humanId), selection }) };
  }

  private resolve(commandId: string, payload: Extract<AttentionCommand, { action: "resolve" }>["payload"], now: Date): CommandOutcome {
    const item = this.requireItem(payload.item_id);
    const decision = decide(itemFacts(item), { kind: "resolve" }, { kind: "operator" }, payload.expected_revision);
    // I05 + §9: a stale combined resolve commits neither the resolution nor the next selection.
    if (!decision.ok) throw new AttentionRefusal(decision.status, decision.error, decision.detail, itemRef(item));
    const nowIso = now.toISOString();
    const revision = item.revision + 1;
    this.db.prepare(`
      UPDATE attention_items SET state='resolved', outcome=?, response=?, revision=?, resolved_at=?, updated_at=? WHERE item_id=? AND revision=?
    `).run(payload.outcome, payload.response, revision, nowIso, nowIso, item.item_id, item.revision);
    this.appendEvent({
      itemId: item.item_id, sourceId: item.source_id, commandId, principal: "operator", type: "resolved", revision,
      payload: { outcome: payload.outcome, response_chars: payload.response.length },
    });
    // I06: the return intent commits with the resolution, or neither does.
    let returnEffect: ReturnRef | null = null;
    const source = item.source_id === null ? null : this.sourceRow(item.source_id);
    if (source && source.return_mode !== "none") {
      returnEffect = this.insertReturn(item.item_id, commandId, 1, source, revision, now);
    }
    const selection = payload.select_next ? this.select(item.human_id, null, commandId, now).selection : null;
    const row = this.itemRow(item.item_id)!;
    return {
      status: 200,
      receipt: this.receipt(commandId, "resolve", "resolved", now, { item: itemRef(row), active: this.activeRef(item.human_id), selection, returnEffect }),
    };
  }

  private retryReturn(
    commandId: string,
    payload: { item_id: number; expected_revision: number; return_generation: number },
    reroute: { sourceId: string; reason: string } | null,
    now: Date,
  ): CommandOutcome {
    const action = reroute === null ? "retry_return" : "reroute_return";
    const item = this.requireItem(payload.item_id);
    if (payload.expected_revision !== item.revision) {
      throw new AttentionRefusal(409, "revision_conflict", `expected revision ${payload.expected_revision}, item is at ${item.revision}`, itemRef(item));
    }
    let current = this.currentReturn(item.item_id);
    if (item.state !== "resolved" || current === null) {
      throw new AttentionRefusal(404, "return_not_found", `item ${item.item_id} has no return effect`);
    }
    if (current.generation !== payload.return_generation) {
      throw new AttentionRefusal(409, "return_generation_conflict",
        `expected return generation ${payload.return_generation}, current is ${current.generation} (${current.phase}); re-read before deciding`);
    }
    // A minted return whose transport already ended is settled first, so the decision below
    // sees its real outcome and never mints behind a still-running delivery.
    if (current.phase === "minted") {
      this.settleIfTerminal(current, now);
      current = this.currentReturn(item.item_id)!;
    }
    if (current.phase === "processed") {
      throw new AttentionRefusal(409, "return_already_processed", `return generation ${current.generation} was already processed; it is never resent`);
    }
    if (current.phase === "minted") {
      if (reroute !== null) {
        throw new AttentionRefusal(409, "return_in_flight", `delivery ${current.delivery_id} is still in flight; a running provider turn cannot be retracted`);
      }
      return { status: 200, receipt: this.receipt(commandId, action, "return_in_flight", now, { item: itemRef(item), returnEffect: returnRef(current) }) };
    }
    if (reroute === null && (current.phase === "pending" || current.phase === "blocked")) {
      this.db.prepare("UPDATE attention_returns SET phase='pending', next_attempt_at=?, updated_at=? WHERE return_id=?")
        .run(now.toISOString(), now.toISOString(), current.return_id);
      this.appendEvent({ itemId: item.item_id, sourceId: current.source_id, commandId, principal: "operator", type: "return_retry_scheduled", revision: null, payload: { generation: current.generation } });
      return { status: 200, receipt: this.receipt(commandId, action, "return_retry_scheduled", now, { item: itemRef(item), returnEffect: returnRef(this.currentReturn(item.item_id)!) }) };
    }
    let source: SourceRow;
    if (reroute === null) {
      source = this.sourceRow(current.source_id)!;
    } else {
      const next = this.sourceRow(reroute.sourceId);
      if (!next) throw new AttentionRefusal(404, "source_not_found", `no attention source ${reroute.sourceId}`);
      if (next.revoked_at !== null) throw new AttentionRefusal(403, "source_revoked", `source ${reroute.sourceId} was revoked`);
      if (next.return_mode === "none") throw new AttentionRefusal(422, "source_has_no_return", `source ${reroute.sourceId} has return mode none`);
      // A reroute moves the return to another seat or session for the SAME work, never into
      // another work context: the add path's scope rule holds here too.
      if (next.project_id !== item.project_id || next.work_id !== item.work_id) {
        throw new AttentionRefusal(403, "source_scope_mismatch",
          `source ${reroute.sourceId} is bound to ${next.project_id}/${next.work_id}, not ${item.project_id}/${item.work_id}; bind a source for this work on the target seat`);
      }
      source = next;
    }
    this.db.prepare("UPDATE attention_returns SET phase='superseded', updated_at=? WHERE return_id=?").run(now.toISOString(), current.return_id);
    this.appendEvent({
      itemId: item.item_id, sourceId: current.source_id, commandId, principal: "operator", type: "return_superseded", revision: null,
      payload: { generation: current.generation, previous_phase: current.phase, ...(reroute ? { reason: reroute.reason, to_source: source.source_id } : {}) },
    });
    const effect = this.insertReturn(item.item_id, current.resolution_command_id, current.generation + 1, source, current.packet_revision, now);
    return {
      status: 200,
      receipt: this.receipt(commandId, action, reroute === null ? "return_retried" : "return_rerouted", now, { item: itemRef(item), returnEffect: effect }),
    };
  }

  private revokeSource(commandId: string, sourceId: string, reason: string, now: Date): CommandOutcome {
    const source = this.sourceRow(sourceId);
    if (!source) throw new AttentionRefusal(404, "source_not_found", `no attention source ${sourceId}`);
    if (source.revoked_at === null) {
      this.db.prepare("UPDATE attention_sources SET revoked_at=?, revoked_reason=?, revoked_by='operator' WHERE source_id=?")
        .run(now.toISOString(), reason, sourceId);
      this.appendEvent({ itemId: null, sourceId, commandId, principal: "operator", type: "source_revoked", revision: null, payload: { reason } });
    }
    return { status: 200, receipt: this.receipt(commandId, "source_revoke", "source_revoked", now, { source: this.sourceView(this.sourceRow(sourceId)!) }) };
  }

  // ───────────────────────────── selection ─────────────────────────────

  /**
   * Promote due deferrals, then claim per FIFO-1 or the explicit pick — unless an item is
   * already active, which is returned instead (F04: a second `next` never discards context).
   */
  private select(humanId: string, pick: number | null, commandId: string, now: Date): { selection: Selection; claimed: ItemRef | null } {
    this.promoteDue(humanId, commandId, now);
    const active = this.activeRow(humanId);
    if (active) return { selection: this.selectionFor(active, "already_active", now), claimed: null };
    const eligible = (this.db.prepare(`
      SELECT item_id, ready_sequence FROM attention_items WHERE human_id=? AND state='queued'
    `).all(humanId) as Array<{ item_id: number; ready_sequence: number }>)
      .map((row) => ({ itemId: row.item_id, readySequence: row.ready_sequence }));
    const decision = selectNext(eligible, pick);
    if (decision.kind === "not_eligible") {
      const target = this.itemRow(decision.itemId);
      if (!target || target.human_id !== humanId) throw new AttentionRefusal(404, "item_not_found", `no attention item ${decision.itemId} for ${humanId}`);
      throw new AttentionRefusal(409, "item_not_eligible",
        target.state === "deferred"
          ? `item ${target.item_id} is deferred; requeue it before selecting it`
          : `item ${target.item_id} is ${target.state}, not queued`,
        itemRef(target));
    }
    if (decision.kind === "empty") return { selection: this.emptySelection(humanId), claimed: null };
    const item = this.itemRow(decision.itemId)!;
    const claim = decide(itemFacts(item), { kind: "claim" }, { kind: "operator" }, item.revision);
    if (!claim.ok) throw new AttentionRefusal(claim.status, claim.error, claim.detail, itemRef(item));
    const nowIso = now.toISOString();
    const revision = item.revision + 1;
    this.db.prepare(`
      UPDATE attention_items SET state='active', revision=?, claimed_at=?, updated_at=? WHERE item_id=? AND state='queued' AND revision=?
    `).run(revision, nowIso, nowIso, item.item_id, item.revision);
    this.appendEvent({
      itemId: item.item_id, sourceId: item.source_id, commandId, principal: "operator", type: "claimed", revision,
      payload: { selection_reason: decision.reason },
    });
    const claimed = this.itemRow(item.item_id)!;
    return { selection: this.selectionFor(claimed, decision.reason, now), claimed: itemRef(claimed) };
  }

  private promoteDue(humanId: string, commandId: string, now: Date): void {
    const deferred = (this.db.prepare(`
      SELECT item_id, deferred_until FROM attention_items WHERE human_id=? AND state='deferred' AND deferred_until IS NOT NULL
    `).all(humanId) as Array<{ item_id: number; deferred_until: string }>)
      .map((row) => ({ itemId: row.item_id, deferredUntil: row.deferred_until }));
    for (const due of duePromotions(deferred, now)) {
      const item = this.itemRow(due.itemId)!;
      const revision = item.revision + 1;
      this.db.prepare(`
        UPDATE attention_items SET state='queued', deferred_until=NULL, revision=?, updated_at=? WHERE item_id=? AND state='deferred'
      `).run(revision, now.toISOString(), item.item_id);
      const eventId = this.appendEvent({
        itemId: item.item_id, sourceId: item.source_id, commandId, principal: "system:clock", type: "promoted", revision,
        payload: { deferred_until: due.deferredUntil },
      });
      this.markReady(item.item_id, eventId);
    }
  }

  private selectionFor(item: ItemRow, reason: Selection["selection_reason"], now: Date): Selection {
    const counts = this.deferredCounts(item.human_id);
    const eligible = this.eligibleCount(item.human_id);
    const view = this.view(item, now);
    return {
      selection_reason: reason,
      item: view,
      brief: renderBrief(view, now, eligible),
      eligible_count: eligible,
      deferred_count: counts.count,
      next_deferred_at: counts.next,
    };
  }

  private emptySelection(humanId: string): Selection {
    const counts = this.deferredCounts(humanId);
    return { selection_reason: "empty", item: null, brief: null, eligible_count: 0, deferred_count: counts.count, next_deferred_at: counts.next };
  }

  /**
   * Still-deferred items. A deferral whose time has come is promoted only by the next `next`,
   * but it is already eligible: the counts say so without a read writing promotion events.
   */
  private deferredCounts(humanId: string): { count: number; next: string | null } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MIN(deferred_until) AS next FROM attention_items
      WHERE human_id=? AND state='deferred' AND (deferred_until IS NULL OR deferred_until > ?)
    `).get(humanId, this.nowIso()) as Row;
    return { count: Number(row.count), next: row.next === null ? null : String(row.next) };
  }

  private eligibleCount(humanId: string): number {
    return Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM attention_items
      WHERE human_id=? AND (state='queued' OR (state='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ?))
    `).get(humanId, this.nowIso()) as Row).count);
  }

  // ───────────────────────────── sources ─────────────────────────────

  private resolveBinding(caller: { edgeId: string; operator: boolean }, command: SourceBindCommand, now: Date): SourceRow {
    const payload = command.payload;
    const evidence = payload.evidence;
    let actor: string;
    let subscription: Subscription;
    let session: { id: string | null; absence: string | null };
    let cwd: string | null;
    let delivery: { id: number; generation: number } | null = null;
    let thread = payload.thread === null ? null : { channel: payload.thread.channel_id, ts: payload.thread.thread_ts };

    if (evidence.kind === "dispatch") {
      try {
        this.broker.assertLease(evidence.source_delivery_id, caller.edgeId, evidence.generation);
      } catch (error) {
        if (error instanceof StaleLeaseError) {
          throw new AttentionRefusal(403, "source_evidence_rejected",
            `delivery ${evidence.source_delivery_id} is not held by this edge at generation ${evidence.generation}; bind while the dispatch is running`);
        }
        throw error;
      }
      const source = this.broker.getDelivery(evidence.source_delivery_id);
      actor = source.actor;
      subscription = this.requireSubscription(actor);
      delivery = { id: source.id, generation: evidence.generation };
      if (thread === null && payload.return_mode !== "none" && isSlackMessageTs(source.event.threadTs)) {
        thread = { channel: source.event.channelId, ts: source.event.threadTs };
      }
      cwd = evidence.cwd;
      if (evidence.route === "pinned_resume") {
        // An exact-session attention return resumed a captured session, which need not be the
        // actor's enrolled one; the delivery's own broker-written target is the authority.
        const target = source.continuationTarget;
        if (target === null || target.mode !== "pinned_session" || target.pinned.session_id !== evidence.session_id) {
          throw new AttentionRefusal(403, "source_evidence_rejected", "pinned-resume evidence does not match the delivery's captured session");
        }
        session = { id: target.pinned.session_id, absence: null };
      } else if (evidence.route === "resume") {
        // The broker's own enrollment names the resumed session; the edge's evidence must agree.
        if (subscription.sessionId === null || evidence.session_id !== subscription.sessionId) {
          throw new AttentionRefusal(403, "source_evidence_rejected", "resume evidence does not match the actor's enrolled session");
        }
        session = { id: subscription.sessionId, absence: null };
      } else if (evidence.route === "live") {
        session = evidence.session_id === null ? { id: null, absence: "live_session_unreported" } : { id: evidence.session_id, absence: null };
      } else {
        session = { id: null, absence: "spawned_session_not_captured" };
      }
    } else if (evidence.kind === "live_registration") {
      actor = canonicalActor(evidence.actor);
      subscription = this.requireSubscription(actor);
      if (evidence.provider !== subscription.provider) {
        throw new AttentionRefusal(403, "source_evidence_rejected", `${actor} is enrolled on ${subscription.provider}, not ${evidence.provider}`);
      }
      if (caller.edgeId !== subscription.homeEdge) {
        throw new AttentionRefusal(403, "source_evidence_rejected", `${actor}'s live sessions run on its home edge ${subscription.homeEdge}, not ${caller.edgeId}`);
      }
      session = { id: evidence.session_id, absence: null };
      cwd = evidence.cwd;
    } else {
      if (!caller.operator) throw new AttentionRefusal(403, "operator_required", "an operator binding needs the operator credential");
      actor = canonicalActor(evidence.actor);
      subscription = this.requireSubscription(actor);
      if (!subscription.edgeWorkspaces.some((workspace) => workspace.edgeId === caller.edgeId)) {
        throw new AttentionRefusal(403, "edge_not_mapped", `${actor} has no workspace on edge ${caller.edgeId}; run the binding on the source edge`);
      }
      // A live-registry verification counts only through the provider the actor is enrolled
      // on: another provider's registration (a seat mid-migration) never vouches for a session
      // that would then be resumed under this one.
      if (evidence.session_verified === "live_registry" && evidence.provider !== subscription.provider) {
        throw new AttentionRefusal(403, "source_evidence_rejected",
          `${actor} is enrolled on ${subscription.provider}; session ${String(evidence.session_id)} was verified by a ${String(evidence.provider)} registration`);
      }
      cwd = evidence.cwd;
      const verified = evidence.session_id !== null && (
        evidence.session_verified === "live_registry"
        || (subscription.sessionId === evidence.session_id && caller.edgeId === subscription.homeEdge)
      );
      session = evidence.session_id === null
        ? { id: null, absence: "no_session_named" }
        : verified ? { id: evidence.session_id, absence: null } : { id: null, absence: "session_unverified" };
    }

    if (payload.return_mode === "pinned_session") {
      const missing = session.id === null
        ? `no verified session (${session.absence})`
        : cwd === null ? "no observed cwd"
        : caller.edgeId !== subscription.homeEdge ? `edge ${caller.edgeId} is not ${actor}'s home edge`
        : subscription.turnSlots > 1 ? `${actor} runs ${subscription.turnSlots} turn slots`
        : null;
      if (missing !== null) {
        throw new AttentionRefusal(422, "pinned_unavailable", `exact-session return is unavailable: ${missing}; bind with --return actor-context`);
      }
    }
    if (payload.return_mode !== "none" && thread === null) {
      throw new AttentionRefusal(422, "thread_required", "a returning source needs a real Slack channel/thread for traceability; supply --channel and --thread");
    }
    return {
      source_id: `src_${randomUUID().replaceAll("-", "")}`,
      provenance: evidence.kind,
      edge_id: caller.edgeId,
      issuer_principal: caller.operator ? "operator" : `edge:${caller.edgeId}`,
      owner_principal: `seat:${actor}`,
      actor,
      provider: subscription.provider,
      project_id: payload.project_id,
      work_id: payload.work_id,
      return_mode: payload.return_mode,
      session_id: session.id,
      session_absence: session.absence,
      cwd,
      account_profile_fingerprint: profileFingerprint(subscription),
      source_delivery_id: delivery?.id ?? null,
      source_generation: delivery?.generation ?? null,
      channel_id: payload.return_mode === "none" ? null : thread!.channel,
      thread_ts: payload.return_mode === "none" ? null : thread!.ts,
      created_at: now.toISOString(),
      revoked_at: null,
      revoked_reason: null,
    };
  }

  private requireSubscription(actor: string): Subscription {
    const subscription = this.broker.getSubscription(actor);
    if (!subscription) throw new AttentionRefusal(403, "actor_not_enrolled", `${actor} has no Hive subscription; only enrolled seats can bind`);
    return subscription;
  }

  /** A fresh source write: this edge's own, unrevoked source. */
  private writableSource(principal: Extract<AttentionPrincipal, { kind: "source" }>): SourceRow {
    const source = this.sourceRow(principal.sourceId);
    if (!source) throw new AttentionRefusal(404, "source_not_found", `no attention source ${principal.sourceId}`);
    if (source.edge_id !== principal.edgeId) throw new AttentionRefusal(403, "source_foreign_edge", "this source belongs to a different edge");
    if (source.revoked_at !== null) throw new AttentionRefusal(403, "source_revoked", `source was revoked: ${source.revoked_reason ?? "no reason"}`);
    return source;
  }

  private actCaller(principal: AttentionPrincipal): ActCaller {
    if (principal.kind === "operator") return { kind: "operator" };
    if (principal.kind === "edge") throw new AttentionRefusal(403, "source_required", "a seat mutation presents its source binding");
    const source = this.writableSource(principal);
    return { kind: "source", sourceId: source.source_id, ownerPrincipal: source.owner_principal };
  }

  sourceRow(sourceId: string): SourceRow | null {
    return (this.db.prepare("SELECT * FROM attention_sources WHERE source_id=?").get(sourceId) as SourceRow | undefined) ?? null;
  }

  source(sourceId: string): SourceView | null {
    const row = this.sourceRow(sourceId);
    return row === null ? null : this.sourceView(row);
  }

  sources(): SourceView[] {
    return (this.db.prepare("SELECT * FROM attention_sources ORDER BY created_at, source_id").all() as SourceRow[]).map((row) => this.sourceView(row));
  }

  sourceView(row: SourceRow): SourceView {
    return {
      source_id: row.source_id,
      provenance: row.provenance,
      edge_id: row.edge_id,
      issuer_principal: row.issuer_principal,
      owner_principal: row.owner_principal,
      actor: row.actor,
      provider: row.provider,
      project_id: row.project_id,
      work_id: row.work_id,
      return_mode: row.return_mode,
      session_id: row.session_id,
      session_absence: row.session_absence,
      cwd: row.cwd,
      account_profile_fingerprint: row.account_profile_fingerprint,
      source_delivery_id: row.source_delivery_id,
      thread: row.channel_id === null || row.thread_ts === null ? null : { channel_id: row.channel_id, thread_ts: row.thread_ts },
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      revoked_reason: row.revoked_reason,
    };
  }

  // ───────────────────────────── returns ─────────────────────────────

  private insertReturn(itemId: number, resolutionCommandId: string, generation: number, source: SourceRow, packetRevision: number, now: Date): ReturnRef {
    const mode = source.return_mode as "pinned_session" | "actor_context";
    const target: AttentionContinuationTarget = mode === "pinned_session"
      ? {
        kind: "attention_return", protocol: 1, source_id: source.source_id, resolution_command_id: resolutionCommandId, generation,
        actor: source.actor, mode,
        pinned: {
          provider: source.provider, home_edge: source.edge_id, account_profile_fingerprint: source.account_profile_fingerprint,
          session_id: source.session_id!, cwd: source.cwd!,
        },
      }
      : {
        kind: "attention_return", protocol: 1, source_id: source.source_id, resolution_command_id: resolutionCommandId, generation,
        actor: source.actor, mode, pinned: null,
      };
    const nowIso = now.toISOString();
    const inserted = this.db.prepare(`
      INSERT INTO attention_returns(
        item_id, resolution_command_id, generation, source_id, mode, target_json, packet_revision, phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(itemId, resolutionCommandId, generation, source.source_id, mode, JSON.stringify(target), packetRevision, nowIso, nowIso);
    this.appendEvent({
      itemId, sourceId: source.source_id, commandId: resolutionCommandId, principal: "operator", type: "return_intent", revision: null,
      payload: { generation, mode },
    });
    return { return_id: Number(inserted.lastInsertRowid), generation, phase: "pending" };
  }

  currentReturn(itemId: number): ReturnRow | null {
    return (this.db.prepare("SELECT * FROM attention_returns WHERE item_id=? AND phase != 'superseded'").get(itemId) as ReturnRow | undefined) ?? null;
  }

  returnRow(returnId: number): ReturnRow | null {
    return (this.db.prepare("SELECT * FROM attention_returns WHERE return_id=?").get(returnId) as ReturnRow | undefined) ?? null;
  }

  /** Pass 1 of a drain: unminted returns that are due now. Blocked rows without a retry time await the operator. */
  dueReturns(limit = ATTENTION_RETURN_BATCH): ReturnRow[] {
    const now = this.nowIso();
    return this.db.prepare(`
      SELECT * FROM attention_returns
      WHERE (phase='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (phase='blocked' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
      ORDER BY return_id LIMIT ?
    `).all(now, now, limit) as ReturnRow[];
  }

  /**
   * Pass 2: minted returns whose core delivery is terminal or gone. In-flight deliveries are not
   * selected at all, so they can neither be reminted nor starve the pending pass.
   */
  settleableReturns(limit = ATTENTION_RETURN_BATCH): ReturnRow[] {
    return this.db.prepare(`
      SELECT r.* FROM attention_returns r LEFT JOIN deliveries d ON d.delivery_id = r.delivery_id
      WHERE r.phase='minted' AND (d.delivery_id IS NULL OR d.status IN ('processed', 'undeliverable', 'failed'))
      ORDER BY r.return_id LIMIT ?
    `).all(limit) as ReturnRow[];
  }

  markReturnMinted(returnId: number, deliveryId: number): void {
    const now = this.nowIso();
    this.db.prepare(`
      UPDATE attention_returns SET phase='minted', delivery_id=?, reason=NULL, next_attempt_at=NULL, updated_at=? WHERE return_id=? AND phase IN ('pending', 'blocked')
    `).run(deliveryId, now, returnId);
    const row = this.returnRow(returnId)!;
    this.appendEvent({ itemId: row.item_id, sourceId: row.source_id, commandId: row.resolution_command_id, principal: "system:returns", type: "return_minted", revision: null, payload: { generation: row.generation, delivery_id: deliveryId } });
  }

  markReturnBlocked(returnId: number, reason: string, retryAt: string | null): void {
    this.db.prepare(`
      UPDATE attention_returns SET phase='blocked', reason=?, next_attempt_at=?, updated_at=? WHERE return_id=? AND phase IN ('pending', 'blocked')
    `).run(reason, retryAt, this.nowIso(), returnId);
  }

  markReturnFailed(returnId: number, reason: string): void {
    this.db.prepare(`
      UPDATE attention_returns SET phase='failed', reason=?, next_attempt_at=NULL, updated_at=? WHERE return_id=? AND phase IN ('pending', 'blocked')
    `).run(reason, this.nowIso(), returnId);
    const row = this.returnRow(returnId)!;
    this.appendEvent({ itemId: row.item_id, sourceId: row.source_id, commandId: row.resolution_command_id, principal: "system:returns", type: "return_failed", revision: null, payload: { generation: row.generation, reason } });
  }

  /** Persist the terminal transport outcome of a minted return. Returns true when the row moved. */
  settleIfTerminal(row: ReturnRow, now: Date = this.clock.now()): boolean {
    if (row.phase !== "minted" || row.delivery_id === null) return false;
    const delivery = this.db.prepare("SELECT status, reasons_json, terminal_at, attempts FROM deliveries WHERE delivery_id=?")
      .get(row.delivery_id) as Row | undefined;
    let phase: "processed" | "failed";
    let status: TransportStatus;
    let snapshot: Record<string, unknown>;
    if (!delivery) {
      // Never inferred processed: a transport row that vanished without a snapshot is named.
      phase = "failed";
      status = "transport_record_missing";
      snapshot = { delivery_id: row.delivery_id };
    } else {
      if (!TERMINAL_TRANSPORT.has(String(delivery.status))) return false;
      status = String(delivery.status) as TransportStatus;
      phase = status === "processed" ? "processed" : "failed";
      snapshot = {
        delivery_id: row.delivery_id,
        status,
        reasons: JSON.parse(String(delivery.reasons_json)) as unknown,
        terminal_at: delivery.terminal_at,
        attempts: delivery.attempts,
      };
    }
    const reasons = Array.isArray(snapshot.reasons) ? snapshot.reasons as Array<{ code?: string }> : [];
    const reason = phase === "processed" ? null : `${status}${reasons[0]?.code ? `: ${reasons[0].code}` : ""}`;
    const nowIso = now.toISOString();
    this.db.prepare(`
      UPDATE attention_returns SET phase=?, transport_status=?, transport_json=?, reason=?, updated_at=? WHERE return_id=? AND phase='minted'
    `).run(phase, status, JSON.stringify(snapshot), reason, nowIso, row.return_id);
    this.appendEvent({
      itemId: row.item_id, sourceId: row.source_id, commandId: row.resolution_command_id, principal: "system:returns",
      type: phase === "processed" ? "return_processed" : "return_failed", revision: null,
      payload: { generation: row.generation, delivery_id: row.delivery_id, transport_status: status },
    });
    return true;
  }

  /**
   * §10: a constrained inbox envelope may be emitted only while it is the current generation,
   * its delivery is the one recorded, that delivery is being dispatched, and the calling edge
   * holds it. Lease expiry alone does not disqualify an outcome-waiting `dispatched` message.
   */
  /**
   * Whether a constrained inbox envelope may be emitted now. Fenced to the exact claim that
   * wrote it (delivery and lease generation): a file left by an earlier attempt of the same
   * delivery is stale even on the same edge, so it can never run beside a later resume.
   */
  returnGuard(edgeId: string, resolutionCommandId: string, generation: number, deliveryId: number, leaseGeneration: number): ReturnGuard {
    const asOf = this.nowIso();
    const answer = (eligible: boolean, reason: string): ReturnGuard => ({ eligible, reason, as_of: asOf });
    const row = this.db.prepare("SELECT * FROM attention_returns WHERE resolution_command_id=? AND generation=?")
      .get(resolutionCommandId, generation) as ReturnRow | undefined;
    if (!row) return answer(false, "return_unknown");
    const current = this.currentReturn(row.item_id);
    if (row.phase === "superseded" || current === null || current.return_id !== row.return_id) return answer(false, "generation_superseded");
    if (row.delivery_id !== deliveryId) return answer(false, "delivery_mismatch");
    const delivery = this.db.prepare("SELECT status, claimed_by, lease_generation FROM deliveries WHERE delivery_id=?").get(deliveryId) as Row | undefined;
    if (!delivery) return answer(false, "transport_record_missing");
    if (delivery.status !== "dispatching" && delivery.status !== "dispatched") return answer(false, `delivery_${String(delivery.status)}`);
    if (delivery.claimed_by !== edgeId) return answer(false, "claimed_by_other_edge");
    if (delivery.lease_generation !== leaseGeneration) return answer(false, "attempt_superseded");
    return answer(true, "current_generation");
  }

  private returnView(row: ReturnRow): ReturnView {
    let transport: TransportStatus | null = row.transport_status;
    if (row.phase === "minted" && row.delivery_id !== null) {
      const delivery = this.db.prepare("SELECT status FROM deliveries WHERE delivery_id=?").get(row.delivery_id) as Row | undefined;
      transport = delivery ? String(delivery.status) as TransportStatus : "transport_record_missing";
    }
    return {
      return_id: row.return_id,
      item_id: row.item_id,
      resolution_command_id: row.resolution_command_id,
      generation: row.generation,
      source_id: row.source_id,
      mode: row.mode,
      phase: row.phase,
      reason: row.reason,
      next_attempt_at: row.next_attempt_at,
      delivery_id: row.delivery_id,
      transport_status: transport,
      observed_at: this.nowIso(),
    };
  }

  // ───────────────────────────── reads ─────────────────────────────

  item(itemId: number): ItemView | null {
    const row = this.itemRow(itemId);
    return row === null ? null : this.view(row, this.clock.now());
  }

  events(itemId: number): EventView[] {
    return (this.db.prepare("SELECT * FROM attention_events WHERE item_id=? ORDER BY event_id").all(itemId) as Row[]).map((row) => ({
      event_id: Number(row.event_id),
      item_id: row.item_id === null ? null : Number(row.item_id),
      source_id: row.source_id === null ? null : String(row.source_id),
      command_id: row.command_id === null ? null : String(row.command_id),
      principal: String(row.principal),
      event_type: String(row.event_type),
      revision: row.revision === null ? null : Number(row.revision),
      created_at: String(row.created_at),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  /** A committed receipt, to its issuing principal's edge or the operator. Works after source revocation. */
  committedReceipt(commandId: string, caller: { kind: "operator" } | { kind: "edge"; edgeId: string }): Receipt | null {
    const row = this.db.prepare("SELECT issuer_edge, receipt_json FROM attention_commands WHERE command_id=?").get(commandId) as Row | undefined;
    if (!row) return null;
    if (caller.kind === "edge" && row.issuer_edge !== caller.edgeId) return null;
    return { ...(JSON.parse(String(row.receipt_json)) as Receipt), replayed: true };
  }

  queue(humanId: string, options: { states?: readonly ItemState[]; after?: string | null; limit?: number } = {}): QueuePage {
    const states = options.states ?? ["active", "queued", "deferred"];
    const limit = Math.min(Math.max(options.limit ?? ATTENTION_PAGE_DEFAULT, 1), ATTENTION_PAGE_MAX);
    const cursor = options.after ? parseCursor(options.after) : [-1, -1, -1];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT *,
          CASE state WHEN 'active' THEN 0 WHEN 'queued' THEN 1 WHEN 'deferred' THEN 2 WHEN 'resolved' THEN 3 ELSE 4 END AS sort_rank,
          CASE state
            WHEN 'queued' THEN ready_sequence
            WHEN 'deferred' THEN COALESCE(CAST(strftime('%s', deferred_until) AS INTEGER), 9007199254740991)
            ELSE item_id END AS sort_key
        FROM attention_items WHERE human_id=? AND state IN (${placeholders})
      ) WHERE (sort_rank, sort_key, item_id) > (?, ?, ?)
      ORDER BY sort_rank, sort_key, item_id LIMIT ?
    `).all(humanId, ...states, ...cursor, limit + 1) as Array<ItemRow & { sort_rank: number; sort_key: number }>;
    const page = rows.slice(0, limit);
    const now = this.clock.now();
    const last = page[page.length - 1];
    return {
      as_of: now.toISOString(),
      status: this.status(humanId),
      items: page.map((row) => this.view(row, now)),
      next_cursor: rows.length > limit && last ? `${last.sort_rank}.${last.sort_key}.${last.item_id}` : null,
    };
  }

  status(humanId: string): QueueStatus {
    const deferred = this.deferredCounts(humanId);
    // Eligible since the event that last made the item ready — a deferral that came due has
    // waited since its promotion, not since it was first summoned.
    // A due deferral has been eligible since its due time.
    const oldest = this.db.prepare(`
      SELECT MIN(ready_at) AS oldest FROM (
        SELECT e.created_at AS ready_at FROM attention_items i JOIN attention_events e ON e.event_id=i.ready_sequence
        WHERE i.human_id=? AND i.state='queued'
        UNION ALL
        SELECT deferred_until FROM attention_items WHERE human_id=? AND state='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ?
      )
    `).get(humanId, humanId, this.nowIso()) as Row;
    const phases = this.db.prepare(`
      SELECT r.phase, COUNT(*) AS count FROM attention_returns r JOIN attention_items i ON i.item_id=r.item_id
      WHERE i.human_id=? AND r.phase IN ('pending', 'minted', 'blocked', 'failed') GROUP BY r.phase
    `).all(humanId) as Array<{ phase: string; count: number }>;
    const count = (phase: string): number => phases.find((row) => row.phase === phase)?.count ?? 0;
    const warnings = (this.db.prepare(`
      SELECT r.item_id, r.generation, r.phase, r.reason FROM attention_returns r JOIN attention_items i ON i.item_id=r.item_id
      WHERE i.human_id=? AND r.phase IN ('blocked', 'failed') ORDER BY r.return_id
    `).all(humanId) as Array<{ item_id: number; generation: number; phase: ReturnPhase; reason: string | null }>)
      .map((row) => ({ item_id: row.item_id, generation: row.generation, phase: row.phase, reason: row.reason ?? row.phase }));
    return {
      human_id: humanId,
      active_item: this.activeRef(humanId),
      eligible_count: this.eligibleCount(humanId),
      deferred_count: deferred.count,
      oldest_eligible_at: oldest.oldest === null ? null : String(oldest.oldest),
      next_deferred_at: deferred.next,
      returns_pending: count("pending"),
      returns_minted: count("minted"),
      returns_blocked: count("blocked"),
      returns_failed: count("failed"),
      route_warnings: warnings,
      observed_at: this.nowIso(),
    };
  }

  private view(row: ItemRow, _now: Date): ItemView {
    const source = row.source_id === null ? null : this.sourceRow(row.source_id);
    const current = this.currentReturn(row.item_id);
    return {
      item_id: row.item_id,
      human_id: row.human_id,
      owner_principal: row.owner_principal,
      origin: row.origin,
      state: row.state,
      revision: row.revision,
      ready_sequence: row.ready_sequence === 0 ? null : row.ready_sequence,
      deferred_until: row.deferred_until,
      packet: JSON.parse(row.packet_json) as InterventionPacket,
      source: source === null ? null : this.sourceView(source),
      return_mode: source === null ? "none" : source.return_mode,
      created_at: row.created_at,
      updated_at: row.updated_at,
      claimed_at: row.claimed_at,
      resolved_at: row.resolved_at,
      outcome: row.outcome,
      response: row.response,
      terminal_reason: row.terminal_reason,
      return: current === null ? null : this.returnView(current),
    };
  }

  private itemRow(itemId: number): ItemRow | null {
    return (this.db.prepare("SELECT * FROM attention_items WHERE item_id=?").get(itemId) as ItemRow | undefined) ?? null;
  }

  private requireItem(itemId: number): ItemRow {
    const row = this.itemRow(itemId);
    if (!row) throw new AttentionRefusal(404, "item_not_found", `no attention item ${itemId}`);
    return row;
  }

  private activeRow(humanId: string): ItemRow | null {
    return (this.db.prepare("SELECT * FROM attention_items WHERE human_id=? AND state='active'").get(humanId) as ItemRow | undefined) ?? null;
  }

  private activeRef(humanId: string): ItemRef | null {
    const row = this.activeRow(humanId);
    return row === null ? null : itemRef(row);
  }

  private assertHuman(humanId: string): void {
    if (humanId !== this.humanId) {
      throw new AttentionRefusal(422, "unknown_human", `${humanId} is not the configured attention human (${this.humanId})`);
    }
  }

  private markReady(itemId: number, eventId: number): void {
    this.db.prepare("UPDATE attention_items SET ready_sequence=? WHERE item_id=?").run(eventId, itemId);
  }

  private appendEvent(event: {
    itemId: number | null; sourceId: string | null; commandId: string | null; principal: string; type: string;
    revision: number | null; payload: Record<string, unknown>;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO attention_events(item_id, source_id, command_id, principal, event_type, revision, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.itemId, event.sourceId, event.commandId, event.principal, event.type, event.revision, this.nowIso(), JSON.stringify(event.payload));
    return Number(result.lastInsertRowid);
  }

  private receipt(
    commandId: string,
    action: Receipt["action"],
    result: ReceiptResult,
    now: Date,
    parts: { item?: ItemRef | null; active?: ItemRef | null; selection?: Selection | null; returnEffect?: ReturnRef | null; source?: SourceView | null },
  ): Receipt {
    return {
      schema_version: 1,
      broker_uuid: this.brokerUuid,
      command_id: commandId,
      action,
      result,
      replayed: false,
      as_of: now.toISOString(),
      item: parts.item ?? null,
      active_item: parts.active ?? null,
      return_effect: parts.returnEffect ?? null,
      selection: parts.selection ?? null,
      source: parts.source ?? null,
    };
  }
}

function itemFacts(row: ItemRow) {
  return { state: row.state, revision: row.revision, ownerPrincipal: row.owner_principal, sourceId: row.source_id };
}

function itemRef(row: Pick<ItemRow, "item_id" | "revision" | "state">): ItemRef {
  return { item_id: row.item_id, revision: row.revision, state: row.state };
}

function refOfView(view: ItemView): ItemRef {
  return { item_id: view.item_id, revision: view.revision, state: view.state };
}

function returnRef(row: ReturnRow): ReturnRef {
  return { return_id: row.return_id, generation: row.generation, phase: row.phase };
}

function disabled(): AttentionRefusal {
  return new AttentionRefusal(503, "attention_disabled",
    "attention is disabled on this broker (HIVE_ATTENTION_ENABLED); reads stay available and already-minted deliveries keep their ordinary lifecycle");
}

const SOURCE_ACTIONS = new Set(["summon", "amend", "withdraw"]);
const OPERATOR_ACTIONS = new Set(["add", "start", "next", "resolve", "defer", "requeue", "cancel", "retry_return", "reroute_return", "source_revoke", "amend"]);

/** I10: a source produces requests; it never selects human work, resolves, or acts as the operator. */
function authorizeAction(principal: AttentionPrincipal, action: AttentionCommand["action"]): void {
  const allowed = principal.kind === "operator" ? OPERATOR_ACTIONS : principal.kind === "source" ? SOURCE_ACTIONS : new Set<string>();
  if (!allowed.has(action)) {
    throw new AttentionRefusal(403, "action_not_permitted",
      principal.kind === "edge"
        ? `${action} needs a source binding (seat) or the operator credential`
        : `${action} is not permitted for ${principal.kind === "source" ? "a seat source" : "the operator"}`);
  }
}

/** Timestamps become canonical UTC milliseconds before hashing or persistence; anything unparseable is refused. */
export function normalizeCommand(command: AttentionCommand): AttentionCommand {
  const instant = (value: string | null, where: string): string | null => {
    if (value === null) return null;
    const canonical = canonicalInstant(value);
    if (canonical === null) throw new AttentionRefusal(422, "invalid_timestamp", `${where} is not a real instant: ${value}`);
    return canonical;
  };
  const packet = (value: InterventionPacket): InterventionPacket => ({ ...value, deadline_at: instant(value.deadline_at, "deadline_at") });
  switch (command.action) {
    case "summon": return { ...command, payload: packet(command.payload) };
    case "add":
    case "start": return { ...command, payload: { ...command.payload, packet: packet(command.payload.packet) } } as AttentionCommand;
    case "amend": {
      const fields = { ...command.payload.fields };
      if (fields.deadline_at !== undefined) fields.deadline_at = instant(fields.deadline_at, "deadline_at");
      return { ...command, payload: { ...command.payload, fields } };
    }
    case "defer": return { ...command, payload: { ...command.payload, until: instant(command.payload.until, "until") } };
    default: return command;
  }
}

/** Canonical JSON (sorted keys) → sha256: the identity of normalized content. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseCursor(cursor: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(cursor);
  if (!match) throw new AttentionRefusal(400, "invalid_cursor", `not an attention queue cursor: ${cursor}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
