/**
 * §11 acceptance — Hákon's ten sequences, run through the composed core (module map §8):
 * the real `BrokerStore` database, the real `ReviewStore` with the real `decide`/`fold`/`read`,
 * the real `ReviewPublisher` over fake GitHub and Slack ports, the real `handleWebhook`,
 * `ReconcileScheduler` and `reconcile` over a fake `GitHubPort`, and the real Codex
 * `classify` over captured producer fixtures (V-6). Each builder proved its module in
 * isolation; this file proves the seams carry every sequence end to end: act → transition →
 * durable state → read → projection. One test per §11 row, named `§11.<n> <sequence>`,
 * asserting exactly that row's "Required result" column.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  Review,
  ReviewKey,
  ReviewReport,
  ReviewState,
} from "./contract.js";
import { validateReview, validateReviewState } from "./contract.js";
import { issueCommentRecord, type GitHubChangedFile, type GitHubPort, type GitHubPullRequest, type GitHubRecord } from "./github/port.js";
import { ReconcileScheduler, reconcile } from "./github/reconcile.js";
import { handleWebhook } from "./github/webhook.js";
import { ReviewPublisher, type ReviewGitHubPort, type SystemWakePort } from "./publisher.js";
import { decide, fold, read } from "./reducer.js";
import { ReviewStore } from "./store.js";

// ---------------------------------------------------------------------------------------
// Fixtures (contract-valid; the store runs Ajv on every act)
// ---------------------------------------------------------------------------------------

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);
/** The head the captured clean comment `hive-issue_comment-5560110170` binds by its footer. */
const HIVE_66_HEAD = "4df54b1c368a31d3f617c2f4c0672479724ccdad";
const BASE = "1".repeat(40);
const MERGE_BASE = "2".repeat(40);
const DIFF = "d".repeat(64);
const FP = (n: number): string => `ifp-sha256:${n.toString(16).padStart(64, "0")}`;
const T0 = "2026-09-06T12:00:00.000Z";
const MINUTE = 60_000;

const KEY: ReviewKey = { repository_id: 1, pr_number: 7 };
const DISPLAY = "Owner/repo#7";
const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
/** An obviously fake webhook secret (never a real one in a test). */
const WEBHOOK_SECRET = "hive-acceptance-test-webhook-secret-not-real";
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/codex");

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

const ADAPTER: Principal = { kind: "adapter", source: "github", reconcile_run: "run1", event_login: CODEX_LOGIN };
const OPERATOR: Principal = { kind: "operator", id: "hakon" };
const seat = (actor: string): Principal => ({ kind: "seat", actor, custody: { delivery_id: 1 } });

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

function codexFixture(name: string): GitHubRecord {
  return issueCommentRecord(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>);
}

interface ObserveOverrides {
  head?: string;
  lifecycle?: ObservePRAction["lifecycle"];
  draft?: boolean;
  mergeable?: boolean | null;
  exemption?: ObservePRAction["exemption"];
}

