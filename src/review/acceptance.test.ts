/**
 * §11 acceptance, run through the composed core (module map §8): the real `BrokerStore`
 * database, the real `ReviewStore` with the real `decide`/`fold`/`read`, the real
 * `ReviewPublisher` over fake GitHub and Slack ports, and `reconcile` over a fake
 * `GitHubPort`. Each builder proved its module in isolation; this file proves the seams
 * carry every sequence end to end: act → transition → durable state → read → projection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BrokerStore } from "../broker/store.js";
import type { Clock } from "../time.js";
import type {
  Action,
  AppliedOutcome,
  ExternalResult,
  Finding,
  ObservePRAction,
  Policy,
  Principal,
  Receipt,
  RefusedOutcome,
  ReplayedOutcome,
  Review,
  ReviewKey,
  ReviewReport,
  ReviewState,
} from "./contract.js";
import { validateReview, validateReviewState } from "./contract.js";
import type { GitHubChangedFile, GitHubPort, GitHubPullRequest, GitHubRecord } from "./github/port.js";
import { reconcile } from "./github/reconcile.js";
import { ReviewPublisher, type ReviewGitHubPort, type SystemWakePort } from "./publisher.js";
import { decide, fold, read } from "./reducer.js";
import { ReviewStore } from "./store.js";

// ---------------------------------------------------------------------------------------
// Fixtures (contract-valid; the store runs Ajv on every act)
// ---------------------------------------------------------------------------------------

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);
const BASE = "1".repeat(40);
const MERGE_BASE = "2".repeat(40);
const DIFF = "d".repeat(64);
const FP = (n: number): string => `ifp-sha256:${n.toString(16).padStart(64, "0")}`;
const T0 = "2026-09-06T12:00:00.000Z";

const KEY: ReviewKey = { repository_id: 1, pr_number: 7 };
const DISPLAY = "Owner/repo#7";

const POLICY: Policy = {
  version: 1,
  rounds_max: 7,
  reviewer_set: ["ariadne", "theoros"],
  substitute_actor: "ariadne",
  burn_actor: "talos",
  retrospective_actor: "theoros",
  closure_by_seat: true,
  routing_by_round: { first: "codex", later: "ariadne" },
  exempt_roots: ["docs/"],
  author_aliases: { "talos-weave": "talos" },
  stall_window_s: 1200,
  transport_bound: 2,
  codex_meter: null,
  slack: { channel_id: "C0123ABCD" },
};
/** First round to a seat, for the sequences that need a seat answer. */
const SEAT_POLICY: Policy = { ...POLICY, routing_by_round: { first: "ariadne", later: "theoros" } };
const TIGHT_POLICY: Policy = { ...SEAT_POLICY, rounds_max: 1 };

const ADAPTER: Principal = { kind: "adapter", source: "github", reconcile_run: "run1", event_login: "chatgpt-codex-connector[bot]" };
const OPERATOR: Principal = { kind: "operator", id: "hakon" };
const seat = (actor: string): Principal => ({ kind: "seat", actor, custody: { delivery_id: 1 } });

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

interface ObserveOverrides {
  head?: string;
  lifecycle?: ObservePRAction["lifecycle"];
  draft?: boolean;
  mergeable?: boolean | null;
}

function observe(o: ObserveOverrides = {}): ObservePRAction {
  const head = o.head ?? H1;
  return {
    kind: "ObservePR",
    lifecycle: o.lifecycle ?? "open",
    draft: o.draft ?? false,
    observed: {
      title: "Fix x",
      author_login: "talos-weave",
      head_ref: "feature",
      base_sha_now: BASE,
      mergeable: o.mergeable === undefined ? true : o.mergeable,
      seen_at: T0,
    },
    subject: {
      key: `${head}:main`,
      head_sha: head,
      base_ref: "main",
      base_sha_at_first_sight: BASE,
      merge_base_sha: MERGE_BASE,
      diff_sha256: DIFF,
      changed_paths: ["src/x.py"],
      author: { kind: "seat", actor: "talos" },
      first_seen_at: T0,
    },
  };
}

