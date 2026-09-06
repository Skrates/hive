/**
 * The Review store (design §9.3, module map §3).
 *
 * Owns the review tables inside the broker's SQLite handle — new tables only, never a
 * change to an existing one — and the one transaction that admits an act:
 * Ajv → replay check by `act_id` → revision fence → `decide` → `fold` → persist the batch,
 * the `state_json` cache, and the effect rows → `Receipt`.
 *
 * `review_batches` is the truth and `state_json` is a cache (§9.3): {@link ReviewStore.replay}
 * folds the stored batches and never calls `decide`, never re-emits effects (§5.B3).
 */
import type Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "../time.js";
import { iso } from "../time.js";
import type {
  Action,
  Batch,
  Effect,
  Policy,
  Principal,
  Receipt,
  Refusal,
  Review,
  ReviewKey,
  ReviewState,
} from "./contract.js";
import { validateAction } from "./contract.js";
import type { DecideContext, ReviewIdentity, decide as reducerDecide, fold as reducerFold, read as reducerRead } from "./reducer.js";

interface Row { [key: string]: unknown }

/**
 * Structural mirror of `DecideContext` in `src/review/reducer.ts` (module map §2). The reducer
 * lands in parallel, so the store spells the shape out instead of importing it; the real
 * `decide`/`fold`/`read` satisfy {@link ReviewStoreDeps} structurally. `display` is passed in
 * addition to the map's fields: the reducer needs it for `Review.display` and the
 * `check:<owner/repo>:<sha>` effect target, and the store is the party that holds it.
 */
/**
 * The reducer's own context type (module map §2). The store adds nothing to it: the identity
 * the reducer needs on an opening act (`ReviewIdentity`, §3.1) is built here from the key and
 * the caller's `display`.
 */
export type { DecideContext, ReviewIdentity };

export interface ReviewStoreDeps {
  decide: typeof reducerDecide;
  fold: typeof reducerFold;
  read: typeof reducerRead;
  clock: Clock;
}

export interface ApplyInput {
  actId: string;
  principal: Principal;
  expectedRevision: number | null;
  /** Not yet shape-valid: `apply` runs `validateAction` first (§E2). */
  action: Action;
  /** `owner/repo#n`; required when the Review does not exist yet (the opening `ObservePR`). */
  display?: string;
  meter?: DecideContext["meter"];
}

export type EffectStatus = "pending" | "claimed" | "sent" | "obsolete" | "failed";

export interface EffectRow extends Effect {
  reviewId: string;
  revision: number;
  status: EffectStatus;
  attempts: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  obsoleteAt: string | null;
}

export interface InboxDelivery {
  deliveryId: string;
  event: string;
  repositoryId: number | null;
  prNumber: number | null;
  payload: unknown;
  receivedAt: string;
}

export interface SourceRecordInput {
  recordKey: string;
  version: string;
  reviewId: string;
  authorLogin: string;
  body: unknown;
}

export interface SourceRecordRow extends SourceRecordInput {
  classification: string | null;
  admittedActId: string | null;
}

/**
 * An effect row that keeps failing is retried behind the caller's backoff and finally
 * terminalized as `failed` — the same bound the Slack outbox uses (`OUTBOX_MAX_ATTEMPTS`),
 * restated here so the review module does not load the broker store to read one number.
 */
export const REVIEW_EFFECT_MAX_ATTEMPTS = 50;

/** A caller precondition the store refuses to paper over (a missing display, an unknown row). */
export class ReviewStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewStoreError";
  }
}