function observe(o: ObserveOverrides = {}): ObservePRAction {
  const head = o.head ?? H1;
  return {
    kind: "ObservePR",
    lifecycle: o.lifecycle ?? "open",
    draft: o.draft ?? false,
    exemption: o.exemption ?? null,
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
  /** The outbox drains between publisher passes: every queued line has been posted as `1700.<outboxId>`. */
  outboxMessageTs(outboxId: number): string | null {
    return outboxId >= 1 && outboxId <= this.lines.length ? `1700.${outboxId}` : null;
  }
}

/** The projection sink. `boardGate`, when set, holds the worker inside the board render (§11.5's delayed worker). */
class FakeGitHub implements ReviewGitHubPort {
  checks: Array<{ headSha: string; conclusion: "success" | "failure"; title: string }> = [];
  boards: string[] = [];
  /** What each call was asked to edit (`existingId`): null is a create. Same order as `checks` / `boards`. */
  checkEdits: Array<number | null> = [];
  boardEdits: Array<number | null> = [];
  threads: Array<{ commentId: number; op: "resolve" | "unresolve" }> = [];
  comments: string[] = [];
  boardGate: { reached: () => void; proceed: Promise<void> } | null = null;
  async createOrUpdateCheckRun(input: { headSha: string; existingId: number | null; conclusion: "success" | "failure"; title: string }): Promise<{ checkRunId: number }> {
    this.checks.push({ headSha: input.headSha, conclusion: input.conclusion, title: input.title });
    this.checkEdits.push(input.existingId);
    return { checkRunId: input.existingId ?? this.checks.length };
  }
  async createOrUpdateBoardComment(input: { existingId: number | null; body: string }): Promise<{ commentId: number }> {
    const gate = this.boardGate;
    if (gate !== null) {
      this.boardGate = null;
      gate.reached();
      await gate.proceed;
    }
    this.boards.push(input.body);
    this.boardEdits.push(input.existingId);
    return { commentId: input.existingId ?? 500 };
  }
  async resolveThread(input: { commentId: number }): Promise<void> { this.threads.push({ commentId: input.commentId, op: "resolve" }); }
  async unresolveThread(input: { commentId: number }): Promise<void> { this.threads.push({ commentId: input.commentId, op: "unresolve" }); }
  async postComment(input: { body: string }): Promise<{ commentId: number }> {
    this.comments.push(input.body);
    return { commentId: 700 + this.comments.length };
  }
}

/** The adapter's port: a live PR whose head the test moves, and the Codex records GitHub returns. */
class FakeGitHubPort implements GitHubPort {
  pr: GitHubPullRequest;
  pulls = 0;
  issueComments: GitHubRecord[] = [];
  files: GitHubChangedFile[] = [{ path: "src/x.py", sha: "1".repeat(40), status: "modified" }];
  /** Canonical template blobs by path (§6.C6 verbatim_copy). */
  blobs = new Map<string, string>();
  constructor(headSha: string) {
    this.pr = {
      repositoryId: KEY.repository_id, prNumber: KEY.pr_number, owner: "Owner", repo: "repo", title: "Fix x", authorLogin: "talos-weave",
      draft: false, state: "open", merged: false, mergeable: true, headSha, headRef: "feature", baseRef: "main", baseSha: BASE, mergeBaseSha: MERGE_BASE, etag: null,
    };
  }
  async getPullRequest(): Promise<GitHubPullRequest | "not_modified"> { this.pulls += 1; return { ...this.pr }; }
  async listReviews(): Promise<GitHubRecord[]> { return []; }
  async listReviewComments(): Promise<GitHubRecord[]> { return []; }
  async listIssueComments(): Promise<GitHubRecord[]> { return [...this.issueComments]; }
  async listFiles(): Promise<GitHubChangedFile[]> { return [...this.files]; }
  async getBlobSha(_r: number, _ref: string, path: string): Promise<string | null> { return this.blobs.get(path) ?? null; }
  async listFailedDeliveries(): Promise<Array<{ id: number; guid: string }>> { return []; }
  async redeliver(): Promise<void> {}
}

/** §7 ingress: a signed `pull_request` delivery naming `head`, exactly as GitHub would send it. */
function webhookDelivery(deliveryId: string, head: string): { headers: Record<string, string>; rawBody: Buffer } {
  const rawBody = Buffer.from(JSON.stringify({
    action: "synchronize",
    repository: { id: KEY.repository_id, full_name: "Owner/repo" },
    pull_request: { number: KEY.pr_number, head: { sha: head } },
  }));
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
  return {
    headers: { "x-hub-signature-256": signature, "x-github-delivery": deliveryId, "x-github-event": "pull_request" },
    rawBody,
  };
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
    this.assertContract();
    return receipt;
  }

  /** Every persisted Review and every derived ReviewState is contract-valid, whichever path wrote it. */
  assertContract(): void {
    const review = this.store.get(KEY);
    if (review === null) return;
    const shape = validateReview(review);
    assert.ok(shape.ok, `state_json violates the contract: ${shape.ok ? "" : shape.detail}`);
    const derived = validateReviewState(this.state());
    assert.ok(derived.ok, `ReviewState violates the contract: ${derived.ok ? "" : derived.detail}`);
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

  /** The `state_json` column verbatim — the bytes §11.7 compares. */
  stateJson(): string {
    const row = this.broker.db.prepare("SELECT state_json FROM reviews WHERE repository_id = ? AND pr_number = ?").get(KEY.repository_id, KEY.pr_number) as { state_json: string } | undefined;
    assert.ok(row !== undefined);
    return row.state_json;
  }

  inboxRows(): Array<{ delivery_id: string; reconciled_run: string | null }> {
    return this.broker.db.prepare("SELECT delivery_id, reconciled_run FROM github_inbox ORDER BY rowid").all() as Array<{ delivery_id: string; reconciled_run: string | null }>;
  }

  sourceRecord(recordKey: string): { classification: string | null; admitted_act_id: string | null } {
    const row = this.broker.db.prepare("SELECT classification, admitted_act_id FROM source_records WHERE record_key = ?").get(recordKey) as { classification: string | null; admitted_act_id: string | null } | undefined;
    assert.ok(row !== undefined, `no source record ${recordKey}`);
    return row;
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

// ---------------------------------------------------------------------------------------
// §11
// ---------------------------------------------------------------------------------------

test("§11.1 CLEAN answer → required re-review opened → malformed Answer → corrected Answer", () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  core.applied(external(), ADAPTER);
  assert.equal(core.state().readiness.ready, true, "the Codex CLEAN satisfies the requirement at H1 (§H)");
  const key = `${H1}:main`;

  // §D2: every request after the first charge goes to the substitute; the operator opens it as required.
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "initial", assignee: "ariadne", subject_key: key, required: true, names: [], reason: "required re-review by the substitute" }, OPERATOR);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  assert.equal(req.required, true);
  const pendingReason = { ready: false, subject_key: key, reasons: [{ required_request_pending: [req.id] }] };
  assert.deepEqual(core.state().readiness, pendingReason, "ready = false with required_request_pending (§H)");
  assert.equal(core.state().requirement.status, "satisfied", "the old CLEAN still satisfies the requirement; the pending required request is what blocks");

  // §E2: a malformed Answer is refused, the request stays pending, the attempt is logged.
  const malformed = core.refused(answer(req.id, key, report("ariadne", { generation: 1 })), seat("ariadne"));
  assert.equal(malformed.code, "malformed");
  assert.deepEqual(malformed.state?.readiness, pendingReason, "still pending after the malformed Answer");
  assert.equal(core.review().requests.find((r) => r.id === req.id)?.status, "pending");
  assert.equal(core.review().answers.length, 1, "no answer was admitted");
  assert.equal(core.attempts(), 1, "the refusal is a visible attempt (§B4)");
  assert.deepEqual(core.state().readiness, pendingReason, "ready = false until the corrected answer is admitted");

  // The corrected Answer is admitted; then ready = true.
  core.applied(answer(req.id, key, report("ariadne")), seat("ariadne"));
  assert.equal(core.review().requests.find((r) => r.id === req.id)?.status, "answered");
  assert.deepEqual(core.state().readiness, { ready: true, subject_key: key });
  core.close();
});

