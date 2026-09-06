import assert from "node:assert/strict";
import test from "node:test";
import type {
  Action,
  AdmittedFinding,
  Batch,
  Effect,
  ExemptionReason,
  ExternalResult,
  Finding,
  ObservePRAction,
  Policy,
  Principal,
  Refusal,
  Review,
  ReviewReport,
  ReviewState,
} from "./contract.js";
import { validateBatch, validateReview, validateReviewState } from "./contract.js";
import { applicability, parseTarget } from "./effects.js";
import {
  AUTHORIZATION_TABLE,
  authorize,
  decide,
  displayName,
  fold,
  isBlocking,
  isRefusal,
  read,
  type DecideContext,
  type ReviewIdentity,
} from "./reducer.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);
const BASE = "1".repeat(40);
const BASE2 = "3".repeat(40);
const MERGE_BASE = "2".repeat(40);
const DIFF = "d".repeat(64);
const FP = (n: number): string => `ifp-sha256:${n.toString(16).padStart(64, "0")}`;
const T0 = "2026-09-06T12:00:00.000Z";
const T1 = "2026-09-06T13:00:00.000Z";
const T2 = "2026-09-06T14:00:00.000Z";

const IDENTITY: ReviewIdentity = { key: { repository_id: 1, pr_number: 7 }, display: "Owner/repo#7" };

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
/** A policy whose first-round reviewer is a seat, for the rules that need a seat answer. */
const SEAT_POLICY: Policy = { ...POLICY, routing_by_round: { first: "ariadne", later: "theoros" } };
const TIGHT_POLICY: Policy = { ...SEAT_POLICY, rounds_max: 1 };

const ADAPTER: Principal = { kind: "adapter", source: "github", reconcile_run: "run1", event_login: "chatgpt-codex-connector[bot]" };
const seat = (actor: string): Principal => ({ kind: "seat", actor, custody: { delivery_id: 1 } });
const OPERATOR: Principal = { kind: "operator", id: "hakon" };
const SYSTEM: Principal = { kind: "system", caused_by: "act0" };

interface ObserveOverrides {
  head?: string;
  baseRef?: string;
  lifecycle?: ObservePRAction["lifecycle"];
  draft?: boolean;
  mergeable?: boolean | null;
  baseShaNow?: string;
  changedPaths?: string[];
  author?: ObservePRAction["subject"]["author"];
  seenAt?: string;
  diff?: string;
  /** §C6 evidence as the reconcile run would carry it; a reason alone names the observed subject. */
  exemption?: ObservePRAction["exemption"] | ExemptionReason;
}

function observe(o: ObserveOverrides = {}): ObservePRAction {
  const head = o.head ?? H1;
  const baseRef = o.baseRef ?? "main";
  const key = `${head}:${baseRef}`;
  const exemption: ObservePRAction["exemption"] = o.exemption === undefined || o.exemption === null
    ? null
    : typeof o.exemption === "string"
      ? { reason: o.exemption, evidence: (o.changedPaths ?? ["src/x.py"]).join(", "), subject_key: key }
      : o.exemption;
  return {
    kind: "ObservePR",
    lifecycle: o.lifecycle ?? "open",
    draft: o.draft ?? false,
    exemption,
    observed: {
      title: "Fix x",
      author_login: "talos-weave",
      head_ref: "feature",
      base_sha_now: o.baseShaNow ?? BASE,
      mergeable: o.mergeable === undefined ? true : o.mergeable,
      seen_at: o.seenAt ?? T0,
    },
    subject: {
      key: `${head}:${baseRef}`,
      head_sha: head,
      base_ref: baseRef,
      base_sha_at_first_sight: BASE,
      merge_base_sha: MERGE_BASE,
      diff_sha256: o.diff ?? DIFF,
      changed_paths: o.changedPaths ?? ["src/x.py"],
      author: o.author ?? { kind: "seat", actor: "talos" },
      first_seen_at: T0,
    },
  };
}

interface CtxOverrides {
  now?: string;
  policy?: Policy;
  meter?: DecideContext["meter"];
  expectedRevision?: number | null;
  identity?: ReviewIdentity;
}

function ctx(principal: Principal, actId: string, o: CtxOverrides = {}): DecideContext {
  const fenced = principal.kind === "seat" || principal.kind === "operator";
  const base: DecideContext = {
    now: o.now ?? T0,
    policy: o.policy ?? POLICY,
    actId,
    principal,
    expectedRevision: o.expectedRevision === undefined ? (fenced ? -1 : null) : o.expectedRevision,
    meter: o.meter ?? null,
  };
  if (o.identity !== undefined) base.identity = o.identity;
  return base;
}

let acts = 0;
function nextAct(prefix = "act"): string {
  acts += 1;
  return `${prefix}${acts}`;
}

/** Decide, prove the batch and the folded state against the contract, fold. */
function apply(state: Review | null, action: Action, principal: Principal, o: CtxOverrides & { actId?: string } = {}): { state: Review; batch: Batch } {
  const actId = o.actId ?? nextAct();
  const context = ctx(principal, actId, {
    ...o,
    expectedRevision: o.expectedRevision === undefined && state !== null && (principal.kind === "seat" || principal.kind === "operator") ? state.revision : o.expectedRevision ?? null,
    ...(state === null ? { identity: IDENTITY } : {}),
  });
  const result = decide(state, action, context);
  assert.ok(!isRefusal(result), `refused: ${isRefusal(result) ? `${result.code} — ${result.detail}` : ""}`);
  const checked = validateBatch(result);
  assert.ok(checked.ok, `batch violates the contract: ${checked.ok ? "" : checked.detail}`);
  const next = fold(state, result, state === null ? IDENTITY : undefined);
  const shape = validateReview(next);
  assert.ok(shape.ok, `folded Review violates the contract: ${shape.ok ? "" : shape.detail}`);
  const derived = validateReviewState(read(next, { now: context.now, policy: context.policy }));
  assert.ok(derived.ok, `ReviewState violates the contract: ${derived.ok ? "" : derived.detail}`);
  return { state: next, batch: result };
}

function refusal(state: Review | null, action: Action, principal: Principal, o: CtxOverrides = {}): Refusal {
  const context = ctx(principal, nextAct(), {
    ...o,
    expectedRevision: o.expectedRevision === undefined && state !== null && (principal.kind === "seat" || principal.kind === "operator") ? state.revision : o.expectedRevision ?? null,
    ...(state === null && o.identity === undefined ? { identity: IDENTITY } : {}),
  });
  const result = decide(state, action, context);
  assert.ok(isRefusal(result), `expected a refusal, got batch ${isRefusal(result) ? "" : result.batch_id}`);
  return result;
}

function opened(o: ObserveOverrides = {}, policy: Policy = POLICY): Review {
  return apply(null, observe(o), ADAPTER, { policy }).state;
}

function pending(state: Review, assignee?: string) {
  return state.requests.filter((r) => r.status === "pending" && (assignee === undefined || r.assignee === assignee));
}

function state(review: Review, policy: Policy = POLICY, now = T0): ReviewState {
  return read(review, { now, policy });
}

function targets(batch: Batch): string[] {
  return batch.effects.map((e) => e.target);
}

function kinds(batch: Batch): string[] {
  return batch.consequences.map((c) => c.kind);
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
    ...(o.material_cure_regression !== undefined ? { material_cure_regression: o.material_cure_regression } : {}),
  };
}

interface ReportOverrides extends Partial<ReviewReport> {
  head?: string;
}

function report(reviewer: string, o: ReportOverrides = {}): ReviewReport {
  const { head, ...rest } = o;
  const findings = rest.findings ?? [];
  const mode = rest.mode ?? "initial";
  const blockers = findings.some((f) => f.disposition === "must-fix");
  const base: ReviewReport = {
    schema_version: "1",
    report_id: `report-${acts}`,
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

function answerAction(requestId: string, subjectKey: string, r: ReviewReport): Action {
  return { kind: "Answer", request_id: requestId, subject_key: subjectKey, submission: { arm: "reviewkit", report: r } };
}

function external(o: Partial<ExternalResult> & { comments?: Array<{ id: number; title?: string; priority?: AdmittedFinding["priority"] }> } = {}): Action {
  const { comments, ...rest } = o;
  return {
    kind: "AdmitExternalResult",
    result: {
      schema_version: "1",
      source: "codex",
      reviewed_head: H1,
      verdict: comments === undefined || comments.length === 0 ? "clean" : "findings",
      findings: (comments ?? []).map((c) => ({
        container_kind: "review_comment",
        container_id: c.id,
        locator: 0,
        path: "src/x.py",
        line: 12,
        priority: c.priority ?? "P1",
        title: c.title ?? `Codex ${c.id}`,
        body: "…",
      })),
      source_record: { kind: "review", id: 5001, version: T0 },
      submitted_at: T0,
      ...rest,
    },
  };
}

/** A Review at H1 with an initial request pending to `ariadne` (SEAT_POLICY). */
function seatReviewed(): { review: Review; request: string } {
  const review = opened({}, SEAT_POLICY);
  const request = pending(review, "ariadne")[0];
  assert.ok(request);
  return { review, request: request.id };
}

/** A Review where ariadne's complete answer raised one must-fix finding F at H1. */
function withFinding(findingOverrides: Partial<Finding> = {}): { review: Review; finding: string; answer: string } {
  const { review, request } = seatReviewed();
  const r = report("ariadne", { findings: [rkFinding("F1", findingOverrides)] });
  const next = apply(review, answerAction(request, review.subject.key, r), seat("ariadne"), { policy: SEAT_POLICY }).state;
  const finding = next.findings[0];
  const answer = next.answers[0];
  assert.ok(finding && answer);
  return { review: next, finding: finding.id, answer: answer.id };
}

// ---------------------------------------------------------------------------------------------
// §4 — the authorization table, every row for every principal kind
// ---------------------------------------------------------------------------------------------

/** A state in which every seat qualifier of §4 can hold for `ariadne` (or fail for `talos`). */
function authorizationFixture(): Review {
  const { review } = withFinding({ disposition: "follow-up" });
  // A hold by ariadne and an answer by ariadne exist; the finding was raised by ariadne.
  const held = apply(review, { kind: "Hold", hold: { kind: "human_gate", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: false } } }, seat("ariadne"), { policy: SEAT_POLICY }).state;
  // A second pending request to ariadne (closure) so `assignee` has a target; findings for same_as.
  const f = held.findings[0];
  assert.ok(f);
  return apply(held, { kind: "OpenRequest", request_kind: "review", mode: "closure", assignee: "ariadne", subject_key: held.subject.key, required: true, names: [f.id], reason: "burn landed" }, OPERATOR, { policy: SEAT_POLICY }).state;
}

/** One representative action per table row, built against `authorizationFixture()`. */
function representative(row: (typeof AUTHORIZATION_TABLE)[number], review: Review): Action {
  const finding = review.findings[0];
  const hold = review.holds[0];
  const answer = review.answers[0];
  const closure = review.requests.find((r) => r.status === "pending" && r.mode === "closure");
  assert.ok(finding && hold && answer && closure);
  const variant = row.variants?.[0];
  switch (row.verb) {
    case "ObservePR":
      return observe();
    case "AdmitExternalResult":
      return external();
    case "SetReviewerAvailability":
      return { kind: "SetReviewerAvailability", reviewer: "codex", available: true, reason: null, until: null, evidence: "e" };
    case "OpenRequest":
      return variant === "review"
        ? { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "theoros", subject_key: review.subject.key, required: true, names: [finding.id], reason: "r" }
        : { kind: "OpenRequest", request_kind: "retrospective", mode: null, assignee: "theoros", subject_key: review.subject.key, required: false, names: [], reason: "r" };
    case "CancelRequest":
      return { kind: "CancelRequest", request_id: closure.id, reason: "r" };
    case "Answer":
      return answerAction(closure.id, review.subject.key, report("ariadne", { mode: "closure" }));
    case "RetractAnswer":
      return { kind: "RetractAnswer", answer_id: answer.id, reason: "r" };
    case "ResolveFinding":
      switch (variant) {
        case "fixed":
          return { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "fixed", evidence: "e", commits: [H2] } };
        case "withdrawn":
          return { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "withdrawn", evidence: "e" } };
        case "follow_up":
          return { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "follow_up", evidence: "e", ticket: "KRA-1" } };
        case "owner_decision":
          return { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "owner_decision", evidence: "e", resolution_text: "t" } };
        default:
          return { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "same_as", evidence: "e", other: finding.id } };
      }
    case "ClassifyFinding":
      return { kind: "ClassifyFinding", finding_id: finding.id, priority: "P1" };
    case "Hold":
      return variant === "human_gate"
        ? { kind: "Hold", hold: { kind: "human_gate", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: false } } }
        : variant === "operator"
          ? { kind: "Hold", hold: { kind: "operator", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: false } } }
          : { kind: "Hold", hold: { kind: "exhaustion", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: true } } };
    case "Release":
      return { kind: "Release", hold_id: hold.id, reason: "r" };
    case "GrantRounds":
      return { kind: "GrantRounds", n: 1, reason: "r" };
    case "AdoptPolicy":
      return { kind: "AdoptPolicy", version: 2 };
  }
}

test("§4 the authorization table: every row, every principal kind", () => {
  const review = authorizationFixture();
  const principals: Array<[Principal["kind"], Principal]> = [
    ["seat", seat("ariadne")],
    ["operator", OPERATOR],
    ["adapter", ADAPTER],
    ["system", SYSTEM],
  ];
  assert.equal(AUTHORIZATION_TABLE.length, 20, "§4 has twenty rows");
  for (const row of AUTHORIZATION_TABLE) {
    const action = representative(row, review);
    for (const [kind, principal] of principals) {
      const allowed = row[kind] !== false;
      const result = authorize(review, action, principal, SEAT_POLICY);
      const label = `${row.verb}/${row.variants?.join("|") ?? "*"} by ${kind}`;
      if (allowed) {
        // Seat/system qualifiers hold in the fixture for these representatives, except the ones
        // whose qualifier is a property the fixture cannot satisfy for every row at once.
        const qualifierCannotHold =
          (kind === "seat" && row.seat === "burn_or_author_not_raiser") || // ariadne raised the finding
          (kind === "system" && row.system === "subject_change_or_transport_exhausted"); // the hold releases explicitly
        if (qualifierCannotHold) assert.equal(result?.code, "unauthorized", label);
        else assert.equal(result, null, `${label}: ${result?.detail ?? ""}`);
      } else {
        assert.equal(result?.code, "unauthorized", label);
      }
    }
  }
});

