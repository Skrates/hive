import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import type { Clock } from "../time.js";
import type {
  Action,
  AppliedOutcome,
  Batch,
  ObservePRAction,
  Policy,
  Principal,
  Receipt,
  Refusal,
  RefusedOutcome,
  Review,
  ReviewKey,
  ReviewState,
} from "./contract.js";
import { validateBatch, validateReceipt, validateReview, validateReviewState } from "./contract.js";
import {
  REVIEW_EFFECT_MAX_ATTEMPTS,
  ReviewStore,
  ReviewStoreError,
  type ApplyInput,
  type DecideContext,
  type ReviewStoreDeps,
} from "./store.js";

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const KEY: ReviewKey = { repository_id: 42, pr_number: 7 };
const DISPLAY = "Owner/repo#7";
const ADAPTER: Principal = { kind: "adapter", source: "github", reconcile_run: "run_1", event_login: "chatgpt-codex-connector[bot]" };
const OPERATOR: Principal = { kind: "operator", id: "hakon" };
const SEAT: Principal = { kind: "seat", actor: "talos", custody: { delivery_id: 1 } };

function policy(version: number): Policy {
  return {
    version,
    rounds_max: 7,
    reviewer_set: ["ariadne", "theoros"],
    substitute_actor: "ariadne",
    burn_actor: "talos",
    retrospective_actor: "theoros",
    closure_by_seat: true,
    routing_by_round: { first: "codex", later: "ariadne" },
    exempt_roots: ["skills/"],
    author_aliases: { "talos-weave": "talos" },
    stall_window_s: 1200,
    transport_bound: 2,
    codex_meter: null,
    slack: { channel_id: "C0123ABCD" },
  };
}

function observe(headSha: string, at = "2026-09-06T12:00:00.000Z"): ObservePRAction {
  return {
    kind: "ObservePR",
    lifecycle: "open",
    draft: false,
    exemption: null,
    observed: { title: "Fix x", author_login: "talos-weave", head_ref: "feature", base_sha_now: SHA_B, mergeable: true, seen_at: at },
    subject: {
      key: `${headSha}:main`,
      head_sha: headSha,
      base_ref: "main",
      base_sha_at_first_sight: SHA_B,
      merge_base_sha: SHA_C,
      diff_sha256: "d".repeat(64),
      changed_paths: ["src/x.py"],
      author: { kind: "seat", actor: "talos" },
      first_seen_at: at,
    },
  };
}

const grant = (n: number): Action => ({ kind: "GrantRounds", n, reason: "one more" });

/**
 * A fake reducer: enough of `decide`/`fold`/`read` to exercise the store's rules without the
 * real one (which lands in parallel). `decide` refuses any `CancelRequest` as `no_such_target`
 * so the refusal path can be driven; ids follow the module map's deterministic scheme.
 */
function fakeReducer(): ReviewStoreDeps & { calls: { decide: DecideContext[]; read: Array<{ now: string; policy: Policy }> }; clock: FakeClock } {
  const calls = { decide: [] as DecideContext[], read: [] as Array<{ now: string; policy: Policy }> };
  const decide = (state: Review | null, action: Action, ctx: DecideContext): Batch | Refusal => {
    calls.decide.push(ctx);
    if (action.kind === "CancelRequest") return { refused: true, code: "no_such_target", detail: `no request ${action.request_id}` };
    const revision = (state?.revision ?? 0) + 1;
    const base = {
      batch_id: `bat_${ctx.actId}`,
      revision,
      command: { act_id: ctx.actId, action, expected_revision: ctx.expectedRevision, principal: ctx.principal },
      admitted_at: ctx.now,
      policy_version: state?.policy_version ?? ctx.policy.version,
    };
    const reviewId = state?.id ?? `rev_${ctx.actId}`;
    if (action.kind === "ObservePR") {
      const changed = state === null || state.subject.key !== action.subject.key;
      return {
        ...base,
        consequences: changed ? [{ kind: "subject_changed", previous_key: state?.subject.key ?? null, subject: action.subject }] : [],
        effects: [
          { effect_id: `eff_${ctx.actId}_1`, kind: "refresh", target: `board:${reviewId}`, payload: null },
          { effect_id: `eff_${ctx.actId}_2`, kind: "refresh", target: `check:${ctx.identity?.display.split("#")[0]}:${action.subject.head_sha}`, payload: null },
          ...(changed
            ? [{ effect_id: `eff_${ctx.actId}_3`, kind: "actionable" as const, target: `summon:req_${ctx.actId}_1`, payload: { text: "@codex review" } }]
            : []),
        ],
      };
    }
    if (action.kind === "GrantRounds") {
      return {
        ...base,
        consequences: [{ kind: "rounds_granted", n: action.n, reason: action.reason }],
        effects: [{ effect_id: `eff_${ctx.actId}_1`, kind: "refresh", target: `board:${reviewId}`, payload: null }],
      };
    }
    return { refused: true, code: "unauthorized", detail: `fake reducer does not model ${action.kind}` };
  };
  const fold = (state: Review | null, batch: Batch): Review => {
    let next: Review;
    if (state === null) {
      const action = batch.command.action as ObservePRAction;
      next = {
        id: `rev_${batch.command.act_id}`,
        key: KEY,
        display: DISPLAY,
        revision: 0,
        policy_version: batch.policy_version,
        subject: action.subject,
        subjects: [],
        lifecycle: action.lifecycle,
        draft: action.draft,
        observed: action.observed,
        requests: [],
        answers: [],
        findings: [],
        holds: [],
        charges: [],
        budget: { rounds_max: 7, granted: 0 },
        episodes: [],
        availability: {},
        exemption: null,
        projection_handles: { board_comment_id: null, check_run_ids: {}, slack_thread_ts: null },
      };
    } else {
      next = structuredClone(state);
    }
    for (const consequence of batch.consequences) {
      if (consequence.kind === "subject_changed") {
        next.subject = consequence.subject;
        next.subjects = [...next.subjects, consequence.subject];
      } else if (consequence.kind === "rounds_granted") {
        next.budget = { ...next.budget, granted: next.budget.granted + consequence.n };
      }
    }
    next.revision = batch.revision;
    return next;
  };
  const read = (state: Review, ctx: { now: string; policy: Policy }): ReviewState => {
    calls.read.push(ctx);
    const pending = state.requests.filter((request) => request.status === "pending").map((request) => request.id);
    return {
      ...state,
      requirement: { subject_key: state.subject.key, status: "unsatisfied", pending },
      blocking_findings: [],
      advisories: [],
      rounds_consumed: state.charges.length,
      rounds_remaining: state.budget.rounds_max + state.budget.granted - state.charges.length,
      active_holds: [],
      readiness: { ready: false, subject_key: state.subject.key, reasons: [{ requirement_unsatisfied: [state.subject.key] }] },
    };
  };
  const clock = new FakeClock(new Date("2026-09-06T12:00:00.000Z"));
  return { decide, fold, read, clock, calls };
}