test("§11.2 Finding F raised at H1 → unrelated push H2 → complete answer at H2 that does not mention F", () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  core.applied(external({ comments: [{ id: 1, title: "F" }] }), ADAPTER);
  const F = core.review().findings[0];
  assert.ok(F);
  assert.equal(F.subject_key, `${H1}:main`, "F was raised at H1");
  assert.deepEqual(core.state().readiness.ready, false);

  core.applied(observe({ head: H2 }), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req, "the later round goes to the substitute (§D2)");
  assert.equal(req.subject_key, `${H2}:main`);
  core.applied(answer(req.id, `${H2}:main`, report("ariadne", { head: H2 })), seat("ariadne"));

  const answered = core.review().answers.at(-1);
  assert.ok(answered && "findings" in answered.normalized);
  assert.deepEqual(answered.normalized.findings, [], "the H2 answer does not mention F");
  assert.equal(core.state().requirement.status, "satisfied", "the H2 answer satisfies the requirement at H2");
  const f = core.review().findings.find((x) => x.id === F.id);
  assert.ok(f);
  assert.deepEqual(f.status, { open: true }, "F is still open (§E5: a later clean withdraws nothing)");
  assert.deepEqual(core.state().blocking_findings.map((x) => x.id), [F.id], "F is still blocking (§F4: no transfer by omission)");
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: `${H2}:main`, reasons: [{ blocking_findings: [F.id] }] });
  core.close();
});

test("§11.3 Draft → ready-for-review at unchanged head; open → closed → reopened", async () => {
  const core = new Core();
  const github = core.github;
  assert.ok(github !== null);
  core.applied(observe({ draft: true }), ADAPTER);
  assert.equal(core.pending().length, 0, "no auto-request while draft (§C4)");
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: `${H1}:main`, reasons: [{ requirement_unsatisfied: [`${H1}:main`] }, "draft"] });

  core.applied(observe({ draft: false }), ADAPTER);
  const initial = core.pending();
  assert.equal(initial.length, 1, "the draft flip opens the initial request (§C4)");
  assert.equal(initial[0]?.mode, "initial");
  assert.equal(initial[0]?.subject_key, `${H1}:main`, "at the unchanged head");
  assert.equal(core.review().subjects.length, 1, "the draft flip is not a subject change");
  assert.deepEqual(core.effectRows().filter((r) => r.target === `summon:${initial[0]?.id}`).map((r) => r.status), ["pending"], "one summons queued at open (§D5)");

  core.applied(external({ comments: [{ id: 1 }] }), ADAPTER);
  assert.equal(core.pending().length, 0, "Codex answered the initial request");
  // A required re-review to a seat is pending across the close; its one delivery effect is queued at open (§D5).
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "initial", assignee: "ariadne", subject_key: `${H1}:main`, required: true, names: [], reason: "re-review" }, OPERATOR);
  const before = core.review();
  assert.equal(before.findings.length, 1);
  const reReview = core.pending("ariadne")[0];
  assert.ok(reReview);
  const delivery = `delivery:ariadne:${reReview.id}`;

  core.applied(observe({ lifecycle: "closed" }), ADAPTER);
  const closed = core.state().readiness;
  assert.equal(closed.ready, false, "readiness false while closed (§C3)");
  assert.ok(!closed.ready && closed.reasons[0] === "closed");
  assert.deepEqual(core.review().requests, before.requests, "requests intact while closed: the re-review stays pending");
  assert.deepEqual(core.review().findings, before.findings, "findings intact while closed");
  // §C3 transport paused: the publisher withholds the pending delivery while closed — not sent, not obsolete.
  await core.publisher.drainOnce();
  assert.equal(core.slack.wakes.length, 0, "no delivery while closed");
  assert.deepEqual(core.effectRows().filter((r) => r.target === delivery).map((r) => r.status), ["pending"]);
  assert.deepEqual(core.effectRows().filter((r) => r.target.startsWith("summon:")).map((r) => r.status), ["obsolete"], "the answered Codex request's summons is obsolete (§D7)");

  core.applied(observe({ lifecycle: "open" }), ADAPTER);
  const reopened = core.review();
  assert.equal(reopened.lifecycle, "open");
  assert.deepEqual(reopened.requests, before.requests, "requests intact across close/reopen");
  assert.deepEqual(reopened.findings, before.findings, "findings intact across close/reopen");
  assert.deepEqual(reopened.answers, before.answers);
  assert.equal(reopened.subjects.length, 1, "history intact: still one subject");
  const after = core.state().readiness;
  assert.ok(!after.ready && !after.reasons.includes("closed"), "closed no longer blocks; the pending re-review and the finding do");
  // §C3 resumes: the withheld delivery goes out once; the reopen queued no second one.
  assert.deepEqual(core.effectRows().filter((r) => r.target === delivery).map((r) => r.status), ["pending"], "still the one delivery row");
  await core.publisher.drainOnce();
  await core.publisher.drainOnce();
  assert.deepEqual(core.slack.wakes.map((w) => w.actor), ["ariadne"], "delivered exactly once after the reopen");
  assert.deepEqual(core.effectRows().filter((r) => r.target === delivery).map((r) => r.status), ["sent"]);
  core.close();
});