test("§4 seat qualifiers refuse with the table's code, not the caller's", () => {
  const review = authorizationFixture();
  const finding = review.findings[0];
  const hold = review.holds[0];
  const answer = review.answers[0];
  const closure = review.requests.find((r) => r.status === "pending" && r.mode === "closure");
  assert.ok(finding && hold && answer && closure);
  const rows: Array<[string, Action, Principal, string]> = [
    ["OpenRequest for self", { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "talos", subject_key: review.subject.key, required: true, names: [], reason: "r" }, seat("talos"), "self_review"],
    ["Answer by a non-assignee", answerAction(closure.id, review.subject.key, report("theoros", { mode: "closure" })), seat("theoros"), "not_assignee"],
    ["RetractAnswer of another's", { kind: "RetractAnswer", answer_id: answer.id, reason: "r" }, seat("theoros"), "unauthorized"],
    ["fixed by the raiser", { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("ariadne"), "unauthorized"],
    ["fixed by a bystander", { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("theoros"), "unauthorized"],
    ["withdrawn by a non-raiser", { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "withdrawn", evidence: "e" } }, seat("talos"), "unauthorized"],
    ["ClassifyFinding by a non-raiser", { kind: "ClassifyFinding", finding_id: finding.id, priority: "P1" }, seat("talos"), "unauthorized"],
    ["Release of another's hold", { kind: "Release", hold_id: hold.id, reason: "r" }, seat("talos"), "unauthorized"],
    ["Release by the system of an explicit hold", { kind: "Release", hold_id: hold.id, reason: "r" }, SYSTEM, "unauthorized"],
    ["AdmitExternalResult with a non-Codex login", external(), { ...ADAPTER, event_login: "someone" }, "unauthorized"],
    ["owner_decision by a seat", { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "owner_decision", evidence: "e", resolution_text: "t" } }, seat("talos"), "unauthorized"],
  ];
  for (const [label, action, principal, code] of rows) {
    assert.equal(authorize(review, action, principal, SEAT_POLICY)?.code, code, label);
  }
  // The burn seat and the author seat may claim a fix on a finding they did not raise (§F3).
  assert.equal(authorize(review, { kind: "ResolveFinding", finding_id: finding.id, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("talos"), SEAT_POLICY), null);
  // follow_up is the seat's only when the raiser's disposition was follow-up (§F3, F-9).
  const mustFix = withFinding({ disposition: "must-fix" });
  assert.equal(authorize(mustFix.review, { kind: "ResolveFinding", finding_id: mustFix.finding, resolution: { kind: "follow_up", evidence: "e", ticket: "KRA-1" } }, seat("ariadne"), SEAT_POLICY)?.code, "unauthorized");
  assert.equal(authorize(mustFix.review, { kind: "ResolveFinding", finding_id: mustFix.finding, resolution: { kind: "follow_up", evidence: "e", ticket: "KRA-1" } }, OPERATOR, SEAT_POLICY), null);
});

test("§4 decide refuses through the table before any verb rule runs", () => {
  const review = opened();
  assert.equal(refusal(review, observe(), seat("ariadne")).code, "unauthorized");
  assert.equal(refusal(review, { kind: "GrantRounds", n: 1, reason: "r" }, seat("ariadne")).code, "unauthorized");
  assert.equal(refusal(review, { kind: "CancelRequest", request_id: "nope", reason: "r" }, ADAPTER).code, "unauthorized");
});

// ---------------------------------------------------------------------------------------------
// Opening, §B1, §B3
// ---------------------------------------------------------------------------------------------

test("a null state admits only an adapter/system ObservePR; everything else is no_such_target", () => {
  assert.equal(refusal(null, { kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR, { expectedRevision: 0 }).code, "no_such_target");
  assert.equal(refusal(null, observe(), seat("ariadne"), { expectedRevision: 0 }).code, "no_such_target");
  assert.equal(refusal(null, observe(), OPERATOR, { expectedRevision: 0 }).code, "no_such_target");
  const bySystem = decide(null, observe(), ctx(SYSTEM, "sys1", { identity: IDENTITY }));
  assert.ok(!isRefusal(bySystem));
  // Without the Review's identity nothing can open.
  const noIdentity = decide(null, observe(), ctx(ADAPTER, "obs:1"));
  assert.ok(isRefusal(noIdentity) && noIdentity.code === "malformed");
});

test("opening mints rev_/bat_/req_/eff_ ids from the act id and records the opening consequences", () => {
  const { state: review, batch } = apply(null, observe(), ADAPTER, { actId: "obs:run1" });
  assert.equal(review.id, "rev_obs:run1");
  assert.equal(batch.batch_id, "bat_obs:run1");
  assert.equal(batch.revision, 1);
  assert.equal(review.revision, 1);
  assert.equal(review.display, "Owner/repo#7");
  assert.equal(displayName(review), "Owner/repo#7");
  assert.deepEqual(kinds(batch), ["subject_changed", "exemption_set", "mergeable_observed", "request_opened"].filter((k) => k !== "exemption_set"));
  assert.equal(review.requests[0]?.id, "req_obs:run1_1");
  assert.equal(review.requests[0]?.assignee, "codex");
  assert.deepEqual(targets(batch), ["summon:req_obs:run1_1", "board:github:rev_obs:run1", "board:slack:rev_obs:run1", `check:Owner/repo:${H1}`]);
  assert.deepEqual(batch.effects.map((e) => e.effect_id), ["eff_obs:run1_1", "eff_obs:run1_2", "eff_obs:run1_3", "eff_obs:run1_4"]);
  assert.equal(batch.effects.find((e) => e.target.startsWith("summon"))?.kind, "actionable");
  assert.equal(batch.effects.find((e) => e.target.startsWith("board"))?.payload, null);
});

test("§B1 stale_revision: seat and operator acts are fenced; adapter acts carry null", () => {
  const review = opened();
  const stale = refusal(review, { kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR, { expectedRevision: review.revision + 1 });
  assert.equal(stale.code, "stale_revision");
  assert.match(stale.detail, /current is 1/);
  assert.equal(refusal(review, { kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR, { expectedRevision: null }).code, "malformed");
  const ok = apply(review, { kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR, { expectedRevision: review.revision });
  assert.equal(ok.state.revision, 2);
  const adapter = apply(ok.state, observe({ seenAt: T1 }), ADAPTER, { expectedRevision: null });
  assert.equal(adapter.state.revision, 3);
  assert.equal(refusal(ok.state, observe({ seenAt: T1 }), ADAPTER, { expectedRevision: 1 }).code, "stale_revision");
});

test("§B3 a batch records the command, the policy version and distinct deterministic effect ids", () => {
  const { batch } = apply(null, observe(), ADAPTER, { actId: "obs:x" });
  assert.equal(batch.command.act_id, "obs:x");
  assert.deepEqual(batch.command.principal, ADAPTER);
  assert.equal(batch.command.expected_revision, null);
  assert.equal(batch.policy_version, 1);
  assert.equal(batch.admitted_at, T0);
  assert.equal(new Set(batch.effects.map((e) => e.effect_id)).size, batch.effects.length);
});

// ---------------------------------------------------------------------------------------------
// §C — observation, subject, lifecycle
// ---------------------------------------------------------------------------------------------

test("§C1 an unchanged subject preserves judgments and never suppresses the other consequences", () => {
  const review = opened();
  const { state: next, batch } = apply(review, observe({ lifecycle: "closed", draft: true, mergeable: null, seenAt: T1, baseShaNow: BASE2 }), ADAPTER);
  assert.deepEqual(kinds(batch), ["lifecycle_changed", "draft_changed", "observed_refreshed", "mergeable_observed"]);
  assert.equal(next.subject.key, review.subject.key);
  assert.equal(next.subjects.length, 1);
  assert.deepEqual(pending(next).map((r) => r.id), pending(review).map((r) => r.id));
  assert.equal(next.observed.base_sha_now, BASE2);
  assert.equal(next.observed.mergeable, null);
  // The same observation again changes nothing but still refreshes the projections.
  const again = apply(next, observe({ lifecycle: "closed", draft: true, mergeable: null, seenAt: T1, baseShaNow: BASE2 }), ADAPTER);
  assert.deepEqual(kinds(again.batch), []);
  assert.deepEqual(targets(again.batch), [`board:github:${next.id}`, `board:slack:${next.id}`, `check:Owner/repo:${H1}`]);
});

test("§C2 a subject change cancels pending requests at the old subject, releases subject_change holds and opens the initial request", () => {
  let review = opened();
  review = apply(review, { kind: "Hold", hold: { kind: "human_gate", reason: "wait", release_on: "subject_change", blocks: { readiness: true, summons: false } } }, seat("ariadne")).state;
  review = apply(review, { kind: "Hold", hold: { kind: "stack", reason: "stacked", release_on: "explicit", blocks: { readiness: true, summons: false } } }, seat("ariadne")).state;
  const old = pending(review)[0];
  assert.ok(old);
  const { state: next, batch } = apply(review, observe({ head: H2 }), ADAPTER);
  assert.equal(next.subject.key, `${H2}:main`);
  assert.equal(next.subjects.length, 2);
  assert.equal(next.requests.find((r) => r.id === old.id)?.status, "cancelled");
  assert.ok(batch.consequences.some((c) => c.kind === "request_cancelled" && c.reason === "subject_changed"));
  assert.equal(next.holds.find((h) => h.kind === "human_gate")?.released?.reason, "subject_changed");
  assert.equal(next.holds.find((h) => h.kind === "stack")?.released, null);
  const fresh = pending(next);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.subject_key, `${H2}:main`);
  assert.equal(fresh[0]?.mode, "initial");
  assert.ok(targets(batch).includes(`summon:${fresh[0]?.id}`));
  assert.ok(targets(batch).includes(`check:Owner/repo:${H2}`));
});

test("§C3 closed pauses: requests stay pending, transport is paused at dispatch, readiness is false; reopen queues nothing", () => {
  const review = opened();
  const closed = apply(review, observe({ lifecycle: "closed" }), ADAPTER);
  assert.equal(pending(closed.state).length, 1);
  assert.ok(!closed.batch.effects.some((e) => e.kind === "actionable"), "closing queues no transport");
  assert.deepEqual(state(closed.state).readiness, { ready: false, subject_key: closed.state.subject.key, reasons: ["closed", { required_request_pending: [pending(closed.state)[0]?.id ?? ""] }, { requirement_unsatisfied: [closed.state.subject.key] }] });
  // A request opened while closed queues its one transport effect (§D5); the publisher withholds it while closed (§8.1).
  const held = apply(closed.state, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: closed.state.subject.key, required: true, names: [], reason: "r" }, OPERATOR);
  const delivery = `delivery:ariadne:${pending(held.state, "ariadne")[0]?.id}`;
  assert.deepEqual(targets(held.batch).filter((t) => t.startsWith("delivery:") || t.startsWith("summon:")), [delivery]);
  assert.equal(applicability(parseTarget(delivery), held.state), "withheld", "paused while closed");
  assert.equal(applicability(parseTarget(`summon:${pending(held.state, "codex")[0]?.id}`), held.state), "withheld");
  // The reopen resumes with history intact and queues no second transport: the withheld rows become applicable.
  const reopened = apply(held.state, observe({ lifecycle: "open" }), ADAPTER);
  assert.equal(pending(reopened.state).length, 2);
  assert.deepEqual(reopened.state.requests, held.state.requests);
  assert.ok(!reopened.batch.effects.some((e) => e.kind === "actionable"), "no duplicate summons or delivery on reopen");
  assert.equal(applicability(parseTarget(delivery), reopened.state), "applicable");
  assert.equal(applicability(parseTarget(`summon:${pending(held.state, "codex")[0]?.id}`), reopened.state), "applicable");
});

test("§C3 merged is terminal: only Release, RetractAnswer and ResolveFinding(follow_up) pass; the merge announces", () => {
  const { review, finding, answer } = withFinding({ disposition: "follow-up" });
  const held = apply(review, { kind: "Hold", hold: { kind: "human_gate", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: false } } }, seat("ariadne"), { policy: SEAT_POLICY }).state;
  const hold = held.holds[0];
  assert.ok(hold);
  const merged = apply(held, observe({ lifecycle: "merged" }), ADAPTER, { policy: SEAT_POLICY });
  assert.ok(targets(merged.batch).includes(`announce:${held.id}`));
  assert.equal(merged.batch.effects.find((e) => e.target.startsWith("announce"))?.kind, "actionable");
  assert.deepEqual(state(merged.state).readiness, { ready: false, subject_key: held.subject.key, reasons: ["merged", { hold: "human_gate" }] });
  const m = merged.state;
  assert.equal(refusal(m, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "theoros", subject_key: m.subject.key, required: true, names: [], reason: "r" }, OPERATOR).code, "lifecycle");
  assert.equal(refusal(m, { kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR).code, "lifecycle");
  assert.equal(refusal(m, observe({ lifecycle: "merged", seenAt: T1 }), ADAPTER).code, "lifecycle");
  assert.equal(refusal(m, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("talos")).code, "lifecycle");
  const released = apply(m, { kind: "Release", hold_id: hold.id, reason: "done" }, seat("ariadne"), { policy: SEAT_POLICY }).state;
  const followed = apply(released, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "follow_up", evidence: "e", ticket: "KRA-99" } }, seat("ariadne"), { policy: SEAT_POLICY }).state;
  assert.equal(followed.findings[0]?.status.open, false);
  const retracted = apply(followed, { kind: "RetractAnswer", answer_id: answer, reason: "r" }, seat("ariadne"), { policy: SEAT_POLICY }).state;
  assert.equal(retracted.answers[0]?.status, "retracted");
});