function rkFinding(id: string, o: Partial<Finding> & { fp?: number } = {}): Finding {
  return {
    id,
    fingerprint: FP(o.fp ?? 1),
    semantic_key: `behavior; entry=${id}; contract=returns the persisted value`,
    title: o.title ?? `Finding ${id}`,
    priority: o.priority ?? "P2",
    disposition: o.disposition ?? "must-fix",
    confidence: "high",
    contract_basis: { authority: "data-integrity-invariant", expectation: "x", reference: "KRA-1" },
    diff_anchor: { path: "src/x.py", start_line: 10, end_line: 12, note: null },
    look_here_first: [{ path: "src/x.py", start_line: 10, end_line: 12, note: null }],
    evidence: [{ kind: "preimage-control", statement: "seen", command: null, control: null, observed: null, coordinates: [] }],
    failure: "The changed branch drops the durable value.",
    falsifier: { description: "d", status: "demonstrated", command: null, control: null, expected_failure: null },
    impact: "A false total downstream.",
    introduced_by: "The diff added an early return.",
    reachability: "Replay enters this branch after a crash.",
    repair_boundary: "Consult durable evidence first.",
    ...(o.parent_fingerprint !== undefined ? { parent_fingerprint: o.parent_fingerprint } : {}),
  };
}

let reports = 0;
function report(reviewer: string, o: Partial<ReviewReport> & { head?: string } = {}): ReviewReport {
  const { head, ...rest } = o;
  const findings = rest.findings ?? [];
  const mode = rest.mode ?? "initial";
  const blockers = findings.some((f) => f.disposition === "must-fix");
  reports += 1;
  const base: ReviewReport = {
    schema_version: "1",
    report_id: `report-${reports}`,
    repository: "Owner/repo",
    pr_number: 7,
    head_sha: head ?? H1,
    base_sha: BASE,
    merge_base_sha: MERGE_BASE,
    chain_id: "Owner/repo#7:aaaa",
    packet_scope_fingerprint: `scope-sha256:${"f".repeat(64)}`,
    reviewer,
    author: "talos",
    mode,
    generation: mode === "initial" ? 0 : 1,
    automatic_chain_terminal: mode === "initial" ? !blockers : true,
    completion: "complete",
    orchestration: "single-reviewer",
    orchestration_reason: "one seam",
    recommendation: blockers ? "changes-requested" : "pass",
    findings,
    coverage: [],
    created_at: T0,
    ...(mode === "initial" ? {} : { parent_report_id: "report-0", parent_resolution_id: "res-0" }),
  };
  return { ...base, ...rest };
}

function answer(requestId: string, subjectKey: string, r: ReviewReport): Action {
  return { kind: "Answer", request_id: requestId, subject_key: subjectKey, submission: { arm: "reviewkit", report: r } };
}

