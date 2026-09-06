/**
 * The one transition function of the review state machine (design v0.2 §4–§6, §8.1).
 *
 * `decide(state, action, ctx)` is pure: the authorization table (§4), the lifecycle gate
 * (§C3), the revision fence (§B1) and then the verb's own rules, producing a `Batch` whose
 * `consequences` are the materialized state changes and whose `effects` are the outbox rows
 * (§5.B3, §8.1). `fold(state, batch)` applies consequences only — it never re-derives and never
 * emits, so replay is `fold` over the stored batches (§5.B3). `read(state)` derives §3.6.
 *
 * Everything the reducer needs is in `ctx`: no I/O, no `Date.now()`, no randomness. Ids are
 * minted deterministically from the act id (module map §1) so a replayed batch carries the same
 * ids the original did.
 *
 * Doc comments cite the rule they implement.
 */
import type {
  Action,
  AdmittedFinding,
  Answer,
  AnswerAction,
  Availability,
  Batch,
  Consequence,
  Effect,
  ExhaustionEpisode,
  FindingAnswer,
  FindingAnswerKind,
  Hold,
  HoldSpec,
  NormalizedResult,
  Observed,
  ObservePRAction,
  Policy,
  Principal,
  Reason,
  Refusal,
  RefusalCode,
  Request,
  Resolution,
  Review,
  ReviewKey,
  ReviewReport,
  ReviewState,
  Testimony,
} from "./contract.js";
import { BOARD_SINKS, transportState } from "./effects.js";
import { threadContainerIds, threadState } from "./render.js";

// ---------------------------------------------------------------------------------------------
// Context and identity
// ---------------------------------------------------------------------------------------------

/**
 * §3.1: GitHub's stable ids plus the display name. Neither the `ObservePR` action nor the batch
 * carries them, so the store hands them to `decide` (first act) and to `fold` (first batch of a
 * replay) — module-map deviation recorded by the reducer builder.
 */
export interface ReviewIdentity {
  key: ReviewKey;
  display: string;
}

export interface DecideContext {
  /** ISO UTC; the only clock. */
  now: string;
  /** The Review's policy version (§6.I), or the repo's latest when state is null. */
  policy: Policy;
  actId: string;
  principal: Principal;
  /** Seat/operator must equal `state.revision` (§B1); adapter/system pass null. */
  expectedRevision: number | null;
  /** §D2 routing input, fetched by the reconcile run and recorded in the batch. */
  meter: { reading: number; threshold: number } | null;
  /** Required when `state` is null: the Review being opened (§3.1). */
  identity?: ReviewIdentity;
}

/** §9.2 default when the policy leaves `rounds_max` unset. */
export const DEFAULT_ROUNDS_MAX = 7;
/** Every seat/operator verb carries a client ULID; the reducer only needs it to be non-empty. */
const SHA_RE = /^[0-9a-f]{40}$/;
/** §3.2 A3 / §4: the connector's bot logins — the only adapter provenance that may admit an external result. */
export const CODEX_LOGINS: ReadonlySet<string> = new Set(["chatgpt-codex-connector[bot]"]);
/** §9.2 defaults when the policy leaves the §D6 knobs unset. */
export const DEFAULT_STALL_WINDOW_S = 1200;
export const DEFAULT_TRANSPORT_BOUND = 2;

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

function refuse(code: RefusalCode, detail: string): Refusal {
  return { refused: true, code, detail };
}

export function isRefusal(result: Batch | Refusal): result is Refusal {
  return "refused" in result && result.refused === true;
}

// ---------------------------------------------------------------------------------------------
// §4 — the one authorization table
// ---------------------------------------------------------------------------------------------

/**
 * How a seat qualifies on a row. Evaluated in exactly one place (`authorize`); the code the
 * refusal carries is the table's, never the caller's.
 */
export type SeatRule =
  | "any"
  | "not_self" // OpenRequest review: assignee ≠ the acting seat (§4, `self_review`)
  | "assignee" // Answer: the request's assignee only (§E1, `not_assignee`)
  | "own_answer" // RetractAnswer: its own
  | "burn_or_author_not_raiser" // ResolveFinding fixed/refuted/product_gate
  | "raiser" // ResolveFinding withdrawn, ClassifyFinding
  | "follow_up_disposition" // ResolveFinding follow_up only when the raiser's disposition was follow-up
  | "own_hold"; // Release: its own holds

export type SystemRule = boolean | "subject_change_or_transport_exhausted";
export type AdapterRule = boolean | "codex_login";

export interface AuthorizationRow {
  verb: Action["kind"];
  /** Row qualifier: `request_kind`, `resolution.kind` or `hold.kind`; null for the whole verb. */
  variants: string[] | null;
  seat: SeatRule | false;
  operator: boolean;
  adapter: AdapterRule;
  system: SystemRule;
}

/** §4, verbatim as data. No caller adds an exception. */
export const AUTHORIZATION_TABLE: readonly AuthorizationRow[] = [
  { verb: "ObservePR", variants: null, seat: false, operator: false, adapter: true, system: true },
  { verb: "AdmitExternalResult", variants: null, seat: false, operator: false, adapter: "codex_login", system: false },
  { verb: "SetReviewerAvailability", variants: null, seat: false, operator: true, adapter: true, system: true },
  { verb: "OpenRequest", variants: ["review"], seat: "not_self", operator: true, adapter: false, system: true },
  { verb: "OpenRequest", variants: ["retrospective"], seat: false, operator: true, adapter: false, system: true },
  { verb: "CancelRequest", variants: null, seat: false, operator: true, adapter: false, system: true },
  { verb: "Answer", variants: null, seat: "assignee", operator: false, adapter: false, system: false },
  { verb: "RetractAnswer", variants: null, seat: "own_answer", operator: true, adapter: false, system: false },
  { verb: "ResolveFinding", variants: ["fixed", "refuted", "product_gate"], seat: "burn_or_author_not_raiser", operator: true, adapter: false, system: false },
  { verb: "ResolveFinding", variants: ["withdrawn"], seat: "raiser", operator: true, adapter: false, system: false },
  { verb: "ResolveFinding", variants: ["follow_up"], seat: "follow_up_disposition", operator: true, adapter: false, system: false },
  { verb: "ResolveFinding", variants: ["owner_decision"], seat: false, operator: true, adapter: false, system: false },
  { verb: "ResolveFinding", variants: ["same_as"], seat: "any", operator: true, adapter: false, system: false },
  { verb: "ClassifyFinding", variants: null, seat: "raiser", operator: true, adapter: false, system: false },
  { verb: "Hold", variants: ["human_gate", "stack"], seat: "any", operator: true, adapter: false, system: false },
  { verb: "Hold", variants: ["operator"], seat: false, operator: true, adapter: false, system: false },
  { verb: "Hold", variants: ["exhaustion", "transport_exhausted", "owner_decision"], seat: false, operator: false, adapter: false, system: true },
  { verb: "Release", variants: null, seat: "own_hold", operator: true, adapter: false, system: "subject_change_or_transport_exhausted" },
  { verb: "GrantRounds", variants: null, seat: false, operator: true, adapter: false, system: false },
  { verb: "AdoptPolicy", variants: null, seat: false, operator: true, adapter: false, system: false },
];

/** The row qualifier an action selects (§4 splits three verbs by payload). */
export function variantOf(action: Action): string | null {
  switch (action.kind) {
    case "OpenRequest":
      return action.request_kind;
    case "ResolveFinding":
      return action.resolution.kind;
    case "Hold":
      return action.hold.kind;
    default:
      return null;
  }
}

export function authorizationRow(action: Action): AuthorizationRow {
  const variant = variantOf(action);
  const row = AUTHORIZATION_TABLE.find(
    (r) => r.verb === action.kind && (r.variants === null || (variant !== null && r.variants.includes(variant))),
  );
  if (row === undefined) throw new Error(`§4 table has no row for ${action.kind}/${variant ?? "*"}`);
  return row;
}

function principalLabel(principal: Principal): string {
  switch (principal.kind) {
    case "seat":
      return principal.actor;
    case "operator":
      return `operator:${principal.id}`;
    case "adapter":
      return `adapter:${principal.reconcile_run}`;
    case "system":
      return `system:${principal.caused_by}`;
  }
}

function isSeatOf(principal: Principal, actor: string): boolean {
  return principal.kind === "seat" && principal.actor === actor;
}

/**
 * §4: the authorization table and nothing else. Returns the refusal or null. Seat qualifiers
 * that need a target return `no_such_target` when the target is missing, so a caller never has
 * to pre-check one.
 */
export function authorize(state: Review | null, action: Action, principal: Principal, policy: Policy): Refusal | null {
  const row = authorizationRow(action);
  const denied = refuse("unauthorized", `${principal.kind} may not ${action.kind}${variantOf(action) === null ? "" : ` ${variantOf(action)}`}`);
  switch (principal.kind) {
    case "operator":
      return row.operator ? null : denied;
    case "adapter":
      if (row.adapter === false) return denied;
      if (row.adapter === "codex_login" && !CODEX_LOGINS.has(principal.event_login)) {
        return refuse("unauthorized", `adapter provenance ${principal.event_login} is not a Codex login`);
      }
      return null;
    case "system":
      if (row.system === false) return denied;
      if (row.system === "subject_change_or_transport_exhausted") {
        if (action.kind !== "Release" || state === null) return denied;
        const hold = state.holds.find((h) => h.id === action.hold_id);
        if (hold === undefined) return refuse("no_such_target", `hold ${action.hold_id} does not exist`);
        return hold.release_on === "subject_change" || hold.kind === "transport_exhausted" ? null : denied;
      }
      return null;
    case "seat":
      return authorizeSeat(state, action, principal.actor, row, policy, denied);
  }
}