test("§C4 draft: no auto-request while draft; the flip at an unchanged subject opens the initial request; readiness false while draft", () => {
  const draft = opened({ draft: true });
  assert.equal(pending(draft).length, 0);
  assert.deepEqual(state(draft).readiness, { ready: false, subject_key: draft.subject.key, reasons: [{ requirement_unsatisfied: [draft.subject.key] }, "draft"] });
  const { state: ready, batch } = apply(draft, observe({ draft: false }), ADAPTER);
  assert.deepEqual(kinds(batch), ["draft_changed", "request_opened"]);
  assert.equal(pending(ready).length, 1);
  assert.equal(pending(ready)[0]?.reason, "ready_for_review: routing_by_round.first");
  // A push while still draft changes the subject and still opens nothing.
  const pushed = apply(draft, observe({ draft: true, head: H2 }), ADAPTER).state;
  assert.equal(pending(pushed).length, 0);
});

test("§C5 the base advancing under an unchanged (head, base_ref) is not a subject change; a retarget is", () => {
  const review = opened();
  const advanced = apply(review, observe({ baseShaNow: BASE2, seenAt: T1 }), ADAPTER);
  assert.ok(!kinds(advanced.batch).includes("subject_changed"));
  assert.equal(advanced.state.observed.base_sha_now, BASE2);
  const retargeted = apply(advanced.state, observe({ baseRef: "release" }), ADAPTER);
  assert.ok(kinds(retargeted.batch).includes("subject_changed"));
  assert.equal(retargeted.state.subject.key, `${H1}:release`);
  // The key is reducer-checked against head and base_ref.
  const bad = observe();
  bad.subject.key = `${H2}:main`;
  assert.equal(refusal(review, bad, ADAPTER).code, "malformed");
});

test("§C6 the Review records the exemption evidence the reconcile run carried: it satisfies the requirement, opens no request, never releases a hold, and is never recomputed here", () => {
  const skill = opened({ changedPaths: ["skills/code-review/SKILL.md", "skills/x/y.md"], exemption: "skill_only" });
  assert.deepEqual(skill.exemption, { reason: "skill_only", evidence: "skills/code-review/SKILL.md, skills/x/y.md", subject_key: skill.subject.key });
  assert.equal(pending(skill).length, 0);
  assert.deepEqual(state(skill).requirement, { subject_key: skill.subject.key, status: "exempt" });
  assert.equal(state(skill).readiness.ready, true);
  // verbatim_copy is evidence only the reconcile run can compute (template blobs); the Review records it like any other reason.
  const verbatim = opened({ changedPaths: [".github/scripts/review_loop.py"], exemption: "verbatim_copy" });
  assert.equal(verbatim.exemption?.reason, "verbatim_copy");
  assert.deepEqual(state(verbatim).requirement, { subject_key: verbatim.subject.key, status: "exempt" });
  assert.equal(pending(verbatim).length, 0);
  // The reducer holds no rule of its own: a skills/-only subject without evidence is not exempt.
  const unproven = opened({ changedPaths: ["skills/x/SKILL.md"] });
  assert.equal(unproven.exemption, null);
  assert.equal(pending(unproven).length, 1);
  // Evidence that names another subject is malformed.
  assert.equal(refusal(null, observe({ exemption: { reason: "skill_only", evidence: "e", subject_key: `${H2}:main` } }), ADAPTER).code, "malformed");
  // A hold survives an exempt subject change.
  const mixed = opened({ changedPaths: ["docs/a.md", "src/x.py"] });
  const held = apply(mixed, { kind: "Hold", hold: { kind: "operator", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: false } } }, OPERATOR).state;
  const exempt = apply(held, observe({ head: H2, changedPaths: ["docs/b.md"], exemption: "exempt_paths" }), ADAPTER).state;
  assert.equal(exempt.exemption?.subject_key, `${H2}:main`);
  assert.equal(exempt.holds[0]?.released, null);
  assert.deepEqual(state(exempt).readiness, { ready: false, subject_key: exempt.subject.key, reasons: [{ hold: "operator" }] });
  // A later subject with no evidence clears it; an unchanged subject preserves the recorded judgment (§C1).
  const back = apply(exempt, observe({ head: H3 }), ADAPTER).state;
  assert.equal(back.exemption, null);
  const same = apply(back, observe({ head: H3, exemption: "skill_only" }), ADAPTER);
  assert.ok(!kinds(same.batch).includes("exemption_set"), "exemption is a subject-change consequence only");
  assert.equal(same.state.exemption, null);
});

// ---------------------------------------------------------------------------------------------
// §D — requests, routing, availability, transport
// ---------------------------------------------------------------------------------------------

test("§D1 at most one pending request per (assignee, subject_key, kind)", () => {
  const review = opened();
  const dup: Action = { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "codex", subject_key: review.subject.key, required: true, names: [], reason: "again" };
  assert.equal(refusal(review, dup, OPERATOR).code, "duplicate_request");
  const other = apply(review, { ...dup, assignee: "ariadne" }, OPERATOR).state;
  assert.equal(pending(other).length, 2);
  const retro = apply(other, { kind: "OpenRequest", request_kind: "retrospective", mode: null, assignee: "codex", subject_key: review.subject.key, required: false, names: [], reason: "r" }, OPERATOR).state;
  assert.equal(pending(retro, "codex").length, 2);
  assert.equal(refusal(review, { ...dup, subject_key: `${H3}:main` }, OPERATOR).code, "unknown_subject");
  assert.equal(refusal(review, { ...dup, mode: "initial", names: ["x"] }, OPERATOR).code, "malformed");
  assert.equal(refusal(review, { ...dup, mode: "closure", names: ["nope"] }, OPERATOR).code, "no_such_target");
  // The system's own openers honour §D1 too: a draft flip after an operator-opened codex request
  // opens no second pending codex review request at the subject.
  const draft = opened({ draft: true });
  const early = apply(draft, { ...dup, subject_key: draft.subject.key, reason: "early look" }, OPERATOR).state;
  assert.equal(pending(early, "codex").length, 1);
  const flipped = apply(early, observe({ draft: false }), ADAPTER);
  assert.ok(!kinds(flipped.batch).includes("request_opened"), "no second opening");
  assert.equal(pending(flipped.state, "codex").length, 1, "still one pending codex review request");
  assert.equal(pending(flipped.state, "codex")[0]?.mode, "appeal", "the operator's request stands");
});

// ---------------------------------------------------------------------------------------------
// §D6 — stall handling
// ---------------------------------------------------------------------------------------------

const MIN = 60_000;
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * MIN).toISOString();

test("§D6 stall handling: after the stall window one more transport, bounded by transport_bound; then transport_exhausted and Hold(transport_exhausted, blocks summons) — the obligation stands; an answer arriving anyway releases it", () => {
  const review = opened();
  const req = pending(review, "codex")[0];
  assert.ok(req);
  // Inside the window (policy: 1200 s): housekeeping records nothing.
  const soon = apply(review, observe(), ADAPTER, { now: at(10) });
  assert.deepEqual(kinds(soon.batch), []);
  // Past the window: one re-transport, one more summon effect, recorded on the request.
  const first = apply(soon.state, observe(), ADAPTER, { now: at(21), actId: "obs:s1" });
  assert.deepEqual(kinds(first.batch), ["request_retransported"]);
  assert.deepEqual(first.batch.consequences[0], { kind: "request_retransported", request_id: req.id, at: at(21), attempt: 1 });
  assert.deepEqual(targets(first.batch).filter((t) => t.startsWith("summon:")), [`summon:${req.id}`]);
  assert.deepEqual(first.state.requests[0]?.retransports, [at(21)]);
  assert.equal(first.state.requests[0]?.status, "pending");
  // The window is measured from the last transport, not from opened_at.
  const notYet = apply(first.state, observe(), ADAPTER, { now: at(35) });
  assert.deepEqual(kinds(notYet.batch), []);
  const second = apply(notYet.state, observe(), ADAPTER, { now: at(42), actId: "obs:s2" });
  assert.deepEqual(kinds(second.batch), ["request_retransported"]);
  assert.equal(second.state.requests[0]?.retransports.length, 2, "transport_bound = 2 re-transports");
  // The bound is spent: transport is exhausted and the system holds, blocking readiness and summons.
  // The obligation is untouched — the request is still pending and still blocks readiness by name.
  const spent = apply(second.state, observe(), ADAPTER, { now: at(63), actId: "obs:s3" });
  assert.deepEqual(kinds(spent.batch), ["request_transport_exhausted", "hold_placed"]);
  assert.ok(!spent.batch.effects.some((e) => e.kind === "actionable"), "no further transport once the bound is spent");
  assert.equal(spent.state.requests[0]?.status, "pending");
  assert.equal(spent.state.requests[0]?.transport_exhausted, true);
  const hold = spent.state.holds[0];
  assert.ok(hold);
  assert.equal(hold.kind, "transport_exhausted");
  assert.equal(hold.reason, `transport_exhausted:${req.id}`);
  assert.equal(hold.release_on, "explicit");
  assert.deepEqual(hold.blocks, { readiness: true, summons: true });
  assert.deepEqual(hold.by, { kind: "system", caused_by: "obs:s3" });
  assert.deepEqual(state(spent.state, POLICY, at(63)).readiness, {
    ready: false,
    subject_key: review.subject.key,
    reasons: [{ hold: "transport_exhausted" }, { required_request_pending: [req.id] }, { requirement_unsatisfied: [review.subject.key] }],
  });
  assert.equal(applicability(parseTarget(`summon:${req.id}`), spent.state), "withheld", "the hold withholds the summon; it is not obsolete");
  // Housekeeping is idempotent over an exhausted transport.
  assert.deepEqual(kinds(apply(spent.state, observe(), ADAPTER, { now: at(90) }).batch), []);
  // §4 Release row: the system's release — the late answer discharges the request and releases the hold.
  const late = apply(spent.state, external(), ADAPTER, { now: at(95), actId: "src:review:5001:v1" });
  assert.deepEqual(kinds(late.batch), ["answer_admitted", "request_answered", "hold_released", "charge_recorded"]);
  assert.equal(late.state.requests[0]?.status, "answered");
  assert.deepEqual(late.state.holds[0]?.released, { by: { kind: "system", caused_by: "src:review:5001:v1" }, at: at(95), reason: "answered" });
  assert.equal(state(late.state, POLICY, at(95)).readiness.ready, true);
});

test("§D6 the operator releases a transport_exhausted hold explicitly; a seat cannot; a paused transport never stalls; a seat request is re-delivered", () => {
  // A seat assignee stalls into a redelivery with its own dedupe key.
  const { review, request } = seatReviewed();
  const stalled = apply(review, observe(), ADAPTER, { now: at(25), actId: "obs:seat", policy: SEAT_POLICY });
  assert.deepEqual(kinds(stalled.batch), ["request_retransported"]);
  const redelivery = stalled.batch.effects.find((e) => e.target === `delivery:ariadne:${request}`);
  assert.ok(redelivery, "one more delivery to the seat");
  assert.equal((redelivery.payload as { dedupe_key: string }).dedupe_key, `request:${request}:obs:seat`);

  // Transport paused ⇒ no stall: closed (§C3), conflicting (§D8), summons-blocking hold (§G3).
  assert.ok(!kinds(apply(review, observe({ lifecycle: "closed" }), ADAPTER, { now: at(25), policy: SEAT_POLICY }).batch).includes("request_retransported"), "closed");
  assert.ok(!kinds(apply(review, observe({ mergeable: false }), ADAPTER, { now: at(25), policy: SEAT_POLICY }).batch).includes("request_retransported"), "conflicting");
  const held = apply(review, { kind: "Hold", hold: { kind: "stack", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: true } } }, seat("talos"), { policy: SEAT_POLICY }).state;
  assert.ok(!kinds(apply(held, observe(), ADAPTER, { now: at(25), policy: SEAT_POLICY }).batch).includes("request_retransported"), "summons-blocking hold");

  // Spend the bound (transport_bound 2) and check the explicit release path.
  const twice = apply(stalled.state, observe(), ADAPTER, { now: at(50), policy: SEAT_POLICY }).state;
  const spent = apply(twice, observe(), ADAPTER, { now: at(75), policy: SEAT_POLICY }).state;
  const hold = spent.holds.find((h) => h.kind === "transport_exhausted");
  assert.ok(hold);
  assert.equal(refusal(spent, { kind: "Release", hold_id: hold.id, reason: "r" }, seat("ariadne"), { policy: SEAT_POLICY }).code, "unauthorized");
  const released = apply(spent, { kind: "Release", hold_id: hold.id, reason: "reviewer is back" }, OPERATOR, { policy: SEAT_POLICY });
  assert.deepEqual(kinds(released.batch), ["hold_released"], "the restoration opens nothing: the obligation never left");
  // §D9: releasing the hold does not discharge the obligation — the required request still blocks.
  assert.deepEqual(state(released.state, SEAT_POLICY).readiness, {
    ready: false,
    subject_key: released.state.subject.key,
    reasons: [{ required_request_pending: [request] }, { requirement_unsatisfied: [released.state.subject.key] }],
  });
  // The obligation stands (transport exhausted, not cancelled): the seat's Answer still discharges it.
  const answered = apply(released.state, answerAction(request, released.state.subject.key, report("ariadne")), seat("ariadne"), { policy: SEAT_POLICY });
  assert.equal(answered.state.requests.find((r) => r.id === request)?.status, "answered");
  assert.equal(state(answered.state, SEAT_POLICY).readiness.ready, true);
  // The §D6 knobs come from the policy: a longer window stalls nothing at 25 minutes.
  const patient = apply(review, observe(), ADAPTER, { now: at(25), policy: { ...SEAT_POLICY, stall_window_s: 3600 } });
  assert.deepEqual(kinds(patient.batch), []);
});