function setup(): { db: Database.Database; store: ReviewStore; reducer: ReturnType<typeof fakeReducer> } {
  const db = new Database(":memory:");
  const reducer = fakeReducer();
  const store = new ReviewStore(db, reducer);
  store.putPolicy(KEY.repository_id, policy(1));
  return { db, store, reducer };
}

function open(store: ReviewStore, actId = "obs:run_1", headSha = SHA_A): ReturnType<ReviewStore["apply"]> {
  return store.apply(KEY, { actId, principal: ADAPTER, expectedRevision: null, action: observe(headSha), display: DISPLAY });
}

function refused(receipt: Receipt): RefusedOutcome {
  assert.ok("refused" in receipt.outcome, `expected a refusal, got ${JSON.stringify(receipt.outcome)}`);
  return receipt.outcome;
}

function applied(receipt: Receipt): AppliedOutcome {
  assert.ok("applied" in receipt.outcome, `expected applied, got ${JSON.stringify(receipt.outcome)}`);
  return receipt.outcome;
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

// §9.3: the DDL is idempotent (IF NOT EXISTS) and never touches an existing table.
test("migrate creates the §9.3 tables and indexes idempotently", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE deliveries (delivery_id INTEGER PRIMARY KEY)");
  const reducer = fakeReducer();
  new ReviewStore(db, reducer);
  new ReviewStore(db, reducer);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
  for (const name of ["reviews", "review_batches", "review_attempts", "review_effects", "github_inbox", "source_records", "review_policies", "operators", "review_projection_handles", "review_transport"]) {
    assert.ok(tables.includes(name), `table ${name}`);
  }
  assert.ok(tables.includes("deliveries"), "an existing broker table is untouched");
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_idx'").all() as Array<{ name: string }>)
    .map((row) => row.name).sort();
  assert.deepEqual(indexes, [
    "github_inbox_unreconciled_idx", "review_effects_status_idx", "review_effects_target_idx", "review_transport_review_idx", "reviews_display_idx", "source_records_review_idx",
  ]);
});