function external(o: Partial<ExternalResult> & { comments?: Array<{ id: number; title?: string }> } = {}): Action {
  const { comments, ...rest } = o;
  return {
    kind: "AdmitExternalResult",
    result: {
      schema_version: "1",
      source: "codex",
      reviewed_head: H1,
      verdict: comments === undefined || comments.length === 0 ? "clean" : "findings",
      findings: (comments ?? []).map((c) => ({ source_comment_id: c.id, path: "src/x.py", line: 12, priority: "P1", title: c.title ?? `Codex ${c.id}`, body: "…" })),
      source_record: { kind: "review", id: 5001, version: T0 },
      submitted_at: T0,
      ...rest,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------------------

class FakeSlack implements SystemWakePort {
  wakes: Array<{ actor: string; channelId: string; threadTs: string | null; text: string; dedupeKey: string }> = [];
  lines: Array<{ channelId: string; threadTs: string | null; text: string }> = [];
  mintSystemWake(input: { actor: string; channelId: string; threadTs: string | null; text: string; dedupeKey: string }): { deliveryId: number } {
    const existing = this.wakes.findIndex((w) => w.dedupeKey === input.dedupeKey);
    if (existing >= 0) return { deliveryId: existing + 1 };
    this.wakes.push(input);
    return { deliveryId: this.wakes.length };
  }
  postBoardLine(input: { channelId: string; threadTs: string | null; text: string }): { outboxId: number } {
    this.lines.push(input);
    return { outboxId: this.lines.length };
  }
}

class FakeGitHub implements ReviewGitHubPort {
  checks: Array<{ headSha: string; conclusion: "success" | "failure"; title: string }> = [];
  boards: string[] = [];
  threads: Array<{ commentId: number; op: "resolve" | "unresolve" }> = [];
  comments: string[] = [];
  async createOrUpdateCheckRun(input: { headSha: string; conclusion: "success" | "failure"; title: string }): Promise<{ checkRunId: number }> {
    this.checks.push({ headSha: input.headSha, conclusion: input.conclusion, title: input.title });
    return { checkRunId: this.checks.length };
  }
  async createOrUpdateBoardComment(input: { body: string }): Promise<{ commentId: number }> {
    this.boards.push(input.body);
    return { commentId: 500 };
  }
  async resolveThread(input: { commentId: number }): Promise<void> { this.threads.push({ commentId: input.commentId, op: "resolve" }); }
  async unresolveThread(input: { commentId: number }): Promise<void> { this.threads.push({ commentId: input.commentId, op: "unresolve" }); }
  async postComment(input: { body: string }): Promise<{ commentId: number }> {
    this.comments.push(input.body);
    return { commentId: 700 + this.comments.length };
  }
}

/** The adapter's port for §11 #4: a live PR whose head the test moves. */
class FakeGitHubPort implements GitHubPort {
  pr: GitHubPullRequest;
  pulls = 0;
  constructor(headSha: string) {
    this.pr = {
      repositoryId: KEY.repository_id, prNumber: KEY.pr_number, owner: "Owner", repo: "repo", title: "Fix x", authorLogin: "talos-weave",
      draft: false, state: "open", merged: false, mergeable: true, headSha, headRef: "feature", baseRef: "main", baseSha: BASE, mergeBaseSha: MERGE_BASE, etag: null,
    };
  }
  async getPullRequest(): Promise<GitHubPullRequest | "not_modified"> { this.pulls += 1; return this.pr; }
  async listReviews(): Promise<GitHubRecord[]> { return []; }
  async listReviewComments(): Promise<GitHubRecord[]> { return []; }
  async listIssueComments(): Promise<GitHubRecord[]> { return []; }
  async listFiles(): Promise<GitHubChangedFile[]> { return [{ path: "src/x.py", sha: "1".repeat(40), status: "modified" }]; }
  async listFailedDeliveries(): Promise<Array<{ id: number; guid: string }>> { return []; }
  async redeliver(): Promise<void> {}
}

// ---------------------------------------------------------------------------------------
// The composed core
// ---------------------------------------------------------------------------------------

class Core {
  readonly clock = new FakeClock(new Date(T0));
  readonly broker = new BrokerStore(":memory:", this.clock);
  readonly store: ReviewStore;
  readonly slack = new FakeSlack();
  readonly github: FakeGitHub | null;
  readonly publisher: ReviewPublisher;
  private acts = 0;

  constructor(policy: Policy = POLICY, options: { github?: boolean } = {}) {
    this.store = new ReviewStore(this.broker.db, { decide, fold, read, clock: this.clock });
    this.store.putPolicy(KEY.repository_id, policy);
    this.github = options.github === false ? null : new FakeGitHub();
    this.publisher = new ReviewPublisher(this.store, { github: this.github, slack: this.slack }, this.clock);
  }

  /** Seat/operator acts carry the current revision unless the test says otherwise (§B1). */
  act(action: Action, principal: Principal, o: { actId?: string; expect?: number | null } = {}): Receipt {
    this.acts += 1;
    const fenced = principal.kind === "seat" || principal.kind === "operator";
    const current = this.store.get(KEY)?.revision ?? 0;
    const expectedRevision = o.expect !== undefined ? o.expect : fenced ? current : null;
    const actId = o.actId ?? (principal.kind === "adapter" ? `obs:run${this.acts}` : `01J${String(this.acts).padStart(3, "0")}`);
    const receipt = this.store.apply(KEY, { actId, principal, expectedRevision, action, display: DISPLAY });
    const review = this.store.get(KEY);
    if (review !== null) {
      const shape = validateReview(review);
      assert.ok(shape.ok, `state_json violates the contract: ${shape.ok ? "" : shape.detail}`);
      const derived = validateReviewState(this.state());
      assert.ok(derived.ok, `ReviewState violates the contract: ${derived.ok ? "" : derived.detail}`);
    }
    return receipt;
  }

  applied(action: Action, principal: Principal, o: { actId?: string; expect?: number | null } = {}): AppliedOutcome {
    const receipt = this.act(action, principal, o);
    assert.ok("applied" in receipt.outcome, `expected applied, got ${JSON.stringify(receipt.outcome)}`);
    return receipt.outcome;
  }

  refused(action: Action, principal: Principal, o: { actId?: string; expect?: number | null } = {}): RefusedOutcome {
    const receipt = this.act(action, principal, o);
    assert.ok("refused" in receipt.outcome, `expected a refusal, got ${JSON.stringify(receipt.outcome)}`);
    return receipt.outcome;
  }

  review(): Review {
    const review = this.store.get(KEY);
    assert.ok(review !== null);
    return review;
  }

  state(): ReviewState {
    const state = this.store.read(KEY);
    assert.ok(state !== null);
    return state;
  }

  pending(assignee?: string) {
    return this.review().requests.filter((r) => r.status === "pending" && (assignee === undefined || r.assignee === assignee));
  }

  effectRows(): Array<{ effect_id: string; kind: string; target: string; status: string }> {
    return this.broker.db.prepare("SELECT effect_id, kind, target, status FROM review_effects ORDER BY rowid").all() as Array<{ effect_id: string; kind: string; target: string; status: string }>;
  }

  attempts(): number {
    return (this.broker.db.prepare("SELECT count(*) AS n FROM review_attempts").get() as { n: number }).n;
  }

  close(): void { this.broker.close(); }
}

// ---------------------------------------------------------------------------------------
// M0 vertical slice (§10.3): act → transition → durable state → read → visible projection
// ---------------------------------------------------------------------------------------

test("M0 slice: an adapter observation and a Codex clean answer reach the Slack board line through the real store and publisher", async () => {
  const core = new Core(POLICY, { github: false });
  const opened = core.applied(observe(), ADAPTER, { actId: "obs:open" });
  assert.equal(opened.revision_after, 1);
  assert.equal(core.pending("codex").length, 1, "the initial request routes to codex (§D2)");
  assert.equal(core.state().readiness.ready, false);

  core.applied(external(), ADAPTER, { actId: "src:review:5001:v1" });
  assert.equal(core.state().readiness.ready, true, "a complete clean answer satisfies the requirement (§H)");

  const handled = await core.publisher.drainOnce();
  assert.ok(handled >= 1);
  assert.equal(core.slack.lines.length, 1, "one board line for the coalesced board refreshes");
  assert.equal(core.slack.lines[0]?.channelId, "C0123ABCD");
  assert.match(core.slack.lines[0]?.text ?? "", /Owner\/repo#7/u);
  // Without GitHub (M0) the check refresh has no sink and the summons waits; nothing is lost.
  const rows = core.effectRows();
  assert.ok(rows.some((r) => r.target.startsWith("check:") && r.status === "obsolete"));
  assert.ok(rows.filter((r) => r.target.startsWith("board:")).every((r) => r.status === "sent" || r.status === "obsolete"));
  core.close();
});

test("§B1/§B2 through the store with the real reducer: a stale seat act is refused with the current state; a repeated act id replays", () => {
  const core = new Core(SEAT_POLICY);
  core.applied(observe(), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  const stale = core.refused(answer(req.id, `${H1}:main`, report("ariadne")), seat("ariadne"), { expect: 0 });
  assert.equal(stale.code, "stale_revision");
  assert.equal(stale.current_revision, 1);
  assert.equal(stale.state?.revision, 1);
  assert.equal(core.attempts(), 1, "the refusal is an attempt (§B4)");

  const first = core.act(answer(req.id, `${H1}:main`, report("ariadne")), seat("ariadne"), { actId: "01JSAME" });
  assert.ok("applied" in first.outcome);
  const effectsBefore = core.effectRows().length;
  const again = core.act(answer(req.id, `${H1}:main`, report("ariadne")), seat("ariadne"), { actId: "01JSAME", expect: 99 });
  assert.ok("replayed" in again.outcome);
  assert.equal((again.outcome as ReplayedOutcome).batch_id, first.outcome.batch_id);
  assert.equal(core.effectRows().length, effectsBefore, "replay writes no effect");
  assert.equal(core.review().revision, 2);
  core.close();
});

// ---------------------------------------------------------------------------------------
// §11
// ---------------------------------------------------------------------------------------

test("§11 #1 CLEAN answer → required re-review opened → malformed Answer → corrected Answer", () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  core.applied(external(), ADAPTER);
  assert.equal(core.state().readiness.ready, true);
  const key = `${H1}:main`;
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: key, required: true, names: [], reason: "second look" }, OPERATOR);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: key, reasons: [{ required_request_pending: [req.id] }] });

  const malformed = core.refused(answer(req.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(1), generation: 0 })), seat("ariadne"));
  assert.equal(malformed.code, "malformed");
  assert.deepEqual(malformed.state?.readiness, { ready: false, subject_key: key, reasons: [{ required_request_pending: [req.id] }] }, "still pending (§E2)");
  assert.equal(core.attempts(), 1);

  core.applied(answer(req.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(1) })), seat("ariadne"));
  assert.equal(core.state().readiness.ready, true);
  core.close();
});