test("§11.4 Observe H2 → delayed webhook for H1 arrives", async () => {
  const core = new Core();
  const port = new FakeGitHubPort(H1);
  const logs: string[] = [];
  const scheduler = new ReconcileScheduler({ store: core.store, github: port, clock: core.clock, log: (line) => logs.push(line) });
  const wake = async (deliveryId: string, head: string): Promise<void> => {
    // §7 ingress: verify, persist to github_inbox, ack — and nothing else.
    assert.deepEqual(handleWebhook(core.store, WEBHOOK_SECRET, webhookDelivery(deliveryId, head), core.clock), { status: 200, outcome: "accepted" });
    assert.equal(core.store.inbox.unreconciled().at(-1)?.deliveryId, deliveryId, "persisted before the ack");
    scheduler.drainInbox();
    await scheduler.idle();
    core.assertContract();
  };

  await wake("delivery-h1", H1);
  assert.equal(core.review().subject.head_sha, H1);
  const atH1 = core.pending("codex")[0];
  assert.ok(atH1);

  port.pr.headSha = H2;
  core.clock.advance(MINUTE);
  await wake("delivery-h2", H2);
  assert.equal(core.review().subject.head_sha, H2, "H2 observed");
  assert.equal(core.review().requests.find((r) => r.id === atH1.id)?.status, "cancelled", "the H1 request was cancelled by the subject change (§C2)");
  assert.equal(core.pending("codex").length, 1, "one initial request at H2");
  const requestsAtH2 = structuredClone(core.review().requests);
  const revisionAtH2 = core.review().revision;

  // The delayed notification about H1 arrives after H2 was observed (F-14). It is a wake, not a command (§7).
  core.clock.advance(MINUTE);
  await wake("delivery-h1-delayed", H1);
  assert.equal(port.pulls, 3, "reconcile fetched the live PR again rather than trusting the payload");
  assert.equal(core.review().subject.head_sha, H2, "subject stays H2: no regression");
  assert.equal(core.review().subjects.length, 2, "H1 was not re-entered as a new subject");
  assert.deepEqual(core.review().requests, requestsAtH2, "no duplicate request (§D1), nothing re-cancelled, nothing re-opened");
  assert.equal(core.review().revision, revisionAtH2 + 1, "the observation is recorded (metadata refresh, §C1) without regressing anything");
  assert.deepEqual(logs, [], "no reconcile run failed or was refused");

  // The three ids stay distinct (§7): every act is `obs:<run>`, never the delivery id; every delivery is stamped with its run.
  const actIds = core.store.batches(KEY).map((b) => b.command.act_id);
  assert.equal(actIds.length, 3);
  assert.ok(actIds.every((id) => id.startsWith("obs:") && !id.includes("delivery-")), `act ids are runs: ${actIds.join(", ")}`);
  const inbox = core.inboxRows();
  assert.deepEqual(inbox.map((r) => r.delivery_id), ["delivery-h1", "delivery-h2", "delivery-h1-delayed"]);
  assert.ok(inbox.every((r) => r.reconciled_run !== null && !r.reconciled_run.includes("delivery-")), "each delivery is stamped with the run that covered it");
  assert.deepEqual(core.store.inbox.unreconciled(), []);

  // GitHub redelivers the same notification (F-14 redelivery is an API act): recorded once, acknowledged, nothing re-run.
  assert.deepEqual(handleWebhook(core.store, WEBHOOK_SECRET, webhookDelivery("delivery-h1-delayed", H1), core.clock), { status: 200, outcome: "duplicate" });
  assert.equal(core.inboxRows().length, 3);
  await scheduler.stop();
  core.close();
});

test("§11.5 Ready refresh queued → Hold → delayed worker runs the earlier job", async () => {
  const core = new Core();
  const github = core.github;
  assert.ok(github !== null);
  core.applied(observe(), ADAPTER);
  core.applied(external(), ADAPTER);
  assert.equal(core.state().readiness.ready, true, "a check refresh saying ready is queued");
  const target = `check:Owner/repo:${H1}`;
  assert.deepEqual(core.effectRows().filter((r) => r.target === target).map((r) => r.status), ["pending", "pending"], "the ready refresh is queued, unsent");

  // The worker picks up the queue now — the ready check job is in its listing — and is then delayed
  // inside the board render (the target before the check) while the Hold lands.
  let reached!: () => void;
  let proceed!: () => void;
  const reachedBoard = new Promise<void>((r) => { reached = r; });
  github.boardGate = { reached, proceed: new Promise<void>((r) => { proceed = r; }) };
  const delayedPass = core.publisher.drainOnce();
  await reachedBoard;

  core.applied({ kind: "Hold", hold: { kind: "operator", reason: "design ruling pending", release_on: "explicit", blocks: { readiness: true, summons: false } } }, OPERATOR);
  assert.equal(core.state().readiness.ready, false);
  assert.deepEqual(core.effectRows().filter((r) => r.target === target).map((r) => r.status), ["pending", "pending", "pending"], "the Hold queued a third check refresh");

  proceed();
  await delayedPass;
  // The earlier job the worker carried coalesced into the newer refresh (§8.1); it never published "ready".
  assert.deepEqual(github.checks, [], "the delayed worker published nothing for the earlier job");
  assert.deepEqual(core.effectRows().filter((r) => r.target === target).map((r) => r.status), ["obsolete", "obsolete", "pending"], "the earlier job coalesced; the Hold's refresh is what remains");

  // The next pass renders the remaining refresh from the current state: failure(hold), never the older verdict.
  await core.publisher.drainOnce();
  assert.deepEqual(github.checks, [{ headSha: H1, conclusion: "failure", title: "hold: operator" }], "the check publishes failure(hold)");
  assert.deepEqual(core.effectRows().filter((r) => r.target === target).map((r) => r.status), ["obsolete", "obsolete", "sent"]);
  assert.match(github.boards.at(-1) ?? "", /not ready — hold: operator/u, "the board is re-rendered from current state too");
  // The clean answer discharged the codex request before dispatch: the summons is obsolete, not sent (§D7).
  assert.deepEqual(github.comments, []);
  assert.deepEqual(core.effectRows().filter((r) => r.target.startsWith("summon:")).map((r) => r.status), ["obsolete"]);
  core.close();
});