// §4 apply → §5.B3 persist: batch, state cache, effect rows, and the Receipt in one go.
test("apply opens a Review: batch persisted, state cached, effects pending, receipt applied", () => {
  const { db, store, reducer } = setup();
  const receipt = open(store);
  assert.equal(validateReceipt(receipt).ok, true, "receipt conforms");
  assert.equal(receipt.review_id, "rev_obs:run_1");
  assert.deepEqual(receipt.outcome, {
    applied: true, revision_before: 0, revision_after: 1, batch_id: "bat_obs:run_1",
    effects: ["eff_obs:run_1_1", "eff_obs:run_1_2", "eff_obs:run_1_3"],
  });
  assert.equal(reducer.calls.decide.length, 1);
  assert.deepEqual(reducer.calls.decide[0], {
    now: "2026-09-06T12:00:00.000Z", policy: policy(1), actId: "obs:run_1", principal: ADAPTER, expectedRevision: null, meter: null,
    identity: { key: KEY, display: DISPLAY },
  });

  const state = store.get(KEY);
  assert.ok(state !== null);
  assert.equal(state.revision, 1);
  assert.equal(validateReview(state).ok, true, "cached state conforms");
  assert.equal(count(db, "SELECT count(*) AS n FROM review_batches WHERE act_id = ?", "obs:run_1"), 1);
  const batchRow = db.prepare("SELECT command_json, consequences_json, policy_version FROM review_batches WHERE act_id = ?").get("obs:run_1") as { command_json: string; consequences_json: string; policy_version: number };
  assert.equal((JSON.parse(batchRow.command_json) as { act_id: string }).act_id, "obs:run_1");
  assert.equal((JSON.parse(batchRow.consequences_json) as unknown[]).length, 1);
  assert.equal(batchRow.policy_version, 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM review_effects WHERE status = 'pending' AND review_id = ?", "rev_obs:run_1"), 3);
  assert.equal(count(db, "SELECT count(*) AS n FROM review_attempts"), 0);

  const [batch] = store.batches(KEY);
  assert.ok(batch !== undefined);
  assert.equal(validateBatch(batch).ok, true, "a stored batch round-trips through the contract");
  assert.deepEqual(batch.effects.map((effect) => effect.effect_id), applied(receipt).effects);

  assert.deepEqual(store.findByDisplay(DISPLAY), KEY);
  assert.equal(store.findByDisplay("Owner/repo#8"), null);
  const view = store.read(KEY);
  assert.ok(view !== null);
  assert.equal(validateReviewState(view).ok, true);
  assert.equal(reducer.calls.read.at(-1)?.policy.version, 1);
  assert.equal(store.read({ repository_id: 1, pr_number: 1 }), null);
});

// §5.B2: the act id is the key — an admitted act answers with its original batch, nothing is re-done.
test("B2 same act_id ⇒ replayed with the original batch id, no new effects, decide not called", () => {
  const { db, store, reducer } = setup();
  open(store);
  reducer.clock.advance(60_000);
  const again = store.apply(KEY, { actId: "obs:run_1", principal: ADAPTER, expectedRevision: null, action: observe(SHA_C), display: DISPLAY });
  assert.deepEqual(again, {
    review_id: "rev_obs:run_1", act_id: "obs:run_1",
    outcome: { replayed: true, revision_at_apply: 1, batch_id: "bat_obs:run_1" },
  });
  assert.equal(validateReceipt(again).ok, true);
  assert.equal(reducer.calls.decide.length, 1, "decide ran once, for the original act");
  assert.equal(store.get(KEY)?.revision, 1);
  assert.equal(store.get(KEY)?.subject.head_sha, SHA_A, "the replayed act's payload changes nothing");
  assert.equal(count(db, "SELECT count(*) AS n FROM review_effects"), 3);
});

// §5.B4: a refusal is an attempt row — visible, non-revising — carrying the current state.
test("B4 refusal from decide ⇒ attempt row, revision unchanged, state is read()", () => {
  const { db, store, reducer } = setup();
  open(store);
  const cancel = store.apply(KEY, {
    actId: "01J_CANCEL", principal: OPERATOR, expectedRevision: 1,
    action: { kind: "CancelRequest", request_id: "req_nope", reason: "gone" },
  });
  assert.equal(validateReceipt(cancel).ok, true);
  assert.equal(cancel.review_id, "rev_obs:run_1");
  assert.equal(refused(cancel).code, "no_such_target");
  assert.equal(refused(cancel).current_revision, 1);
  assert.equal(refused(cancel).state?.revision, 1);
  assert.equal(refused(cancel).state?.readiness.ready, false);
  assert.equal(reducer.calls.read.length, 1, "state on the refusal comes from read()");
  assert.equal(store.get(KEY)?.revision, 1);
  const attempt = db.prepare("SELECT review_id, act_id, refusal_json FROM review_attempts").get() as { review_id: string; act_id: string; refusal_json: string };
  assert.equal(attempt.review_id, "rev_obs:run_1");
  assert.equal(attempt.act_id, "01J_CANCEL");
  assert.equal((JSON.parse(attempt.refusal_json) as Refusal).code, "no_such_target");
  assert.equal(count(db, "SELECT count(*) AS n FROM review_batches"), 1);
  // The refused act id was never admitted, so a corrected resubmission under it is not a replay (§E2).
  const corrected = store.apply(KEY, { actId: "01J_CANCEL", principal: OPERATOR, expectedRevision: 1, action: grant(1) });
  assert.equal(applied(corrected).revision_after, 2);
});

// §E2: Ajv runs before the reducer; a shape defect never reaches decide.
test("E2 malformed action is refused before decide, with an attempt row", () => {
  const { db, store, reducer } = setup();
  open(store);
  const malformed = store.apply(KEY, {
    actId: "01J_BAD", principal: OPERATOR, expectedRevision: 1,
    action: { kind: "GrantRounds", n: "2", reason: "typed wrong" } as unknown as Action,
  });
  assert.equal(refused(malformed).code, "malformed");
  assert.match(refused(malformed).detail, /^Action: /);
  assert.equal(refused(malformed).current_revision, 1);
  assert.equal(reducer.calls.decide.length, 1, "only the opening act reached decide");
  assert.equal(count(db, "SELECT count(*) AS n FROM review_attempts WHERE act_id = ?", "01J_BAD"), 1);

  // Before the Review exists the refusal has no id and no state (§4 Receipt nullability).
  const early = store.apply({ repository_id: 42, pr_number: 99 }, {
    actId: "01J_EARLY", principal: OPERATOR, expectedRevision: 0, action: { kind: "GrantRounds" } as unknown as Action,
  });
  assert.equal(early.review_id, null);
  assert.equal(refused(early).code, "malformed");
  assert.equal(refused(early).state, null);
  assert.equal(validateReceipt(early).ok, true);
});

// Module map §3: before the Review exists, only ObservePR has a target.
test("no_such_target with review_id null when the Review does not exist and the action is not ObservePR", () => {
  const { db, store, reducer } = setup();
  const receipt = store.apply(KEY, { actId: "01J_G", principal: OPERATOR, expectedRevision: 0, action: grant(1) });
  assert.equal(receipt.review_id, null);
  assert.equal(refused(receipt).code, "no_such_target");
  assert.equal(refused(receipt).current_revision, 0);
  assert.equal(refused(receipt).state, null);
  assert.equal(reducer.calls.decide.length, 0);
  const attempt = db.prepare("SELECT review_id FROM review_attempts WHERE act_id = ?").get("01J_G") as { review_id: string | null };
  assert.equal(attempt.review_id, null);
  assert.equal(validateReceipt(receipt).ok, true);
});

// §5.B1: seat and operator acts are fenced on the revision; adapter acts carry null.
test("B1 expected_revision fences seat and operator acts; adapter acts carry null", () => {
  const { db, store, reducer } = setup();
  open(store);
  const stale = store.apply(KEY, { actId: "01J_STALE", principal: SEAT, expectedRevision: 0, action: grant(1) });
  assert.equal(refused(stale).code, "stale_revision");
  assert.equal(refused(stale).current_revision, 1);
  assert.equal(refused(stale).state?.revision, 1, "the refusal carries the current state");
  assert.equal(reducer.calls.decide.length, 1, "a stale act never reaches decide");
  assert.equal(count(db, "SELECT count(*) AS n FROM review_attempts WHERE act_id = ?", "01J_STALE"), 1);

  const nullFence = store.apply(KEY, { actId: "01J_NULL", principal: OPERATOR, expectedRevision: null, action: grant(1) });
  assert.equal(refused(nullFence).code, "stale_revision", "seat/operator must name the revision (§B1)");

  const fresh = store.apply(KEY, { actId: "01J_FRESH", principal: OPERATOR, expectedRevision: 1, action: grant(1) });
  assert.equal(applied(fresh).revision_after, 2);
  assert.equal(reducer.calls.decide.at(-1)?.expectedRevision, 1);

  const adapter = store.apply(KEY, { actId: "obs:run_2", principal: ADAPTER, expectedRevision: null, action: observe(SHA_A) });
  assert.equal(applied(adapter).revision_after, 3);
  assert.equal(reducer.calls.decide.at(-1)?.expectedRevision, null);
  assert.equal(reducer.calls.decide.at(-1)?.identity?.display, DISPLAY, "display comes from the row once the Review exists");
});

// §5.B3 / §11 #7: review_batches is the truth; replay folds it without decide under another clock and policy.
test("replay rebuilds state_json from the batches without decide, under a different clock and policy", () => {
  const { store, reducer } = setup();
  open(store);
  store.apply(KEY, { actId: "01J_G1", principal: OPERATOR, expectedRevision: 1, action: grant(2) });
  store.apply(KEY, { actId: "obs:run_2", principal: ADAPTER, expectedRevision: null, action: observe(SHA_C) });
  store.apply(KEY, { actId: "01J_G2", principal: OPERATOR, expectedRevision: 3, action: grant(1) });
  const cached = store.get(KEY);
  assert.ok(cached !== null);
  assert.equal(cached.revision, 4);
  assert.equal(cached.budget.granted, 3);
  assert.equal(cached.subject.head_sha, SHA_C);

  const decideCalls = reducer.calls.decide.length;
  reducer.clock.advance(7 * 24 * 60 * 60_000);
  store.putPolicy(KEY.repository_id, policy(2));
  const replayed = store.replay(KEY);
  assert.deepEqual(replayed, cached, "state_json equals the fold of the batch log");
  assert.equal(reducer.calls.decide.length, decideCalls, "replay never calls decide");
  assert.equal(store.batches(KEY).map((batch) => batch.revision).join(","), "1,2,3,4");
  assert.throws(() => store.replay({ repository_id: 1, pr_number: 1 }), ReviewStoreError);
});

// A reducer that disagrees with the store about the revision leaves no trace: the transaction rolls back.
test("apply is one transaction: a mis-numbered batch persists nothing", () => {
  const { db, store, reducer } = setup();
  open(store);
  const decide = reducer.decide;
  reducer.decide = (state, action, ctx) => {
    const result = decide(state, action, ctx);
    return "refused" in result ? result : { ...result, revision: result.revision + 5 };
  };
  assert.throws(
    () => store.apply(KEY, { actId: "01J_SKEW", principal: OPERATOR, expectedRevision: 1, action: grant(1) }),
    ReviewStoreError,
  );
  assert.equal(store.get(KEY)?.revision, 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM review_batches"), 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM review_effects"), 3);
});