test("§11 #2 finding F at H1 → unrelated push H2 → complete answer at H2 that does not mention F", () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  core.applied(external({ comments: [{ id: 1, title: "F" }] }), ADAPTER);
  const F = core.review().findings[0];
  assert.ok(F);
  core.applied(observe({ head: H2 }), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req, "the later round goes to the substitute (§D2)");
  core.applied(answer(req.id, `${H2}:main`, report("ariadne", { head: H2 })), seat("ariadne"));
  assert.equal(core.review().findings[0]?.status.open, true);
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: `${H2}:main`, reasons: [{ blocking_findings: [F.id] }] });
  assert.equal(core.state().requirement.status, "satisfied");
  core.close();
});

test("§11 #3 draft → ready at unchanged head; open → closed → reopened", () => {
  const core = new Core();
  core.applied(observe({ draft: true }), ADAPTER);
  assert.equal(core.pending().length, 0);
  core.applied(observe({ draft: false }), ADAPTER);
  assert.equal(core.pending().length, 1, "the draft flip opens the initial request (§C4)");
  core.applied(external({ comments: [{ id: 1 }] }), ADAPTER);
  const before = core.review();
  core.applied(observe({ lifecycle: "closed" }), ADAPTER);
  const closed = core.state().readiness;
  assert.ok(!closed.ready);
  assert.equal(closed.reasons[0], "closed");
  core.applied(observe({ lifecycle: "open" }), ADAPTER);
  const reopened = core.review();
  assert.deepEqual(reopened.requests, before.requests);
  assert.deepEqual(reopened.findings, before.findings);
  assert.deepEqual(reopened.answers, before.answers);
  assert.equal(reopened.subjects.length, 1);
  core.close();
});