test("§11.6 Exhaustion predicate becomes true → another answer at the same subject", async () => {
  const core = new Core(TIGHT_POLICY);
  core.applied(observe(), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  const key = `${H1}:main`;
  const exhausted = core.applied(answer(req.id, key, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"));
  const review = core.review();
  const F1 = review.findings[0];
  assert.ok(F1);

  // Exactly one episode, one hold, one retrospective request.
  assert.equal(review.episodes.length, 1);
  assert.equal(review.episodes[0]?.closed, null);
  assert.equal(review.holds.length, 1);
  assert.equal(review.holds[0]?.kind, "exhaustion");
  assert.equal(review.holds[0]?.id, review.episodes[0]?.hold_id);
  const retrospectives = review.requests.filter((r) => r.kind === "retrospective");
  assert.equal(retrospectives.length, 1);
  const retro = retrospectives[0];
  assert.ok(retro);
  assert.equal(retro.assignee, "theoros", "to the policy's retrospective actor");
  assert.equal(retro.required, false, "§G5: it never gates");
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: key, reasons: [{ hold: "exhaustion" }, "exhausted", { blocking_findings: [F1.id] }] });

  // Each with a distinct effect id: one author delivery, one retrospective delivery, one gate projection.
  assert.equal(new Set(exhausted.effects).size, exhausted.effects.length, "distinct effect ids");
  const rows = core.effectRows().filter((r) => exhausted.effects.includes(r.effect_id));
  const deliveries = rows.filter((r) => r.target.startsWith("delivery:"));
  assert.deepEqual(deliveries.map((r) => r.target).sort(), [`delivery:talos:${retro.id}`, `delivery:theoros:${retro.id}`].sort(), "one author delivery, one retrospective request delivery");
  assert.deepEqual(rows.filter((r) => r.kind === "refresh").map((r) => r.target), [`board:${review.id}`, `check:Owner/repo:${H1}`], "one gate projection (the board and check refresh from current state)");

  // Another answer at the same subject while the episode is open: the predicate holds again and emits nothing new.
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: key, required: false, names: [], reason: "one more look" }, OPERATOR);
  const appeal = core.pending("ariadne")[0];
  assert.ok(appeal);
  const second = core.applied(answer(appeal.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(2), findings: [rkFinding("F2", { fp: 2 })] })), seat("ariadne"));
  assert.equal(core.review().charges.length, 1, "same-subject re-answers charge nothing (§G1)");
  assert.equal(core.review().episodes.length, 1, "exactly one episode");
  assert.equal(core.review().holds.length, 1, "exactly one hold");
  assert.equal(core.review().requests.filter((r) => r.kind === "retrospective").length, 1, "exactly one retrospective request");
  const secondRows = core.effectRows().filter((r) => second.effects.includes(r.effect_id));
  assert.ok(secondRows.every((r) => r.kind === "refresh"), "no second gate, delivery or retrospective");

  // The publisher delivers the gate to the author and the retrospective to its actor, once each, and renders the gate.
  await core.publisher.drainOnce();
  const wakes = core.slack.wakes.map((w) => [w.actor, w.dedupeKey] as const);
  assert.equal(wakes.length, 2);
  assert.ok(wakes.some(([actor]) => actor === "talos"), "the author seat gets the gate");
  assert.ok(wakes.some(([actor]) => actor === "theoros"), "the retrospective actor gets its request");
  assert.equal(new Set(wakes.map(([, dedupe]) => dedupe)).size, 2, "distinct dedupe keys");
  const github = core.github;
  assert.ok(github !== null);
  assert.equal((github.boards.at(-1) ?? "").split("### 🛑 Review rounds exhausted").length, 2, "the board renders the exhaustion gate once");
  assert.deepEqual(github.checks.map((c) => c.title), ["hold: exhaustion"]);

  // §G4: GrantRounds closes the episode and releases the hold.
  core.applied({ kind: "GrantRounds", n: 2, reason: "one more go" }, OPERATOR);
  assert.equal(core.review().episodes[0]?.closed?.by.kind, "operator");
  assert.notEqual(core.review().holds[0]?.released, null);
  core.close();
});