// ---------------------------------------------------------------------------------------------
// §D9 — the obligation survives its transport, its assignment and its holds
// ---------------------------------------------------------------------------------------------

test("§D9 a spent transport bound does not discharge the obligation: releasing the hold leaves the required request blocking, and a late external result discharges it", () => {
  const review = opened();
  const req = pending(review, "codex")[0];
  assert.ok(req);
  // Spend the bound: two re-transports, then transport exhaustion and its hold.
  const a = apply(review, observe(), ADAPTER, { now: at(21), actId: "obs:x1" }).state;
  const b = apply(a, observe(), ADAPTER, { now: at(42), actId: "obs:x2" }).state;
  const spent = apply(b, observe(), ADAPTER, { now: at(63), actId: "obs:x3" }).state;
  assert.equal(spent.requests[0]?.status, "pending", "the obligation is untouched by its transport");
  assert.equal(spent.requests[0]?.transport_exhausted, true);
  const hold = spent.holds.find((h) => h.kind === "transport_exhausted");
  assert.ok(hold);

  // The operator releases the hold. Nothing about the review was ever answered, so readiness
  // must still name the request — this is the defect: the obligation used to evaporate with the hold.
  const released = apply(spent, { kind: "Release", hold_id: hold.id, reason: "acknowledged" }, OPERATOR, { now: at(70) });
  assert.deepEqual(kinds(released.batch), ["hold_released"], "the restoration opens nothing: the obligation never left");
  const after = state(released.state, POLICY, at(70));
  assert.equal(after.readiness.ready, false);
  assert.deepEqual(after.readiness.ready ? [] : after.readiness.reasons, [
    { required_request_pending: [req.id] },
    { requirement_unsatisfied: [review.subject.key] },
  ]);
  assert.deepEqual(after.requirement, { subject_key: review.subject.key, status: "unsatisfied", pending: [req.id] });

  // A late answer to the very same request discharges it.
  const late = apply(released.state, external(), ADAPTER, { now: at(80), actId: "src:review:5001:v1" });
  assert.equal(late.state.requests[0]?.status, "answered");
  assert.equal(late.state.requests[0]?.answered_by, late.state.answers[0]?.id);
  assert.equal(state(late.state, POLICY, at(80)).readiness.ready, true);
});

test("§D4/§D9 reassignment carries the obligation into the substitute's existing pending request; it is never dropped", () => {
  // codex holds a required closure naming F1; ariadne (the substitute) already holds a
  // non-required appeal at the same subject — §D1 leaves room for only one of them.
  const review = opened();
  const reviewed = apply(review, external({ comments: [{ id: 1 }] }), ADAPTER).state;
  const F1 = reviewed.findings[0];
  assert.ok(F1);
  const withClosure = apply(reviewed, { kind: "OpenRequest", request_kind: "review", mode: "closure", assignee: "codex", subject_key: reviewed.subject.key, required: true, names: [F1.id], reason: "fix F1" }, OPERATOR).state;
  const closure = pending(withClosure, "codex")[0];
  assert.ok(closure);
  const withAppeal = apply(withClosure, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: reviewed.subject.key, required: false, names: [], reason: "second opinion" }, OPERATOR).state;
  const appeal = pending(withAppeal, "ariadne")[0];
  assert.ok(appeal);
  assert.equal(appeal.required, false);

  // codex goes unavailable: the closure is cancelled and its obligation is folded into the appeal.
  const down = apply(withAppeal, { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: "quota", until: null, evidence: "429" }, OPERATOR);
  assert.deepEqual(kinds(down.batch), ["availability_set", "request_cancelled", "request_requirement_raised"]);
  assert.deepEqual(down.batch.consequences[2], {
    kind: "request_requirement_raised",
    request_id: appeal.id,
    required: true,
    names: [F1.id],
    mode: "closure",
    supersedes: closure.id,
    reason: "reviewer_unavailable (quota): codex → ariadne",
  });
  const carried = down.state.requests.find((r) => r.id === appeal.id);
  assert.ok(carried);
  assert.deepEqual({ required: carried.required, names: carried.names, supersedes: carried.supersedes }, { required: true, names: [F1.id], supersedes: closure.id });
  assert.ok(!down.batch.effects.some((e) => e.kind === "actionable"), "the substitute's transport row already exists; nothing is doubled");

  // The obligation is outstanding at the subject and readiness waits for it.
  const s = state(down.state);
  assert.equal(s.readiness.ready, false);
  assert.ok((s.readiness.ready ? [] : s.readiness.reasons).some((r) => typeof r === "object" && "required_request_pending" in r && r.required_request_pending.includes(appeal.id)));
  // …until it is answered, addressing the finding it inherited.
  const closed = apply(down.state, answerAction(appeal.id, down.state.subject.key, report("ariadne", { mode: "closure", findings: [], coverage: [{ id: "A1", area: "the F1 seam", paths: ["src/x.py"], status: "reviewed-no-issue", finding_id: F1.id, reason: "fixed in the pushed commit", next_step: null }] })), seat("ariadne"));
  assert.equal(closed.state.requests.find((r) => r.id === appeal.id)?.status, "answered");
  assert.deepEqual(state(closed.state).requirement.status, "satisfied");
});

test("§D9 a head observed under an exhaustion hold gets its required request, and GrantRounds releases the one transport already queued", () => {
  const { review, request } = seatReviewed();
  const exhausted = apply(review, answerAction(request, review.subject.key, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"), { policy: TIGHT_POLICY, actId: "ans1" }).state;
  const hold = exhausted.holds.find((h) => h.kind === "exhaustion");
  assert.ok(hold?.blocks.summons);

  // The author pushes a new head while the hold is active. The hold withholds transport; it
  // must not suppress the obligation (this is the defect: the head used to go unreviewed).
  const pushed = apply(exhausted, observe({ head: H2 }), ADAPTER, { policy: TIGHT_POLICY, actId: "obs:h2" });
  const opened2 = pending(pushed.state).filter((r) => r.kind === "review" && r.subject_key === pushed.state.subject.key);
  assert.equal(opened2.length, 1);
  const fresh = opened2[0];
  assert.ok(fresh);
  assert.equal(fresh.mode, "initial");
  assert.equal(fresh.required, true);
  const transport = `delivery:${fresh.assignee}:${fresh.id}`;
  assert.deepEqual(targets(pushed.batch).filter((t) => t.startsWith("delivery:")), [transport], "exactly one transport row");
  assert.equal(applicability(parseTarget(transport), pushed.state), "withheld", "the hold withholds it, it is not obsolete");

  // GrantRounds closes the episode and releases the hold; the withheld row resumes at dispatch.
  const granted = apply(pushed.state, { kind: "GrantRounds", n: 2, reason: "one more go" }, OPERATOR, { policy: TIGHT_POLICY });
  assert.deepEqual(kinds(granted.batch), ["rounds_granted", "episode_closed", "hold_released"]);
  assert.ok(!granted.batch.effects.some((e) => e.kind === "actionable"), "no second transport is queued");
  const still = pending(granted.state).filter((r) => r.kind === "review" && r.subject_key === granted.state.subject.key);
  assert.deepEqual(still.map((r) => r.id), [fresh.id], "exactly one pending review request at the current subject");
  assert.equal(applicability(parseTarget(transport), granted.state), "applicable", "and its one transport row is now dispatchable");
});

test("§D9 the operator's cancellation stands until the subject changes; the restoration never resurrects it", () => {
  const review = opened();
  const req = pending(review, "codex")[0];
  assert.ok(req);
  const cancelled = apply(review, { kind: "CancelRequest", request_id: req.id, reason: "reviewed out of band" }, OPERATOR);
  assert.deepEqual(kinds(cancelled.batch), ["request_cancelled"], "the operator's decision is not undone by the restoration it triggers");
  assert.deepEqual(cancelled.state.requests[0]?.cancellation, { by: OPERATOR, at: T0, reason: "reviewed out of band" });

  // Neither a hold cycle, nor a grant, nor a fresh observation of the same subject reopens it.
  const held = apply(cancelled.state, { kind: "Hold", hold: { kind: "operator", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: true } } }, OPERATOR).state;
  const releasedAgain = apply(held, { kind: "Release", hold_id: held.holds[0]?.id ?? "", reason: "done" }, OPERATOR);
  assert.deepEqual(kinds(releasedAgain.batch), ["hold_released"]);
  const grantedAgain = apply(releasedAgain.state, { kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR);
  assert.deepEqual(kinds(grantedAgain.batch), ["rounds_granted"]);
  const observedAgain = apply(grantedAgain.state, observe(), ADAPTER);
  assert.deepEqual(kinds(observedAgain.batch), []);
  assert.equal(pending(observedAgain.state).length, 0);

  // A new subject is new work: the decision was about the head the operator saw.
  const pushed = apply(observedAgain.state, observe({ head: H2 }), ADAPTER).state;
  const fresh = pending(pushed).filter((r) => r.subject_key === pushed.subject.key);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.mode, "initial");
});

test("§D9 CancelRequest is the operator's alone (§4), so a cancellation on the request is their decision", () => {
  const { review, request } = seatReviewed();
  assert.equal(refusal(review, { kind: "CancelRequest", request_id: request, reason: "wrong reviewer" }, seat("ariadne"), { policy: SEAT_POLICY }).code, "unauthorized");
  // The system cancels only through a reassignment, which carries the obligation on (§D4), so
  // `cancellation.by.kind === "operator"` is exactly the evidence the restoration must respect.
  const down = apply(review, { kind: "SetReviewerAvailability", reviewer: "ariadne", available: false, reason: "quota", until: null, evidence: "429" }, OPERATOR, { policy: SEAT_POLICY });
  assert.equal(down.state.requests.find((r) => r.id === request)?.cancellation?.by.kind, "system");
  const carried = pending(down.state).filter((r) => r.subject_key === down.state.subject.key);
  assert.equal(carried.length, 1);
  assert.equal(carried[0]?.required, true);
  assert.equal(carried[0]?.supersedes, request);
});

test("§D2 routing by round: codex first, the substitute after the first charge, unavailable or metered codex skipped", () => {
  const first = opened();
  assert.equal(pending(first)[0]?.assignee, "codex");
  assert.equal(pending(first)[0]?.reason, "subject_changed: routing_by_round.first");
  // After a charge the next subject routes to `later`.
  const answered = apply(first, external(), ADAPTER).state;
  assert.equal(answered.charges.length, 1);
  const pushed = apply(answered, observe({ head: H2 }), ADAPTER).state;
  assert.equal(pending(pushed)[0]?.assignee, "ariadne");
  assert.equal(pending(pushed)[0]?.reason, "subject_changed: routing_by_round.later");
  // Codex unavailable at decision time routes the first request to the substitute.
  const draft = opened({ draft: true });
  const down = apply(draft, { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: "connector", until: null, evidence: "500" }, OPERATOR).state;
  const routed = apply(down, observe({ draft: false }), ADAPTER).state;
  assert.equal(pending(routed)[0]?.assignee, "ariadne");
  assert.match(pending(routed)[0]?.reason ?? "", /unavailable \(connector\)/);
  // A meter at or above the threshold routes away and records the breach as a condition.
  const metered = apply(null, observe(), ADAPTER, { meter: { reading: 90, threshold: 90 } });
  assert.equal(pending(metered.state)[0]?.assignee, "ariadne");
  assert.deepEqual(metered.state.availability["codex"], { available: false, since: T0, reason: "meter", until: null, evidence: "meter reading 90 at or above threshold 90" });
  const under = apply(null, observe(), ADAPTER, { meter: { reading: 10, threshold: 90 } });
  assert.equal(pending(under.state)[0]?.assignee, "codex");
  // A repo overrides the ruling as data.
  const seatFirst = opened({}, SEAT_POLICY);
  assert.equal(pending(seatFirst)[0]?.assignee, "ariadne");
});

test("§D3 availability clears on an admitted signal, on `until` passing at routing time, or by the operator", () => {
  const down = (until: string | null): Review =>
    apply(opened({ draft: true }), { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: "quota", until, evidence: "429" }, ADAPTER).state;
  // `until` in the past clears at the next routing decision, recorded as a system consequence.
  const expired = apply(down(T0), observe({ draft: false }), ADAPTER, { now: T1 });
  assert.ok(expired.batch.consequences.some((c) => c.kind === "availability_set" && c.availability.available));
  assert.equal(pending(expired.state)[0]?.assignee, "codex");
  // `until` in the future does not.
  const live = apply(down(T2), observe({ draft: false }), ADAPTER, { now: T1 });
  assert.equal(pending(live.state)[0]?.assignee, "ariadne");
  assert.equal(live.state.availability["codex"]?.available, false);
  // An admitted Codex signal clears it (§11 #10 tail).
  const signalled = apply(live.state, external(), ADAPTER).state;
  assert.deepEqual(signalled.availability["codex"], { available: true });
  // The operator clears it explicitly.
  const cleared = apply(down(null), { kind: "SetReviewerAvailability", reviewer: "codex", available: true, reason: null, until: null, evidence: "manual" }, OPERATOR).state;
  assert.deepEqual(cleared.availability["codex"], { available: true });
  assert.equal(refusal(cleared, { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: null, until: null, evidence: "x" }, OPERATOR).code, "malformed");
});

test("§D4 unavailability while a request is pending reassigns once, with supersedes", () => {
  const review = opened();
  const codexReq = pending(review, "codex")[0];
  assert.ok(codexReq);
  const { state: next, batch } = apply(review, { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: "quota", until: T2, evidence: "429" }, ADAPTER);
  assert.deepEqual(kinds(batch), ["availability_set", "request_cancelled", "request_opened"]);
  assert.equal(next.requests.find((r) => r.id === codexReq.id)?.status, "cancelled");
  const substitute = pending(next)[0];
  assert.equal(substitute?.assignee, "ariadne");
  assert.equal(substitute?.supersedes, codexReq.id);
  assert.equal(substitute?.mode, "initial");
  assert.equal(substitute?.required, true);
  assert.ok(targets(batch).includes(`delivery:ariadne:${substitute?.id}`));
  // Setting it again while nothing is pending to codex reassigns nothing.
  const again = apply(next, { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: "quota", until: T2, evidence: "429" }, ADAPTER);
  assert.deepEqual(kinds(again.batch), ["availability_set"]);
});

test("§D5 transport: a seat assignee gets a delivery with a dedupe key; codex gets a summon", () => {
  const { batch } = apply(null, observe(), ADAPTER, { actId: "obs:t" });
  const summon = batch.effects.find((e) => e.target === "summon:req_obs:t_1");
  assert.deepEqual(summon?.payload, { request_id: "req_obs:t_1", subject_key: `${H1}:main`, text: "@codex review" });
  const review = fold(null, batch, IDENTITY);
  const seatReq = apply(review, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: review.subject.key, required: true, names: [], reason: "second opinion" }, OPERATOR, { actId: "op1" });
  const delivery = seatReq.batch.effects.find((e) => e.target === "delivery:ariadne:req_op1_1");
  assert.ok(delivery);
  assert.equal(delivery.kind, "actionable");
  const payload = delivery.payload as { actor: string; request_id: string; text: string; dedupe_key: string };
  assert.equal(payload.actor, "ariadne");
  assert.equal(payload.request_id, "req_op1_1");
  assert.equal(payload.dedupe_key, "request:req_op1_1:op1");
  assert.match(payload.text, /second opinion/);
});