test("opening a Review without a display is a caller error, not a silent default", () => {
  const { store } = setup();
  assert.throws(
    () => store.apply(KEY, { actId: "obs:run_1", principal: ADAPTER, expectedRevision: null, action: observe(SHA_A) }),
    ReviewStoreError,
  );
  assert.equal(store.get(KEY), null);
});

// §6.I: a Review keeps the policy version it opened under; a new Review takes the latest.
test("I policy versions: a Review keeps its version, putPolicy is dense, a new Review takes the latest", () => {
  const { store, reducer } = setup();
  open(store);
  assert.throws(() => store.putPolicy(KEY.repository_id, policy(3)), ReviewStoreError);
  assert.throws(() => store.putPolicy(KEY.repository_id, policy(1)), ReviewStoreError);
  store.putPolicy(KEY.repository_id, policy(2));
  assert.equal(store.policy(KEY.repository_id, "latest")?.version, 2);
  assert.equal(store.policy(KEY.repository_id, 1)?.version, 1);
  assert.equal(store.policy(KEY.repository_id, 9), null);
  assert.equal(store.policy(999, "latest"), null);

  store.apply(KEY, { actId: "01J_G", principal: OPERATOR, expectedRevision: 1, action: grant(1) });
  assert.equal(reducer.calls.decide.at(-1)?.policy.version, 1, "decide reads the Review's own version");
  store.read(KEY);
  assert.equal(reducer.calls.read.at(-1)?.policy.version, 1);

  const other: ReviewKey = { repository_id: 42, pr_number: 8 };
  store.apply(other, { actId: "obs:run_9", principal: ADAPTER, expectedRevision: null, action: observe(SHA_A), display: "Owner/repo#8" });
  assert.equal(reducer.calls.decide.at(-1)?.policy.version, 2, "a new Review opens under the latest");
  assert.equal(store.get(other)?.policy_version, 2);

  const unconfigured = store.apply({ repository_id: 77, pr_number: 1 }, {
    actId: "obs:run_77", principal: ADAPTER, expectedRevision: null, action: observe(SHA_A), display: "Other/repo#1",
  });
  assert.equal(refused(unconfigured).code, "no_such_target");
  assert.match(refused(unconfigured).detail, /no review policy/);
});