test("§11 #4 observe H2 → delayed webhook for H1 arrives: reconcile observes the live PR, subject stays H2, no duplicate request", async () => {
  const core = new Core();
  const github = new FakeGitHubPort(H2);
  const first = await reconcile({ store: core.store, github, clock: core.clock }, KEY, "run-1");
  assert.equal(first.observed, true);
  assert.equal(core.review().subject.head_sha, H2);
  assert.equal(core.pending("codex").length, 1);
  const requestsBefore = core.review().requests.map((r) => r.id);

  // A notification about H1 arrives late; it is a wake, not a command (§7).
  assert.equal(core.store.inbox.put({ deliveryId: "late-h1", event: "pull_request", repositoryId: KEY.repository_id, prNumber: KEY.pr_number, payload: { pull_request: { head: { sha: H1 } } }, receivedAt: T0 }), true);
  const second = await reconcile({ store: core.store, github, clock: core.clock }, KEY, "run-2");
  core.store.inbox.markReconciled(["late-h1"], second.runId);

  assert.equal(github.pulls, 2, "the live PR was fetched again");
  assert.equal(core.review().subject.head_sha, H2, "no regression");
  assert.equal(core.review().subjects.length, 1);
  assert.deepEqual(core.review().requests.map((r) => r.id), requestsBefore, "no duplicate request (§D1)");
  assert.equal(core.store.inbox.unreconciled().length, 0);
  const batches = core.store.batches(KEY);
  assert.deepEqual(batches.map((b) => b.command.act_id), ["obs:run-1", "obs:run-2"], "act ids are the runs, never the delivery id (§B2)");
  core.close();
});