function authorizeSeat(
  state: Review | null,
  action: Action,
  actor: string,
  row: AuthorizationRow,
  policy: Policy,
  denied: Refusal,
): Refusal | null {
  if (row.seat === false) return denied;
  if (row.seat === "any") return null;
  if (state === null) return denied;
  switch (row.seat) {
    case "not_self": {
      if (action.kind !== "OpenRequest") return denied;
      return action.assignee === actor ? refuse("self_review", `${actor} may not request a review of itself`) : null;
    }
    case "assignee": {
      if (action.kind !== "Answer") return denied;
      const request = state.requests.find((r) => r.id === action.request_id);
      if (request === undefined) return refuse("no_such_target", `request ${action.request_id} does not exist`);
      return request.assignee === actor ? null : refuse("not_assignee", `request ${request.id} is assigned to ${request.assignee}, not ${actor}`);
    }
    case "own_answer": {
      if (action.kind !== "RetractAnswer") return denied;
      const answer = state.answers.find((a) => a.id === action.answer_id);
      if (answer === undefined) return refuse("no_such_target", `answer ${action.answer_id} does not exist`);
      return isSeatOf(answer.principal, actor) ? null : refuse("unauthorized", `${actor} may only retract its own answers`);
    }
    case "own_hold": {
      if (action.kind !== "Release") return denied;
      const hold = state.holds.find((h) => h.id === action.hold_id);
      if (hold === undefined) return refuse("no_such_target", `hold ${action.hold_id} does not exist`);
      return isSeatOf(hold.by, actor) ? null : refuse("unauthorized", `${actor} may only release its own holds`);
    }
    case "burn_or_author_not_raiser":
    case "raiser":
    case "follow_up_disposition": {
      const findingId = action.kind === "ResolveFinding" || action.kind === "ClassifyFinding" ? action.finding_id : null;
      if (findingId === null) return denied;
      const finding = state.findings.find((f) => f.id === findingId);
      if (finding === undefined) return refuse("no_such_target", `finding ${findingId} does not exist`);
      if (row.seat === "raiser") {
        return finding.raised_by === actor ? null : refuse("unauthorized", `${actor} did not raise ${finding.id}`);
      }
      if (row.seat === "follow_up_disposition") {
        return finding.reviewer_disposition === "follow-up"
          ? null
          : refuse("unauthorized", `follow_up on ${finding.id} is the operator's: the raiser's disposition was ${finding.reviewer_disposition ?? "null"}`);
      }
      if (finding.raised_by === actor) return refuse("unauthorized", `the raiser ${actor} may not resolve ${finding.id} as ${variantOf(action)}`);
      const author = state.subject.author;
      const isBurn = actor === policy.burn_actor;
      const isAuthor = author.kind === "seat" && author.actor === actor;
      return isBurn || isAuthor ? null : refuse("unauthorized", `${actor} is neither the burn seat nor the author seat`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Predicates shared by decide and read
// ---------------------------------------------------------------------------------------------

/** §6.F5: blocking ⇔ open ∧ priority ∈ {P0,P1,P2,unknown} ∧ disposition ∈ {must-fix, owner-decision, null}. */
export function isBlocking(finding: AdmittedFinding): boolean {
  if (!finding.status.open) return false;
  if (finding.priority === "P3") return false;
  const d = finding.reviewer_disposition;
  return d === null || d === "must-fix" || d === "owner-decision";
}

function activeHolds(review: Review): Hold[] {
  return review.holds.filter((h) => h.released === null);
}

function openEpisode(review: Review): ExhaustionEpisode | undefined {
  return review.episodes.find((e) => e.closed === null);
}

function pendingReviewRequestsAt(review: Review, subjectKey: string): Request[] {
  return review.requests.filter((r) => isOutstanding(r) && r.kind === "review" && r.subject_key === subjectKey);
}

/**
 * §3.4 / §6.D9 — the one outstanding-obligation predicate.
 *
 * A request carries its obligation until a named authoritative act discharges it: an `Answer`
 * (§E1, `answered`) or an explicit cancellation (§D9, `cancelled`) — an exemption (§C6)
 * discharges the *subject's* requirement, never a request. Transport is not part of this. A
 * request whose transport bound is spent (`transport_exhausted`, §D6), whose transport is
 * withheld by a hold (§G3), by a conflict (§D8) or by a closed PR (§C3), or whose assignee
 * became unavailable (§D3), is still outstanding: the work was never done.
 *
 * Every consumer asks this and nothing else — readiness (§6.H, `read`), recovery (§D6
 * housekeeping, `admitExternal` and `Answer` matching) and restoration (§D9,
 * {@link restoreObligations}).
 */
function isOutstanding(request: Request): boolean {
  return request.status === "pending";
}

/** §6.H: the outstanding *required* obligations at `subjectKey` — what readiness waits on. */
function outstandingRequiredAt(review: Review, subjectKey: string): Request[] {
  return review.requests.filter((r) => isOutstanding(r) && r.required && r.subject_key === subjectKey);
}

/**
 * §D9 cancellation evidence: an operator's `CancelRequest` on a required review request at the
 * *current* subject is the operator's decision that this subject needs no review. It stands
 * until the subject changes (a new subject is new work, and its own requests were cancelled
 * `subject_changed` by the system, not by anyone's decision). The system's own cancellations —
 * `subject_changed`, `reviewer_unavailable` followed by a reassignment — are bookkeeping and
 * never suppress restoration.
 */
function operatorCancelledAt(review: Review, subjectKey: string): boolean {
  return review.requests.some(
    (r) =>
      r.status === "cancelled" &&
      r.required &&
      r.kind === "review" &&
      r.subject_key === subjectKey &&
      r.cancellation !== null &&
      r.cancellation.by.kind === "operator",
  );
}

function isNormalized(n: NormalizedResult | Testimony): n is NormalizedResult {
  return "completion" in n;
}

/** §6.H: a standing, complete answer to an initial or closure review request at `subjectKey`. */
function satisfyingAnswers(review: Review, subjectKey: string): Answer[] {
  return review.answers.filter((a) => {
    if (a.status !== "standing" || a.subject_key !== subjectKey) return false;
    if (!isNormalized(a.normalized) || a.normalized.completion !== "complete") return false;
    const request = review.requests.find((r) => r.id === a.request_id);
    return request !== undefined && request.kind === "review" && (request.mode === "initial" || request.mode === "closure");
  });
}

function roundsMax(policy: Policy): number {
  return policy.rounds_max ?? DEFAULT_ROUNDS_MAX;
}

function subjectKeyOf(headSha: string, baseRef: string): string {
  return `${headSha}:${baseRef}`;
}

/** `owner/repo` from the display name (§3.1), for the §8.1 check target. */
function repoOf(display: string): string {
  const hash = display.lastIndexOf("#");
  return hash === -1 ? display : display.slice(0, hash);
}

export function displayName(review: Review): string {
  return review.display;
}

function timeLte(a: string, b: string): boolean {
  return Date.parse(a) <= Date.parse(b);
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function observedEqual(a: Observed, b: Observed): boolean {
  return (
    a.author_login === b.author_login &&
    a.base_sha_now === b.base_sha_now &&
    a.head_ref === b.head_ref &&
    a.mergeable === b.mergeable &&
    a.title === b.title
  );
}

// ---------------------------------------------------------------------------------------------
// The seed and the fold (§5.B3)
// ---------------------------------------------------------------------------------------------

/**
 * The Review before its first consequence: what the opening `ObservePR` already fixes. Shared by
 * `decide` (first act) and `fold` (first batch of a replay) so both start from the same bytes.
 * `budget.rounds_max` is the contract default; the effective bound is the policy's (§9.2), read
 * at decision time — a replay has no policy.
 */
function seedReview(identity: ReviewIdentity, actId: string, policyVersion: number, opening: ObservePRAction): Review {
  return {
    id: `rev_${actId}`,
    key: identity.key,
    display: identity.display,
    revision: 0,
    policy_version: policyVersion,
    subject: opening.subject,
    subjects: [],
    lifecycle: opening.lifecycle,
    draft: opening.draft,
    observed: opening.observed,
    requests: [],
    answers: [],
    findings: [],
    holds: [],
    charges: [],
    budget: { rounds_max: DEFAULT_ROUNDS_MAX, granted: 0 },
    episodes: [],
    availability: {},
    exemption: null,
    projection_handles: { board_comment_id: null, check_run_ids: {}, slack_thread_ts: null },
  };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fold: ${what} does not exist`);
  return value;
}

/** §5.B3: one consequence, applied in place to a private copy. Never derives, never emits. */
function applyConsequence(review: Review, c: Consequence): void {
  switch (c.kind) {
    case "subject_changed":
      review.subject = c.subject;
      review.subjects.push(c.subject);
      return;
    case "lifecycle_changed":
      review.lifecycle = c.after;
      return;
    case "draft_changed":
      review.draft = c.draft;
      return;
    case "observed_refreshed":
      review.observed = c.observed;
      return;
    case "exemption_set":
      review.exemption = c.exemption;
      return;
    case "request_opened":
      review.requests.push(c.request);
      return;
    case "request_cancelled": {
      // §D9: the cancelling act is retained — it is the evidence `restoreObligations` reads.
      const request = must(review.requests.find((r) => r.id === c.request_id), `request ${c.request_id}`);
      request.status = "cancelled";
      request.cancellation = { by: c.by, at: c.at, reason: c.reason };
      return;
    }
    case "request_answered": {
      const request = must(review.requests.find((r) => r.id === c.request_id), `request ${c.request_id}`);
      request.status = "answered";
      request.answered_by = c.answer_id;
      return;
    }
    case "request_retransported":
      must(review.requests.find((r) => r.id === c.request_id), `request ${c.request_id}`).retransports.push(c.at);
      return;
    case "request_transport_exhausted":
      // §D6: the bound is spent. The obligation is untouched — the request stays pending.
      must(review.requests.find((r) => r.id === c.request_id), `request ${c.request_id}`).transport_exhausted = true;
      return;
    case "request_obligation_merged": {
      // §D4: the superseded obligation folded into the substitute's existing pending request —
      // the union of the two, never a raise the merge invented.
      const request = must(review.requests.find((r) => r.id === c.request_id), `request ${c.request_id}`);
      request.required = c.required;
      request.names = c.names;
      request.mode = c.mode;
      request.supersedes = c.supersedes;
      return;
    }
    case "request_transport_rearmed": {
      // §D6: exhaustion undone by a named act — the request is reachable again and housekeeping
      // measures its window from the transport this consequence's act queues.
      const request = must(review.requests.find((r) => r.id === c.request_id), `request ${c.request_id}`);
      request.transport_exhausted = false;
      request.retransports = [];
      return;
    }
    case "answer_admitted":
      review.answers.push(c.answer);
      return;
    case "answer_retracted": {
      // §E7: the retraction re-opens the request it answered.
      must(review.answers.find((a) => a.id === c.answer_id), `answer ${c.answer_id}`).status = "retracted";
      for (const request of review.requests) {
        if (request.answered_by === c.answer_id) {
          request.status = "pending";
          request.answered_by = null;
        }
      }
      return;
    }
    case "finding_admitted":
      review.findings.push(c.finding);
      return;
    case "finding_resolved":
      must(review.findings.find((f) => f.id === c.finding_id), `finding ${c.finding_id}`).status = { open: false, resolution: c.resolution };
      return;
    case "finding_contested":
      must(review.findings.find((f) => f.id === c.finding_id), `finding ${c.finding_id}`).status = { open: true, contested: c.contest };
      return;
    case "finding_linked":
      must(review.findings.find((f) => f.id === c.finding_id), `finding ${c.finding_id}`).links.push(c.link);
      return;
    case "finding_classified":
      must(review.findings.find((f) => f.id === c.finding_id), `finding ${c.finding_id}`).priority = c.priority;
      return;
    case "hold_placed":
      review.holds.push(c.hold);
      return;
    case "hold_released":
      must(review.holds.find((h) => h.id === c.hold_id), `hold ${c.hold_id}`).released = c.release;
      return;
    case "charge_recorded":
      review.charges.push(c.charge);
      return;
    case "episode_opened":
      review.episodes.push(c.episode);
      return;
    case "episode_closed":
      must(review.episodes.find((e) => e.id === c.episode_id), `episode ${c.episode_id}`).closed = c.close;
      return;
    case "availability_set":
      review.availability[c.reviewer] = c.availability;
      return;
    case "rounds_granted":
      review.budget.granted += c.n;
      return;
    case "policy_adopted":
      review.policy_version = c.version;
      return;
    case "mergeable_observed":
      review.observed.mergeable = c.mergeable;
      return;
  }
}

/**
 * §5.B3: applies consequences only; never re-derives, never emits. `fold(fold(s,b1),b2)` is
 * replay. The first batch of a Review needs its identity (§3.1), which the store holds.
 */
export function fold(state: Review | null, batch: Batch, identity?: ReviewIdentity): Review {
  let review: Review;
  if (state === null) {
    if (batch.command.action.kind !== "ObservePR") throw new Error("fold: a Review opens with ObservePR");
    if (identity === undefined) throw new Error("fold: the opening batch needs the Review's identity");
    review = seedReview(identity, batch.command.act_id, batch.policy_version, batch.command.action);
  } else {
    review = structuredClone(state);
  }
  for (const consequence of batch.consequences) applyConsequence(review, consequence);
  review.revision = batch.revision;
  return review;
}

// ---------------------------------------------------------------------------------------------
// The transaction: a working copy that folds as it decides
// ---------------------------------------------------------------------------------------------

type EffectPayload = Record<string, unknown> | null;

/**
 * Every consequence `decide` records is applied to the working copy through the same
 * `applyConsequence` that `fold` uses, so the state `decide` reasons about is by construction
 * what a replay reproduces.
 */
class Transaction {
  readonly consequences: Consequence[] = [];
  readonly effects: Effect[] = [];
  readonly before: Review | null;
  review: Review;
  private readonly counters = new Map<string, number>();

  constructor(
    readonly ctx: DecideContext,
    state: Review | null,
    seed: Review | null,
  ) {
    this.before = state;
    if (state !== null) this.review = structuredClone(state);
    else if (seed !== null) this.review = seed;
    else throw new Error("transaction needs a state or a seed");
  }

  /** Module map §1: `<prefix>_<actId>_<n>`, `n` from 1 per prefix within one batch. */
  mint(prefix: "req" | "ans" | "fnd" | "hold" | "ep" | "eff"): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${this.ctx.actId}_${n}`;
  }

  record(consequence: Consequence): void {
    this.consequences.push(consequence);
    applyConsequence(this.review, consequence);
  }

  effect(kind: Effect["kind"], target: string, payload: EffectPayload): Effect {
    const effect: Effect = { effect_id: this.mint("eff"), kind, target, payload };
    this.effects.push(effect);
    return effect;
  }

  get system(): Principal {
    return { kind: "system", caused_by: this.ctx.actId };
  }

  batch(action: Action): Batch {
    return {
      batch_id: `bat_${this.ctx.actId}`,
      revision: (this.before?.revision ?? 0) + 1,
      command: {
        act_id: this.ctx.actId,
        action,
        expected_revision: this.ctx.expectedRevision,
        principal: this.ctx.principal,
      },
      admitted_at: this.ctx.now,
      policy_version: this.review.policy_version,
      consequences: this.consequences,
      effects: this.effects,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------------------------

/** §4 + §6: authorization table, lifecycle gate, revision fence, then the verb's own rules. */
export function decide(state: Review | null, action: Action, ctx: DecideContext): Batch | Refusal {
  // Module map §2: on a null state only an adapter/system ObservePR opens a Review.
  let seed: Review | null = null;
  if (state === null) {
    if (action.kind !== "ObservePR" || (ctx.principal.kind !== "adapter" && ctx.principal.kind !== "system")) {
      return refuse("no_such_target", "no Review exists; only an adapter or system ObservePR opens one");
    }
    if (ctx.identity === undefined) return refuse("malformed", "opening a Review needs its identity (key and display)");
    seed = seedReview(ctx.identity, ctx.actId, ctx.policy.version, action);
  }

  const denied = authorize(state, action, ctx.principal, ctx.policy);
  if (denied !== null) return denied;

  if (state !== null) {
    const gate = lifecycleGate(state, action);
    if (gate !== null) return gate;
    const fence = revisionFence(state, ctx);
    if (fence !== null) return fence;
  }

  const tx = new Transaction(ctx, state, seed);
  const verb = applyVerb(tx, action);
  if (verb !== null) return verb;

  // §8.1: a `review_comment` container's thread is refreshed when the *container's* aggregate
  // state changed across the batch — resolved once every finding in it is closed, un-resolved
  // as soon as any is open or contested (`threadState`). Only a `review_comment` container has
  // a GitHub review thread; an `issue_comment` container (the shape that carries several inline
  // findings) has none, so it is never a `thread:` target.
  //
  // The aggregate, not the per-finding status change, is the trigger: admitting a new open
  // finding into a container whose thread is already resolved changes no existing finding's
  // status, and a loop over changed findings emitted nothing — the thread stayed resolved over
  // an open blocking finding. The container is also the target, so a batch that changed several
  // findings in one container refreshes it once.
  for (const commentId of threadContainerIds(tx.review)) {
    const then = tx.before === null ? null : threadState(tx.before, commentId);
    if (threadState(tx.review, commentId) !== then) tx.effect("refresh", `thread:${commentId}`, null);
  }
  // Module map §2: every batch that changed something refreshes the board and the check at the
  // current head. A batch with no consequences is an audit batch — its facts are unchanged, so
  // it has no new publication work and emits nothing.
  // §8.1: the board has one row per sink, always both — the reducer is pure and cannot know
  // which sinks this broker has, so the publisher marks an unconfigured sink's row obsolete
  // (the GitHub comment in M0) exactly as it already does for a check without a GitHub port.
  if (tx.consequences.length > 0) {
    for (const sink of BOARD_SINKS) tx.effect("refresh", `board:${sink}:${tx.review.id}`, null);
    tx.effect("refresh", `check:${repoOf(tx.review.display)}:${tx.review.subject.head_sha}`, null);
  }
  return tx.batch(action);
}

/** §C3: merged is terminal for new work — only lineage hygiene passes. */
function lifecycleGate(state: Review, action: Action): Refusal | null {
  if (state.lifecycle !== "merged") return null;
  const hygiene =
    action.kind === "Release" ||
    action.kind === "RetractAnswer" ||
    (action.kind === "ResolveFinding" && action.resolution.kind === "follow_up");
  return hygiene ? null : refuse("lifecycle", `${state.display} is merged; ${action.kind} is refused`);
}

/** §B1: seat and operator acts carry `expected_revision == revision`; adapter/system carry null. */
function revisionFence(state: Review, ctx: DecideContext): Refusal | null {
  const fenced = ctx.principal.kind === "seat" || ctx.principal.kind === "operator";
  if (ctx.expectedRevision === null) {
    return fenced ? refuse("malformed", `${ctx.principal.kind} acts carry expected_revision`) : null;
  }
  if (ctx.expectedRevision !== state.revision) {
    return refuse("stale_revision", `expected revision ${ctx.expectedRevision}, current is ${state.revision}`);
  }
  return null;
}

function applyVerb(tx: Transaction, action: Action): Refusal | null {
  switch (action.kind) {
    case "ObservePR":
      return observe(tx, action);
    case "AdmitExternalResult":
      return admitExternal(tx, action);
    case "SetReviewerAvailability":
      return setAvailability(tx, action);
    case "OpenRequest":
      return openRequest(tx, action);
    case "CancelRequest":
      return cancelRequest(tx, action);
    case "Answer":
      return answer(tx, action);
    case "RetractAnswer":
      return retractAnswer(tx, action);
    case "ResolveFinding":
      return resolveFinding(tx, action);
    case "ClassifyFinding":
      return classifyFinding(tx, action);
    case "Hold":
      return placeHold(tx, action);
    case "Release":
      return release(tx, action);
    case "GrantRounds":
      return grantRounds(tx, action);
    case "AdoptPolicy":
      return adoptPolicy(tx, action);
  }
}

// ---------------------------------------------------------------------------------------------
// Transport (§D5)
// ---------------------------------------------------------------------------------------------

/**
 * §D5: one effect per opening — a Hive delivery to a seat, a summon comment for `codex` —
 * queued unconditionally. Pausing (§C3 closed, §D8 conflicting, §G3 summons-blocking hold) and
 * resuming are the publisher's applicability check on that one row (§8.1, `effects.ts`); the
 * reducer never queues a second transport for the same opening, so a reopen, a conflict
 * clearing or a release cannot double a summons.
 */
function emitTransport(tx: Transaction, request: Request): void {
  const review = tx.review;
  if (request.assignee === "codex") {
    tx.effect("actionable", `summon:${request.id}`, {
      request_id: request.id,
      subject_key: request.subject_key,
      text: "@codex review",
    });
    return;
  }
  const mode = request.kind === "review" ? request.mode ?? "review" : "retrospective";
  // The obligation the row is delivering, not only the one the request was opened with: a
  // request whose obligation was merged (§D4) is re-dispatched, and what changed is its mode and
  // the findings it now names, so both are in the text the assignee reads.
  const names = request.names.length > 0 ? ` addressing ${request.names.join(", ")};` : "";
  tx.effect("actionable", `delivery:${request.assignee}:${request.id}`, {
    actor: request.assignee,
    request_id: request.id,
    text: `${review.display}: ${mode} request ${request.id} at ${request.subject_key} —${names} ${request.reason}`,
    dedupe_key: `request:${request.id}:${tx.ctx.actId}`,
  });
}

// ---------------------------------------------------------------------------------------------
// Routing and availability (§D2–§D4)
// ---------------------------------------------------------------------------------------------

/** §D3: `until` passing is evaluated at the next routing decision and recorded as a system consequence. */
function clearExpiredAvailability(tx: Transaction, reviewer: string): void {
  const current = tx.review.availability[reviewer];
  if (current === undefined || current.available) return;
  if (current.until !== null && timeLte(current.until, tx.ctx.now)) {
    tx.record({ kind: "availability_set", reviewer, availability: { available: true } });
  }
}

/** §D3: any admitted signal from a reviewer clears its recorded unavailability. */
function clearAvailabilityOnSignal(tx: Transaction, reviewer: string): void {
  const current = tx.review.availability[reviewer];
  if (current !== undefined && !current.available) {
    tx.record({ kind: "availability_set", reviewer, availability: { available: true } });
  }
}

/** §D2 (KRA-1131): the first charged subject's initial request goes to `first`; every later one to `later`. */
function routeInitial(tx: Transaction): { assignee: string; reason: string } {
  const policy = tx.ctx.policy;
  const { first, later } = policy.routing_by_round;
  if (tx.review.charges.length > 0) return { assignee: later, reason: "routing_by_round.later" };
  clearExpiredAvailability(tx, first);
  const availability = tx.review.availability[first];
  if (availability !== undefined && !availability.available) {
    return { assignee: later, reason: `routing_by_round.first ${first} unavailable (${availability.reason}) → later` };
  }
  const meter = tx.ctx.meter;
  if (first === "codex" && meter !== null && meter.reading >= meter.threshold) {
    // §D3: the system records the meter breach as a condition, not a bare flag.
    tx.record({
      kind: "availability_set",
      reviewer: "codex",
      availability: {
        available: false,
        since: tx.ctx.now,
        reason: "meter",
        until: null,
        evidence: `meter reading ${meter.reading} at or above threshold ${meter.threshold}`,
      },
    });
    return { assignee: later, reason: `codex meter ${meter.reading} ≥ ${meter.threshold} → later` };
  }
  return { assignee: first, reason: "routing_by_round.first" };
}

/** §D1's key: the one pending request per `(assignee, subject_key, kind)`, if there is one. */
function pendingFor(review: Review, assignee: string, subjectKey: string, kind: Request["kind"]): Request | undefined {
  return review.requests.find((r) => isOutstanding(r) && r.assignee === assignee && r.subject_key === subjectKey && r.kind === kind);
}

function hasPending(review: Review, assignee: string, subjectKey: string, kind: Request["kind"]): boolean {
  return pendingFor(review, assignee, subjectKey, kind) !== undefined;
}

interface OpenSpec {
  kind: Request["kind"];
  mode: Request["mode"];
  assignee: string;
  subjectKey: string;
  required: boolean;
  names: string[];
  reason: string;
  supersedes: string | null;
  openedBy: Principal;
}

/**
 * §D1 by construction: every opener — the verb, the auto-request (§C2/§C4), a reassignment
 * (§D4), the exhaustion episode (§G5) — passes through here, and a pending request to the same
 * `(assignee, subject_key, kind)` is returned instead of doubled. The verb refuses
 * `duplicate_request` before reaching this point (§D1); the system openers are silent about it.
 */
function open(tx: Transaction, spec: OpenSpec): Request {
  const existing = pendingFor(tx.review, spec.assignee, spec.subjectKey, spec.kind);
  if (existing !== undefined) return existing;
  const request: Request = {
    id: tx.mint("req"),
    kind: spec.kind,
    mode: spec.mode,
    assignee: spec.assignee,
    subject_key: spec.subjectKey,
    required: spec.required,
    names: spec.names,
    status: "pending",
    opened_by: spec.openedBy,
    opened_at: tx.ctx.now,
    reason: spec.reason,
    supersedes: spec.supersedes,
    transport: [],
    retransports: [],
    transport_exhausted: false,
    cancellation: null,
    answered_by: null,
  };
  tx.record({ kind: "request_opened", request });
  emitTransport(tx, request);
  return request;
}

/**
 * §C2 / §C4 / §D9 — restore the required work the current subject must have.
 *
 * Creating an obligation and being permitted to transport it are different things. A hold
 * withholds *transport* — that is `effects.transportState` (§G3, §D8, §C3) — and never
 * prevents the obligation from existing, so this function asks nothing about holds. (Before
 * this, an exhaustion hold suppressed the initial request at a head pushed under it, and the
 * `GrantRounds` that released the hold queued nothing, on the assumption that a withheld
 * transport row already existed: the new head was never reviewed.)
 *
 * It is the reducer's one invariant-restoration point, and so is called from every act that can
 * change the invariant's inputs: `observe` (subject change, draft flip, lifecycle), `release`,
 * `grantRounds`, `cancelRequest`, `setAvailability` and `adoptPolicy`. It is idempotent — it
 * opens nothing when an outstanding obligation already stands at the current subject
 * ({@link outstandingRequiredAt}) — so a release, a grant or a reopen queues no second
 * transport: the withheld row resumes at dispatch (§8.1).
 *
 * It never resurrects what the operator explicitly ended: {@link operatorCancelledAt} is the
 * evidence, and it stands until the subject changes.
 */
function restoreObligations(tx: Transaction, why: string): void {
  const review = tx.review;
  if (review.draft || review.lifecycle !== "open") return;
  // §6.H: the same two ways the subject's requirement is already met — an exemption, or a
  // standing complete answer. Neither leaves work to restore.
  if (review.exemption !== null && review.exemption.subject_key === review.subject.key) return;
  if (satisfyingAnswers(review, review.subject.key).length > 0) return;
  if (outstandingRequiredAt(review, review.subject.key).length > 0) return;
  if (operatorCancelledAt(review, review.subject.key)) return;
  const route = routeInitial(tx);
  open(tx, {
    kind: "review",
    mode: "initial",
    assignee: route.assignee,
    subjectKey: review.subject.key,
    required: true,
    names: [],
    reason: `${why}: ${route.reason}`,
    supersedes: null,
    openedBy: tx.system,
  });
}

/**
 * §3.4 / §6.D4 — the mode a merged request must carry.
 *
 * A merge folds two obligations into one request, and the one request is discharged by one
 * complete answer, so its mode must be one whose complete answer satisfies *every* obligation
 * folded in. {@link satisfyingAnswers} counts only `initial` and `closure`, so an `appeal` mode
 * on a request that absorbed an initial requirement would leave the subject permanently
 * unsatisfied with nothing pending — the requirement discharged by an answer that cannot
 * satisfy it. The precedence, in order:
 *
 * 1. Two retrospective requests have no mode at all (`null` on both sides).
 * 2. `appeal` survives only when *both* obligations were appeals — an appeal is the only mode
 *    that satisfies nothing on its own, so it can never absorb something that must be
 *    satisfied.
 * 3. Otherwise the merged request names findings ⇒ `closure` (a request carrying names is not
 *    an initial, §6.D1), and names none ⇒ `initial`. Both satisfy the subject's requirement,
 *    so an unsatisfied initial obligation survives the merge either way.
 */
function mergedMode(left: Request["mode"], right: Request["mode"], names: readonly string[]): Request["mode"] {
  if (left === null && right === null) return null;
  if (left === "appeal" && right === "appeal") return "appeal";
  return names.length > 0 ? "closure" : "initial";
}

/**
 * §D4: cancel the pending request and carry its obligation to the substitute with `supersedes`
 * — once, and never by silently adopting whatever the substitute happened to have pending.
 *
 * §D1 permits one pending request per `(assignee, subject_key, kind)`, so when the substitute
 * already holds one a second request is not available: the existing request takes the
 * superseded obligation on, as a recorded `request_obligation_merged` consequence carrying the
 * *union* of the two — `required` is the OR (two optional obligations merge into an optional
 * one; the merge records what happened and never invents a requirement), `names` is the union
 * of the named findings, `mode` is {@link mergedMode}, and `supersedes` names what it absorbed.
 * Nothing about the obligation is dropped.
 *
 * A merge that expanded the obligation queues one fresh transport (§D5): the payload already
 * delivered describes the request as it was, so without this the substitute is never told that
 * the request now carries a requirement, named findings or a mode it did not have. The delivery
 * `dedupe_key` carries the act id, so the new row is a distinct row and not a duplicate of the
 * one the opening queued.
 */
function reassign(tx: Transaction, request: Request, substitute: string, reason: string): void {
  const why = `${reason}: ${request.assignee} → ${substitute}`;
  tx.record({ kind: "request_cancelled", request_id: request.id, reason, by: tx.system, at: tx.ctx.now });
  const existing = pendingFor(tx.review, substitute, request.subject_key, request.kind);
  if (existing !== undefined) {
    const names = [...existing.names, ...request.names.filter((id) => !existing.names.includes(id))];
    const required = existing.required || request.required;
    const mode = mergedMode(existing.mode, request.mode, names);
    const expanded = required !== existing.required || names.length > existing.names.length || mode !== existing.mode;
    tx.record({ kind: "request_obligation_merged", request_id: existing.id, required, names, mode, supersedes: request.id, reason: why });
    // The consequence is already folded into `tx.review`, so `existing` is the merged request.
    if (expanded) emitTransport(tx, existing);
    return;
  }
  open(tx, {
    kind: request.kind,
    mode: request.mode,
    assignee: substitute,
    subjectKey: request.subject_key,
    required: request.required,
    names: request.names,
    reason: why,
    supersedes: request.id,
    openedBy: tx.system,
  });
}

function substituteFor(policy: Policy, reviewer: string): string | null {
  if (policy.routing_by_round.later !== reviewer) return policy.routing_by_round.later;
  if (policy.substitute_actor !== reviewer) return policy.substitute_actor;
  return null;
}

// ---------------------------------------------------------------------------------------------
// ObservePR (§C1–§C6, §D8)
// ---------------------------------------------------------------------------------------------

/** §C1: a whole-state observation; every consequence is derived independently. */
function observe(tx: Transaction, action: ObservePRAction): Refusal | null {
  const before = tx.before;
  if (action.subject.key !== subjectKeyOf(action.subject.head_sha, action.subject.base_ref)) {
    return refuse("malformed", "Subject.key must be `<head_sha>:<base_ref>`");
  }
  if (action.exemption !== null && action.exemption.subject_key !== action.subject.key) {
    return refuse("malformed", `exemption evidence names ${action.exemption.subject_key}, not the observed subject ${action.subject.key}`);
  }
  // §C5: the same (head, base_ref) is the same subject however the base tip moved.
  const subjectChanged = before === null || before.subject.key !== action.subject.key;

  if (subjectChanged) {
    const previousKey = before?.subject.key ?? null;
    tx.record({ kind: "subject_changed", previous_key: previousKey, subject: action.subject });
    // §C2: pending requests at the old subject are cancelled …
    for (const request of tx.review.requests) {
      if (request.status === "pending" && request.subject_key !== action.subject.key) {
        tx.record({ kind: "request_cancelled", request_id: request.id, reason: "subject_changed", by: tx.system, at: tx.ctx.now });
      }
    }
    // … holds released on subject change release …
    for (const hold of activeHolds(tx.review)) {
      if (hold.release_on === "subject_change") {
        tx.record({ kind: "hold_released", hold_id: hold.id, release: { by: tx.system, at: tx.ctx.now, reason: "subject_changed" } });
      }
    }
    // … and the exemption is the evidence the reconcile run computed for this subject (§C6:
    // "the reconcile run computes it; the Review records the evidence") — never recomputed here.
    if (JSON.stringify(action.exemption) !== JSON.stringify(tx.review.exemption)) {
      tx.record({ kind: "exemption_set", exemption: action.exemption });
    }
  }

  if (before !== null && before.lifecycle !== action.lifecycle) {
    tx.record({ kind: "lifecycle_changed", before: before.lifecycle, after: action.lifecycle });
  }
  if (before !== null && before.draft !== action.draft) {
    tx.record({ kind: "draft_changed", draft: action.draft });
  }
  if (before !== null && !observedEqual(before.observed, action.observed)) {
    tx.record({ kind: "observed_refreshed", observed: action.observed });
  }
  // §D8: GitHub's tri-state is recorded when it changes (and on open).
  if (before === null || before.observed.mergeable !== action.observed.mergeable) {
    tx.record({ kind: "mergeable_observed", mergeable: action.observed.mergeable });
  }

  // §C2 / §C4 / §D9: the observation may have changed the subject, the draft flag or the
  // lifecycle — each an input of the invariant the restoration establishes.
  if (subjectChanged) restoreObligations(tx, "subject_changed");
  else if (before !== null && before.draft && !action.draft) restoreObligations(tx, "ready_for_review");
  else if (before !== null && before.lifecycle !== action.lifecycle) restoreObligations(tx, "lifecycle_changed");

  // §C3: → merged announces. A reopen queues nothing: the paused transport rows resume at dispatch (§8.1).
  if (before !== null && before.lifecycle !== "merged" && action.lifecycle === "merged") {
    tx.effect("actionable", `announce:${tx.review.id}`, { review_id: tx.review.id, text: `${tx.review.display} merged` });
  }

  // §D8: `mergeable === false` at a subject tells the author once — on the flip into it, and
  // again at a new subject that is born conflicting, since that is a different subject's
  // notice. Whether a request is pending is not the notice's business: the conflict is a fact
  // about the branch, and the author is told so the transport can resume. A flip out of `false`
  // resumes the withheld transport rows at dispatch; the notice itself is never withheld
  // (§8.1 `notice:` — it is not request transport), and `dedupe_key` is the one-per-subject bound.
  const wasConflicting = before !== null && before.observed.mergeable === false;
  const isConflicting = action.observed.mergeable === false;
  if (isConflicting && (subjectChanged || !wasConflicting)) {
    const author = tx.review.subject.author;
    if (author.kind === "seat") {
      tx.effect("actionable", `notice:${author.actor}:${tx.review.subject.key}`, {
        actor: author.actor,
        text: `${tx.review.display} is conflicting against ${tx.review.subject.base_ref} tip ${action.observed.base_sha_now}; review transport is withheld until it is mergeable`,
        dedupe_key: `conflicting:${tx.review.id}:${tx.review.subject.key}`,
      });
    }
  }

  // §D6: housekeeping over pending requests rides the observation (§A4: a system act is a
  // consequence inside an admitted command's batch; the §7 sweep observes every Review with a
  // pending request, which is the housekeeping cadence).
  housekeepStalls(tx);
  return null;
}

/**
 * §D6: after the policy's stall window with no answer, one more transport effect is queued —
 * a summon for Codex, a redelivery for a seat — bounded by `transport_bound`; when the bound is
 * spent the request is marked `transport_exhausted` and the system places
 * `Hold(transport_exhausted, blocks summons)`. That is a fact about reachability, not a
 * discharge: the request stays pending, keeps blocking readiness (§6.H) and is still what a
 * late answer discharges. The window is measured from the last transport the reducer queued (`opened_at`
 * or the last re-transport), and never runs while transport is paused (§C3 closed, §D8
 * conflicting, §G3 summons-blocking hold): a request nobody could reach has not stalled.
 * `Release` is the operator's, or the system's when an answer arrives anyway (`admitAnswer`).
 */
function housekeepStalls(tx: Transaction): void {
  const review = tx.review;
  const policy = tx.ctx.policy;
  const windowMs = (policy.stall_window_s ?? DEFAULT_STALL_WINDOW_S) * 1000;
  const bound = policy.transport_bound ?? DEFAULT_TRANSPORT_BOUND;
  const now = Date.parse(tx.ctx.now);
  for (const request of [...review.requests]) {
    if (!isOutstanding(request)) continue;
    // §D6: the bound is spent once; housekeeping is idempotent over an exhausted transport.
    if (request.transport_exhausted) continue;
    if (transportState(review, request) !== "applicable") continue;
    const lastTransportAt = request.retransports[request.retransports.length - 1] ?? request.opened_at;
    if (now - Date.parse(lastTransportAt) < windowMs) continue;
    if (request.retransports.length < bound) {
      tx.record({ kind: "request_retransported", request_id: request.id, at: tx.ctx.now, attempt: request.retransports.length + 1 });
      emitTransport(tx, request);
      continue;
    }
    tx.record({
      kind: "request_transport_exhausted",
      request_id: request.id,
      reason: `no answer from ${request.assignee} after ${bound} re-transport(s), each ${policy.stall_window_s ?? DEFAULT_STALL_WINDOW_S}s apart`,
    });
    tx.record({
      kind: "hold_placed",
      hold: {
        id: tx.mint("hold"),
        kind: "transport_exhausted",
        by: tx.system,
        at: tx.ctx.now,
        reason: `transport_exhausted:${request.id}`,
        release_on: "explicit",
        blocks: { readiness: true, summons: true },
        released: null,
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Findings admission (§F1, §F5)
// ---------------------------------------------------------------------------------------------

/** §F1: fingerprint and normalized-title matches are evidence shown to reviewers, never authority. */
function correlationHints(review: Review, source: AdmittedFinding["source"], title: string): string[] {
  const wanted = normalizeTitle(title);
  return review.findings
    .filter((f) => {
      if ("fingerprint" in source && "fingerprint" in f.source && f.source.fingerprint === source.fingerprint) return true;
      return normalizeTitle(f.title) === wanted;
    })
    .map((f) => f.id);
}

function admitFinding(tx: Transaction, finding: Omit<AdmittedFinding, "id" | "review_id" | "links" | "correlation_hints" | "status">): AdmittedFinding {
  const admitted: AdmittedFinding = {
    id: tx.mint("fnd"),
    review_id: tx.review.id,
    subject_key: finding.subject_key,
    raised_by: finding.raised_by,
    answer_id: finding.answer_id,
    source: finding.source,
    priority: finding.priority,
    reviewer_disposition: finding.reviewer_disposition,
    title: finding.title,
    path: finding.path,
    line: finding.line,
    status: { open: true },
    links: [],
    correlation_hints: correlationHints(tx.review, finding.source, finding.title),
  };
  tx.record({ kind: "finding_admitted", finding: admitted });
  return admitted;
}

// ---------------------------------------------------------------------------------------------
// AdmitExternalResult (§E4, §E6, §D3)
// ---------------------------------------------------------------------------------------------

function admitExternal(tx: Transaction, action: Extract<Action, { kind: "AdmitExternalResult" }>): Refusal | null {
  const review = tx.review;
  const result = action.result;
  // The head must be one the Review has seen; the newest subject at that head is its key.
  const subject = [...review.subjects].reverse().find((s) => s.head_sha === result.reviewed_head);
  if (subject === undefined) return refuse("unknown_subject", `head ${result.reviewed_head} was never observed on ${review.display}`);
  // §2.3/§3.5: the container is not the identity — one issue comment routinely carries several
  // inline findings — so it is (container kind, container id, locator) that must be distinct.
  const locators = result.findings.map((f) => `${f.container_kind}:${f.container_id}#${f.locator}`);
  if (new Set(locators).size !== locators.length) {
    return refuse("malformed", "external findings must carry distinct source locators within their container");
  }

  // §D3: an admitted signal from Codex clears its recorded unavailability.
  clearAvailabilityOnSignal(tx, "codex");

  // §E4: only a Codex request outstanding at that subject *now* is answered; otherwise
  // unsolicited evidence. §D6: a request whose transport the system gave up on is outstanding
  // like any other — the late answer discharges it, and its hold is released with it.
  const pending = review.requests.find(
    (r) => isOutstanding(r) && r.kind === "review" && r.assignee === "codex" && r.subject_key === subject.key,
  );
  const answerId = pending === undefined ? null : tx.mint("ans");
  const findings = result.findings.map((f) =>
    admitFinding(tx, {
      subject_key: subject.key,
      raised_by: "codex",
      answer_id: answerId,
      source: { container_kind: f.container_kind, comment_id: f.container_id, locator: f.locator },
      priority: f.priority,
      reviewer_disposition: null,
      title: f.title,
      path: f.path,
      line: f.line,
    }),
  );
  if (pending === undefined || answerId === null) return null;

  const completion = result.verdict === "incomplete" ? "incomplete" : "complete";
  const normalized: NormalizedResult = {
    completion,
    verdict: findings.some(isBlocking) ? "findings" : "clean",
    findings,
    answers: [],
    reviewer: "codex",
    subject_key: subject.key,
    provenance: {
      arm: "external",
      record: result.source_record,
      report_ref: `${result.source_record.kind}:${result.source_record.id}@${result.source_record.version}`,
    },
  };
  admitAnswer(tx, pending, answerId, normalized);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Answers (§E1–§E7, §G1, §G4)
// ---------------------------------------------------------------------------------------------

/**
 * Records the answer; a complete one discharges the request (§E1), charges the subject once
 * (§G1) and runs the exhaustion check (§G4). An incomplete one is recorded and leaves the request
 * pending (§E6).
 */
function admitAnswer(tx: Transaction, request: Request, answerId: string, normalized: NormalizedResult | Testimony): Answer {
  const admitted: Answer = {
    id: answerId,
    request_id: request.id,
    subject_key: request.subject_key,
    principal: tx.ctx.principal,
    admitted_at: tx.ctx.now,
    normalized,
    status: "standing",
  };
  tx.record({ kind: "answer_admitted", answer: admitted });
  const complete = !isNormalized(normalized) || normalized.completion === "complete";
  if (!complete) return admitted;

  tx.record({ kind: "request_answered", request_id: request.id, answer_id: answerId });
  // §D6: an answer arriving anyway releases the transport-exhaustion hold placed for it.
  for (const hold of activeHolds(tx.review)) {
    if (hold.kind === "transport_exhausted" && hold.reason === `transport_exhausted:${request.id}`) {
      tx.record({ kind: "hold_released", hold_id: hold.id, release: { by: tx.system, at: tx.ctx.now, reason: "answered" } });
    }
  }
  if (request.kind === "review" && isNormalized(normalized)) {
    // §G1/§G2: one charge per subject key on its first complete accepted answer; a new SHA charges again.
    if (!tx.review.charges.some((c) => c.subject_key === request.subject_key)) {
      tx.record({ kind: "charge_recorded", charge: { subject_key: request.subject_key, answer_id: answerId, at: tx.ctx.now } });
    }
    checkExhaustion(tx);
  }
  return admitted;
}

/** §G4: exhaustion is an episode — opened once while the predicate holds, closed by `GrantRounds`. */
function checkExhaustion(tx: Transaction): void {
  const review = tx.review;
  if (openEpisode(review) !== undefined) return;
  if (!review.findings.some(isBlocking)) return;
  const allowance = roundsMax(tx.ctx.policy) + review.budget.granted;
  if (review.charges.length < allowance) return;

  const hold: Hold = {
    id: tx.mint("hold"),
    kind: "exhaustion",
    by: tx.system,
    at: tx.ctx.now,
    reason: `exhausted: ${review.charges.length} rounds of ${allowance}`,
    release_on: "explicit",
    blocks: { readiness: true, summons: true },
    released: null,
  };
  tx.record({ kind: "hold_placed", hold });
  const episode: ExhaustionEpisode = { id: tx.mint("ep"), opened_at: tx.ctx.now, hold_id: hold.id, closed: null };
  tx.record({ kind: "episode_opened", episode });

  // §G5: the retrospective is an obligation with `required: false`; its transport goes out under the
  // exhaustion hold (the publisher withholds only review requests under a summons-blocking hold, §G3).
  const retrospective = open(tx, {
    kind: "retrospective",
    mode: null,
    assignee: tx.ctx.policy.retrospective_actor,
    subjectKey: review.subject.key,
    required: false,
    names: [],
    reason: `exhaustion:${episode.id}`,
    supersedes: null,
    openedBy: tx.system,
  });
  const author = review.subject.author;
  if (author.kind === "seat") {
    // The gate delivery names the retrospective request: pending until the episode's work is done, so the
    // publisher's §D7 check finds it applicable (the answered review request would already be obsolete).
    const requestId = retrospective.id;
    tx.effect("actionable", `delivery:${author.actor}:${requestId}`, {
      actor: author.actor,
      request_id: requestId,
      text: `${review.display}: review rounds exhausted (${review.charges.length} of ${allowance}) with blocking findings standing; a human gate is required`,
      dedupe_key: `gate:${review.id}:${episode.id}`,
    });
  }
}

/** §2.2 process rules the reviewkit arm must satisfy; each failure is `malformed` (§E2) or `self_review`. */
function checkReport(tx: Transaction, request: Request, report: ReviewReport): Refusal | null {
  const principal = tx.ctx.principal;
  const bad = (why: string): Refusal => refuse("malformed", `report: ${why}`);
  if (report.mode !== request.mode) return bad(`mode ${report.mode} does not match the request's ${request.mode ?? "null"}`);
  if (principal.kind === "seat" && report.reviewer !== principal.actor) return bad(`reviewer ${report.reviewer} is not the acting seat ${principal.actor}`);
  if (report.pr_number !== tx.review.key.pr_number) return bad(`pr_number ${report.pr_number} is not ${tx.review.key.pr_number}`);
  for (const sha of [report.head_sha, report.base_sha, report.merge_base_sha]) {
    if (!SHA_RE.test(sha)) return bad(`${sha} is not a 40-hex SHA`);
  }
  const findings = report.findings ?? [];
  const coverage = report.coverage ?? [];
  const ids = findings.map((f) => f.id);
  if (new Set(ids).size !== ids.length) return bad("finding ids must be unique");
  const fingerprints = findings.map((f) => f.fingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) return bad("finding fingerprints must be unique");
  const coverageIds = coverage.map((c) => c.id);
  if (new Set(coverageIds).size !== coverageIds.length) return bad("coverage ids must be unique");
  const known = new Set([...ids, ...request.names]);
  for (const area of coverage) {
    if (area.finding_id !== null && area.finding_id !== undefined && !known.has(area.finding_id)) {
      return bad(`coverage row ${area.id} references unknown finding ${area.finding_id}`);
    }
  }
  const blockers = findings.filter((f) => f.disposition === "must-fix");
  if (report.mode === "initial") {
    if (report.generation !== 0) return bad("initial reviews are generation 0");
    if (report.completion === "incomplete" && report.automatic_chain_terminal) return bad("an incomplete initial review cannot be terminal");
    if (report.completion === "complete" && report.automatic_chain_terminal !== (blockers.length === 0)) {
      return bad("a complete initial review is terminal exactly when it has no must-fix finding");
    }
    if (report.reviewer_authored_scope === true || report.self_review === true) {
      return refuse("self_review", "self-authored scope cannot receive an initial review");
    }
    if (report.reviewer_designed_parent_cure === true) return bad("an initial review cannot be a reviewer-designed cure closure");
    if (report.appeal_fingerprint !== null && report.appeal_fingerprint !== undefined) return bad("an initial review cannot carry appeal_fingerprint");
  } else {
    if (report.generation !== 1) return bad("closure and appeal reviews are generation 1");
    if (!report.automatic_chain_terminal) return bad("closure and appeal reports are terminal");
    if (!report.parent_report_id) return bad("closure and appeal require parent_report_id");
    if (!report.parent_resolution_id) return bad("closure and appeal require parent_resolution_id");
  }
  if (report.mode === "closure") {
    if (report.appeal_fingerprint !== null && report.appeal_fingerprint !== undefined) return bad("a closure review cannot carry appeal_fingerprint");
    for (const finding of findings) {
      if (finding.parent_fingerprint === null || finding.parent_fingerprint === undefined) {
        return bad(`closure finding ${finding.id} requires parent_fingerprint`);
      }
      if (finding.disposition === "must-fix" && finding.material_cure_regression !== true) {
        return bad(`closure blocking finding ${finding.id} must be a material cure regression`);
      }
    }
  }
  if (report.mode === "appeal") {
    if (!report.appeal_fingerprint) return bad("an appeal review requires appeal_fingerprint");
    if (findings.length > 1) return bad("an appeal review may carry at most one finding");
    if (findings[0] !== undefined && findings[0].fingerprint !== report.appeal_fingerprint) return bad("the appeal finding must match appeal_fingerprint");
  }
  return null;
}

/**
 * §E3: what a closure/appeal report says about each finding the request named. A report finding
 * whose `parent_fingerprint` is the named finding's fingerprint speaks by its disposition
 * (must-fix / follow-up ⇒ standing, owner-decision ⇒ referred, noise ⇒ refuted); a coverage row
 * naming the finding speaks by its status (reviewed-no-issue ⇒ fixed, not-review-relevant ⇒
 * refuted, finding ⇒ standing). Anything else is omission — a non-answer.
 */
function findingAnswers(review: Review, request: Request, report: ReviewReport): { answers: FindingAnswer[]; missing: string[] } {
  const answers: FindingAnswer[] = [];
  const missing: string[] = [];
  const findings = report.findings ?? [];
  const coverage = report.coverage ?? [];
  for (const id of request.names) {
    const named = review.findings.find((f) => f.id === id);
    if (named === undefined) {
      missing.push(id);
      continue;
    }
    const fingerprint = "fingerprint" in named.source ? named.source.fingerprint : null;
    const child = fingerprint === null ? undefined : findings.find((f) => f.parent_fingerprint === fingerprint);
    if (child !== undefined) {
      const answer: FindingAnswerKind =
        child.disposition === "owner-decision" ? "referred" : child.disposition === "noise" ? "refuted" : "standing";
      answers.push({ finding_id: id, answer, evidence: `${child.id}: ${child.title}` });
      continue;
    }
    const row = coverage.find((c) => c.finding_id === id);
    const byStatus: Partial<Record<string, FindingAnswerKind>> = {
      "reviewed-no-issue": "fixed",
      "not-review-relevant": "refuted",
      finding: "standing",
    };
    const answer = row === undefined ? undefined : byStatus[row.status];
    if (row === undefined || answer === undefined) {
      missing.push(id);
      continue;
    }
    answers.push({ finding_id: id, answer, evidence: `${row.id}: ${row.reason ?? row.area}` });
  }
  return { answers, missing };
}

/** §F3: what the closure reviewer's word does to each named finding. */
function applyFindingAnswers(tx: Transaction, answerId: string, answers: FindingAnswer[]): void {
  for (const { finding_id, answer, evidence } of answers) {
    const finding = tx.review.findings.find((f) => f.id === finding_id);
    if (finding === undefined) continue;
    const status = finding.status;
    switch (answer) {
      case "fixed":
        if (!status.open && status.resolution.kind === "fixed") {
          tx.record({ kind: "finding_resolved", finding_id, resolution: { ...status.resolution, confirmed_by: answerId } });
        } else if (status.open) {
          tx.record({ kind: "finding_resolved", finding_id, resolution: resolution(tx, "fixed", evidence, { confirmed_by: answerId }) });
        }
        break;
      case "standing":
        if (!status.open) {
          tx.record({ kind: "finding_contested", finding_id, contest: { by: answerId, at: tx.ctx.now, prior: status.resolution } });
        }
        break;
      case "refuted":
        if (status.open) tx.record({ kind: "finding_resolved", finding_id, resolution: resolution(tx, "refuted", evidence, {}) });
        break;
      case "referred":
        placeOwnerDecisionHold(tx, `referred:${finding_id}`);
        break;
    }
  }
}

function resolution(
  tx: Transaction,
  kind: Resolution["kind"],
  evidence: string,
  extra: Partial<Pick<Resolution, "commits" | "ticket" | "resolution_text" | "confirmed_by">>,
): Resolution {
  return {
    kind,
    by: tx.ctx.principal,
    at: tx.ctx.now,
    evidence,
    commits: extra.commits ?? [],
    ticket: extra.ticket ?? null,
    resolution_text: extra.resolution_text ?? null,
    confirmed_by: extra.confirmed_by ?? null,
  };
}

/** §F3: `product_gate` and a closure's `referred` open one `Hold(owner_decision, explicit)` per question. */
function placeOwnerDecisionHold(tx: Transaction, reason: string): void {
  if (activeHolds(tx.review).some((h) => h.kind === "owner_decision" && h.reason === reason)) return;
  tx.record({
    kind: "hold_placed",
    hold: {
      id: tx.mint("hold"),
      kind: "owner_decision",
      by: tx.system,
      at: tx.ctx.now,
      reason,
      release_on: "explicit",
      blocks: { readiness: true, summons: false },
      released: null,
    },
  });
}

function answer(tx: Transaction, action: AnswerAction): Refusal | null {
  const review = tx.review;
  const request = review.requests.find((r) => r.id === action.request_id);
  if (request === undefined) return refuse("no_such_target", `request ${action.request_id} does not exist`);
  if (!isOutstanding(request)) return refuse("no_such_target", `request ${request.id} is ${request.status}`);
  // §E1: the subject binds the request, the action and the report.
  if (action.subject_key !== request.subject_key) {
    return refuse("unknown_subject", `answer names ${action.subject_key}; request ${request.id} is at ${request.subject_key}`);
  }
  const subject = [...review.subjects].reverse().find((s) => s.key === request.subject_key);
  if (subject === undefined) return refuse("unknown_subject", `subject ${request.subject_key} was never observed`);
  // §4 self-review ban: a seat never answers a review of its own subject.
  if (request.kind === "review" && subject.author.kind === "seat" && isSeatOf(tx.ctx.principal, subject.author.actor)) {
    return refuse("self_review", `${subject.author.actor} authored ${subject.key}`);
  }
  // §D3: an admitted signal from the assignee clears its unavailability.
  clearAvailabilityOnSignal(tx, request.assignee);

  if (request.kind === "retrospective") {
    // §G5: the retrospective's answer is a testimony naming its deliverable.
    if (action.submission.arm !== "testimony") return refuse("malformed", "a retrospective request is answered by a testimony");
    admitAnswer(tx, request, tx.mint("ans"), action.submission.testimony);
    return null;
  }
  if (action.submission.arm !== "reviewkit") return refuse("malformed", "a review request is answered by a reviewkit report");
  const report = action.submission.report;
  if (report.head_sha !== subject.head_sha) {
    return refuse("unknown_subject", `report head ${report.head_sha} is not the subject head ${subject.head_sha}`);
  }
  const bases = new Set([subject.base_sha_at_first_sight, subject.merge_base_sha, review.observed.base_sha_now]);
  if (!bases.has(report.base_sha)) {
    return refuse("unknown_subject", `report base ${report.base_sha} is not a base the Review recorded for ${subject.key}`);
  }
  const bad = checkReport(tx, request, report);
  if (bad !== null) return bad;
  // §E3: every named finding must be addressed.
  const named = findingAnswers(review, request, report);
  if (named.missing.length > 0) {
    return refuse("unanswered_findings", `report does not address ${named.missing.join(", ")}`);
  }

  const answerId = tx.mint("ans");
  const reviewer = tx.ctx.principal.kind === "seat" ? tx.ctx.principal.actor : report.reviewer;
  const findings = (report.findings ?? []).map((f) =>
    admitFinding(tx, {
      subject_key: subject.key,
      raised_by: reviewer,
      answer_id: answerId,
      source: { fingerprint: f.fingerprint, semantic_key: f.semantic_key },
      priority: f.priority,
      reviewer_disposition: f.disposition,
      title: f.title,
      path: f.diff_anchor.path,
      line: f.diff_anchor.start_line,
    }),
  );
  const normalized: NormalizedResult = {
    completion: report.completion,
    verdict: findings.some(isBlocking) ? "findings" : "clean",
    findings,
    answers: named.answers,
    reviewer,
    subject_key: subject.key,
    // A reviewkit report arrives through the edge, not as a GitHub record; the contract still
    // demands a SourceRef, so the record names the PR and the report names itself.
    provenance: {
      arm: "reviewkit",
      record: { kind: "review", id: review.key.pr_number, version: report.created_at ?? tx.ctx.now },
      report_ref: report.report_id ?? `${report.chain_id}:g${report.generation}`,
    },
  };
  // §F3 runs before the exhaustion check so a confirmed fix no longer counts as blocking.
  if (report.completion === "complete") applyFindingAnswers(tx, answerId, named.answers);
  admitAnswer(tx, request, answerId, normalized);
  return null;
}

/**
 * §E7: re-opens the request, keeps the charge, leaves the findings admitted.
 *
 * §D6: a request whose transport bound was spent can still be discharged by a late answer, and
 * that answer released the `transport_exhausted` hold. Retracting it reopens an obligation
 * housekeeping will never push again — it skips an exhausted request — so the retraction is the
 * named act that re-arms transport: the flag is cleared, the re-transport ledger emptied, and
 * one fresh transport queued. Exhaustion measured a reviewer who never answered; this one did.
 */
function retractAnswer(tx: Transaction, action: Extract<Action, { kind: "RetractAnswer" }>): Refusal | null {
  const found = tx.review.answers.find((a) => a.id === action.answer_id);
  if (found === undefined) return refuse("no_such_target", `answer ${action.answer_id} does not exist`);
  if (found.status !== "standing") return refuse("no_such_target", `answer ${found.id} is already retracted`);
  const reopened = tx.review.requests.filter((r) => r.answered_by === found.id);
  tx.record({ kind: "answer_retracted", answer_id: found.id, reason: action.reason });
  for (const request of reopened) {
    if (!request.transport_exhausted) continue;
    tx.record({
      kind: "request_transport_rearmed",
      request_id: request.id,
      reason: `answer ${found.id} retracted; the obligation is outstanding again and unreachable while transport stays exhausted`,
    });
    emitTransport(tx, request);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Requests (§D1, §D4, §I)
// ---------------------------------------------------------------------------------------------

function openRequest(tx: Transaction, action: Extract<Action, { kind: "OpenRequest" }>): Refusal | null {
  const review = tx.review;
  if (action.subject_key !== review.subject.key) {
    return refuse("unknown_subject", `requests open at the current subject ${review.subject.key}, not ${action.subject_key}`);
  }
  if (action.request_kind === "retrospective") {
    if (action.mode !== null) return refuse("malformed", "a retrospective request has no mode");
    if (action.names.length > 0) return refuse("malformed", "a retrospective request names no findings");
  } else {
    if (action.mode === null) return refuse("malformed", "a review request has a mode");
    if (action.mode === "initial" && action.names.length > 0) return refuse("malformed", "an initial request names no findings");
    if (new Set(action.names).size !== action.names.length) return refuse("malformed", "names must be unique");
    for (const id of action.names) {
      if (!review.findings.some((f) => f.id === id)) return refuse("no_such_target", `finding ${id} does not exist`);
    }
  }
  // §D1: at most one pending request per (assignee, subject_key, kind).
  if (hasPending(review, action.assignee, action.subject_key, action.request_kind)) {
    return refuse("duplicate_request", `${action.assignee} already has a pending ${action.request_kind} request at ${action.subject_key}`);
  }
  open(tx, {
    kind: action.request_kind,
    mode: action.mode,
    assignee: action.assignee,
    subjectKey: action.subject_key,
    required: action.required,
    names: action.names,
    reason: action.reason,
    supersedes: null,
    openedBy: tx.ctx.principal,
  });
  return null;
}

function cancelRequest(tx: Transaction, action: Extract<Action, { kind: "CancelRequest" }>): Refusal | null {
  const request = tx.review.requests.find((r) => r.id === action.request_id);
  if (request === undefined) return refuse("no_such_target", `request ${action.request_id} does not exist`);
  if (!isOutstanding(request)) return refuse("no_such_target", `request ${request.id} is ${request.status}`);
  tx.record({ kind: "request_cancelled", request_id: request.id, reason: action.reason, by: tx.ctx.principal, at: tx.ctx.now });
  // §D9: cancelling is an input of the invariant. An operator's cancellation at the current
  // subject is their decision and stands; anyone else's leaves the subject needing its review.
  restoreObligations(tx, "request_cancelled");
  return null;
}

/** §D3 sets the condition; §D4 reassigns every request pending to a reviewer that became unavailable. */
function setAvailability(tx: Transaction, action: Extract<Action, { kind: "SetReviewerAvailability" }>): Refusal | null {
  if (action.available) {
    tx.record({ kind: "availability_set", reviewer: action.reviewer, availability: { available: true } });
    return null;
  }
  if (action.reason === null) return refuse("malformed", "available = false requires a reason");
  const availability: Availability = {
    available: false,
    since: tx.ctx.now,
    reason: action.reason,
    until: action.until,
    evidence: action.evidence,
  };
  tx.record({ kind: "availability_set", reviewer: action.reviewer, availability });
  const substitute = substituteFor(tx.ctx.policy, action.reviewer);
  if (substitute === null) return null;
  for (const request of tx.review.requests.filter((r) => isOutstanding(r) && r.assignee === action.reviewer)) {
    reassign(tx, request, substitute, `reviewer_unavailable (${action.reason})`);
  }
  // §D9: routing is an input of the invariant; a reassignment that could not be made leaves the
  // subject without its required work, and this is where that is noticed.
  restoreObligations(tx, "reviewer_unavailable");
  return null;
}

/** §6.I: records the adoption and re-derives routing for the initial requests still pending. */
function adoptPolicy(tx: Transaction, action: Extract<Action, { kind: "AdoptPolicy" }>): Refusal | null {
  const review = tx.review;
  if (action.version <= review.policy_version) {
    return refuse("malformed", `policy version ${action.version} is not newer than the Review's ${review.policy_version}`);
  }
  if (tx.ctx.policy.version !== action.version) {
    return refuse("malformed", `the decision context carries policy ${tx.ctx.policy.version}, not the adopted ${action.version}`);
  }
  tx.record({ kind: "policy_adopted", version: action.version });
  for (const request of pendingReviewRequestsAt(review, review.subject.key)) {
    if (request.mode !== "initial") continue;
    const route = routeInitial(tx);
    if (route.assignee !== request.assignee) reassign(tx, request, route.assignee, `policy_adopted (${route.reason})`);
  }
  // §D9: routing is policy-dependent, so adopting a policy is an input of the invariant.
  restoreObligations(tx, "policy_adopted");
  return null;
}

// ---------------------------------------------------------------------------------------------
// Findings (§F2, §F3, §F5)
// ---------------------------------------------------------------------------------------------

function resolveFinding(tx: Transaction, action: Extract<Action, { kind: "ResolveFinding" }>): Refusal | null {
  const review = tx.review;
  const finding = review.findings.find((f) => f.id === action.finding_id);
  if (finding === undefined) return refuse("no_such_target", `finding ${action.finding_id} does not exist`);
  const req = action.resolution;

  if (req.kind === "same_as") {
    // §F2: an explicit link; a resolved counterpart becomes contested, open and blocking again.
    if (req.other === finding.id) return refuse("malformed", "a finding cannot be the same as itself");
    const other = review.findings.find((f) => f.id === req.other);
    if (other === undefined) return refuse("no_such_target", `finding ${req.other} does not exist`);
    const link = { relation: "same_as" as const, by: tx.ctx.principal, at: tx.ctx.now };
    tx.record({ kind: "finding_linked", finding_id: finding.id, link: { ...link, other: other.id } });
    tx.record({ kind: "finding_linked", finding_id: other.id, link: { ...link, other: finding.id } });
    if (!other.status.open) {
      tx.record({
        kind: "finding_contested",
        finding_id: other.id,
        contest: { by: principalLabel(tx.ctx.principal), at: tx.ctx.now, prior: other.status.resolution },
      });
    }
    return null;
  }

  if (req.kind === "owner_decision") {
    // §F3: the operator's ruling closes the finding and releases the owner_decision hold it opened.
    tx.record({ kind: "finding_resolved", finding_id: finding.id, resolution: resolution(tx, "owner_decision", req.evidence, { resolution_text: req.resolution_text }) });
    for (const hold of activeHolds(review)) {
      if (hold.kind === "owner_decision" && (hold.reason === `product_gate:${finding.id}` || hold.reason === `referred:${finding.id}`)) {
        tx.record({ kind: "hold_released", hold_id: hold.id, release: { by: tx.ctx.principal, at: tx.ctx.now, reason: "owner_decision" } });
      }
    }
    return null;
  }

  if (!finding.status.open) {
    return refuse("no_such_target", `finding ${finding.id} is already resolved (${finding.status.resolution.kind})`);
  }
  switch (req.kind) {
    case "fixed":
      tx.record({ kind: "finding_resolved", finding_id: finding.id, resolution: resolution(tx, "fixed", req.evidence, { commits: req.commits }) });
      return null;
    case "refuted":
    case "withdrawn":
      tx.record({ kind: "finding_resolved", finding_id: finding.id, resolution: resolution(tx, req.kind, req.evidence, {}) });
      return null;
    case "follow_up":
      tx.record({ kind: "finding_resolved", finding_id: finding.id, resolution: resolution(tx, "follow_up", req.evidence, { ticket: req.ticket }) });
      return null;
    case "product_gate":
      tx.record({ kind: "finding_resolved", finding_id: finding.id, resolution: resolution(tx, "product_gate", req.evidence, {}) });
      placeOwnerDecisionHold(tx, `product_gate:${finding.id}`);
      return null;
  }
}

/** §F5: assigns a known priority; `unknown` is the absence of one. */
function classifyFinding(tx: Transaction, action: Extract<Action, { kind: "ClassifyFinding" }>): Refusal | null {
  const finding = tx.review.findings.find((f) => f.id === action.finding_id);
  if (finding === undefined) return refuse("no_such_target", `finding ${action.finding_id} does not exist`);
  tx.record({ kind: "finding_classified", finding_id: finding.id, priority: action.priority });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Holds and budget (§G1, §G3, §G4)
// ---------------------------------------------------------------------------------------------

function holdFromSpec(tx: Transaction, spec: HoldSpec): Hold {
  const base = { id: tx.mint("hold"), by: tx.ctx.principal, at: tx.ctx.now, reason: spec.reason, blocks: spec.blocks, released: null };
  if (spec.kind === "human_gate" || spec.kind === "stack") return { ...base, kind: spec.kind, release_on: spec.release_on };
  return { ...base, kind: spec.kind, release_on: "explicit" };
}

function placeHold(tx: Transaction, action: Extract<Action, { kind: "Hold" }>): Refusal | null {
  tx.record({ kind: "hold_placed", hold: holdFromSpec(tx, action.hold) });
  return null;
}

/**
 * §G3: releasing an exhaustion hold closes its episode. A released summons-blocking hold queues
 * nothing: the withheld transport rows resume at dispatch (§8.1).
 */
function release(tx: Transaction, action: Extract<Action, { kind: "Release" }>): Refusal | null {
  const hold = tx.review.holds.find((h) => h.id === action.hold_id);
  if (hold === undefined) return refuse("no_such_target", `hold ${action.hold_id} does not exist`);
  if (hold.released !== null) return refuse("no_such_target", `hold ${hold.id} is already released`);
  tx.record({ kind: "hold_released", hold_id: hold.id, release: { by: tx.ctx.principal, at: tx.ctx.now, reason: action.reason } });
  const episode = tx.review.episodes.find((e) => e.closed === null && e.hold_id === hold.id);
  if (episode !== undefined) {
    tx.record({ kind: "episode_closed", episode_id: episode.id, close: { at: tx.ctx.now, by: tx.ctx.principal } });
  }
  // §D9: the hold withheld transport, never creation — but a subject observed while it was
  // active may still be missing the work the operator's release now expects to see move.
  restoreObligations(tx, "hold_released");
  return null;
}

/** §G1/§G4: changes the allowance, not history; closes the open episode and releases its hold. */
function grantRounds(tx: Transaction, action: Extract<Action, { kind: "GrantRounds" }>): Refusal | null {
  tx.record({ kind: "rounds_granted", n: action.n, reason: action.reason });
  const episode = openEpisode(tx.review);
  if (episode === undefined) return null;
  tx.record({ kind: "episode_closed", episode_id: episode.id, close: { at: tx.ctx.now, by: tx.ctx.principal } });
  const hold = tx.review.holds.find((h) => h.id === episode.hold_id);
  if (hold !== undefined && hold.released === null) {
    tx.record({ kind: "hold_released", hold_id: hold.id, release: { by: tx.ctx.principal, at: tx.ctx.now, reason: `rounds_granted: ${action.reason}` } });
  }
  // §D9: the grant is what makes the head pushed under the episode reviewable again.
  restoreObligations(tx, "rounds_granted");
  return null;
}

// ---------------------------------------------------------------------------------------------
// read (§3.6, §6.H, §8.1 precedence)
// ---------------------------------------------------------------------------------------------

/** §3.6 / §6.H: requirement, blocking set, rounds, active holds, readiness with precedence-ordered reasons. */
export function read(state: Review, ctx: { now: string; policy: Policy }): ReviewState {
  const subjectKey = state.subject.key;
  // §6.H: readiness waits on the outstanding obligations, not on their transport (§D9).
  const pendingRequired = outstandingRequiredAt(state, subjectKey).map((r) => r.id);
  const satisfying = satisfyingAnswers(state, subjectKey);
  const requirement: ReviewState["requirement"] =
    state.exemption !== null && state.exemption.subject_key === subjectKey
      ? { subject_key: subjectKey, status: "exempt" }
      : satisfying.length > 0
        ? { subject_key: subjectKey, status: "satisfied", by: satisfying.map((a) => a.id) }
        : { subject_key: subjectKey, status: "unsatisfied", pending: pendingRequired };

  const blocking = state.findings.filter(isBlocking);
  const advisories = state.findings.filter((f) => f.status.open && !isBlocking(f));
  const holds = activeHolds(state);
  const roundsMaxNow = roundsMax(ctx.policy);
  const consumed = state.charges.length;
  const incomplete = state.answers.some(
    (a) => a.status === "standing" && a.subject_key === subjectKey && isNormalized(a.normalized) && a.normalized.completion === "incomplete",
  );

  // §8.1 precedence: merged > closed > hold > exhausted > required request pending > requirement
  // unsatisfied > blocking findings > (incomplete answer) > draft.
  const reasons: Reason[] = [];
  if (state.lifecycle === "merged") reasons.push("merged");
  if (state.lifecycle === "closed") reasons.push("closed");
  for (const hold of holds) reasons.push({ hold: hold.kind });
  if (openEpisode(state) !== undefined) reasons.push("exhausted");
  if (pendingRequired.length > 0) reasons.push({ required_request_pending: pendingRequired });
  if (requirement.status === "unsatisfied") reasons.push({ requirement_unsatisfied: [subjectKey] });
  if (blocking.length > 0) reasons.push({ blocking_findings: blocking.map((f) => f.id) });
  if (requirement.status === "unsatisfied" && incomplete) reasons.push("incomplete_answer");
  if (state.draft) reasons.push("draft");

  const [first, ...rest] = reasons;
  return {
    ...structuredClone(state),
    budget: { rounds_max: roundsMaxNow, granted: state.budget.granted },
    requirement,
    blocking_findings: blocking,
    advisories,
    rounds_consumed: consumed,
    rounds_remaining: Math.max(0, roundsMaxNow + state.budget.granted - consumed),
    active_holds: holds,
    readiness: first === undefined ? { ready: true, subject_key: subjectKey } : { ready: false, subject_key: subjectKey, reasons: [first, ...rest] },
  };
}