// §8.1: one row per target — newest refresh, oldest actionable; claims are exclusive.
test("effects: pendingByTarget never returns two rows for one target; claim is exclusive", () => {
  const { store, reducer } = setup();
  open(store);
  store.apply(KEY, { actId: "01J_G1", principal: OPERATOR, expectedRevision: 1, action: grant(1) });
  store.apply(KEY, { actId: "01J_G2", principal: OPERATOR, expectedRevision: 2, action: grant(1) });
  const now = reducer.clock.now().toISOString();
  const pending = store.effects.pendingByTarget(now);
  const targets = pending.map((effect) => effect.target);
  assert.equal(new Set(targets).size, targets.length, "one row per target");
  const board = pending.find((effect) => effect.target === "board:rev_obs:run_1");
  assert.equal(board?.effect_id, "eff_01J_G2_1", "the newest pending refresh for the board");
  assert.equal(board?.revision, 3);
  const summon = pending.find((effect) => effect.target === "summon:req_obs:run_1_1");
  assert.equal(summon?.effect_id, "eff_obs:run_1_3");
  assert.deepEqual(summon?.payload, { text: "@codex review" });
  assert.equal(summon?.status, "pending");
  assert.equal(store.effects.pendingByTarget(now, 1).length, 1);

  const claimed = store.effects.claim("eff_01J_G2_1");
  assert.equal(claimed?.status, "claimed");
  assert.equal(store.effects.claim("eff_01J_G2_1"), null, "a second claim loses");
  assert.equal(store.effects.claim("eff_nope"), null);
  assert.ok(!store.effects.pendingByTarget(now).some((effect) => effect.effect_id === "eff_01J_G2_1"));
  // With the newest claimed, the older board refreshes are still pending and the next-newest surfaces.
  assert.equal(store.effects.pendingByTarget(now).find((effect) => effect.target === "board:rev_obs:run_1")?.effect_id, "eff_01J_G1_1");
});