test("§11 #5 ready refresh queued → Hold → delayed worker: the check publishes failure(hold); the earlier job is coalesced", async () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  core.applied(external(), ADAPTER);
  assert.equal(core.state().readiness.ready, true, "a check refresh saying ready is queued");
  core.applied({ kind: "Hold", hold: { kind: "operator", reason: "design ruling pending", release_on: "explicit", blocks: { readiness: true, summons: false } } }, OPERATOR);

  const target = `check:Owner/repo:${H1}`;
  const queued = core.effectRows().filter((r) => r.target === target);
  assert.equal(queued.length, 3, "three refreshes for one check target, all pending");
  assert.ok(queued.every((r) => r.status === "pending"));

  await core.publisher.drainOnce();
  const github = core.github;
  assert.ok(github !== null);
  assert.deepEqual(github.checks, [{ headSha: H1, conclusion: "failure", title: "hold: operator" }], "never the older verdict");
  const after = core.effectRows().filter((r) => r.target === target);
  assert.deepEqual(after.map((r) => r.status), ["obsolete", "obsolete", "sent"]);
  assert.equal(github.boards.length, 1, "one board render for the coalesced board refreshes");
  // The clean answer discharged the codex request before dispatch: the summons is obsolete, not sent (§D7).
  assert.deepEqual(github.comments, []);
  assert.deepEqual(core.effectRows().filter((r) => r.target.startsWith("summon:")).map((r) => r.status), ["obsolete"]);
  core.close();
});

test("§11 #6 exhaustion: one episode, one hold, one gate, one author delivery and one retrospective request, each with a distinct effect id", async () => {
  const core = new Core(TIGHT_POLICY);
  core.applied(observe(), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  const key = `${H1}:main`;
  const exhausted = core.applied(answer(req.id, key, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"));
  const review = core.review();
  assert.equal(review.episodes.length, 1);
  assert.equal(review.holds.length, 1);
  assert.equal(review.holds[0]?.kind, "exhaustion");
  const retro = review.requests.find((r) => r.kind === "retrospective");
  assert.ok(retro);
  assert.equal(new Set(exhausted.effects).size, exhausted.effects.length);
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: key, reasons: [{ hold: "exhaustion" }, "exhausted", { blocking_findings: [review.findings[0]?.id ?? ""] }] });

  // Another answer at the same subject while the episode is open emits nothing new.
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: key, required: false, names: [], reason: "r" }, OPERATOR);
  const appeal = core.pending("ariadne")[0];
  assert.ok(appeal);
  const second = core.applied(answer(appeal.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(2), findings: [rkFinding("F2", { fp: 2 })] })), seat("ariadne"));
  assert.equal(core.review().episodes.length, 1);
  assert.equal(core.review().holds.length, 1);
  const secondRows = core.effectRows().filter((r) => second.effects.includes(r.effect_id));
  assert.ok(secondRows.every((r) => r.kind === "refresh"), "no second gate, delivery or retrospective");

  // The publisher delivers the gate to the author and the retrospective to its actor, once each.
  await core.publisher.drainOnce();
  const wakes = core.slack.wakes.map((w) => [w.actor, w.dedupeKey]);
  assert.equal(wakes.length, 2);
  assert.ok(wakes.some(([actor]) => actor === "talos"), "the author seat gets the gate");
  assert.ok(wakes.some(([actor]) => actor === "theoros"), "the retrospective actor gets its request");
  assert.equal(new Set(wakes.map(([, key]) => key)).size, 2, "distinct dedupe keys");

  core.applied({ kind: "GrantRounds", n: 2, reason: "one more go" }, OPERATOR);
  assert.equal(core.review().episodes[0]?.closed?.by.kind, "operator");
  assert.equal(core.review().holds[0]?.released !== null, true);
  core.close();
});