test("§D8 mergeable=false withholds transport at dispatch and tells the author once per subject; a flip to true queues nothing; null never withholds", () => {
  const { state: conflicting, batch } = apply(null, observe({ mergeable: false }), ADAPTER, { actId: "obs:c" });
  assert.ok(kinds(batch).includes("mergeable_observed"));
  assert.equal(conflicting.observed.mergeable, false);
  assert.equal(pending(conflicting).length, 1, "the request is still opened");
  // §D5: the one summon is queued at open; §D8: the publisher withholds it while conflicting.
  assert.ok(targets(batch).includes("summon:req_obs:c_1"));
  assert.equal(applicability(parseTarget("summon:req_obs:c_1"), conflicting), "withheld");
  const notice = batch.effects.find((e) => e.target === `notice:talos:${H1}:main`);
  assert.ok(notice, "the author seat is told");
  const payload = notice.payload as { actor: string; dedupe_key: string; text: string };
  assert.equal(payload.actor, "talos");
  assert.equal(payload.dedupe_key, `conflicting:${conflicting.id}:${H1}:main`);
  assert.match(payload.text, /conflicting against main/);
  // The notice is not request transport: it names no request and the §D8 pause never holds it.
  assert.equal("request_id" in (notice.payload as Record<string, unknown>), false);
  assert.equal(applicability(parseTarget(notice.target), conflicting), "applicable");
  // Still conflicting: nothing new.
  const still = apply(conflicting, observe({ mergeable: false, seenAt: T1 }), ADAPTER);
  assert.ok(!still.batch.effects.some((e) => e.kind === "actionable"));
  // Flip to true: no second summon, no further author notice; the withheld row is now applicable.
  const resumed = apply(still.state, observe({ mergeable: true, seenAt: T2 }), ADAPTER);
  assert.deepEqual(kinds(resumed.batch), ["observed_refreshed", "mergeable_observed"]);
  assert.ok(!resumed.batch.effects.some((e) => e.kind === "actionable"));
  assert.equal(applicability(parseTarget("summon:req_obs:c_1"), resumed.state), "applicable");
  // null never withholds.
  const unknown = apply(null, observe({ mergeable: null }), ADAPTER, { actId: "obs:n" });
  assert.ok(targets(unknown.batch).includes("summon:req_obs:n_1"));
  assert.equal(applicability(parseTarget("summon:req_obs:n_1"), unknown.state), "applicable");
  // A human author gets no notice; the summon is queued and withheld all the same.
  const human = apply(null, observe({ mergeable: false, author: { kind: "human", login: "hakon" } }), ADAPTER);
  assert.ok(!human.batch.effects.some((e) => e.target.startsWith("notice:")));
  assert.equal(human.batch.effects.filter((e) => e.kind === "actionable").length, 1);
});

test("§D8 the conflict notice is one per subject, emitted whether or not a request is pending, and reissued at a new subject", () => {
  // A draft opens no request (§C4); the conflict is still a fact about the branch, and the
  // author is still told — the notice is not the request's transport.
  const first = apply(null, observe({ draft: true, mergeable: false }), ADAPTER, { actId: "obs:d" });
  assert.equal(pending(first.state).length, 0, "no request is pending");
  const noticeTargets = (b: Batch) => targets(b).filter((t) => t.startsWith("notice:"));
  assert.deepEqual(noticeTargets(first.batch), [`notice:talos:${H1}:main`]);

  // Repeated `false` at the same subject says nothing more.
  const again = apply(first.state, observe({ draft: true, mergeable: false, seenAt: T1 }), ADAPTER);
  assert.deepEqual(noticeTargets(again.batch), []);

  // A new subject born conflicting is a different subject, and gets its own notice — the
  // dedupe key moves with it, so the author is told once about each head.
  const moved = apply(again.state, observe({ draft: true, mergeable: false, head: H2, seenAt: T2 }), ADAPTER, { actId: "obs:d2" });
  assert.deepEqual(noticeTargets(moved.batch), [`notice:talos:${H2}:main`]);
  const movedPayload = moved.batch.effects.find((e) => e.target === `notice:talos:${H2}:main`)?.payload as { dedupe_key: string };
  assert.equal(movedPayload.dedupe_key, `conflicting:${moved.state.id}:${H2}:main`);
  // The first subject's notice is moot once the Review has left it; the current one stands.
  assert.equal(applicability(parseTarget(`notice:talos:${H1}:main`), moved.state), "obsolete");
  assert.equal(applicability(parseTarget(`notice:talos:${H2}:main`), moved.state), "applicable");
});

// ---------------------------------------------------------------------------------------------
// §E — answers
// ---------------------------------------------------------------------------------------------

test("§E1 an Answer binds request, assignee, subject and report; any mismatch is refused", () => {
  const { review, request } = seatReviewed();
  const key = review.subject.key;
  assert.equal(refusal(review, answerAction("req_nope", key, report("ariadne")), seat("ariadne"), { policy: SEAT_POLICY }).code, "no_such_target");
  assert.equal(refusal(review, answerAction(request, key, report("theoros")), seat("theoros"), { policy: SEAT_POLICY }).code, "not_assignee");
  assert.equal(refusal(review, answerAction(request, `${H2}:main`, report("ariadne")), seat("ariadne"), { policy: SEAT_POLICY }).code, "unknown_subject");
  assert.equal(refusal(review, answerAction(request, key, report("ariadne", { head: H2 })), seat("ariadne"), { policy: SEAT_POLICY }).code, "unknown_subject");
  assert.equal(refusal(review, answerAction(request, key, report("ariadne", { base_sha: "9".repeat(40) })), seat("ariadne"), { policy: SEAT_POLICY }).code, "unknown_subject");
  assert.equal(refusal(review, answerAction(request, key, report("theoros")), seat("ariadne"), { policy: SEAT_POLICY }).code, "malformed");
  assert.equal(refusal(review, { kind: "Answer", request_id: request, subject_key: key, submission: { arm: "testimony", testimony: { cause: null, scars: [], deliverable: { comment_id: 1 } } } }, seat("ariadne"), { policy: SEAT_POLICY }).code, "malformed");
  // The author seat never answers a review of its own subject.
  const own = apply(review, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "talos", subject_key: key, required: true, names: [], reason: "r" }, OPERATOR, { policy: SEAT_POLICY }).state;
  const talosReq = pending(own, "talos")[0];
  assert.ok(talosReq);
  assert.equal(refusal(own, answerAction(talosReq.id, key, report("talos", { mode: "appeal", appeal_fingerprint: FP(1) })), seat("talos"), { policy: SEAT_POLICY }).code, "self_review");
  // A complete answer discharges the request and nothing else does.
  const ok = apply(review, answerAction(request, key, report("ariadne")), seat("ariadne"), { policy: SEAT_POLICY });
  assert.deepEqual(kinds(ok.batch), ["answer_admitted", "request_answered", "charge_recorded"]);
  assert.equal(ok.state.requests[0]?.status, "answered");
  assert.equal(ok.state.requests[0]?.answered_by, ok.state.answers[0]?.id);
  assert.equal(state(ok.state, SEAT_POLICY).readiness.ready, true);
});

test("§E2 process rules refuse malformed and leave the request pending; a corrected Answer is admitted", () => {
  const { review, request } = seatReviewed();
  const key = review.subject.key;
  const cases: Array<[string, ReviewReport, string]> = [
    ["initial generation 1", report("ariadne", { generation: 1 }), "malformed"],
    ["terminal with a must-fix", report("ariadne", { findings: [rkFinding("F1")], automatic_chain_terminal: true }), "malformed"],
    ["incomplete but terminal", report("ariadne", { completion: "incomplete", automatic_chain_terminal: true }), "malformed"],
    ["duplicate finding ids", report("ariadne", { findings: [rkFinding("F1", { fp: 1 }), rkFinding("F1", { fp: 2 })] }), "malformed"],
    ["duplicate fingerprints", report("ariadne", { findings: [rkFinding("F1", { fp: 1 }), rkFinding("F2", { fp: 1 })] }), "malformed"],
    ["coverage names an unknown finding", report("ariadne", { coverage: [{ id: "A1", area: "area", paths: ["x"], status: "finding", finding_id: "F9", reason: null, next_step: null }] }), "malformed"],
    ["initial with appeal_fingerprint", report("ariadne", { appeal_fingerprint: FP(1) }), "malformed"],
    ["initial as a reviewer-designed cure", report("ariadne", { reviewer_designed_parent_cure: true }), "malformed"],
    ["closure mode against an initial request", report("ariadne", { mode: "closure" }), "malformed"],
    ["wrong pr_number", report("ariadne", { pr_number: 8 }), "malformed"],
    ["self review", report("ariadne", { self_review: true }), "self_review"],
    ["reviewer-authored scope", report("ariadne", { reviewer_authored_scope: true }), "self_review"],
  ];
  for (const [label, r, code] of cases) {
    const refused = refusal(review, answerAction(request, key, r), seat("ariadne"), { policy: SEAT_POLICY });
    assert.equal(refused.code, code, `${label}: ${refused.detail}`);
  }
  assert.equal(pending(review).length, 1, "the request stays pending");
  const corrected = apply(review, answerAction(request, key, report("ariadne")), seat("ariadne"), { policy: SEAT_POLICY }).state;
  assert.equal(corrected.requests[0]?.status, "answered");
});

test("§E2 closure and appeal process rules", () => {
  const { review, finding } = withFinding();
  const key = review.subject.key;
  const closureReq = apply(review, { kind: "OpenRequest", request_kind: "review", mode: "closure", assignee: "theoros", subject_key: key, required: true, names: [finding], reason: "burn" }, OPERATOR, { policy: SEAT_POLICY }).state;
  const closure = pending(closureReq, "theoros")[0];
  assert.ok(closure);
  const covering: ReviewReport["coverage"] = [{ id: "A1", area: "cure", paths: ["src/x.py"], status: "reviewed-no-issue", finding_id: finding, reason: "fixed", next_step: null }];
  const cases: Array<[string, ReviewReport, string]> = [
    ["closure generation 0", report("theoros", { mode: "closure", generation: 0, coverage: covering }), "malformed"],
    ["closure not terminal", report("theoros", { mode: "closure", automatic_chain_terminal: false, coverage: covering }), "malformed"],
    ["closure without parent_report_id", report("theoros", { mode: "closure", parent_report_id: null, coverage: covering }), "malformed"],
    ["closure without parent_resolution_id", report("theoros", { mode: "closure", parent_resolution_id: null, coverage: covering }), "malformed"],
    ["closure finding without parent_fingerprint", report("theoros", { mode: "closure", findings: [rkFinding("F2", { fp: 5 })] }), "malformed"],
    ["closure must-fix that is not a material cure regression", report("theoros", { mode: "closure", findings: [rkFinding("F2", { fp: 5, parent_fingerprint: FP(1) })] }), "malformed"],
    ["closure with appeal_fingerprint", report("theoros", { mode: "closure", appeal_fingerprint: FP(1), coverage: covering }), "malformed"],
    ["closure that omits the named finding", report("theoros", { mode: "closure" }), "unanswered_findings"],
  ];
  for (const [label, r, code] of cases) {
    const refused = refusal(closureReq, answerAction(closure.id, key, r), seat("theoros"), { policy: SEAT_POLICY });
    assert.equal(refused.code, code, `${label}: ${refused.detail}`);
  }
  // Appeal: at most one finding, matching the appeal fingerprint.
  const appealReq = apply(closureReq, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: key, required: false, names: [], reason: "appeal" }, OPERATOR, { policy: SEAT_POLICY }).state;
  const appeal = pending(appealReq, "ariadne")[0];
  assert.ok(appeal);
  assert.equal(refusal(appealReq, answerAction(appeal.id, key, report("ariadne", { mode: "appeal" })), seat("ariadne"), { policy: SEAT_POLICY }).code, "malformed");
  assert.equal(refusal(appealReq, answerAction(appeal.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(9), findings: [rkFinding("F8", { fp: 8 }), rkFinding("F7", { fp: 7 })] })), seat("ariadne"), { policy: SEAT_POLICY }).code, "malformed");
  assert.equal(refusal(appealReq, answerAction(appeal.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(9), findings: [rkFinding("F8", { fp: 8 })] })), seat("ariadne"), { policy: SEAT_POLICY }).code, "malformed");
  const ok = apply(appealReq, answerAction(appeal.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(9), findings: [rkFinding("F8", { fp: 9 })] })), seat("ariadne"), { policy: SEAT_POLICY });
  assert.ok(ok.state.answers.length === 2);
});