test("effects: markSent / markObsolete / markFailed with backoff and a terminal bound", () => {
  const { db, store, reducer } = setup();
  open(store);
  store.effects.claim("eff_obs:run_1_1");
  store.effects.markSent("eff_obs:run_1_1");
  store.effects.claim("eff_obs:run_1_3");
  store.effects.markObsolete("eff_obs:run_1_3");
  const rows = db.prepare("SELECT effect_id, status, sent_at, obsolete_at FROM review_effects ORDER BY rowid").all() as Array<{ effect_id: string; status: string; sent_at: string | null; obsolete_at: string | null }>;
  assert.deepEqual(rows.map((row) => [row.effect_id, row.status]), [
    ["eff_obs:run_1_1", "sent"], ["eff_obs:run_1_2", "pending"], ["eff_obs:run_1_3", "obsolete"],
  ]);
  assert.equal(rows[0]?.sent_at, "2026-09-06T12:00:00.000Z");
  assert.equal(rows[2]?.obsolete_at, "2026-09-06T12:00:00.000Z");

  const now = reducer.clock.now().toISOString();
  store.effects.claim("eff_obs:run_1_2");
  const later = new Date(reducer.clock.now().getTime() + 5_000).toISOString();
  store.effects.markFailed("eff_obs:run_1_2", later);
  const failedOnce = db.prepare("SELECT status, attempts, next_attempt_at FROM review_effects WHERE effect_id = ?").get("eff_obs:run_1_2") as { status: string; attempts: number; next_attempt_at: string };
  assert.deepEqual(failedOnce, { status: "pending", attempts: 1, next_attempt_at: later });
  assert.equal(store.effects.pendingByTarget(now).length, 0, "not due yet");
  assert.equal(store.effects.pendingByTarget(later).length, 1, "due at next_attempt_at");

  for (let attempt = 1; attempt < REVIEW_EFFECT_MAX_ATTEMPTS; attempt += 1) store.effects.markFailed("eff_obs:run_1_2", later);
  const exhausted = db.prepare("SELECT status, attempts, next_attempt_at FROM review_effects WHERE effect_id = ?").get("eff_obs:run_1_2") as { status: string; attempts: number; next_attempt_at: string | null };
  assert.deepEqual(exhausted, { status: "failed", attempts: REVIEW_EFFECT_MAX_ATTEMPTS, next_attempt_at: null });
  assert.equal(store.effects.pendingByTarget(later).length, 0);
  assert.throws(() => store.effects.markSent("eff_nope"), ReviewStoreError);
  assert.throws(() => store.effects.markFailed("eff_nope", later), ReviewStoreError);
});

// §8.1 / §11 #5 (store half): pending refreshes for one target coalesce into the newest.
test("effects: coalesceRefresh keeps only the newest pending refresh per target", () => {
  const { db, store } = setup();
  open(store);
  store.apply(KEY, { actId: "01J_G1", principal: OPERATOR, expectedRevision: 1, action: grant(1) });
  store.apply(KEY, { actId: "01J_G2", principal: OPERATOR, expectedRevision: 2, action: grant(1) });
  store.effects.claim("eff_01J_G1_1");
  assert.equal(store.effects.coalesceRefresh("board:rev_obs:run_1"), 1, "only pending rows are coalesced");
  const rows = db.prepare("SELECT effect_id, status FROM review_effects WHERE target = ? ORDER BY rowid").all("board:rev_obs:run_1") as Array<{ effect_id: string; status: string }>;
  assert.deepEqual(rows, [
    { effect_id: "eff_obs:run_1_1", status: "obsolete" },
    { effect_id: "eff_01J_G1_1", status: "claimed" },
    { effect_id: "eff_01J_G2_1", status: "pending" },
  ]);
  assert.equal(store.effects.coalesceRefresh("board:rev_obs:run_1"), 0);
  assert.equal(store.effects.coalesceRefresh("summon:req_obs:run_1_1"), 0, "actionable rows never coalesce");
  assert.equal(db.prepare("SELECT status FROM review_effects WHERE effect_id = ?").pluck().get("eff_obs:run_1_3"), "pending");
});

// §7: persist-before-ack; GitHub redelivers, the inbox records a delivery once.
test("inbox: duplicate delivery_id ⇒ false; unreconciled drains in order; markReconciled stamps the run", () => {
  const { store } = setup();
  const delivery = { deliveryId: "d-1", event: "pull_request", repositoryId: 42, prNumber: 7, payload: { action: "synchronize" }, receivedAt: "2026-09-06T12:00:00.000Z" };
  assert.equal(store.inbox.put(delivery), true);
  assert.equal(store.inbox.put({ ...delivery, payload: { action: "other" } }), false);
  assert.equal(store.inbox.put({ ...delivery, deliveryId: "d-2", repositoryId: null, prNumber: null, event: "installation_repositories" }), true);
  const pending = store.inbox.unreconciled();
  assert.deepEqual(pending.map((row) => row.deliveryId), ["d-1", "d-2"]);
  assert.deepEqual(pending[0]?.payload, { action: "synchronize" }, "the first body wins");
  assert.equal(pending[1]?.repositoryId, null);
  assert.equal(store.inbox.unreconciled(1).length, 1);
  store.inbox.markReconciled(["d-1"], "run_1");
  assert.deepEqual(store.inbox.unreconciled().map((row) => row.deliveryId), ["d-2"]);
  store.inbox.markReconciled(["d-1", "d-2"], "run_2");
  assert.equal(store.inbox.unreconciled().length, 0);
});