test("§11 #7 replay all batches under a different clock and the current policy: identical state_json, zero effects emitted", () => {
  const core = new Core(SEAT_POLICY);
  core.applied(observe(), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  core.applied(answer(req.id, `${H1}:main`, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"));
  const F = core.review().findings[0]?.id ?? "";
  core.clock.advance(3_600_000);
  core.applied({ kind: "ResolveFinding", finding_id: F, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("talos"));
  core.applied(observe({ head: H2, mergeable: false }), ADAPTER);
  core.applied({ kind: "SetReviewerAvailability", reviewer: "theoros", available: false, reason: "connector", until: "2026-09-06T14:00:00.000Z", evidence: "500" }, ADAPTER);
  core.applied({ kind: "Hold", hold: { kind: "human_gate", reason: "r", release_on: "subject_change", blocks: { readiness: true, summons: true } } }, OPERATOR);
  core.applied({ kind: "GrantRounds", n: 3, reason: "r" }, OPERATOR);
  core.applied(observe({ head: H3, mergeable: true }), ADAPTER);
  core.store.putPolicy(KEY.repository_id, { ...SEAT_POLICY, version: 2, rounds_max: 3 });
  core.applied({ kind: "AdoptPolicy", version: 2 }, OPERATOR);
  assert.equal(core.review().policy_version, 2, "the store decided AdoptPolicy under the adopted version (§6.I)");

  const cached = core.review();
  assert.equal(core.store.batches(KEY).length, 9);
  const effectsBefore = core.effectRows().length;

  // A second store over the same database, under another clock, replays the batches.
  const later = new ReviewStore(core.broker.db, { decide, fold, read, clock: new FakeClock(new Date("2027-01-01T00:00:00.000Z")) });
  const replayed = later.replay(KEY);
  assert.deepEqual(replayed, cached);
  assert.equal(JSON.stringify(replayed), JSON.stringify(cached), "state_json is identical");
  assert.equal(core.effectRows().length, effectsBefore, "replay emits nothing");
  assert.equal(later.read(KEY)?.revision, 9);
  core.close();
});

test("§11 #8 unsolicited Codex re-sample at H → request opened later at H stays pending", () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  core.applied(external(), ADAPTER);
  core.applied(external({ comments: [{ id: 42 }], source_record: { kind: "review", id: 5002, version: "2026-09-06T13:00:00.000Z" } }), ADAPTER);
  const F = core.review().findings[0];
  assert.ok(F);
  assert.equal(F.answer_id, null, "unsolicited evidence answers nothing (§E4)");
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "codex", subject_key: `${H1}:main`, required: true, names: [], reason: "again" }, OPERATOR);
  const later = core.pending("codex")[0];
  assert.ok(later);
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: `${H1}:main`, reasons: [{ required_request_pending: [later.id] }, { blocking_findings: [F.id] }] });
  core.close();
});

test("§11 #9 fixed claim on F → new subject → Codex raises F′ → same_as F: F contested and open, F′ linked, the board shows the prior claim", async () => {
  const core = new Core(SEAT_POLICY);
  core.applied(observe(), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  core.applied(answer(req.id, `${H1}:main`, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"));
  const F = core.review().findings[0]?.id ?? "";
  core.applied({ kind: "ResolveFinding", finding_id: F, resolution: { kind: "fixed", evidence: "cured", commits: [H2] } }, seat("talos"));
  core.applied(observe({ head: H2 }), ADAPTER);
  const next = core.pending("theoros")[0];
  assert.ok(next);
  core.applied(answer(next.id, `${H2}:main`, report("theoros", { head: H2, findings: [rkFinding("F1", { fp: 2, title: "Finding F1" })] })), seat("theoros"));
  const fPrime = core.review().findings[1];
  assert.ok(fPrime);
  assert.deepEqual(fPrime.correlation_hints, [F], "a hint, never authority (§F1/§F4)");
  core.applied({ kind: "ResolveFinding", finding_id: fPrime.id, resolution: { kind: "same_as", evidence: "same bug", other: F } }, seat("theoros"));

  const f = core.review().findings.find((x) => x.id === F);
  assert.ok(f && f.status.open && "contested" in f.status);
  assert.equal(f.status.contested.prior.kind, "fixed");
  assert.equal(core.review().findings[1]?.links[0]?.other, F);
  assert.deepEqual(core.state().blocking_findings.map((x) => x.id), [F, fPrime.id]);

  await core.publisher.drainOnce();
  const board = core.github?.boards.at(-1) ?? "";
  assert.match(board, /contested by theoros/u);
  assert.match(board, /prior claim: fixed, claimed by talos @ bbbbbbb/u);
  core.close();
});

test("§11 #10 Codex request pending → quota refusal → later Codex signal: one reassignment with supersedes; availability clears", () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  const codexReq = core.pending("codex")[0];
  assert.ok(codexReq);
  core.applied({ kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: "quota", until: "2026-09-06T14:00:00.000Z", evidence: "quota exhausted" }, ADAPTER);
  const sub = core.pending()[0];
  assert.equal(sub?.assignee, "ariadne");
  assert.equal(sub?.supersedes, codexReq.id);
  assert.equal(core.review().requests.filter((r) => r.supersedes !== null).length, 1, "one reassignment (§D4)");
  core.applied(external({ comments: [{ id: 5 }] }), ADAPTER);
  assert.deepEqual(core.review().availability["codex"], { available: true }, "clears on the admitted signal (§D3)");
  assert.equal(core.review().findings[0]?.answer_id, null, "the cancelled request is not answered by the late signal");
  assert.equal(core.pending("ariadne").length, 1);
  core.close();
});