test("§E3 a closure answers every named finding or is refused unanswered_findings with the ids; the answers act on the findings (§F3)", () => {
  const { review, finding } = withFinding();
  const key = review.subject.key;
  const opened2 = apply(review, { kind: "OpenRequest", request_kind: "review", mode: "closure", assignee: "theoros", subject_key: key, required: true, names: [finding], reason: "burn" }, OPERATOR, { policy: SEAT_POLICY }).state;
  const closure = pending(opened2, "theoros")[0];
  assert.ok(closure);
  const omitted = refusal(opened2, answerAction(closure.id, key, report("theoros", { mode: "closure" })), seat("theoros"), { policy: SEAT_POLICY });
  assert.equal(omitted.code, "unanswered_findings");
  assert.match(omitted.detail, new RegExp(finding));
  assert.deepEqual(state(opened2, SEAT_POLICY).readiness, {
    ready: false,
    subject_key: key,
    reasons: [{ required_request_pending: [closure.id] }, { blocking_findings: [finding] }],
  });
  // "fixed" through a coverage row closes the open finding, confirmed by the closure answer.
  const fixed = apply(opened2, answerAction(closure.id, key, report("theoros", { mode: "closure", coverage: [{ id: "A1", area: "cure", paths: ["src/x.py"], status: "reviewed-no-issue", finding_id: finding, reason: "cured", next_step: null }] })), seat("theoros"), { policy: SEAT_POLICY });
  const answer = fixed.state.answers.find((a) => a.request_id === closure.id);
  assert.ok(answer && "answers" in answer.normalized);
  assert.deepEqual(answer.normalized.answers, [{ finding_id: finding, answer: "fixed", evidence: "A1: cured" }]);
  const f = fixed.state.findings.find((x) => x.id === finding);
  assert.ok(f && !f.status.open);
  assert.equal(f.status.resolution.kind, "fixed");
  assert.equal(f.status.resolution.confirmed_by, answer.id);
  assert.equal(state(fixed.state, SEAT_POLICY).readiness.ready, true);
});

test("§E3 / §F3 a closure finding with the parent fingerprint says standing (re-opens a claimed fix) or referred (owner_decision hold)", () => {
  const { review, finding } = withFinding();
  const key = review.subject.key;
  const claimed = apply(review, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "fixed", evidence: "cured in H2", commits: [H2] } }, seat("talos"), { policy: SEAT_POLICY }).state;
  const withClosure = apply(claimed, { kind: "OpenRequest", request_kind: "review", mode: "closure", assignee: "theoros", subject_key: key, required: true, names: [finding], reason: "burn" }, OPERATOR, { policy: SEAT_POLICY }).state;
  const closure = pending(withClosure, "theoros")[0];
  assert.ok(closure);
  const standing = apply(withClosure, answerAction(closure.id, key, report("theoros", { mode: "closure", findings: [rkFinding("F2", { fp: 5, parent_fingerprint: FP(1), material_cure_regression: true })] })), seat("theoros"), { policy: SEAT_POLICY });
  const f = standing.state.findings.find((x) => x.id === finding);
  assert.ok(f && f.status.open && "contested" in f.status);
  assert.equal(f.status.contested.prior.kind, "fixed");
  assert.ok(kinds(standing.batch).includes("finding_contested"));
  assert.ok(isBlocking(f));
  // referred: a closure finding with owner-decision disposition opens Hold(owner_decision).
  const withClosure2 = apply(review, { kind: "OpenRequest", request_kind: "review", mode: "closure", assignee: "theoros", subject_key: key, required: true, names: [finding], reason: "burn" }, OPERATOR, { policy: SEAT_POLICY }).state;
  const closure2 = pending(withClosure2, "theoros")[0];
  assert.ok(closure2);
  const referred = apply(withClosure2, answerAction(closure2.id, key, report("theoros", { mode: "closure", findings: [rkFinding("F2", { fp: 5, parent_fingerprint: FP(1), disposition: "owner-decision" })] })), seat("theoros"), { policy: SEAT_POLICY });
  assert.equal(referred.state.holds.find((h) => h.kind === "owner_decision")?.reason, `referred:${finding}`);
  // The operator's ruling releases it.
  const ruled = apply(referred.state, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "owner_decision", evidence: "ruled", resolution_text: "ship it" } }, OPERATOR, { policy: SEAT_POLICY }).state;
  assert.equal(ruled.holds.find((h) => h.kind === "owner_decision")?.released?.reason, "owner_decision");
  assert.equal(ruled.findings.find((x) => x.id === finding)?.status.open, false);
});

test("§E4 an external result answers the Codex request pending at that subject at admission; otherwise it is unsolicited evidence", () => {
  const review = opened();
  const codexReq = pending(review, "codex")[0];
  assert.ok(codexReq);
  const answered = apply(review, external({ comments: [{ id: 9001 }] }), ADAPTER, { actId: "src:review:5001:v1" });
  assert.deepEqual(kinds(answered.batch), ["finding_admitted", "answer_admitted", "request_answered", "charge_recorded"]);
  assert.equal(answered.state.requests[0]?.status, "answered");
  const finding = answered.state.findings[0];
  assert.ok(finding);
  assert.equal(finding.id, "fnd_src:review:5001:v1_1");
  assert.deepEqual(finding.source, { container_kind: "review_comment", comment_id: 9001, locator: 0 }, "the source names its container and the finding's place in it");
  assert.equal(finding.answer_id, "ans_src:review:5001:v1_1");
  assert.equal(finding.raised_by, "codex");
  assert.equal(finding.reviewer_disposition, null);
  const normalized = answered.state.answers[0]?.normalized;
  assert.ok(normalized && "verdict" in normalized);
  assert.equal(normalized.verdict, "findings");
  assert.equal(normalized.provenance.arm, "external");
  assert.equal(normalized.provenance.report_ref, `review:5001@${T0}`);
  // The head must have been observed.
  assert.equal(refusal(review, external({ reviewed_head: H3 }), ADAPTER).code, "unknown_subject");
  assert.equal(refusal(review, external({ comments: [{ id: 1 }, { id: 1 }] }), ADAPTER).code, "malformed");
  // A result at an old head is unsolicited evidence at that subject.
  const pushed = apply(answered.state, observe({ head: H2 }), ADAPTER).state;
  const old = apply(pushed, external({ comments: [{ id: 9002 }], source_record: { kind: "review", id: 5002, version: T1 } }), ADAPTER);
  assert.deepEqual(kinds(old.batch), ["finding_admitted"]);
  assert.equal(old.state.findings[1]?.subject_key, `${H1}:main`);
  assert.equal(old.state.findings[1]?.answer_id, null);
});

test("§E5 answers at one subject accumulate: a later clean answer withdraws nothing", () => {
  const review = opened();
  const first = apply(review, external({ comments: [{ id: 9001 }] }), ADAPTER).state;
  const clean = apply(first, external({ source_record: { kind: "review", id: 5002, version: T1 } }), ADAPTER).state;
  assert.equal(clean.findings.length, 1);
  assert.equal(clean.findings[0]?.status.open, true);
  assert.deepEqual(state(clean).readiness, { ready: false, subject_key: clean.subject.key, reasons: [{ blocking_findings: [clean.findings[0]?.id ?? ""] }] });
});

test("§E6 an incomplete answer satisfies nothing, charges nothing and leaves the request pending", () => {
  const { review, request } = seatReviewed();
  const key = review.subject.key;
  const { state: next, batch } = apply(review, answerAction(request, key, report("ariadne", { completion: "incomplete", automatic_chain_terminal: false })), seat("ariadne"), { policy: SEAT_POLICY });
  assert.deepEqual(kinds(batch), ["answer_admitted"]);
  assert.equal(next.requests[0]?.status, "pending");
  assert.equal(next.charges.length, 0);
  const s = state(next, SEAT_POLICY);
  assert.equal(s.requirement.status, "unsatisfied");
  assert.deepEqual(s.readiness, { ready: false, subject_key: key, reasons: [{ required_request_pending: [request] }, { requirement_unsatisfied: [key] }, "incomplete_answer"] });
  // External incomplete behaves the same.
  const codex = opened();
  const inc = apply(codex, external({ verdict: "incomplete" }), ADAPTER);
  assert.deepEqual(kinds(inc.batch), ["answer_admitted"]);
  assert.equal(inc.state.charges.length, 0);
  assert.equal(pending(inc.state, "codex").length, 1);
});

test("§E7 RetractAnswer re-opens the request, removes the answer from the requirement, keeps findings and the charge", () => {
  const { review, finding, answer } = withFinding();
  assert.equal(review.charges.length, 1);
  const { state: next, batch } = apply(review, { kind: "RetractAnswer", answer_id: answer, reason: "wrong head" }, seat("ariadne"), { policy: SEAT_POLICY });
  assert.deepEqual(kinds(batch), ["answer_retracted"]);
  assert.equal(next.answers[0]?.status, "retracted");
  assert.equal(next.requests[0]?.status, "pending");
  assert.equal(next.requests[0]?.answered_by, null);
  assert.equal(next.charges.length, 1);
  assert.equal(next.findings.find((f) => f.id === finding)?.status.open, true);
  assert.equal(state(next, SEAT_POLICY).requirement.status, "unsatisfied");
  assert.equal(refusal(next, { kind: "RetractAnswer", answer_id: answer, reason: "again" }, seat("ariadne"), { policy: SEAT_POLICY }).code, "no_such_target");
  // Withdrawing the finding takes an explicit act by the raiser.
  const withdrawn = apply(next, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "withdrawn", evidence: "retracted report" } }, seat("ariadne"), { policy: SEAT_POLICY }).state;
  assert.equal(withdrawn.findings[0]?.status.open, false);
});

// ---------------------------------------------------------------------------------------------
// §F — findings
// ---------------------------------------------------------------------------------------------

test("§F1 / §F4 correlation hints are evidence: a matching fingerprint or title is a new open finding with a hint", () => {
  const { review, finding } = withFinding({ title: "Returns zero" });
  const key = review.subject.key;
  const fixed = apply(review, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("talos"), { policy: SEAT_POLICY }).state;
  const again = apply(fixed, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "theoros", subject_key: key, required: true, names: [], reason: "r" }, OPERATOR, { policy: SEAT_POLICY }).state;
  const req = pending(again, "theoros")[0];
  assert.ok(req);
  const re = apply(again, answerAction(req.id, key, report("theoros", { mode: "appeal", appeal_fingerprint: FP(1), findings: [rkFinding("F1", { fp: 1, title: "  returns ZERO " })] })), seat("theoros"), { policy: SEAT_POLICY }).state;
  const fresh = re.findings[1];
  assert.ok(fresh);
  assert.equal(fresh.status.open, true);
  assert.deepEqual(fresh.correlation_hints, [finding]);
  assert.equal(re.findings[0]?.status.open, false, "the resolution never transfers by matching");
  assert.deepEqual(fresh.links, []);
});

test("§F2 same_as links explicitly and contests a resolved counterpart (§11 #9)", () => {
  const { review, finding } = withFinding();
  const key = review.subject.key;
  const claimed = apply(review, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "fixed", evidence: "cured", commits: [H2] } }, seat("talos"), { policy: SEAT_POLICY }).state;
  const pushed = apply(claimed, observe({ head: H2 }), ADAPTER, { policy: SEAT_POLICY }).state;
  const req = pending(pushed, "theoros")[0];
  assert.ok(req);
  const prime = apply(pushed, answerAction(req.id, pushed.subject.key, report("theoros", { head: H2, findings: [rkFinding("F1", { fp: 2, title: "Finding F1" })] })), seat("theoros"), { policy: SEAT_POLICY }).state;
  const fPrime = prime.findings[1];
  assert.ok(fPrime);
  assert.deepEqual(fPrime.correlation_hints, [finding]);
  const { state: linked, batch } = apply(prime, { kind: "ResolveFinding", finding_id: fPrime.id, resolution: { kind: "same_as", evidence: "same bug", other: finding } }, seat("theoros"), { policy: SEAT_POLICY });
  assert.deepEqual(kinds(batch), ["finding_linked", "finding_linked", "finding_contested"]);
  const f = linked.findings.find((x) => x.id === finding);
  assert.ok(f && f.status.open && "contested" in f.status);
  assert.equal(f.status.contested.prior.kind, "fixed");
  assert.equal(f.status.contested.by, "theoros");
  assert.equal(f.links[0]?.other, fPrime.id);
  assert.equal(linked.findings[1]?.links[0]?.other, finding);
  assert.equal(linked.findings[1]?.status.open, true);
  assert.deepEqual(state(linked, SEAT_POLICY).blocking_findings.map((x) => x.id), [finding, fPrime.id]);
  assert.equal(refusal(linked, { kind: "ResolveFinding", finding_id: fPrime.id, resolution: { kind: "same_as", evidence: "e", other: fPrime.id } }, seat("theoros"), { policy: SEAT_POLICY }).code, "malformed");
  assert.equal(refusal(linked, { kind: "ResolveFinding", finding_id: fPrime.id, resolution: { kind: "same_as", evidence: "e", other: "fnd_nope" } }, seat("theoros"), { policy: SEAT_POLICY }).code, "no_such_target");
});