// §7 step 2-3: records keyed (record_key, version); admission and classification live on the record.
test("source records: upsert new/same/updated; unadmitted; markAdmitted; setClassification", () => {
  const { store } = setup();
  const record = { recordKey: "review:100", version: "2026-09-06T12:00:00Z", reviewId: "rev_1", authorLogin: "chatgpt-codex-connector[bot]", body: { text: "LGTM" } };
  assert.equal(store.sourceRecords.upsert(record), "new");
  assert.equal(store.sourceRecords.upsert(record), "same");
  assert.equal(store.sourceRecords.upsert({ ...record, body: { text: "LGTM (edited)" } }), "updated");
  assert.equal(store.sourceRecords.upsert({ ...record, version: "2026-09-06T13:00:00Z" }), "new", "a new version is a new row");
  assert.equal(store.sourceRecords.upsert({ ...record, recordKey: "review:101", reviewId: "rev_2" }), "new");

  const unadmitted = store.sourceRecords.unadmitted("rev_1");
  assert.deepEqual(unadmitted.map((row) => [row.recordKey, row.version]), [
    ["review:100", "2026-09-06T12:00:00Z"], ["review:100", "2026-09-06T13:00:00Z"],
  ]);
  assert.deepEqual(unadmitted[0]?.body, { text: "LGTM (edited)" });
  assert.equal(unadmitted[0]?.classification, null);

  store.sourceRecords.setClassification("review:100", "2026-09-06T12:00:00Z", "clean");
  store.sourceRecords.markAdmitted("review:100", "2026-09-06T12:00:00Z", "src:review:100:2026-09-06T12:00:00Z");
  assert.equal(store.sourceRecords.upsert({ ...record, body: { text: "LGTM (edited)" } }), "same");
  const remaining = store.sourceRecords.unadmitted("rev_1");
  assert.deepEqual(remaining.map((row) => row.version), ["2026-09-06T13:00:00Z"]);
  assert.equal(store.sourceRecords.upsert({ ...record, body: { text: "again" } }), "updated");
  assert.equal(store.sourceRecords.unadmitted("rev_1").length, 1, "a body refresh does not un-admit");
  assert.throws(() => store.sourceRecords.markAdmitted("review:999", "v", "act"), ReviewStoreError);
  assert.throws(() => store.sourceRecords.setClassification("review:999", "v", "clean"), ReviewStoreError);
});

// §5.A2: the operator credential is returned once and only its digest is stored.
test("operators: create returns the raw token once and never stores it; verify is by digest", () => {
  const { db, store } = setup();
  const token = store.operators.create("hakon");
  assert.ok(token.length >= 40);
  const row = db.prepare("SELECT token_hash FROM operators WHERE operator_id = ?").get("hakon") as { token_hash: string };
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, token);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM operators").all()).includes(token), "the raw token is nowhere in the table");
  assert.equal(store.operators.verify(token), "hakon");
  assert.equal(store.operators.verify(`${token}x`), null);
  assert.equal(store.operators.verify(""), null);
  const rotated = store.operators.create("hakon");
  assert.notEqual(rotated, token);
  assert.equal(store.operators.verify(token), null, "rotation retires the old token");
  assert.equal(store.operators.verify(rotated), "hakon");
  assert.equal(count(db, "SELECT count(*) AS n FROM operators"), 1);
});

// §7 bounded reconcile: pending requests keep a Review active; otherwise the 24 h activity window.
test("active(since) lists Reviews with a pending request or recent activity", () => {
  const { db, store, reducer } = setup();
  open(store);
  const quiet: ReviewKey = { repository_id: 42, pr_number: 8 };
  reducer.clock.advance(60_000);
  store.apply(quiet, { actId: "obs:run_8", principal: ADAPTER, expectedRevision: null, action: observe(SHA_A), display: "Owner/repo#8" });
  assert.deepEqual(store.active("2026-09-06T12:00:30.000Z"), [quiet]);
  assert.deepEqual(store.active("2026-09-06T12:00:00.000Z"), [quiet, KEY]);
  // A pending request (planted in the cache, as the real reducer would fold it) keeps the Review active.
  const state = store.get(KEY);
  assert.ok(state !== null);
  state.requests.push({
    id: "req_1", kind: "review", mode: "initial", assignee: "codex", subject_key: state.subject.key, required: true, names: [],
    status: "pending", opened_by: { kind: "system", caused_by: "obs:run_1" }, opened_at: "2026-09-06T12:00:00.000Z", reason: "routing_by_round.first",
    supersedes: null, transport: [], retransports: [], transport_exhausted: false, cancellation: null, answered_by: null,
  });
  db.prepare("UPDATE reviews SET state_json = ? WHERE review_id = ?").run(JSON.stringify(state), state.id);
  assert.deepEqual(store.active("2026-09-06T12:00:30.000Z"), [quiet, KEY]);
});

test("ApplyInput.meter reaches decide as ctx.meter", () => {
  const { store, reducer } = setup();
  const input: ApplyInput = { actId: "obs:run_1", principal: ADAPTER, expectedRevision: null, action: observe(SHA_A), display: DISPLAY, meter: { reading: 3, threshold: 5 } };
  store.apply(KEY, input);
  assert.deepEqual(reducer.calls.decide[0]?.meter, { reading: 3, threshold: 5 });
});

