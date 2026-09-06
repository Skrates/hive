/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/review-contract.schema.json,
 * vendored from weave-doctrine@84af72b31f0a9c98a2b3798a7345360cc4a29ca6 (see contracts/SOURCE).
 * Regenerate with `bun run check:contracts`.
 */

/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Action".
 */
export type Action =
  | ObservePRAction
  | AdmitExternalResultAction
  | SetReviewerAvailabilityAction
  | OpenRequestAction
  | CancelRequestAction
  | AnswerAction
  | RetractAnswerAction
  | ResolveFindingAction
  | ClassifyFindingAction
  | HoldAction
  | ReleaseAction
  | GrantRoundsAction
  | AdoptPolicyAction;
/**
 * §6.C3: closed pauses, reopened resumes, merged is terminal.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Lifecycle".
 */
export type Lifecycle = "open" | "closed" | "merged";
/**
 * §3.5 / §6.F5: ``unknown`` is admitted, visible and blocking until classified.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingPriority".
 */
export type FindingPriority = "P0" | "P1" | "P2" | "P3" | "unknown";
/**
 * §7 source records: GitHub reviews, review comments, issue comments.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SourceRecordKind".
 */
export type SourceRecordKind = "review" | "review_comment" | "issue_comment";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExternalVerdict".
 */
export type ExternalVerdict = "clean" | "findings" | "incomplete";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AvailabilityReason".
 */
export type AvailabilityReason = "quota" | "connector" | "meter";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewMode".
 */
export type ReviewMode = "initial" | "closure" | "appeal";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequestKind".
 */
export type RequestKind = "review" | "retrospective";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Completion".
 */
export type Completion = "complete" | "incomplete";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "CoverageStatus".
 */
export type CoverageStatus =
  "finding" | "reviewed-no-issue" | "not-review-relevant" | "not-covered";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Confidence".
 */
export type Confidence = "high" | "medium" | "low";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Disposition".
 */
export type Disposition = "must-fix" | "owner-decision" | "follow-up" | "noise";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "EvidenceKind".
 */
export type EvidenceKind =
  | "static-path"
  | "contract"
  | "test"
  | "probe"
  | "preimage-control"
  | "mutation-control"
  | "production-observation"
  | "history"
  | "tool-output";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FalsifierStatus".
 */
export type FalsifierStatus = "demonstrated" | "proposed" | "not-practical";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Priority".
 */
export type Priority = "P0" | "P1" | "P2" | "P3";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Recommendation".
 */
export type Recommendation =
  "block" | "changes-requested" | "discuss" | "pass-with-caveat" | "pass";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReleaseOn".
 */
export type ReleaseOn = "explicit" | "subject_change";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AnswerSubmission".
 */
export type AnswerSubmission = ReviewkitSubmission | TestimonySubmission;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Availability".
 */
export type Availability = Available | Unavailable;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExemptionReason".
 */
export type ExemptionReason = "skill_only" | "exempt_paths" | "verbatim_copy";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequestStatus".
 */
export type RequestStatus = "pending" | "answered" | "cancelled" | "unanswerable";
/**
 * §2.3 ``FindingAnswer.answer`` — the closure reviewer's word on a named finding.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingAnswerKind".
 */
export type FindingAnswerKind = "fixed" | "standing" | "refuted" | "referred";
/**
 * §6.F3 — the closed set of ways a finding leaves the standing set.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ResolutionKind".
 */
export type ResolutionKind =
  "fixed" | "refuted" | "withdrawn" | "product_gate" | "follow_up" | "owner_decision";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReportArm".
 */
export type ReportArm = "reviewkit" | "external";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "NormalizedVerdict".
 */
export type NormalizedVerdict = "clean" | "findings";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AnswerStatus".
 */
export type AnswerStatus = "standing" | "retracted";
/**
 * §8.1: refresh targets re-render from ``read()``; actionable targets check applicability.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "EffectKind".
 */
export type EffectKind = "refresh" | "actionable";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Consequence".
 */
export type Consequence =
  | SubjectChanged
  | LifecycleChanged
  | DraftChanged
  | ObservedRefreshed
  | ExemptionSet
  | RequestOpened
  | RequestCancelled
  | RequestAnswered
  | RequestUnanswerable
  | AnswerAdmitted
  | AnswerRetracted
  | FindingAdmitted
  | FindingResolved
  | FindingContestedConsequence
  | FindingLinked
  | FindingClassified
  | HoldPlaced
  | HoldReleased
  | ChargeRecorded
  | EpisodeOpened
  | EpisodeClosed
  | AvailabilitySet
  | RoundsGranted
  | PolicyAdopted
  | MergeableObserved;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingSource".
 */