test("§F3 resolution kinds: fixed (unconfirmed), refuted, withdrawn, follow_up, product_gate + owner_decision", () => {
  const { review, finding } = withFinding();
  const fixed = apply(review, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "fixed", evidence: "cured", commits: [H2] } }, seat("talos"), { policy: SEAT_POLICY });
  const f = fixed.state.findings[0];
  assert.ok(f && !f.status.open);
  assert.equal(f.status.resolution.kind, "fixed");
  assert.deepEqual(f.status.resolution.commits, [H2]);
  assert.equal(f.status.resolution.confirmed_by, null);
  assert.deepEqual(f.status.resolution.by, seat("talos"));
  assert.equal(state(fixed.state, SEAT_POLICY).readiness.ready, true);
  assert.equal(refusal(fixed.state, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "refuted", evidence: "e" } }, seat("talos"), { policy: SEAT_POLICY }).code, "no_such_target");

  const refuted = apply(review, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "refuted", evidence: "counterevidence" } }, OPERATOR, { policy: SEAT_POLICY }).state;
  assert.equal(refuted.findings[0]?.status.open === false && refuted.findings[0]?.status.resolution.kind, "refuted");

  const followed = apply(review, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "follow_up", evidence: "later", ticket: "KRA-1400" } }, OPERATOR, { policy: SEAT_POLICY }).state;
  assert.equal(followed.findings[0]?.status.open === false && followed.findings[0]?.status.resolution.ticket, "KRA-1400");

  const gated = apply(review, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "product_gate", evidence: "is this intended?" } }, seat("talos"), { policy: SEAT_POLICY });
  assert.deepEqual(kinds(gated.batch), ["finding_resolved", "hold_placed"]);
  const hold = gated.state.holds[0];
  assert.ok(hold && hold.kind === "owner_decision" && hold.release_on === "explicit" && hold.reason === `product_gate:${finding}`);
  assert.deepEqual(state(gated.state, SEAT_POLICY).readiness, { ready: false, subject_key: review.subject.key, reasons: [{ hold: "owner_decision" }] });
  const ruled = apply(gated.state, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "owner_decision", evidence: "ruled", resolution_text: "intended" } }, OPERATOR, { policy: SEAT_POLICY });
  assert.deepEqual(kinds(ruled.batch), ["finding_resolved", "hold_released"]);
  assert.equal(ruled.state.findings[0]?.status.open === false && ruled.state.findings[0]?.status.resolution.resolution_text, "intended");
  assert.equal(state(ruled.state, SEAT_POLICY).readiness.ready, true);
  assert.equal(refusal(review, { kind: "ResolveFinding", finding_id: "fnd_nope", resolution: { kind: "refuted", evidence: "e" } }, OPERATOR, { policy: SEAT_POLICY }).code, "no_such_target");
});

test("§F5 blocking ⇔ open ∧ priority ∈ {P0,P1,P2,unknown} ∧ disposition ∈ {must-fix, owner-decision, null}", () => {
  const base: AdmittedFinding = {
    id: "f", review_id: "r", subject_key: `${H1}:main`, raised_by: "codex", answer_id: null, source: { container_kind: "review_comment", comment_id: 1, locator: 0 },
    priority: "P1", reviewer_disposition: null, title: "t", path: "p", line: null, status: { open: true }, links: [], correlation_hints: [],
  };
  const table: Array<[AdmittedFinding["priority"], AdmittedFinding["reviewer_disposition"], boolean]> = [
    ["P0", null, true], ["P1", "must-fix", true], ["P2", "owner-decision", true], ["unknown", null, true],
    ["P3", "must-fix", false], ["P3", null, false], ["P1", "follow-up", false], ["P1", "noise", false],
  ];
  for (const [priority, reviewer_disposition, expected] of table) {
    assert.equal(isBlocking({ ...base, priority, reviewer_disposition }), expected, `${priority}/${reviewer_disposition}`);
  }
  const closed: AdmittedFinding = { ...base, status: { open: false, resolution: { kind: "fixed", by: OPERATOR, at: T0, evidence: "e", commits: [], ticket: null, resolution_text: null, confirmed_by: null } } };
  assert.equal(isBlocking(closed), false);
  // An unknown priority is admitted, shown and blocking until classified by the raiser or the operator.
  const review = opened();
  const unknown = apply(review, external({ comments: [{ id: 1, priority: "unknown" }] }), ADAPTER).state;
  assert.equal(state(unknown).blocking_findings.length, 1);
  const classified = apply(unknown, { kind: "ClassifyFinding", finding_id: unknown.findings[0]?.id ?? "", priority: "P3" }, OPERATOR).state;
  assert.equal(state(classified).blocking_findings.length, 0);
  assert.equal(state(classified).advisories.length, 1);
  assert.equal(state(classified).readiness.ready, true);
});

// ---------------------------------------------------------------------------------------------
// §G — budget, holds, exhaustion
// ---------------------------------------------------------------------------------------------

test("§G1 / §G2 a charge is recorded once per subject; retraction keeps it; a new SHA charges again", () => {
  const review = opened();
  const one = apply(review, external(), ADAPTER).state;
  assert.equal(one.charges.length, 1);
  assert.equal(one.charges[0]?.subject_key, `${H1}:main`);
  const two = apply(one, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: one.subject.key, required: false, names: [], reason: "r" }, OPERATOR).state;
  const appeal = pending(two, "ariadne")[0];
  assert.ok(appeal);
  const reanswered = apply(two, answerAction(appeal.id, two.subject.key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(1) })), seat("ariadne")).state;
  assert.equal(reanswered.charges.length, 1, "same-subject re-answers charge nothing");
  const retracted = apply(reanswered, { kind: "RetractAnswer", answer_id: reanswered.answers[0]?.id ?? "", reason: "r" }, OPERATOR).state;
  assert.equal(retracted.charges.length, 1);
  // A new SHA with an identical patch is re-reviewed and charged (F-5).
  const pushed = apply(retracted, observe({ head: H2, diff: DIFF }), ADAPTER).state;
  const later = pending(pushed)[0];
  assert.ok(later && later.assignee === "ariadne");
  const charged = apply(pushed, answerAction(later.id, pushed.subject.key, report("ariadne", { head: H2 })), seat("ariadne")).state;
  assert.equal(charged.charges.length, 2);
  assert.equal(state(charged).rounds_consumed, 2);
  assert.equal(state(charged).rounds_remaining, 5);
  const granted = apply(charged, { kind: "GrantRounds", n: 2, reason: "more" }, OPERATOR).state;
  assert.equal(state(granted).rounds_remaining, 7);
  assert.equal(granted.budget.granted, 2);
});

test("§G3 holds: any active hold ⇒ not ready; blocks.summons pauses transport at dispatch; release queues nothing", () => {
  const draft = opened({ draft: true });
  const held = apply(draft, { kind: "Hold", hold: { kind: "stack", reason: "on top of #6", release_on: "explicit", blocks: { readiness: true, summons: true } } }, seat("talos")).state;
  // §D9: a hold withholds transport, never creation — the auto-request opens under it (§C2/§C4).
  const requested = apply(held, observe({ draft: false }), ADAPTER);
  assert.equal(pending(requested.state).length, 1, "the obligation exists under a summons-blocking hold");
  const summon = `summon:${pending(requested.state)[0]?.id}`;
  assert.ok(targets(requested.batch).includes(summon), "the one summon is queued at open (§D5)");
  assert.equal(applicability(parseTarget(summon), requested.state), "withheld", "transport paused by the hold");
  assert.deepEqual(state(requested.state).readiness, {
    ready: false,
    subject_key: held.subject.key,
    reasons: [{ hold: "stack" }, { required_request_pending: [pending(requested.state)[0]?.id ?? ""] }, { requirement_unsatisfied: [held.subject.key] }],
  });
  const hold = requested.state.holds[0];
  assert.ok(hold);
  assert.equal(refusal(requested.state, { kind: "Release", hold_id: hold.id, reason: "r" }, seat("ariadne")).code, "unauthorized");
  const released = apply(requested.state, { kind: "Release", hold_id: hold.id, reason: "landed" }, seat("talos"));
  assert.deepEqual(kinds(released.batch), ["hold_released"]);
  assert.ok(!released.batch.effects.some((e) => e.kind === "actionable"), "release queues no second summons");
  assert.equal(applicability(parseTarget(summon), released.state), "applicable", "the withheld row resumes at dispatch");
  assert.equal(refusal(released.state, { kind: "Release", hold_id: hold.id, reason: "r" }, OPERATOR).code, "no_such_target");
  assert.equal(refusal(released.state, { kind: "Release", hold_id: "hold_nope", reason: "r" }, OPERATOR).code, "no_such_target");
  // The system may release a subject_change hold, never an explicit one.
  const sc = apply(released.state, { kind: "Hold", hold: { kind: "human_gate", reason: "r", release_on: "subject_change", blocks: { readiness: true, summons: false } } }, OPERATOR).state;
  const byHand = apply(sc, { kind: "Release", hold_id: sc.holds[1]?.id ?? "", reason: "r" }, SYSTEM).state;
  assert.equal(byHand.holds[1]?.released?.by.kind, "system");
});

test("§G4 exhaustion is one episode: hold, gate, author delivery and retrospective once; GrantRounds closes it (§11 #6)", () => {
  const { review, request } = seatReviewed();
  const key = review.subject.key;
  const { state: exhausted, batch } = apply(review, answerAction(request, key, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"), { policy: TIGHT_POLICY, actId: "ans1" });
  assert.deepEqual(kinds(batch), ["finding_admitted", "answer_admitted", "request_answered", "charge_recorded", "hold_placed", "episode_opened", "request_opened"]);
  const hold = exhausted.holds[0];
  const episode = exhausted.episodes[0];
  const retro = exhausted.requests.find((r) => r.kind === "retrospective");
  assert.ok(hold && episode && retro);
  assert.equal(hold.kind, "exhaustion");
  assert.equal(hold.blocks.summons, true);
  assert.equal(episode.hold_id, hold.id);
  assert.equal(retro.assignee, "theoros");
  assert.equal(retro.required, false);
  assert.equal(retro.reason, `exhaustion:${episode.id}`);
  const actionable = batch.effects.filter((e) => e.kind === "actionable");
  assert.deepEqual(actionable.map((e) => e.target), [`delivery:theoros:${retro.id}`, `delivery:talos:${retro.id}`]);
  assert.equal(new Set(batch.effects.map((e) => e.effect_id)).size, batch.effects.length, "each effect has a distinct id");
  assert.equal((actionable[1]?.payload as { dedupe_key: string }).dedupe_key, `gate:${exhausted.id}:${episode.id}`);
  const s = state(exhausted, TIGHT_POLICY);
  assert.equal(s.rounds_remaining, 0);
  assert.deepEqual(s.readiness, { ready: false, subject_key: key, reasons: [{ hold: "exhaustion" }, "exhausted", { blocking_findings: [exhausted.findings[0]?.id ?? ""] }] });
  // Another answer at the same subject while the episode is open emits nothing new.
  const again = apply(exhausted, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: key, required: false, names: [], reason: "r" }, OPERATOR, { policy: TIGHT_POLICY }).state;
  const appeal = pending(again, "ariadne")[0];
  assert.ok(appeal);
  const second = apply(again, answerAction(appeal.id, key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(2), findings: [rkFinding("F2", { fp: 2 })] })), seat("ariadne"), { policy: TIGHT_POLICY });
  assert.equal(second.state.episodes.length, 1);
  assert.equal(second.state.holds.length, 1);
  assert.ok(!second.batch.effects.some((e) => e.kind === "actionable"));
  // GrantRounds closes the episode and releases the hold.
  const granted = apply(second.state, { kind: "GrantRounds", n: 2, reason: "one more go" }, OPERATOR, { policy: TIGHT_POLICY });
  assert.deepEqual(kinds(granted.batch), ["rounds_granted", "episode_closed", "hold_released"]);
  assert.equal(granted.state.episodes[0]?.closed?.by.kind, "operator");
  assert.equal(granted.state.holds[0]?.released?.reason, "rounds_granted: one more go");
  assert.equal(state(granted.state, TIGHT_POLICY).rounds_remaining, 2);
  // Releasing the exhaustion hold by hand closes the episode too.
  const byHand = apply(exhausted, { kind: "Release", hold_id: hold.id, reason: "human gate passed" }, OPERATOR, { policy: TIGHT_POLICY });
  assert.deepEqual(kinds(byHand.batch), ["hold_released", "episode_closed"]);
  assert.equal(byHand.state.episodes[0]?.closed?.at, T0);
});

test("§G5 the retrospective is a non-gating request answered by a testimony; it never charges", () => {
  const review = opened();
  const withRetro = apply(review, { kind: "OpenRequest", request_kind: "retrospective", mode: null, assignee: "theoros", subject_key: review.subject.key, required: false, names: [], reason: "r" }, OPERATOR).state;
  const retro = pending(withRetro, "theoros")[0];
  assert.ok(retro);
  const clean = apply(withRetro, external(), ADAPTER).state;
  assert.equal(state(clean).readiness.ready, true, "a pending retrospective never gates");
  assert.equal(refusal(clean, answerAction(retro.id, clean.subject.key, report("theoros")), seat("theoros")).code, "malformed");
  const answered = apply(clean, { kind: "Answer", request_id: retro.id, subject_key: clean.subject.key, submission: { arm: "testimony", testimony: { cause: "budget", scars: ["s1"], deliverable: { report_ref: "retro-1" } } } }, seat("theoros"));
  assert.deepEqual(kinds(answered.batch), ["answer_admitted", "request_answered"]);
  assert.equal(answered.state.charges.length, 1);
  assert.equal(refusal(withRetro, { kind: "OpenRequest", request_kind: "retrospective", mode: "initial", assignee: "x", subject_key: review.subject.key, required: false, names: [], reason: "r" }, OPERATOR).code, "malformed");
});

// ---------------------------------------------------------------------------------------------
// §H readiness, §I policy
// ---------------------------------------------------------------------------------------------