// §8.1 / §3.3 / §6.D5: what a port answered is a projection fact — recorded beside the fold, merged
// into every read, never replayed (state_json stays the pure fold the §11 #7 comparison needs).
test("projection facts: handles are recorded outside the fold, merged into get/read/readById, absent from replay and state_json", () => {
  const { db, store } = setup();
  const reviewId = String(applied(open(store)).batch_id).replace(/^bat_/, "rev_");
  assert.deepEqual(store.get(KEY)?.projection_handles, { board_comment_id: null, check_run_ids: {}, slack_thread_ts: null });

  store.projections.recordBoardComment(reviewId, 500);
  store.projections.recordCheckRun(reviewId, SHA_A, 9);
  store.projections.recordSlackThread(reviewId, "1700.5");
  const expected = { board_comment_id: 500, check_run_ids: { [SHA_A]: 9 }, slack_thread_ts: "1700.5" };
  assert.deepEqual(store.get(KEY)?.projection_handles, expected, "get merges the handles");
  assert.deepEqual(store.read(KEY)?.projection_handles, expected, "read merges the handles");
  assert.deepEqual(store.readById(reviewId)?.projection_handles, expected, "readById merges the handles");
  assert.deepEqual(store.replay(KEY).projection_handles, { board_comment_id: null, check_run_ids: {}, slack_thread_ts: null }, "replay is the pure fold");
  const cached = JSON.parse(String((db.prepare("SELECT state_json FROM reviews WHERE review_id = ?").get(reviewId) as { state_json: string }).state_json)) as Review;
  assert.deepEqual(cached.projection_handles, { board_comment_id: null, check_run_ids: {}, slack_thread_ts: null }, "state_json never carries a handle");

  // Re-recording replaces: the newest answer from the port wins; a second head gets its own check run.
  store.projections.recordBoardComment(reviewId, 501);
  store.projections.recordCheckRun(reviewId, SHA_B, 10);
  assert.deepEqual(store.get(KEY)?.projection_handles, { board_comment_id: 501, check_run_ids: { [SHA_A]: 9, [SHA_B]: 10 }, slack_thread_ts: "1700.5" });

  // The first board line's outbox row is kept until its ts is known; it is not a contract handle.
  assert.equal(store.projections.slackBoardOutboxId(reviewId), null);
  store.projections.recordSlackBoardOutbox(reviewId, 77);
  assert.equal(store.projections.slackBoardOutboxId(reviewId), 77);
  assert.equal(count(db, "SELECT count(*) AS n FROM review_projection_handles WHERE review_id = ?", reviewId), 5);

  // A transport reference must name a request the Review has; otherwise the fact is a defect, refused loudly on read.
  store.projections.recordTransport(reviewId, "eff_x", "req_missing", { delivery_id: 3 });
  assert.throws(() => store.get(KEY), ReviewStoreError);
});

// §7 step 3: `unknown` is recorded on the source record and surfaced on the board, never promoted.
test("source records: unknown(reviewId) lists the live records classified unknown with url and excerpt; admission removes them", () => {
  const { store } = setup();
  open(store);
  const reviewId = "rev_obs:run_1";
  const record = (id: number, version: string) => ({
    recordKey: `issue_comment:${id}`,
    version,
    reviewId,
    authorLogin: "chatgpt-codex-connector[bot]",
    body: { id, html_url: `https://github.com/Owner/repo/pull/7#issuecomment-${id}`, body: "\n### Summary\nA work report, not a review.\n" },
  });
  store.sourceRecords.upsert(record(55, "v1"));
  store.sourceRecords.upsert(record(56, "v1"));
  assert.deepEqual(store.sourceRecords.unknown(reviewId), [], "nothing classified yet");
  store.sourceRecords.setClassification("issue_comment:55", "v1", "unknown");
  store.sourceRecords.setClassification("issue_comment:56", "v1", "clean");
  assert.deepEqual(store.sourceRecords.unknown(reviewId), [{
    recordKey: "issue_comment:55",
    version: "v1",
    authorLogin: "chatgpt-codex-connector[bot]",
    htmlUrl: "https://github.com/Owner/repo/pull/7#issuecomment-55",
    excerpt: "### Summary",
  }]);
  // An edited record supersedes its old version; a version later admitted is no longer unknown.
  store.sourceRecords.setClassification("issue_comment:55", "v1", "superseded");
  store.sourceRecords.upsert(record(55, "v2"));
  store.sourceRecords.setClassification("issue_comment:55", "v2", "unknown");
  assert.deepEqual(store.sourceRecords.unknown(reviewId).map((r) => r.version), ["v2"]);
  store.sourceRecords.markAdmitted("issue_comment:55", "v2", "src:issue_comment:55:v2");
  assert.deepEqual(store.sourceRecords.unknown(reviewId), []);
});


test("startup retries an interrupted claimed effect after backoff", () => {
  const { db, store, reducer } = setup();
  open(store);
  const id = "eff_obs:run_1_2";
  assert.ok(store.effects.claim(id));
  const reopened = new ReviewStore(db, reducer);
  const recovered = db.prepare("SELECT status, attempts, next_attempt_at FROM review_effects WHERE effect_id = ?").get(id) as { status: string; attempts: number; next_attempt_at: string };
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.attempts, 1);
  assert.ok(recovered.next_attempt_at > reducer.clock.now().toISOString());
  assert.ok(reopened.effects.pendingByTarget(recovered.next_attempt_at).some(row => row.effect_id === id));
  db.close();
});