export type FindingSource = ReviewkitFindingSource | CommentFindingSource;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingStatus".
 */
export type FindingStatus = FindingOpen | FindingClosed | FindingContested;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Hold".
 */
export type Hold = SubjectClearableHold | ExplicitHold;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HoldSpec".
 */
export type HoldSpec = SubjectClearableHoldSpec | ExplicitHoldSpec;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Principal".
 */
export type Principal = SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Readiness".
 */
export type Readiness = Ready | NotReady;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Reason".
 */
export type Reason =
  | ("merged" | "closed" | "draft" | "exhausted" | "incomplete_answer")
  | HoldReason
  | RequirementUnsatisfiedReason
  | RequiredRequestPendingReason
  | BlockingFindingsReason;
/**
 * §4 Receipt — the closed set of refusal codes.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RefusalCode".
 */
export type RefusalCode =
  | "stale_revision"
  | "unauthorized"
  | "lifecycle"
  | "unknown_subject"
  | "self_review"
  | "malformed"
  | "unanswered_findings"
  | "not_assignee"
  | "duplicate_request"
  | "no_such_target";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReceiptOutcome".
 */
export type ReceiptOutcome = AppliedOutcome | ReplayedOutcome | RefusedOutcome;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Requirement".
 */
export type Requirement = RequirementSatisfied | RequirementExempt | RequirementUnsatisfied;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ResolutionRequest".
 */
export type ResolutionRequest =
  | FixedResolutionRequest
  | RefutedResolutionRequest
  | WithdrawnResolutionRequest
  | ProductGateResolutionRequest
  | FollowUpResolutionRequest
  | OwnerDecisionResolutionRequest
  | SameAsResolutionRequest;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ResolutionDisposition".
 */
export type ResolutionDisposition =
  "fixed" | "refuted" | "accepted" | "deferred" | "owner-decision";
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SubjectAuthor".
 */
export type SubjectAuthor = SeatAuthor | HumanAuthor;
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "TransportRef".
 */
export type TransportRef = DeliveryRef | SummonRef;

/**
 * The Weave review contract (review-state-machine v0.2 §2). Validate one shape by compiling {"$ref": "<$id>#/$defs/<Name>"}.
 */
export interface ReviewContract {
  action?: Action;
  answer_submission?: AnswerSubmission;
  availability?: Availability;
  batch?: Batch;
  command?: Command;
  consequence?: Consequence;
  effect?: Effect;
  external_result?: ExternalResult;
  finding_source?: FindingSource;
  finding_status?: FindingStatus;
  hold?: Hold;
  hold_spec?: HoldSpec;
  lifecycle?: Lifecycle;
  normalized_result?: NormalizedResult;
  policy?: Policy;
  principal?: Principal;
  readiness?: Readiness;
  reason?: Reason;
  receipt?: Receipt;
  receipt_outcome?: ReceiptOutcome;
  refusal?: Refusal;
  refusal_code?: RefusalCode;
  requirement?: Requirement;
  resolution_request?: ResolutionRequest;
  review?: Review;
  review_key?: ReviewKey;
  review_state?: ReviewState;
  reviewkit_report?: ReviewReport;
  reviewkit_resolution?: ReviewResolution;
  subject?: Subject;
  subject_author?: SubjectAuthor;
  testimony?: Testimony;
  transport_ref?: TransportRef;
}
/**
 * §6.C1 — a whole-state observation; the reducer derives each consequence independently.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ObservePRAction".
 */
export interface ObservePRAction {
  draft: boolean;
  kind: "ObservePR";
  lifecycle: Lifecycle;
  observed: Observed;
  subject: Subject;
}
/**
 * §3.3 metadata refreshed by observation; ``mergeable`` is GitHub's tri-state (§6.D8).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Observed".
 */
export interface Observed {
  author_login: string;
  base_sha_now: string;
  head_ref: string;
  mergeable: boolean | null;
  seen_at: string;
  title: string;
}
/**
 * §3.3: the current code binding; ``key`` is ``f"{head_sha}:{base_ref}"`` (reducer-checked).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Subject".
 */