test("§H readiness reasons follow the §8.1 precedence and the requirement consults the current subject", () => {
  const review = opened();
  const one = apply(review, external({ comments: [{ id: 1 }] }), ADAPTER).state;
  const s1 = state(one);
  assert.deepEqual(s1.requirement, { subject_key: `${H1}:main`, status: "satisfied", by: [one.answers[0]?.id ?? ""] });
  assert.deepEqual(s1.readiness, { ready: false, subject_key: `${H1}:main`, reasons: [{ blocking_findings: [one.findings[0]?.id ?? ""] }] });
  // An old CLEAN never satisfies a newer obligation.
  const pushed = apply(one, observe({ head: H2, draft: true, lifecycle: "closed" }), ADAPTER).state;
  const held = apply(pushed, { kind: "Hold", hold: { kind: "operator", reason: "r", release_on: "explicit", blocks: { readiness: true, summons: false } } }, OPERATOR).state;
  const s2 = state(held);
  assert.deepEqual(s2.requirement, { subject_key: `${H2}:main`, status: "unsatisfied", pending: [] });
  assert.deepEqual(s2.readiness, {
    ready: false,
    subject_key: `${H2}:main`,
    reasons: ["closed", { hold: "operator" }, { requirement_unsatisfied: [`${H2}:main`] }, { blocking_findings: [one.findings[0]?.id ?? ""] }, "draft"],
  });
  assert.equal(s2.rounds_consumed, 1);
  assert.equal(s2.active_holds.length, 1);
  assert.equal(s2.budget.rounds_max, 7);
  assert.equal(state(held, TIGHT_POLICY).budget.rounds_max, 1);
});

test("§I AdoptPolicy is explicit, newer, carried by the context, and re-derives routing for pending initial requests", () => {
  const review = opened();
  assert.equal(refusal(review, { kind: "AdoptPolicy", version: 1 }, OPERATOR).code, "malformed");
  assert.equal(refusal(review, { kind: "AdoptPolicy", version: 2 }, OPERATOR, { policy: POLICY }).code, "malformed");
  const v2: Policy = { ...POLICY, version: 2, routing_by_round: { first: "theoros", later: "ariadne" } };
  const { state: adopted, batch } = apply(review, { kind: "AdoptPolicy", version: 2 }, OPERATOR, { policy: v2 });
  assert.equal(batch.policy_version, 2);
  assert.equal(adopted.policy_version, 2);
  assert.deepEqual(kinds(batch), ["policy_adopted", "request_cancelled", "request_opened"]);
  const rerouted = pending(adopted)[0];
  assert.equal(rerouted?.assignee, "theoros");
  assert.equal(rerouted?.supersedes, review.requests[0]?.id);
  assert.ok(targets(batch).includes(`delivery:theoros:${rerouted?.id}`));
  // The same routing under the new policy changes nothing.
  const v3: Policy = { ...v2, version: 3 };
  const same = apply(adopted, { kind: "AdoptPolicy", version: 3 }, OPERATOR, { policy: v3 });
  assert.deepEqual(kinds(same.batch), ["policy_adopted"]);
});

test("CancelRequest cancels a pending request; a second cancel is no_such_target", () => {
  const review = opened();
  const req = pending(review)[0];
  assert.ok(req);
  const cancelled = apply(review, { kind: "CancelRequest", request_id: req.id, reason: "not needed" }, OPERATOR).state;
  assert.equal(cancelled.requests[0]?.status, "cancelled");
  assert.equal(refusal(cancelled, { kind: "CancelRequest", request_id: req.id, reason: "again" }, OPERATOR).code, "no_such_target");
  assert.equal(refusal(cancelled, { kind: "CancelRequest", request_id: "req_nope", reason: "x" }, SYSTEM).code, "no_such_target");
  assert.deepEqual(state(cancelled).requirement, { subject_key: review.subject.key, status: "unsatisfied", pending: [] });
});

test("§8.1 a comment-sourced finding whose status changes refreshes its thread; a reviewkit one does not", () => {
  const review = opened();
  const withCodex = apply(review, external({ comments: [{ id: 777 }] }), ADAPTER).state;
  const codexFinding = withCodex.findings[0];
  assert.ok(codexFinding);
  const closed = apply(withCodex, { kind: "ResolveFinding", finding_id: codexFinding.id, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("talos"));
  assert.deepEqual(targets(closed.batch), ["thread:777", `board:github:${review.id}`, `board:slack:${review.id}`, `check:Owner/repo:${H1}`]);
  assert.equal(closed.batch.effects[0]?.kind, "refresh");
  const classified = apply(closed.state, { kind: "ClassifyFinding", finding_id: codexFinding.id, priority: "P3" }, OPERATOR);
  assert.ok(!targets(classified.batch).includes("thread:777"), "a classification is not a status change");
  const { review: rk, finding } = withFinding();
  const rkClosed = apply(rk, { kind: "ResolveFinding", finding_id: finding, resolution: { kind: "refuted", evidence: "e" } }, OPERATOR, { policy: SEAT_POLICY });
  assert.ok(!targets(rkClosed.batch).some((t) => t.startsWith("thread:")));
});

// ---------------------------------------------------------------------------------------------
// §11 — acceptance sequences (the pure part)
// ---------------------------------------------------------------------------------------------

test("§11 #1 CLEAN answer → required re-review opened → malformed Answer → corrected Answer", () => {
  const review = opened();
  const clean = apply(review, external(), ADAPTER).state;
  assert.equal(state(clean).readiness.ready, true);
  const rereview = apply(clean, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "ariadne", subject_key: clean.subject.key, required: true, names: [], reason: "second look" }, OPERATOR).state;
  const req = pending(rereview, "ariadne")[0];
  assert.ok(req);
  assert.deepEqual(state(rereview).readiness, { ready: false, subject_key: clean.subject.key, reasons: [{ required_request_pending: [req.id] }] });
  const malformed = refusal(rereview, answerAction(req.id, clean.subject.key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(1), generation: 0 })), seat("ariadne"));
  assert.equal(malformed.code, "malformed");
  assert.deepEqual(state(rereview).readiness, { ready: false, subject_key: clean.subject.key, reasons: [{ required_request_pending: [req.id] }] });
  const corrected = apply(rereview, answerAction(req.id, clean.subject.key, report("ariadne", { mode: "appeal", appeal_fingerprint: FP(1) })), seat("ariadne")).state;
  assert.equal(state(corrected).readiness.ready, true);
});

test("§11 #2 finding F at H1 → unrelated push H2 → complete answer at H2 that does not mention F", () => {
  const review = opened();
  const withF = apply(review, external({ comments: [{ id: 1, title: "F" }] }), ADAPTER).state;
  const F = withF.findings[0];
  assert.ok(F);
  const pushed = apply(withF, observe({ head: H2 }), ADAPTER).state;
  const req = pending(pushed, "ariadne")[0];
  assert.ok(req);
  const answered = apply(pushed, answerAction(req.id, pushed.subject.key, report("ariadne", { head: H2 })), seat("ariadne")).state;
  assert.equal(answered.findings[0]?.status.open, true);
  assert.deepEqual(state(answered).readiness, { ready: false, subject_key: `${H2}:main`, reasons: [{ blocking_findings: [F.id] }] });
  assert.equal(state(answered).requirement.status, "satisfied");
});

test("§11 #3 draft → ready at unchanged head; open → closed → reopened", () => {
  const draft = opened({ draft: true });
  assert.equal(pending(draft).length, 0);
  const ready = apply(draft, observe({ draft: false }), ADAPTER).state;
  assert.equal(pending(ready).length, 1);
  const withF = apply(ready, external({ comments: [{ id: 1 }] }), ADAPTER).state;
  const closed = apply(withF, observe({ lifecycle: "closed" }), ADAPTER).state;
  const closedReadiness = state(closed).readiness;
  assert.ok(!closedReadiness.ready);
  assert.equal(closedReadiness.reasons[0], "closed");
  const reopened = apply(closed, observe({ lifecycle: "open" }), ADAPTER).state;
  assert.deepEqual(reopened.requests, withF.requests);
  assert.deepEqual(reopened.findings, withF.findings);
  assert.deepEqual(reopened.answers, withF.answers);
  assert.equal(reopened.subjects.length, 1);
});

test("§11 #7 replay: fold over the batches under a different clock and policy is byte-identical and emits nothing", () => {
  const { review: seeded, request } = seatReviewed();
  const batches: Batch[] = [];
  const record = (r: { state: Review; batch: Batch }): Review => {
    batches.push(r.batch);
    return r.state;
  };
  // Rebuild the seed's batch too: replay must start from null.
  const first = decide(null, observe(), ctx(ADAPTER, "obs:seed", { policy: SEAT_POLICY, identity: IDENTITY }));
  assert.ok(!isRefusal(first));
  batches.push(first);
  let s = fold(null, first, IDENTITY);
  assert.deepEqual(s.requests.map((r) => r.assignee), seeded.requests.map((r) => r.assignee));
  const req = s.requests[0]?.id ?? request;
  s = record(apply(s, answerAction(req, s.subject.key, report("ariadne", { findings: [rkFinding("F1")] })), seat("ariadne"), { policy: SEAT_POLICY }));
  const F = s.findings[0]?.id ?? "";
  s = record(apply(s, { kind: "ResolveFinding", finding_id: F, resolution: { kind: "fixed", evidence: "e", commits: [H2] } }, seat("talos"), { policy: SEAT_POLICY, now: T1 }));
  s = record(apply(s, observe({ head: H2, mergeable: false, seenAt: T1 }), ADAPTER, { policy: SEAT_POLICY, now: T1 }));
  s = record(apply(s, { kind: "SetReviewerAvailability", reviewer: "theoros", available: false, reason: "connector", until: T2, evidence: "500" }, ADAPTER, { policy: SEAT_POLICY, now: T1 }));
  s = record(apply(s, { kind: "Hold", hold: { kind: "human_gate", reason: "r", release_on: "subject_change", blocks: { readiness: true, summons: true } } }, OPERATOR, { policy: SEAT_POLICY, now: T2 }));
  s = record(apply(s, { kind: "GrantRounds", n: 3, reason: "r" }, OPERATOR, { policy: SEAT_POLICY, now: T2 }));
  s = record(apply(s, observe({ head: H3, mergeable: true, seenAt: T2 }), ADAPTER, { policy: SEAT_POLICY, now: T2 }));
  s = record(apply(s, { kind: "AdoptPolicy", version: 2 }, OPERATOR, { policy: { ...SEAT_POLICY, version: 2, rounds_max: 3 }, now: T2 }));

  assert.equal(batches.length, 9);
  assert.ok(batches.some((b) => b.effects.some((e) => e.kind === "actionable")), "the original run emitted actionable effects");
  // Replay: no decide, a different clock and policy are irrelevant because fold takes neither.
  let replayed: Review | null = null;
  for (const b of batches) replayed = fold(replayed, b, replayed === null ? IDENTITY : undefined);
  assert.deepEqual(replayed, s);
  assert.equal(JSON.stringify(replayed), JSON.stringify(s), "state_json is identical");
  // fold is pure: the inputs are untouched and it emits nothing (it has no channel to).
  const frozen = JSON.stringify(batches);
  fold(replayed, batches[8] as Batch);
  assert.equal(JSON.stringify(batches), frozen);
  // read() under yet another clock/policy derives from the same state.
  assert.equal(read(replayed as Review, { now: "2027-01-01T00:00:00Z", policy: POLICY }).revision, 9);
});

test("§11 #8 unsolicited Codex re-sample at H → request opened later at H stays pending", () => {
  const review = opened();
  const answered = apply(review, external(), ADAPTER).state;
  const resample = apply(answered, external({ comments: [{ id: 42 }], source_record: { kind: "review", id: 5002, version: T1 } }), ADAPTER);
  assert.deepEqual(kinds(resample.batch), ["finding_admitted"]);
  assert.equal(resample.state.findings[0]?.answer_id, null);
  const later = apply(resample.state, { kind: "OpenRequest", request_kind: "review", mode: "appeal", assignee: "codex", subject_key: review.subject.key, required: true, names: [], reason: "again" }, OPERATOR).state;
  assert.equal(pending(later, "codex").length, 1);
  assert.ok(state(later).readiness.ready === false);
  assert.deepEqual(state(later).readiness, { ready: false, subject_key: review.subject.key, reasons: [{ required_request_pending: [pending(later, "codex")[0]?.id ?? ""] }, { blocking_findings: [resample.state.findings[0]?.id ?? ""] }] });
});

test("§11 #10 Codex request pending → quota refusal → later Codex signal", () => {
  const review = opened();
  const codexReq = pending(review, "codex")[0];
  assert.ok(codexReq);
  const refusedQuota = apply(review, { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: "quota", until: T2, evidence: "quota exhausted" }, ADAPTER);
  const sub = pending(refusedQuota.state)[0];
  assert.equal(sub?.assignee, "ariadne");
  assert.equal(sub?.supersedes, codexReq.id);
  assert.equal(refusedQuota.state.requests.filter((r) => r.supersedes !== null).length, 1, "one reassignment");
  const signal = apply(refusedQuota.state, external({ comments: [{ id: 5 }] }), ADAPTER);
  assert.deepEqual(kinds(signal.batch), ["availability_set", "finding_admitted"]);
  assert.deepEqual(signal.state.availability["codex"], { available: true });
  assert.equal(signal.state.findings[0]?.answer_id, null, "the cancelled request is not answered by the late signal");
  assert.equal(pending(signal.state, "ariadne").length, 1);
});

test("effects: every applied batch refreshes board and check; refresh payloads are null; ids are distinct across a batch", () => {
  const review = opened();
  const { batch } = apply(review, { kind: "GrantRounds", n: 1, reason: "r" }, OPERATOR, { actId: "01J" });
  assert.deepEqual(batch.effects, [
    // §8.1: one row per board sink, so a failing GitHub comment never gates the Slack line.
    { effect_id: "eff_01J_1", kind: "refresh", target: `board:github:${review.id}`, payload: null },
    { effect_id: "eff_01J_2", kind: "refresh", target: `board:slack:${review.id}`, payload: null },
    { effect_id: "eff_01J_3", kind: "refresh", target: `check:Owner/repo:${H1}`, payload: null },
  ] satisfies Effect[]);
});