test("§11.7 Replay all batches under a different clock and the current policy", () => {
  const core = new Core(SEAT_POLICY);
  core.applied(observe(), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  core.applied(answer(req.id, `${H1}:main`, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"));
  const F = core.review().findings[0]?.id ?? "";
  core.clock.advance(60 * MINUTE);
  core.applied({ kind: "ResolveFinding", finding_id: F, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("talos"));
  core.applied(observe({ head: H2, mergeable: false }), ADAPTER);
  core.applied({ kind: "SetReviewerAvailability", reviewer: "theoros", available: false, reason: "connector", until: "2026-09-06T14:00:00.000Z", evidence: "500" }, ADAPTER);
  core.applied({ kind: "Hold", hold: { kind: "human_gate", reason: "r", release_on: "subject_change", blocks: { readiness: true, summons: true } } }, OPERATOR);
  core.applied({ kind: "GrantRounds", n: 3, reason: "r" }, OPERATOR);
  core.applied(observe({ head: H3, mergeable: true }), ADAPTER);
  core.store.putPolicy(KEY.repository_id, { ...SEAT_POLICY, version: 2, rounds_max: 3 });
  core.applied({ kind: "AdoptPolicy", version: 2 }, OPERATOR);
  assert.equal(core.review().policy_version, 2, "the store decided AdoptPolicy under the adopted version (§6.I)");

  const cachedJson = core.stateJson();
  const batches = core.store.batches(KEY);
  assert.equal(batches.length, 9, "every consequence kind this sequence touches is in the batch log");
  const effectsBefore = core.effectRows();
  const attemptsBefore = core.attempts();
  // The repository's current policy moves on; a replay does not consult it (fold takes no policy, §B3).
  core.store.putPolicy(KEY.repository_id, { ...SEAT_POLICY, version: 3, rounds_max: 1 });

  // A second store over the same database, under another clock, folds the stored batches: never `decide`, never an effect.
  const later = new ReviewStore(core.broker.db, { decide, fold, read, clock: new FakeClock(new Date("2027-01-01T00:00:00.000Z")) });
  const replayed = later.replay(KEY);
  assert.equal(JSON.stringify(replayed), cachedJson, "state_json is byte-identical");
  assert.equal(replayed.revision, 9);
  assert.equal(replayed.policy_version, 2);
  assert.deepEqual(core.effectRows(), effectsBefore, "zero effects emitted by the replay");
  assert.equal(core.store.batches(KEY).length, 9, "no batch written by the replay");
  assert.equal(core.attempts(), attemptsBefore, "no attempt written by the replay");
  assert.equal(core.stateJson(), cachedJson, "the cache is untouched");
  assert.equal(later.read(KEY)?.revision, 9);
  core.close();
});

test("§11.8 Unsolicited Codex re-sample at H → request opened later at H", () => {
  const core = new Core();
  core.applied(observe(), ADAPTER);
  core.applied(external(), ADAPTER, { actId: "src:review:5001:v1" });
  assert.equal(core.pending("codex").length, 0, "the initial Codex request is answered");

  // A second Codex sample at H with no Codex request pending: unsolicited evidence (§E4).
  const resample: Action = external({ comments: [{ id: 42 }], source_record: { kind: "review", id: 5002, version: "2026-09-06T13:00:00.000Z" } });
  core.applied(resample, ADAPTER, { actId: "src:review:5002:v1" });
  const F = core.review().findings[0];
  assert.ok(F, "findings admitted");
  assert.equal(F.raised_by, "codex");
  assert.equal(F.answer_id, null, "unsolicited evidence answers nothing (§E4)");
  assert.equal(core.review().answers.length, 1, "no second answer");
  assert.deepEqual(core.state().blocking_findings.map((x) => x.id), [F.id], "the admitted finding blocks (§F5)");

  // A Codex request opened later at the same subject is not answered by the earlier evidence.
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "initial", assignee: "codex", subject_key: `${H1}:main`, required: true, names: [], reason: "again at H" }, OPERATOR);
  const later = core.pending("codex")[0];
  assert.ok(later, "the later request stays pending");
  assert.equal(later.answered_by, null);
  assert.deepEqual(core.state().readiness, { ready: false, subject_key: `${H1}:main`, reasons: [{ required_request_pending: [later.id] }, { blocking_findings: [F.id] }] });

  // The reconciler re-presenting the same record at the same version is a replay (§B2): it still answers nothing.
  const again = core.act(resample, ADAPTER, { actId: "src:review:5002:v1" });
  assert.ok("replayed" in again.outcome);
  assert.equal(core.pending("codex")[0]?.id, later.id, "the later request stays pending");
  assert.equal(core.review().findings.length, 1, "nothing re-admitted");
  core.close();
});

test("§11.9 `fixed` claim on F → new subject → Codex raises F′ → `same_as F`", async () => {
  const core = new Core(SEAT_POLICY);
  core.applied(observe(), ADAPTER);
  const req = core.pending("ariadne")[0];
  assert.ok(req);
  core.applied(answer(req.id, `${H1}:main`, report("ariadne", { findings: [rkFinding("F1", { title: "Off-by-one in pagination" })] })), seat("ariadne"));
  const F = core.review().findings[0]?.id ?? "";
  assert.ok(F !== "");

  // The burn seat claims the fix; the board says so, unconfirmed (§F3).
  core.applied({ kind: "ResolveFinding", finding_id: F, resolution: { kind: "fixed", evidence: "cured", commits: [H2] } }, seat("talos"));
  assert.equal(core.review().findings[0]?.status.open, false);
  assert.equal(core.state().readiness.ready, true, "a claimed fix closes the finding (§F3)");

  // New subject; Codex re-samples unsolicited and raises F′ — the same title, a new observation (§F4).
  core.applied(observe({ head: H2 }), ADAPTER);
  core.applied(external({ reviewed_head: H2, comments: [{ id: 91, title: "Off-by-one in pagination" }], source_record: { kind: "review", id: 5002, version: "2026-09-06T13:00:00.000Z" } }), ADAPTER, { actId: "src:review:5002:v1" });
  const fPrime = core.review().findings[1];
  assert.ok(fPrime);
  assert.equal(fPrime.raised_by, "codex");
  assert.deepEqual(fPrime.correlation_hints, [F], "a hint, never authority (§F1/§F4)");
  assert.equal(core.review().findings[0]?.status.open, false, "F stays resolved until someone links (§F4)");

  // The explicit link: F′ same_as F (§F2).
  core.applied({ kind: "ResolveFinding", finding_id: fPrime.id, resolution: { kind: "same_as", evidence: "same bug, new head", other: F } }, seat("ariadne"));
  const f = core.review().findings.find((x) => x.id === F);
  assert.ok(f && f.status.open && "contested" in f.status, "F contested and open");
  assert.equal(f.status.contested.by, "ariadne");
  assert.equal(f.status.contested.prior.kind, "fixed", "the prior claim is retained as history");
  assert.deepEqual(core.review().findings[1]?.links.map((l) => l.other), [F], "F′ linked to F");
  assert.deepEqual(f.links.map((l) => l.other), [fPrime.id], "F linked back to F′");
  assert.deepEqual(core.state().blocking_findings.map((x) => x.id), [F, fPrime.id], "both open and blocking");

  await core.publisher.drainOnce();
  const board = core.github?.boards.at(-1) ?? "";
  assert.match(board, /contested by ariadne/u);
  assert.match(board, /prior claim: fixed, claimed by talos @ bbbbbbb, unconfirmed/u, "the board shows the prior claim");
  assert.match(board, new RegExp(`same as ${F.replaceAll(":", "\\:")}`, "u"), "the board shows the link");
  core.close();
});

test("§11.10 Codex request pending → quota refusal → later Codex signal", async () => {
  const core = new Core();
  const port = new FakeGitHubPort(HIVE_66_HEAD);
  const deps = { store: core.store, github: port, clock: core.clock };

  const first = await reconcile(deps, KEY, "run-1");
  assert.equal(first.observed, true);
  core.assertContract();
  const codexReq = core.pending("codex")[0];
  assert.ok(codexReq, "the initial request routes to codex (§D2)");

  // GitHub now returns the connector's quota refusal (captured producer fixture, V-6).
  const quota = codexFixture("sokrates-issue_comment-5350649768");
  assert.equal(quota.authorLogin, CODEX_LOGIN);
  port.issueComments = [quota];
  core.clock.advance(MINUTE);
  const second = await reconcile(deps, KEY, "run-2");
  core.assertContract();
  assert.deepEqual(second.refused, []);
  assert.deepEqual(second.admitted, [`src:issue_comment:${quota.id}:${quota.version}`], "classified once and admitted under the record's own act id");
  assert.equal(core.sourceRecord(`issue_comment:${quota.id}`).classification, "quota_refusal");
  const unavailable = core.review().availability["codex"];
  assert.ok(unavailable && !unavailable.available);
  assert.equal(unavailable.reason, "quota");
  assert.equal(unavailable.until, null, "no meter ⇒ no resets_at");
  assert.match(unavailable.evidence, /^You have reached your Codex usage limits/u);

  // §D4: one reassignment to the substitute with `supersedes`.
  assert.equal(core.review().requests.find((r) => r.id === codexReq.id)?.status, "cancelled");
  const reassigned = core.review().requests.filter((r) => r.supersedes !== null);
  assert.equal(reassigned.length, 1, "one reassignment");
  assert.equal(reassigned[0]?.assignee, "ariadne", "to the policy's substitute");
  assert.equal(reassigned[0]?.supersedes, codexReq.id);
  assert.equal(reassigned[0]?.status, "pending");
  assert.deepEqual(core.pending().map((r) => r.assignee), ["ariadne"]);

  // A later Codex signal — the connector's clean comment at this head (fixture) — clears availability (§D3)
  // and, with no Codex request pending, answers nothing (§E4).
  const clean = codexFixture("hive-issue_comment-5560110170");
  port.issueComments = [quota, clean];
  core.clock.advance(MINUTE);
  const third = await reconcile(deps, KEY, "run-3");
  core.assertContract();
  assert.deepEqual(third.refused, []);
  assert.deepEqual(third.admitted, [`src:issue_comment:${clean.id}:${clean.version}`]);
  assert.equal(core.sourceRecord(`issue_comment:${clean.id}`).classification, "clean");
  assert.deepEqual(core.review().availability["codex"], { available: true }, "availability clears on the later signal");
  assert.equal(core.review().requests.filter((r) => r.supersedes !== null).length, 1, "still exactly one reassignment");
  assert.deepEqual(core.review().answers, [], "the cancelled request is not answered by the late signal");
  assert.equal(core.pending("ariadne").length, 1, "the substitute's request stays pending");
  assert.equal(core.state().requirement.status, "unsatisfied");

  // Transport: the summons for the cancelled Codex request is obsolete (§D7); the substitute got one delivery.
  await core.publisher.drainOnce();
  assert.deepEqual(core.effectRows().filter((r) => r.target.startsWith("summon:")).map((r) => r.status), ["obsolete"]);
  assert.deepEqual(core.github?.comments, []);
  assert.deepEqual(core.slack.wakes.map((w) => w.actor), ["ariadne"]);
  core.close();
});

// ---------------------------------------------------------------------------------------
// Burn of the 2026-09-06 verification findings, through the composed core
// ---------------------------------------------------------------------------------------

// §8.1 board comment "one per Review, created once, edited in place through projection_handles";
// §6.D5 "the request stores references". The real store records what the real publisher learned.
test("§8.1 one board comment and one check run per head, created once and edited in place; the request carries its summon reference", async () => {
  const core = new Core();
  const github = core.github;
  assert.ok(github);
  core.applied(observe(), ADAPTER);
  await core.publisher.drainOnce();
  assert.deepEqual(github.boardEdits, [null], "the first board refresh creates");
  assert.deepEqual(github.checkEdits, [null]);
  assert.deepEqual(github.comments, ["@codex review"]);
  assert.deepEqual(core.review().projection_handles, { board_comment_id: 500, check_run_ids: { [H1]: 1 }, slack_thread_ts: null });
  assert.deepEqual(core.pending("codex")[0]?.transport, [{ summon_comment_id: 701 }], "the summon comment id is the request's reference");
  assert.equal(core.slack.lines.length, 1);
  assert.equal(core.slack.lines[0]?.threadTs, null, "the first line opens the thread");

  // Every later act refreshes the same comment and the same check run (PATCH by id), and threads the line.
  core.applied({ kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR);
  await core.publisher.drainOnce();
  assert.deepEqual(github.boardEdits, [null, 500], "the second board refresh edits in place");
  assert.deepEqual(github.checkEdits, [null, 1]);
  assert.equal(core.slack.lines.at(-1)?.threadTs, "1700.1", "later lines thread under the first, once the outbox posted it");
  assert.equal(core.review().projection_handles.slack_thread_ts, "1700.1");
  assert.equal(github.boards.length, 2, "one comment per refresh, never a second comment");

  // A new head gets its own check run; the board comment stays the one comment.
  core.applied(observe({ head: H2 }), ADAPTER);
  await core.publisher.drainOnce();
  assert.deepEqual(github.checkEdits.at(-1), null, "a check run names one head: the new head creates");
  assert.deepEqual(github.boardEdits.at(-1), 500);
  assert.deepEqual(core.review().projection_handles.check_run_ids, { [H1]: 1, [H2]: 3 });
  // The seat's delivery id is the reference on a seat request; §11.7's replay is untouched by any of it.
  core.applied({ kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: `${H2}:main`, required: true, names: [], reason: "r" }, OPERATOR);
  await core.publisher.drainOnce();
  assert.deepEqual(core.pending("ariadne")[0]?.transport, [{ delivery_id: 1 }]);
  assert.deepEqual(core.slack.wakes[0]?.threadTs, "1700.1", "deliveries land in the Review's thread");
  const replayed = new ReviewStore(core.broker.db, { decide, fold, read, clock: core.clock }).replay(KEY);
  assert.equal(JSON.stringify(replayed), core.stateJson(), "projection facts never enter the fold");
  assert.deepEqual(replayed.projection_handles, { board_comment_id: null, check_run_ids: {}, slack_thread_ts: null });
  core.close();
});

// §6.C6 "(the reconcile run computes it; the Review records the evidence)": verbatim_copy and the
// three skill roots reach `read().requirement` through the real reconciler and the real reducer.
test("§6.C6 through the reconciler: a verbatim template copy is exempt in the Review; a .claude/skills PR is exempt; a code push is not", async () => {
  const core = new Core();
  const port = new FakeGitHubPort(H1);
  port.files = [{ path: ".github/scripts/review_loop.py", sha: "7".repeat(40), status: "modified" }];
  port.blobs.set(".github/scripts/review_loop.py", "7".repeat(40));
  const deps = { store: core.store, github: port, clock: core.clock, templates: { repositoryId: 999, ref: "canonical" } };

  const verbatim = await reconcile(deps, KEY, "run-verbatim");
  assert.equal(verbatim.exemption?.reason, "verbatim_copy");
  assert.equal(core.review().exemption?.reason, "verbatim_copy");
  assert.equal(core.review().exemption?.subject_key, `${H1}:main`);
  assert.deepEqual(core.state().requirement, { subject_key: `${H1}:main`, status: "exempt" });
  assert.equal(core.pending().length, 0, "an exempt subject opens no request");
  assert.equal(core.state().readiness.ready, true);

  port.pr.headSha = H2;
  port.files = [{ path: ".claude/skills/x/SKILL.md", sha: "8".repeat(40), status: "added" }];
  core.clock.advance(MINUTE);
  await reconcile(deps, KEY, "run-skill");
  assert.equal(core.review().exemption?.reason, "skill_only");
  assert.deepEqual(core.state().requirement, { subject_key: `${H2}:main`, status: "exempt" });
  assert.equal(core.pending().length, 0);

  port.pr.headSha = H3;
  port.files = [{ path: "src/x.py", sha: "9".repeat(40), status: "modified" }];
  core.clock.advance(MINUTE);
  await reconcile(deps, KEY, "run-code");
  assert.equal(core.review().exemption, null);
  assert.equal(core.pending("codex").length, 1, "a code subject gets its initial request");
  assert.equal(core.state().requirement.status, "unsatisfied");
  core.close();
});