function isRefusal(result: Batch | Refusal): result is Refusal {
  return (result as Refusal).refused === true;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function effectFromRow(row: Row): EffectRow {
  return {
    effect_id: String(row.effect_id),
    kind: String(row.kind) as Effect["kind"],
    target: String(row.target),
    payload: row.payload_json === null ? null : (JSON.parse(String(row.payload_json)) as Effect["payload"]),
    reviewId: String(row.review_id),
    revision: Number(row.revision),
    status: String(row.status) as EffectStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    obsoleteAt: row.obsolete_at === null ? null : String(row.obsolete_at),
  };
}

function inboxFromRow(row: Row): InboxDelivery {
  return {
    deliveryId: String(row.delivery_id),
    event: String(row.event),
    repositoryId: row.repository_id === null ? null : Number(row.repository_id),
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    payload: JSON.parse(String(row.payload_json)),
    receivedAt: String(row.received_at),
  };
}

function sourceRecordFromRow(row: Row): SourceRecordRow {
  return {
    recordKey: String(row.record_key),
    version: String(row.version),
    reviewId: String(row.review_id),
    authorLogin: String(row.author_login),
    body: JSON.parse(String(row.body_json)),
    classification: row.classification === null ? null : String(row.classification),
    admittedActId: row.admitted_act_id === null ? null : String(row.admitted_act_id),
  };
}

export class ReviewStore {
  private readonly applyTx: (key: ReviewKey, input: ApplyInput) => Receipt;

  constructor(private readonly db: Database.Database, private readonly deps: ReviewStoreDeps) {
    this.migrate();
    // §5 "apply is serialized per Review": better-sqlite3 transactions are synchronous and
    // exclusive within the process, so two acts on one Review never interleave.
    this.applyTx = this.db.transaction((key: ReviewKey, input: ApplyInput) => this.applyInTransaction(key, input));
  }

  /** §9.3 DDL verbatim, plus the module map's indexes. Same `IF NOT EXISTS` style as `BrokerStore.migrate`. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (review_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL, pr_number INTEGER NOT NULL,
        display TEXT NOT NULL, revision INTEGER NOT NULL, policy_version INTEGER NOT NULL,
        state_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repository_id, pr_number));
      CREATE TABLE IF NOT EXISTS review_batches (review_id TEXT NOT NULL, revision INTEGER NOT NULL, batch_id TEXT NOT NULL UNIQUE,
        act_id TEXT NOT NULL UNIQUE, command_json TEXT NOT NULL, consequences_json TEXT NOT NULL,
        policy_version INTEGER NOT NULL, admitted_at TEXT NOT NULL, PRIMARY KEY(review_id, revision));
      CREATE TABLE IF NOT EXISTS review_attempts (attempt_id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT, act_id TEXT NOT NULL,
        command_json TEXT NOT NULL, refusal_json TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_effects (effect_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, target TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, sent_at TEXT, obsolete_at TEXT);
      CREATE INDEX IF NOT EXISTS review_effects_target_idx ON review_effects(target, status, effect_id);
      CREATE TABLE IF NOT EXISTS github_inbox (delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, repository_id INTEGER, pr_number INTEGER,
        payload_json TEXT NOT NULL, received_at TEXT NOT NULL, reconciled_run TEXT);
      CREATE TABLE IF NOT EXISTS source_records (record_key TEXT NOT NULL, version TEXT NOT NULL, review_id TEXT NOT NULL,
        author_login TEXT NOT NULL, body_json TEXT NOT NULL, classification TEXT, admitted_act_id TEXT,
        PRIMARY KEY(record_key, version));
      CREATE TABLE IF NOT EXISTS review_policies (repository_id INTEGER NOT NULL, version INTEGER NOT NULL, policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(repository_id, version));
      CREATE TABLE IF NOT EXISTS operators (operator_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL);

      CREATE INDEX IF NOT EXISTS reviews_display_idx ON reviews(display);
      CREATE INDEX IF NOT EXISTS review_effects_status_idx ON review_effects(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS github_inbox_unreconciled_idx ON github_inbox(reconciled_run) WHERE reconciled_run IS NULL;
      CREATE INDEX IF NOT EXISTS source_records_review_idx ON source_records(review_id, admitted_act_id);
    `);
  }

  // ---------------------------------------------------------------------------------------
  // apply / read

  /**
   * §4 `apply`: one transaction — Ajv (§E2) → replay check by `act_id` (§B2) → revision fence
   * (§B1) → `decide` → refusal appends `review_attempts` (§B4) | `fold` → persist batch,
   * `state_json`, effect rows → Receipt.
   */
  apply(key: ReviewKey, input: ApplyInput): Receipt {
    return this.applyTx(key, input);
  }

  private applyInTransaction(key: ReviewKey, input: ApplyInput): Receipt {
    const now = iso(this.deps.clock);
    const row = this.reviewRow(key);
    const state = row === undefined ? null : (JSON.parse(String(row.state_json)) as Review);
    const reviewId = row === undefined ? null : String(row.review_id);
    const currentRevision = state?.revision ?? 0;

    // §E2: schema first; the reducer may assume shape. A defect here never reaches `decide`.
    const shape = validateAction(input.action);
    if (!shape.ok) {
      return this.refuse(key, input, reviewId, state, now, null, { refused: true, code: "malformed", detail: shape.detail });
    }

    // §B2: the act id is the key; an admitted act is answered with its original batch, and
    // nothing — no state, no effect — is written again.
    const admitted = this.db.prepare(
      "SELECT review_id, revision, batch_id FROM review_batches WHERE act_id = ?",
    ).get(input.actId) as Row | undefined;
    if (admitted !== undefined) {
      return {
        review_id: String(admitted.review_id),
        act_id: input.actId,
        outcome: { replayed: true, revision_at_apply: Number(admitted.revision), batch_id: String(admitted.batch_id) },
      };
    }

    // Module map §3: before the Review exists only the opening `ObservePR` has a target.
    if (state === null && input.action.kind !== "ObservePR") {
      return this.refuse(key, input, null, null, now, null, {
        refused: true,
        code: "no_such_target",
        detail: `no review for ${key.repository_id}:${key.pr_number}`,
      });
    }

    // §B1: seat and operator acts carry `expected_revision == revision`; adapter and system
    // acts carry null (observations reconciled against GitHub, serialized per Review).
    const fenced = input.principal.kind === "seat" || input.principal.kind === "operator";
    if (fenced && input.expectedRevision !== currentRevision) {
      const policy = this.policyFor(key, state);
      return this.refuse(key, input, reviewId, state, now, policy, {
        refused: true,
        code: "stale_revision",
        detail: `expected revision ${input.expectedRevision ?? "null"}, current is ${currentRevision}`,
      });
    }

    // §6.I: a Review keeps its policy version; the opening act takes the repository's latest;
    // `AdoptPolicy(version)` decides under the version it adopts (the reducer checks the two agree).
    const policyVersion: number | "latest" = input.action.kind === "AdoptPolicy"
      ? input.action.version
      : state === null ? "latest" : state.policy_version;
    const policy = this.policy(key.repository_id, policyVersion);
    if (policy === null) {
      return this.refuse(key, input, reviewId, state, now, this.policyFor(key, state), {
        refused: true,
        code: "no_such_target",
        detail: policyVersion === "latest"
          ? `repository ${key.repository_id} has no review policy`
          : `repository ${key.repository_id} has no review policy version ${policyVersion}`,
      });
    }

    const display = input.display ?? (row === undefined ? undefined : String(row.display));
    if (display === undefined) {
      throw new ReviewStoreError(`apply: display is required to open review ${key.repository_id}:${key.pr_number}`);
    }

    const identity: ReviewIdentity = { key, display };
    const ctx: DecideContext = {
      now,
      policy,
      actId: input.actId,
      principal: input.principal,
      expectedRevision: input.expectedRevision,
      meter: input.meter ?? null,
      identity,
    };
    const decided = this.deps.decide(state, shape.value, ctx);
    if (isRefusal(decided)) {
      return this.refuse(key, input, reviewId, state, now, policy, decided);
    }

    // The reducer numbers the batch; the store checks the two agree before anything is written
    // (the whole transaction rolls back on a throw).
    if (decided.revision !== currentRevision + 1) {
      throw new ReviewStoreError(
        `apply: reducer produced revision ${decided.revision} on top of ${currentRevision} for act ${input.actId}`,
      );
    }
    const next = this.deps.fold(state, decided, identity);
    if (next.revision !== decided.revision) {
      throw new ReviewStoreError(`apply: fold produced revision ${next.revision} for batch at ${decided.revision}`);
    }

    this.db.prepare(`
      INSERT INTO review_batches(review_id, revision, batch_id, act_id, command_json, consequences_json, policy_version, admitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      next.id,
      decided.revision,
      decided.batch_id,
      input.actId,
      JSON.stringify(decided.command),
      JSON.stringify(decided.consequences),
      decided.policy_version,
      decided.admitted_at,
    );
    this.db.prepare(`
      INSERT INTO reviews(review_id, repository_id, pr_number, display, revision, policy_version, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_id) DO UPDATE SET
        display = excluded.display, revision = excluded.revision, policy_version = excluded.policy_version,
        state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(next.id, key.repository_id, key.pr_number, display, next.revision, next.policy_version, JSON.stringify(next), now);
    const insertEffect = this.db.prepare(`
      INSERT INTO review_effects(effect_id, review_id, revision, kind, target, payload_json, status, attempts)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)
    `);
    for (const effect of decided.effects) {
      insertEffect.run(
        effect.effect_id,
        next.id,
        decided.revision,
        effect.kind,
        effect.target,
        effect.payload === null ? null : JSON.stringify(effect.payload),
      );
    }

    return {
      review_id: next.id,
      act_id: input.actId,
      outcome: {
        applied: true,
        revision_before: currentRevision,
        revision_after: next.revision,
        batch_id: decided.batch_id,
        effects: decided.effects.map((effect) => effect.effect_id),
      },
    };
  }

  /** §B4: a refusal is appended to `review_attempts` — visible, non-revising — and carries the current state. */
  private refuse(
    key: ReviewKey,
    input: ApplyInput,
    reviewId: string | null,
    state: Review | null,
    now: string,
    policy: Policy | null,
    refusal: Refusal,
  ): Receipt {
    const command = {
      act_id: input.actId,
      action: input.action,
      expected_revision: input.expectedRevision,
      principal: input.principal,
    };
    this.db.prepare(`
      INSERT INTO review_attempts(review_id, act_id, command_json, refusal_json, at) VALUES (?, ?, ?, ?, ?)
    `).run(reviewId, input.actId, JSON.stringify(command), JSON.stringify(refusal), now);
    const current = state !== null && policy !== null ? this.deps.read(state, { now, policy }) : null;
    return {
      review_id: reviewId,
      act_id: input.actId,
      outcome: {
        refused: true,
        code: refusal.code,
        detail: refusal.detail,
        current_revision: state?.revision ?? 0,
        state: current,
      },
    };
  }

  read(key: ReviewKey): ReviewState | null {
    const state = this.get(key);
    if (state === null) return null;
    const policy = this.policy(key.repository_id, state.policy_version);
    if (policy === null) {
      throw new ReviewStoreError(`read: repository ${key.repository_id} has no review policy version ${state.policy_version}`);
    }
    return this.deps.read(state, { now: iso(this.deps.clock), policy });
  }

  get(key: ReviewKey): Review | null {
    const row = this.reviewRow(key);
    return row === undefined ? null : (JSON.parse(String(row.state_json)) as Review);
  }

  /** `read` by Review id: an effect row (§8.1) names its Review by id, not by key. */
  readById(reviewId: string): ReviewState | null {
    const row = this.db.prepare("SELECT repository_id, pr_number FROM reviews WHERE review_id = ?").get(reviewId) as Row | undefined;
    return row === undefined ? null : this.read({ repository_id: Number(row.repository_id), pr_number: Number(row.pr_number) });
  }

  findByDisplay(display: string): ReviewKey | null {
    const row = this.db.prepare("SELECT repository_id, pr_number FROM reviews WHERE display = ?").get(display) as Row | undefined;
    return row === undefined ? null : { repository_id: Number(row.repository_id), pr_number: Number(row.pr_number) };
  }

  /** §5.B3 truth: fold over `review_batches` in revision order; never calls `decide`, never emits. */
  replay(key: ReviewKey): Review {
    const row = this.reviewRow(key);
    const batches = this.batches(key);
    if (row === undefined || batches.length === 0) {
      throw new ReviewStoreError(`replay: no batches for review ${key.repository_id}:${key.pr_number}`);
    }
    // §3.1: the opening batch carries no key or display; the reviews row is where they live.
    const identity: ReviewIdentity = { key, display: String(row.display) };
    let state: Review | null = null;
    for (const batch of batches) state = this.deps.fold(state, batch, identity);
    return state as Review;
  }

  batches(key: ReviewKey): Batch[] {
    const row = this.reviewRow(key);
    if (row === undefined) return [];
    const reviewId = String(row.review_id);
    const effectsByRevision = new Map<number, Effect[]>();
    const effectRows = this.db.prepare(
      "SELECT revision, effect_id, kind, target, payload_json FROM review_effects WHERE review_id = ? ORDER BY rowid",
    ).all(reviewId) as Row[];
    for (const effectRow of effectRows) {
      const revision = Number(effectRow.revision);
      const list = effectsByRevision.get(revision) ?? [];
      list.push({
        effect_id: String(effectRow.effect_id),
        kind: String(effectRow.kind) as Effect["kind"],
        target: String(effectRow.target),
        payload: effectRow.payload_json === null ? null : (JSON.parse(String(effectRow.payload_json)) as Effect["payload"]),
      });
      effectsByRevision.set(revision, list);
    }
    const rows = this.db.prepare(
      "SELECT revision, batch_id, command_json, consequences_json, policy_version, admitted_at FROM review_batches WHERE review_id = ? ORDER BY revision",
    ).all(reviewId) as Row[];
    return rows.map((batchRow) => {
      const revision = Number(batchRow.revision);
      return {
        batch_id: String(batchRow.batch_id),
        revision,
        command: JSON.parse(String(batchRow.command_json)) as Batch["command"],
        admitted_at: String(batchRow.admitted_at),
        policy_version: Number(batchRow.policy_version),
        consequences: JSON.parse(String(batchRow.consequences_json)) as Batch["consequences"],
        effects: effectsByRevision.get(revision) ?? [],
      };
    });
  }

  /** §7 bounded reconcile: Reviews with a pending request, or any activity since `since`. */
  active(since: string): ReviewKey[] {
    const rows = this.db.prepare(`
      SELECT repository_id, pr_number FROM reviews
      WHERE updated_at >= ?
         OR EXISTS (SELECT 1 FROM json_each(reviews.state_json, '$.requests') WHERE json_extract(value, '$.status') = 'pending')
      ORDER BY updated_at DESC, review_id
    `).all(since) as Row[];
    return rows.map((row) => ({ repository_id: Number(row.repository_id), pr_number: Number(row.pr_number) }));
  }

  private reviewRow(key: ReviewKey): Row | undefined {
    return this.db.prepare(
      "SELECT review_id, display, revision, policy_version, state_json FROM reviews WHERE repository_id = ? AND pr_number = ?",
    ).get(key.repository_id, key.pr_number) as Row | undefined;
  }

  /** §6.I: the Review's own version, or the repository's latest before the Review exists. */
  private policyFor(key: ReviewKey, state: Review | null): Policy | null {
    return this.policy(key.repository_id, state === null ? "latest" : state.policy_version);
  }

  // ---------------------------------------------------------------------------------------
  // policies (§9.2, §6.I)

  /** Versions are dense per repository: `policy.version` must be the current latest plus one. */
  putPolicy(repositoryId: number, policy: Policy): void {
    this.db.transaction(() => {
      const latest = this.policy(repositoryId, "latest");
      const expected = (latest?.version ?? 0) + 1;
      if (policy.version !== expected) {
        throw new ReviewStoreError(
          `putPolicy: repository ${repositoryId} expects policy version ${expected}, got ${policy.version}`,
        );
      }
      this.db.prepare(
        "INSERT INTO review_policies(repository_id, version, policy_json, created_at) VALUES (?, ?, ?, ?)",
      ).run(repositoryId, policy.version, JSON.stringify(policy), iso(this.deps.clock));
    })();
  }

  policy(repositoryId: number, version: number | "latest"): Policy | null {
    const row = version === "latest"
      ? this.db.prepare(
        "SELECT policy_json FROM review_policies WHERE repository_id = ? ORDER BY version DESC LIMIT 1",
      ).get(repositoryId) as Row | undefined
      : this.db.prepare(
        "SELECT policy_json FROM review_policies WHERE repository_id = ? AND version = ?",
      ).get(repositoryId, version) as Row | undefined;
    return row === undefined ? null : (JSON.parse(String(row.policy_json)) as Policy);
  }

  // ---------------------------------------------------------------------------------------
  // effects (§8.1)

  readonly effects = {
    /**
     * One row per target: the newest pending refresh (a refresh re-renders from `read()`, so
     * only the latest matters) or the oldest pending actionable (dispatched in order). A row
     * whose `next_attempt_at` is in the future is not yet due.
     */
    pendingByTarget: (now: string, limit = 100): EffectRow[] => {
      const rows = this.db.prepare(`
        SELECT * FROM review_effects
        WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY rowid
      `).all(now) as Row[];
      const byTarget = new Map<string, EffectRow>();
      for (const row of rows) {
        const effect = effectFromRow(row);
        if (effect.kind === "refresh" || !byTarget.has(effect.target)) byTarget.set(effect.target, effect);
      }
      return [...byTarget.values()].slice(0, limit);
    },

    /** pending → claimed; null when another worker got there first (or the row is not pending). */
    claim: (effectId: string): EffectRow | null => {
      const changed = this.db.prepare(
        "UPDATE review_effects SET status = 'claimed' WHERE effect_id = ? AND status = 'pending'",
      ).run(effectId).changes;
      if (changed !== 1) return null;
      const row = this.db.prepare("SELECT * FROM review_effects WHERE effect_id = ?").get(effectId) as Row;
      return effectFromRow(row);
    },

    markSent: (effectId: string): void => {
      this.updateEffect(effectId, "UPDATE review_effects SET status = 'sent', sent_at = ? WHERE effect_id = ?", iso(this.deps.clock));
    },

    /** §D7 / §8.1: an actionable job no longer applicable, or a refresh superseded by a newer one. */
    markObsolete: (effectId: string): void => {
      this.updateEffect(
        effectId,
        "UPDATE review_effects SET status = 'obsolete', obsolete_at = ? WHERE effect_id = ?",
        iso(this.deps.clock),
      );
    },

    /**
     * attempts + 1 and back to `pending` behind `nextAttemptAt`; terminal `failed` once the
     * bound is spent ({@link REVIEW_EFFECT_MAX_ATTEMPTS}).
     */
    markFailed: (effectId: string, nextAttemptAt: string): void => {
      this.db.transaction(() => {
        const row = this.db.prepare("SELECT attempts FROM review_effects WHERE effect_id = ?").get(effectId) as Row | undefined;
        if (row === undefined) throw new ReviewStoreError(`no effect ${effectId}`);
        const attempts = Number(row.attempts) + 1;
        const status: EffectStatus = attempts >= REVIEW_EFFECT_MAX_ATTEMPTS ? "failed" : "pending";
        this.db.prepare(
          "UPDATE review_effects SET status = ?, attempts = ?, next_attempt_at = ? WHERE effect_id = ?",
        ).run(status, attempts, status === "failed" ? null : nextAttemptAt, effectId);
      })();
    },

    /** §8.1: pending refreshes for one target coalesce into the newest; returns how many were retired. */
    coalesceRefresh: (target: string): number => {
      return this.db.prepare(`
        UPDATE review_effects SET status = 'obsolete', obsolete_at = ?
        WHERE target = ? AND kind = 'refresh' AND status = 'pending'
          AND rowid < (SELECT max(rowid) FROM review_effects WHERE target = ? AND kind = 'refresh' AND status = 'pending')
      `).run(iso(this.deps.clock), target, target).changes;
    },
  };

  private updateEffect(effectId: string, sql: string, ...params: unknown[]): void {
    const changed = this.db.prepare(sql).run(...params, effectId).changes;
    if (changed !== 1) throw new ReviewStoreError(`no effect ${effectId}`);
  }

  // ---------------------------------------------------------------------------------------
  // github inbox (§7 persist-before-ack)

  readonly inbox = {
    /** false on a duplicate `delivery_id`: GitHub redelivers, the inbox records once. */
    put: (delivery: InboxDelivery): boolean => {
      return this.db.prepare(`
        INSERT OR IGNORE INTO github_inbox(delivery_id, event, repository_id, pr_number, payload_json, received_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        delivery.deliveryId,
        delivery.event,
        delivery.repositoryId,
        delivery.prNumber,
        JSON.stringify(delivery.payload),
        delivery.receivedAt,
      ).changes === 1;
    },

    unreconciled: (limit = 100): InboxDelivery[] => {
      const rows = this.db.prepare(
        "SELECT * FROM github_inbox WHERE reconciled_run IS NULL ORDER BY rowid LIMIT ?",
      ).all(limit) as Row[];
      return rows.map(inboxFromRow);
    },

    markReconciled: (deliveryIds: string[], runId: string): void => {
      const stamp = this.db.prepare("UPDATE github_inbox SET reconciled_run = ? WHERE delivery_id = ? AND reconciled_run IS NULL");
      this.db.transaction(() => {
        for (const deliveryId of deliveryIds) stamp.run(runId, deliveryId);
      })();
    },
  };

  // ---------------------------------------------------------------------------------------
  // source records (§7 step 2: a record is not a notification is not an act)

  readonly sourceRecords = {
    /** Keyed `(record_key, version)`; classification and admission survive a body refresh at the same version. */
    upsert: (record: SourceRecordInput): "new" | "same" | "updated" => {
      return this.db.transaction((): "new" | "same" | "updated" => {
        const bodyJson = JSON.stringify(record.body);
        const existing = this.db.prepare(
          "SELECT author_login, body_json FROM source_records WHERE record_key = ? AND version = ?",
        ).get(record.recordKey, record.version) as Row | undefined;
        if (existing === undefined) {
          this.db.prepare(`
            INSERT INTO source_records(record_key, version, review_id, author_login, body_json, classification, admitted_act_id)
            VALUES (?, ?, ?, ?, ?, NULL, NULL)
          `).run(record.recordKey, record.version, record.reviewId, record.authorLogin, bodyJson);
          return "new";
        }
        if (existing.author_login === record.authorLogin && existing.body_json === bodyJson) return "same";
        this.db.prepare(
          "UPDATE source_records SET author_login = ?, body_json = ? WHERE record_key = ? AND version = ?",
        ).run(record.authorLogin, bodyJson, record.recordKey, record.version);
        return "updated";
      })();
    },

    unadmitted: (reviewId: string): SourceRecordRow[] => {
      const rows = this.db.prepare(
        "SELECT * FROM source_records WHERE review_id = ? AND admitted_act_id IS NULL ORDER BY rowid",
      ).all(reviewId) as Row[];
      return rows.map(sourceRecordFromRow);
    },

    markAdmitted: (recordKey: string, version: string, actId: string): void => {
      this.updateSourceRecord(recordKey, version, "UPDATE source_records SET admitted_act_id = ? WHERE record_key = ? AND version = ?", actId);
    },

    setClassification: (recordKey: string, version: string, classification: string): void => {
      this.updateSourceRecord(
        recordKey,
        version,
        "UPDATE source_records SET classification = ? WHERE record_key = ? AND version = ?",
        classification,
      );
    },
  };

  private updateSourceRecord(recordKey: string, version: string, sql: string, value: string): void {
    const changed = this.db.prepare(sql).run(value, recordKey, version).changes;
    if (changed !== 1) throw new ReviewStoreError(`no source record ${recordKey}@${version}`);
  }

  // ---------------------------------------------------------------------------------------
  // operators (§5.A2)

  readonly operators = {
    /** Returns the raw token exactly once; only its sha256 is stored. Calling again rotates the token. */
    create: (operatorId: string): string => {
      const token = randomBytes(32).toString("base64url");
      this.db.prepare(`
        INSERT INTO operators(operator_id, token_hash, created_at) VALUES (?, ?, ?)
        ON CONFLICT(operator_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at
      `).run(operatorId, hashToken(token), iso(this.deps.clock));
      return token;
    },

    /** `operator_id` for a live token, else null; the digest comparison is constant-time. */
    verify: (token: string): string | null => {
      const presented = Buffer.from(hashToken(token), "hex");
      const rows = this.db.prepare("SELECT operator_id, token_hash FROM operators ORDER BY operator_id").all() as Row[];
      let found: string | null = null;
      for (const row of rows) {
        const stored = Buffer.from(String(row.token_hash), "hex");
        if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = String(row.operator_id);
      }
      return found;
    },
  };
}