export interface Subject {
  author: SeatAuthor | HumanAuthor;
  base_ref: string;
  base_sha_at_first_sight: string;
  changed_paths: string[];
  diff_sha256: string;
  first_seen_at: string;
  head_sha: string;
  key: string;
  merge_base_sha: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SeatAuthor".
 */
export interface SeatAuthor {
  actor: string;
  kind: "seat";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HumanAuthor".
 */
export interface HumanAuthor {
  kind: "human";
  login: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AdmitExternalResultAction".
 */
export interface AdmitExternalResultAction {
  kind: "AdmitExternalResult";
  result: ExternalResult;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExternalResult".
 */
export interface ExternalResult {
  findings: ExternalFinding[];
  reviewed_head: string;
  schema_version: "1";
  source: "codex";
  source_record: SourceRef;
  submitted_at: string;
  verdict: ExternalVerdict;
}
/**
 * No fingerprint, falsifier or evidence is invented for Codex; provenance is the comment.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExternalFinding".
 */
export interface ExternalFinding {
  body: string;
  line: number | null;
  path: string;
  priority: FindingPriority;
  source_comment_id: number;
  title: string;
}
/**
 * §7: a GitHub record by kind, id and version (``updated_at``/``submitted_at``).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SourceRef".
 */
export interface SourceRef {
  id: number;
  kind: SourceRecordKind;
  version: string;
}
/**
 * §6.D3. ``available = false`` requires ``reason`` (reducer-checked).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SetReviewerAvailabilityAction".
 */
export interface SetReviewerAvailabilityAction {
  available: boolean;
  evidence: string;
  kind: "SetReviewerAvailability";
  reason: AvailabilityReason | null;
  reviewer: string;
  until: string | null;
}
/**
 * §3.4 / §6.D. The obligation's kind is ``request_kind`` (``kind`` names the verb).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "OpenRequestAction".
 */
export interface OpenRequestAction {
  assignee: string;
  kind: "OpenRequest";
  mode: ReviewMode | null;
  names: string[];
  reason: string;
  request_kind: RequestKind;
  required: boolean;
  subject_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "CancelRequestAction".
 */
export interface CancelRequestAction {
  kind: "CancelRequest";
  reason: string;
  request_id: string;
}
/**
 * §6.E1 — binds the request, the subject and the report; nothing else discharges.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AnswerAction".
 */
export interface AnswerAction {
  kind: "Answer";
  request_id: string;
  subject_key: string;
  submission: ReviewkitSubmission | TestimonySubmission;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewkitSubmission".
 */
export interface ReviewkitSubmission {
  arm: "reviewkit";
  report: ReviewReport;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewReport".
 */
export interface ReviewReport {
  appeal_fingerprint?: string | null;
  author: string;
  automatic_chain_terminal: boolean;
  base_sha: string;
  blind_spots?: string[];
  chain_id: string;
  completion: Completion;
  coverage?: CoverageArea[];
  created_at?: string;
  findings?: Finding[];
  generation: number;
  head_sha: string;
  merge_base_sha: string;
  mode: ReviewMode;
  orchestration: "single-reviewer" | "parallel-specialists";
  orchestration_reason: string;
  overall_assessment?: string;
  packet_scope_fingerprint: string;
  parent_report_id?: string | null;
  parent_resolution_id?: string | null;
  pr_number: number;
  questions?: ReviewQuestion[];
  recommendation: Recommendation;
  report_id?: string;
  repository: string;
  reviewer: string;
  reviewer_authored_scope?: boolean;
  reviewer_designed_parent_cure?: boolean;
  schema_version?: "1";
  self_review?: boolean;
  verification?: VerificationRecord[];
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "CoverageArea".
 */
export interface CoverageArea {
  area: string;
  finding_id?: string | null;
  id: string;
  next_step?: string | null;
  /**
   * @minItems 1
   */
  paths: [string, ...string[]];
  reason?: string | null;
  status: CoverageStatus;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Finding".
 */
export interface Finding {
  confidence: Confidence;
  contract_basis: ContractBasis;
  diff_anchor: Coordinate;
  disposition: Disposition;
  /**
   * @minItems 1
   */
  evidence: [EvidenceItem, ...EvidenceItem[]];
  failure: string;
  falsifier: Falsifier;
  fingerprint: string;
  id: string;
  impact: string;
  introduced_by: string;
  /**
   * @minItems 1
   * @maxItems 2
   */
  look_here_first: [Coordinate] | [Coordinate, Coordinate];
  material_cure_regression?: boolean;
  parent_fingerprint?: string | null;
  priority: Priority;
  reachability: string;
  repair_boundary: string;
  reviewer_designed?: boolean;
  semantic_key: string;
  suggested_remedy?: SuggestedRemedy | null;
  title: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ContractBasis".
 */
export interface ContractBasis {
  authority:
    | "owner-decision"
    | "acceptance-criteria"
    | "public-contract"
    | "ratified-design"
    | "schema-or-law"
    | "repository-doc"
    | "data-integrity-invariant"
    | "unconfirmed-product-choice";
  expectation: string;
  reference: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Coordinate".
 */
export interface Coordinate {
  end_line: number;
  note?: string | null;
  path: string;
  start_line: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "EvidenceItem".
 */
export interface EvidenceItem {
  command?: string | null;
  control?: string | null;
  coordinates?: Coordinate[];
  kind: EvidenceKind;
  observed?: string | null;
  statement: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Falsifier".
 */
export interface Falsifier {
  command?: string | null;
  control?: string | null;
  description: string;
  expected_failure?: string | null;
  status: FalsifierStatus;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SuggestedRemedy".
 */
export interface SuggestedRemedy {
  authority: "non-authoritative" | "reviewer-designed";
  description: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewQuestion".
 */
export interface ReviewQuestion {
  authority_needed: string;
  id: string;
  question: string;
  settlement_criterion: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "VerificationRecord".
 */
export interface VerificationRecord {
  command: string;
  result: string;
  scope: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "TestimonySubmission".
 */
export interface TestimonySubmission {
  arm: "testimony";
  testimony: Testimony;
}
/**
 * §3.4 / §6.G5 — the retrospective's answer names its deliverable.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Testimony".
 */
export interface Testimony {
  cause: string | null;
  deliverable: CommentDeliverable | ReportDeliverable;
  scars: string[];
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "CommentDeliverable".
 */
export interface CommentDeliverable {
  comment_id: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReportDeliverable".
 */
export interface ReportDeliverable {
  report_ref: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RetractAnswerAction".
 */
export interface RetractAnswerAction {
  answer_id: string;
  kind: "RetractAnswer";
  reason: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ResolveFindingAction".
 */
export interface ResolveFindingAction {
  finding_id: string;
  kind: "ResolveFinding";
  resolution:
    | FixedResolutionRequest
    | RefutedResolutionRequest
    | WithdrawnResolutionRequest
    | ProductGateResolutionRequest
    | FollowUpResolutionRequest
    | OwnerDecisionResolutionRequest
    | SameAsResolutionRequest;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FixedResolutionRequest".
 */
export interface FixedResolutionRequest {
  /**
   * @minItems 1
   */
  commits: [string, ...string[]];
  evidence: string;
  kind: "fixed";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RefutedResolutionRequest".
 */
export interface RefutedResolutionRequest {
  evidence: string;
  kind: "refuted";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "WithdrawnResolutionRequest".
 */
export interface WithdrawnResolutionRequest {
  evidence: string;
  kind: "withdrawn";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ProductGateResolutionRequest".
 */
export interface ProductGateResolutionRequest {
  evidence: string;
  kind: "product_gate";
}
/**
 * §6.F3 — the ticket id is format-checked here; Linear I/O stays out of the transaction.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FollowUpResolutionRequest".
 */
export interface FollowUpResolutionRequest {
  evidence: string;
  kind: "follow_up";
  ticket: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "OwnerDecisionResolutionRequest".
 */
export interface OwnerDecisionResolutionRequest {
  evidence: string;
  kind: "owner_decision";
  resolution_text: string;
}
/**
 * §6.F2 — an explicit link; contests the other finding's resolution if it has one.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SameAsResolutionRequest".
 */
export interface SameAsResolutionRequest {
  evidence: string;
  kind: "same_as";
  other: string;
}
/**
 * §6.F5 — assigns a known priority; ``unknown`` is not a classification.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ClassifyFindingAction".
 */
export interface ClassifyFindingAction {
  finding_id: string;
  kind: "ClassifyFinding";
  priority: Priority;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HoldAction".
 */
export interface HoldAction {
  hold: SubjectClearableHoldSpec | ExplicitHoldSpec;
  kind: "Hold";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SubjectClearableHoldSpec".
 */
export interface SubjectClearableHoldSpec {
  blocks: HoldBlocks;
  kind: "human_gate" | "stack";
  reason: string;
  release_on: ReleaseOn;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HoldBlocks".
 */
export interface HoldBlocks {
  readiness: true;
  summons: boolean;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExplicitHoldSpec".
 */
export interface ExplicitHoldSpec {
  blocks: HoldBlocks;
  kind: "exhaustion" | "owner_decision" | "unanswerable" | "operator";
  reason: string;
  release_on: "explicit";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReleaseAction".
 */
export interface ReleaseAction {
  hold_id: string;
  kind: "Release";
  reason: string;
}
/**
 * §6.G1 — changes the allowance, not history; closes an open episode (§G4).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "GrantRoundsAction".
 */
export interface GrantRoundsAction {
  kind: "GrantRounds";
  n: number;
  reason: string;
}
/**
 * §6.I.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AdoptPolicyAction".
 */
export interface AdoptPolicyAction {
  kind: "AdoptPolicy";
  version: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Available".
 */
export interface Available {
  available: true;
}
/**
 * §6.D3 — a recorded condition with a clearing rule, never a bare flag.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Unavailable".
 */
export interface Unavailable {
  available: false;
  evidence: string;
  reason: AvailabilityReason;
  since: string;
  until: string | null;
}
/**
 * §5.B3 — the materialized transition; replay folds these and never calls ``decide``.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Batch".
 */
export interface Batch {
  admitted_at: string;
  batch_id: string;
  command: Command;
  consequences: (
    | SubjectChanged
    | LifecycleChanged
    | DraftChanged
    | ObservedRefreshed
    | ExemptionSet
    | RequestOpened
    | RequestCancelled
    | RequestAnswered
    | RequestUnanswerable
    | AnswerAdmitted
    | AnswerRetracted
    | FindingAdmitted
    | FindingResolved
    | FindingContestedConsequence
    | FindingLinked
    | FindingClassified
    | HoldPlaced
    | HoldReleased
    | ChargeRecorded
    | EpisodeOpened
    | EpisodeClosed
    | AvailabilitySet
    | RoundsGranted
    | PolicyAdopted
    | MergeableObserved
  )[];
  effects: Effect[];
  policy_version: number;
  revision: number;
}
/**
 * §5.B1-B2: the admitted command as recorded in the batch.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Command".
 */
export interface Command {
  act_id: string;
  action:
    | ObservePRAction
    | AdmitExternalResultAction
    | SetReviewerAvailabilityAction
    | OpenRequestAction
    | CancelRequestAction
    | AnswerAction
    | RetractAnswerAction
    | ResolveFindingAction
    | ClassifyFindingAction
    | HoldAction
    | ReleaseAction
    | GrantRoundsAction
    | AdoptPolicyAction;
  expected_revision: number | null;
  principal: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SeatPrincipal".
 */
export interface SeatPrincipal {
  actor: string;
  custody: DeliveryCustody | SessionCustody;
  kind: "seat";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "DeliveryCustody".
 */
export interface DeliveryCustody {
  delivery_id: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SessionCustody".
 */
export interface SessionCustody {
  session_id: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "OperatorPrincipal".
 */
export interface OperatorPrincipal {
  id: string;
  kind: "operator";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AdapterPrincipal".
 */
export interface AdapterPrincipal {
  event_login: string;
  kind: "adapter";
  reconcile_run: string;
  source: "github";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SystemPrincipal".
 */
export interface SystemPrincipal {
  caused_by: string;
  kind: "system";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SubjectChanged".
 */
export interface SubjectChanged {
  kind: "subject_changed";
  previous_key: string | null;
  subject: Subject;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "LifecycleChanged".
 */
export interface LifecycleChanged {
  after: Lifecycle;
  before: Lifecycle;
  kind: "lifecycle_changed";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "DraftChanged".
 */
export interface DraftChanged {
  draft: boolean;
  kind: "draft_changed";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ObservedRefreshed".
 */
export interface ObservedRefreshed {
  kind: "observed_refreshed";
  observed: Observed;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExemptionSet".
 */
export interface ExemptionSet {
  exemption: Exemption | null;
  kind: "exemption_set";
}
/**
 * §6.C6.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Exemption".
 */
export interface Exemption {
  evidence: string;
  reason: ExemptionReason;
  subject_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequestOpened".
 */
export interface RequestOpened {
  kind: "request_opened";
  request: Request;
}
/**
 * §3.4 — an obligation. ``names`` is non-empty only for closure/appeal (reducer-checked).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Request".
 */
export interface Request {
  answered_by: string | null;
  assignee: string;
  id: string;
  kind: RequestKind;
  mode: ReviewMode | null;
  names: string[];
  opened_at: string;
  opened_by: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
  reason: string;
  required: boolean;
  status: RequestStatus;
  subject_key: string;
  supersedes: string | null;
  transport: (DeliveryRef | SummonRef)[];
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "DeliveryRef".
 */
export interface DeliveryRef {
  delivery_id: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SummonRef".
 */
export interface SummonRef {
  summon_comment_id: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequestCancelled".
 */
export interface RequestCancelled {
  kind: "request_cancelled";
  reason: string;
  request_id: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequestAnswered".
 */
export interface RequestAnswered {
  answer_id: string;
  kind: "request_answered";
  request_id: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequestUnanswerable".
 */
export interface RequestUnanswerable {
  kind: "request_unanswerable";
  reason: string;
  request_id: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AnswerAdmitted".
 */
export interface AnswerAdmitted {
  answer: Answer;
  kind: "answer_admitted";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Answer".
 */
export interface Answer {
  admitted_at: string;
  id: string;
  normalized: NormalizedResult | Testimony;
  principal: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
  request_id: string;
  status: AnswerStatus;
  subject_key: string;
}
/**
 * §2.3 — the one interpretation of both report arms.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "NormalizedResult".
 */
export interface NormalizedResult {
  answers: FindingAnswer[];
  completion: Completion;
  findings: AdmittedFinding[];
  provenance: Provenance;
  reviewer: string;
  subject_key: string;
  verdict: NormalizedVerdict;
}
/**
 * §2.3: one per finding the request named.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingAnswer".
 */
export interface FindingAnswer {
  answer: FindingAnswerKind;
  evidence: string;
  finding_id: string;
}
/**
 * §3.5 — an obligation with an immutable id and its native source identity.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AdmittedFinding".
 */
export interface AdmittedFinding {
  answer_id: string | null;
  correlation_hints: string[];
  id: string;
  line: number | null;
  links: FindingLink[];
  path: string;
  priority: FindingPriority;
  raised_by: string;
  review_id: string;
  reviewer_disposition: Disposition | null;
  source: ReviewkitFindingSource | CommentFindingSource;
  status: FindingOpen | FindingClosed | FindingContested;
  subject_key: string;
  title: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingLink".
 */
export interface FindingLink {
  at: string;
  by: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
  other: string;
  relation: "same_as";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewkitFindingSource".
 */
export interface ReviewkitFindingSource {
  fingerprint: string;
  semantic_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "CommentFindingSource".
 */
export interface CommentFindingSource {
  comment_id: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingOpen".
 */
export interface FindingOpen {
  open: true;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingClosed".
 */
export interface FindingClosed {
  open: false;
  resolution: Resolution;
}
/**
 * §3.5 / §6.F3.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Resolution".
 */
export interface Resolution {
  at: string;
  by: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
  commits: string[];
  confirmed_by: string | null;
  evidence: string;
  kind: ResolutionKind;
  resolution_text: string | null;
  ticket: string | null;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingContested".
 */
export interface FindingContested {
  contested: Contest;
  open: true;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Contest".
 */
export interface Contest {
  at: string;
  by: string;
  prior: Resolution;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Provenance".
 */
export interface Provenance {
  arm: ReportArm;
  record: SourceRef;
  report_ref: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AnswerRetracted".
 */
export interface AnswerRetracted {
  answer_id: string;
  kind: "answer_retracted";
  reason: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingAdmitted".
 */
export interface FindingAdmitted {
  finding: AdmittedFinding;
  kind: "finding_admitted";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingResolved".
 */
export interface FindingResolved {
  finding_id: string;
  kind: "finding_resolved";
  resolution: Resolution;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingContestedConsequence".
 */
export interface FindingContestedConsequence {
  contest: Contest;
  finding_id: string;
  kind: "finding_contested";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingLinked".
 */
export interface FindingLinked {
  finding_id: string;
  kind: "finding_linked";
  link: FindingLink;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingClassified".
 */
export interface FindingClassified {
  finding_id: string;
  kind: "finding_classified";
  priority: Priority;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HoldPlaced".
 */
export interface HoldPlaced {
  hold: SubjectClearableHold | ExplicitHold;
  kind: "hold_placed";
}
/**
 * §6.G3: only ``human_gate`` and ``stack`` may release on subject change.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SubjectClearableHold".
 */
export interface SubjectClearableHold {
  at: string;
  blocks: HoldBlocks;
  by: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
  id: string;
  kind: "human_gate" | "stack";
  reason: string;
  release_on: ReleaseOn;
  released: HoldRelease | null;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HoldRelease".
 */
export interface HoldRelease {
  at: string;
  by: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
  reason: string;
}
/**
 * §6.G3: exhaustion, owner_decision, unanswerable and operator release only explicitly.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExplicitHold".
 */
export interface ExplicitHold {
  at: string;
  blocks: HoldBlocks;
  by: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
  id: string;
  kind: "exhaustion" | "owner_decision" | "unanswerable" | "operator";
  reason: string;
  release_on: "explicit";
  released: HoldRelease | null;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HoldReleased".
 */
export interface HoldReleased {
  hold_id: string;
  kind: "hold_released";
  release: HoldRelease;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ChargeRecorded".
 */
export interface ChargeRecorded {
  charge: Charge;
  kind: "charge_recorded";
}
/**
 * §6.G1 — recorded once per subject on its first complete accepted answer.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Charge".
 */
export interface Charge {
  answer_id: string;
  at: string;
  subject_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "EpisodeOpened".
 */
export interface EpisodeOpened {
  episode: ExhaustionEpisode;
  kind: "episode_opened";
}
/**
 * §6.G4.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ExhaustionEpisode".
 */
export interface ExhaustionEpisode {
  closed: EpisodeClose | null;
  hold_id: string;
  id: string;
  opened_at: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "EpisodeClose".
 */
export interface EpisodeClose {
  at: string;
  by: SeatPrincipal | OperatorPrincipal | AdapterPrincipal | SystemPrincipal;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "EpisodeClosed".
 */
export interface EpisodeClosed {
  close: EpisodeClose;
  episode_id: string;
  kind: "episode_closed";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AvailabilitySet".
 */
export interface AvailabilitySet {
  availability: Available | Unavailable;
  kind: "availability_set";
  reviewer: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RoundsGranted".
 */
export interface RoundsGranted {
  kind: "rounds_granted";
  n: number;
  reason: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "PolicyAdopted".
 */
export interface PolicyAdopted {
  kind: "policy_adopted";
  version: number;
}
/**
 * §6.D8.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "MergeableObserved".
 */
export interface MergeableObserved {
  kind: "mergeable_observed";
  mergeable: boolean | null;
}
/**
 * §8.1 — an outbox row with its own id; ``target`` follows the §8.1 grammar.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Effect".
 */
export interface Effect {
  effect_id: string;
  kind: EffectKind;
  payload: {
    [k: string]: unknown | undefined;
  } | null;
  target: string;
}
/**
 * §9.2 — versioned per repository; a Review keeps the version it opened under (§6.I).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Policy".
 */
export interface Policy {
  author_aliases: {
    [k: string]: string | undefined;
  };
  burn_actor: string;
  closure_by_seat: boolean;
  codex_meter: CodexMeter | null;
  exempt_roots: string[];
  retrospective_actor: string;
  reviewer_set: string[];
  rounds_max?: number;
  routing_by_round: RoutingByRound;
  slack: SlackPolicy | null;
  stall_window_s?: number;
  substitute_actor: string;
  transport_bound?: number;
  version: number;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "CodexMeter".
 */
export interface CodexMeter {
  pool: string;
  threshold: number;
  url: string;
}
/**
 * §6.D2 (KRA-1131): Codex holds round one; the substitute every later round.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RoutingByRound".
 */
export interface RoutingByRound {
  first: string;
  later: string;
}
/**
 * Where system-origin deliveries and the board line go.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "SlackPolicy".
 */
export interface SlackPolicy {
  channel_id: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Ready".
 */
export interface Ready {
  ready: true;
  subject_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "NotReady".
 */
export interface NotReady {
  ready: false;
  /**
   * @minItems 1
   */
  reasons: [
    (
      | ("merged" | "closed" | "draft" | "exhausted" | "incomplete_answer")
      | HoldReason
      | RequirementUnsatisfiedReason
      | RequiredRequestPendingReason
      | BlockingFindingsReason
    ),
    ...(
      | ("merged" | "closed" | "draft" | "exhausted" | "incomplete_answer")
      | HoldReason
      | RequirementUnsatisfiedReason
      | RequiredRequestPendingReason
      | BlockingFindingsReason
    )[]
  ];
  subject_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "HoldReason".
 */
export interface HoldReason {
  hold: "human_gate" | "stack" | "exhaustion" | "owner_decision" | "unanswerable" | "operator";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequirementUnsatisfiedReason".
 */
export interface RequirementUnsatisfiedReason {
  requirement_unsatisfied: string[];
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequiredRequestPendingReason".
 */
export interface RequiredRequestPendingReason {
  required_request_pending: string[];
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "BlockingFindingsReason".
 */
export interface BlockingFindingsReason {
  blocking_findings: string[];
}
/**
 * §4. ``review_id`` is null when the refusal precedes the Review's existence.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Receipt".
 */
export interface Receipt {
  act_id: string;
  outcome: AppliedOutcome | ReplayedOutcome | RefusedOutcome;
  review_id: string | null;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "AppliedOutcome".
 */
export interface AppliedOutcome {
  applied: true;
  batch_id: string;
  effects: string[];
  revision_after: number;
  revision_before: number;
}
/**
 * §5.B2 — the act id was already admitted; nothing changed.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReplayedOutcome".
 */
export interface ReplayedOutcome {
  batch_id: string;
  replayed: true;
  revision_at_apply: number;
}
/**
 * §5.B4 — appended to ``review_attempts``; ``state`` is null before the Review exists.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RefusedOutcome".
 */
export interface RefusedOutcome {
  code: RefusalCode;
  current_revision: number;
  detail: string;
  refused: true;
  state: ReviewState | null;
}
/**
 * §3.6 — ``Review`` plus what ``read()`` derives; never stored.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewState".
 */
export interface ReviewState {
  active_holds: (SubjectClearableHold | ExplicitHold)[];
  advisories: AdmittedFinding[];
  answers: Answer[];
  availability: {
    [k: string]: Available | Unavailable | undefined;
  };
  blocking_findings: AdmittedFinding[];
  budget: Budget;
  charges: Charge[];
  display: string;
  draft: boolean;
  episodes: ExhaustionEpisode[];
  exemption: Exemption | null;
  findings: AdmittedFinding[];
  holds: (SubjectClearableHold | ExplicitHold)[];
  id: string;
  key: ReviewKey;
  lifecycle: Lifecycle;
  observed: Observed;
  policy_version: number;
  projection_handles: ProjectionHandles;
  readiness: Ready | NotReady;
  requests: Request[];
  requirement: RequirementSatisfied | RequirementExempt | RequirementUnsatisfied;
  revision: number;
  rounds_consumed: number;
  rounds_remaining: number;
  subject: Subject;
  subjects: Subject[];
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Budget".
 */
export interface Budget {
  granted: number;
  rounds_max: number;
}
/**
 * §3.1: GitHub's stable ids; ``owner/repo#n`` is display only.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewKey".
 */
export interface ReviewKey {
  pr_number: number;
  repository_id: number;
}
/**
 * §8.1 handles the projections edit in place.
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ProjectionHandles".
 */
export interface ProjectionHandles {
  board_comment_id: number | null;
  check_run_ids: {
    [k: string]: number | undefined;
  };
  slack_thread_ts: string | null;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequirementSatisfied".
 */
export interface RequirementSatisfied {
  by: string[];
  status: "satisfied";
  subject_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequirementExempt".
 */
export interface RequirementExempt {
  status: "exempt";
  subject_key: string;
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "RequirementUnsatisfied".
 */
export interface RequirementUnsatisfied {
  pending: string[];
  status: "unsatisfied";
  subject_key: string;
}
/**
 * What ``decide`` returns instead of a batch (§5.B3).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Refusal".
 */
export interface Refusal {
  code: RefusalCode;
  detail: string;
  refused: true;
}
/**
 * §3.3 — the durable record. ``review_batches`` is the truth; this is its fold (§5.B3).
 *
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "Review".
 */
export interface Review {
  answers: Answer[];
  availability: {
    [k: string]: Available | Unavailable | undefined;
  };
  budget: Budget;
  charges: Charge[];
  display: string;
  draft: boolean;
  episodes: ExhaustionEpisode[];
  exemption: Exemption | null;
  findings: AdmittedFinding[];
  holds: (SubjectClearableHold | ExplicitHold)[];
  id: string;
  key: ReviewKey;
  lifecycle: Lifecycle;
  observed: Observed;
  policy_version: number;
  projection_handles: ProjectionHandles;
  requests: Request[];
  revision: number;
  subject: Subject;
  subjects: Subject[];
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "ReviewResolution".
 */
export interface ReviewResolution {
  findings: FindingResolution[];
  head_after: string;
  head_before: string;
  parent_report_id: string;
  pr_number: number;
  repository: string;
  resolution_id: string;
  resolver: string;
  schema_version?: "1";
}
/**
 * This interface was referenced by `ReviewContract`'s JSON-Schema
 * via the `definition` "FindingResolution".
 */
export interface FindingResolution {
  affected_paths: string[];
  claimed_behavior: string;
  commits?: string[];
  disposition: ResolutionDisposition;
  falsifier?: string | null;
  falsifier_result?: string | null;
  fingerprint: string;
  notes?: string | null;
  reviewer_remedy_followed: boolean;
}
