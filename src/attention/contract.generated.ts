/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/attention/attention-v1.schema.json,
 * hive's own attention contract (ADR-0004); not vendored.
 * Regenerate with `bun run check:contracts`.
 */

/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SchemaVersion".
 */
export type SchemaVersion = 1;
/**
 * A configured queue identity (`hakon` first). Not a provider actor and never enrolled as one.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "HumanId".
 */
export type HumanId = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ActorId".
 */
export type ActorId = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "EdgeId".
 */
export type EdgeId = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Provider".
 */
export type Provider = "codex" | "claude" | "grok";
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ProjectId".
 */
export type ProjectId = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "WorkId".
 */
export type WorkId = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "InterventionKey".
 */
export type InterventionKey = string;
/**
 * A client-minted UUID naming one mutation. The same id with the same content replays the committed receipt.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "CommandId".
 */
export type CommandId = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ItemId".
 */
export type ItemId = number;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Revision".
 */
export type Revision = number;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ReturnGeneration".
 */
export type ReturnGeneration = number;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceId".
 */
export type SourceId = string;
/**
 * RFC 3339 with an explicit offset. The broker canonicalizes to UTC milliseconds before persistence and compares instants, never strings.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Reason".
 */
export type Reason = string;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "InterventionKind".
 */
export type InterventionKind = "review" | "decision" | "selection" | "unblock" | "human_work";
/**
 * Workflow labels, not permissions or executable actions.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ResolutionOutcome".
 */
export type ResolutionOutcome =
  "approved" | "changes_requested" | "answered" | "selected" | "delegated" | "completed";
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ItemState".
 */
export type ItemState = "queued" | "active" | "deferred" | "resolved" | "cancelled";
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ReturnMode".
 */
export type ReturnMode = "pinned_session" | "actor_context" | "none";
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ReturnPhase".
 */
export type ReturnPhase = "pending" | "blocked" | "minted" | "processed" | "failed" | "superseded";
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceProvenance".
 */
export type SourceProvenance = "dispatch" | "live_registration" | "operator_binding";
/**
 * The strict mutation envelope at `POST /v1/attention/commands`. The authenticated principal, never the body, decides which actions are allowed.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "AttentionCommand".
 */
export type AttentionCommand =
  | SummonCommand
  | AmendCommand
  | WithdrawCommand
  | AddCommand
  | StartCommand
  | NextCommand
  | ResolveCommand
  | DeferCommand
  | RequeueCommand
  | CancelCommand
  | RetryReturnCommand
  | RerouteReturnCommand
  | SourceRevokeCommand;
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceEvidence".
 */
export type SourceEvidence = DispatchEvidence | LiveEvidence | OperatorEvidence;
/**
 * Broker-derived routing metadata written on the core delivery in the mint transaction. `pinned` is non-null exactly for `pinned_session`.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "AttentionContinuationTarget".
 */
export type AttentionContinuationTarget = PinnedContinuationTarget | ContextContinuationTarget;
/**
 * The core Hive delivery state behind a minted return, projected at read time or snapshotted once terminal.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "TransportStatus".
 */
export type TransportStatus =
  | "pending"
  | "claimed"
  | "accepted_local"
  | "dispatching"
  | "dispatched"
  | "processed"
  | "undeliverable"
  | "failed"
  | "transport_record_missing";
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SelectionReason".
 */
export type SelectionReason = "fifo" | "explicit_pick" | "already_active" | "empty";
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ReceiptResult".
 */
export type ReceiptResult =
  | "created"
  | "existing"
  | "amended"
  | "withdrawn"
  | "claimed"
  | "already_active"
  | "empty"
  | "started"
  | "resolved"
  | "deferred"
  | "requeued"
  | "cancelled"
  | "return_retry_scheduled"
  | "return_in_flight"
  | "return_retried"
  | "return_rerouted"
  | "source_bound"
  | "source_revoked";

/**
 * Hive Attention v1: the durable human-intervention queue. Hive owns this schema (ADR-0004); it is not vendored. Every shape the broker admits or emits for attention is a $defs entry here.
 */
export interface AttentionContract {
  [k: string]: unknown | undefined;
}
/**
 * A reference, never fetched or interpreted by the broker. `https://…`, a Hive handle (`hive:…`), or an absolute file path — which must name its owning `edge_id`, so a path on a remote seat is never presented as a local file.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Artifact".
 */
export interface Artifact {
  label: string;
  uri: string;
  version?: string;
  edge_id?: EdgeId;
}
/**
 * What a producer authors. Source identity, state, revision, ready sequence, claimed human and return route are never packet fields.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "InterventionPacket".
 */
export interface InterventionPacket {
  human_id: HumanId;
  project_id: ProjectId;
  work_id: WorkId;
  intervention_key: InterventionKey;
  kind: InterventionKind;
  title: string;
  requested_action: string;
  context: string;
  unblocks: string;
  /**
   * @maxItems 12
   */
  artifacts:
    | []
    | [Artifact]
    | [Artifact, Artifact]
    | [Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact
      ]
    | [
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact
      ]
    | [
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact
      ];
  estimate_minutes: number | null;
  deadline_at: Timestamp | null;
  predecessor_item_id: ItemId | null;
}
/**
 * Replacement values for the producer-mutable packet fields. Identity, owner, state, source, predecessor and route are not amendable.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "PacketAmendment".
 */
export interface PacketAmendment {
  title?: string;
  requested_action?: string;
  context?: string;
  unblocks?: string;
  /**
   * @maxItems 12
   */
  artifacts?:
    | []
    | [Artifact]
    | [Artifact, Artifact]
    | [Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact, Artifact]
    | [
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact
      ]
    | [
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact
      ]
    | [
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact,
        Artifact
      ];
  estimate_minutes?: number | null;
  deadline_at?: Timestamp | null;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SummonCommand".
 */
export interface SummonCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "summon";
  payload: InterventionPacket;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "AmendPayload".
 */
export interface AmendPayload {
  item_id: ItemId;
  expected_revision: Revision;
  fields: PacketAmendment;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "AmendCommand".
 */
export interface AmendCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "amend";
  payload: AmendPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ItemReasonPayload".
 */
export interface ItemReasonPayload {
  item_id: ItemId;
  expected_revision: Revision;
  reason: Reason;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "WithdrawCommand".
 */
export interface WithdrawCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "withdraw";
  payload: ItemReasonPayload;
}
/**
 * Human-first work. `return_source_id` optionally binds an already-enrolled source so a resolution returns to it.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "HumanPacketPayload".
 */
export interface HumanPacketPayload {
  packet: InterventionPacket;
  return_source_id: SourceId | null;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "AddCommand".
 */
export interface AddCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "add";
  payload: HumanPacketPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "StartCommand".
 */
export interface StartCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "start";
  payload: HumanPacketPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "NextPayload".
 */
export interface NextPayload {
  human_id: HumanId;
  item_id: ItemId | null;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "NextCommand".
 */
export interface NextCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "next";
  payload: NextPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ResolvePayload".
 */
export interface ResolvePayload {
  item_id: ItemId;
  expected_revision: Revision;
  outcome: ResolutionOutcome;
  response: string;
  select_next: boolean;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ResolveCommand".
 */
export interface ResolveCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "resolve";
  payload: ResolvePayload;
}
/**
 * `until` null is an explicit indefinite hold; it never promotes on its own.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "DeferPayload".
 */
export interface DeferPayload {
  item_id: ItemId;
  expected_revision: Revision;
  reason: Reason;
  until: Timestamp | null;
  select_next: boolean;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "DeferCommand".
 */
export interface DeferCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "defer";
  payload: DeferPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "RequeueCommand".
 */
export interface RequeueCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "requeue";
  payload: ItemReasonPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "CancelPayload".
 */
export interface CancelPayload {
  item_id: ItemId;
  expected_revision: Revision;
  reason: Reason;
  select_next: boolean;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "CancelCommand".
 */
export interface CancelCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "cancel";
  payload: CancelPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "RetryReturnPayload".
 */
export interface RetryReturnPayload {
  item_id: ItemId;
  expected_revision: Revision;
  return_generation: ReturnGeneration;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "RetryReturnCommand".
 */
export interface RetryReturnCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "retry_return";
  payload: RetryReturnPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "RerouteReturnPayload".
 */
export interface RerouteReturnPayload {
  item_id: ItemId;
  expected_revision: Revision;
  return_generation: ReturnGeneration;
  source_id: SourceId;
  reason: Reason;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "RerouteReturnCommand".
 */
export interface RerouteReturnCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "reroute_return";
  payload: RerouteReturnPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceRevokePayload".
 */
export interface SourceRevokePayload {
  source_id: SourceId;
  reason: Reason;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceRevokeCommand".
 */
export interface SourceRevokeCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "source_revoke";
  payload: SourceRevokePayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SlackThread".
 */
export interface SlackThread {
  channel_id: string;
  thread_ts: string;
}
/**
 * Edge-resolved from a running dispatch token. The broker fences it with assertLease and derives the actor from the delivery.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "DispatchEvidence".
 */
export interface DispatchEvidence {
  kind: "dispatch";
  source_delivery_id: number;
  generation: number;
  route: "live" | "resume" | "spawn" | "pinned_resume";
  session_id: string | null;
  cwd: string | null;
}
/**
 * Edge-verified against an unexpired live registration matching actor, provider and session exactly.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "LiveEvidence".
 */
export interface LiveEvidence {
  kind: "live_registration";
  actor: ActorId;
  provider: Provider;
  session_id: string;
  cwd: string | null;
  surface_version: string;
}
/**
 * An explicit operator enrollment on the source edge. A session counts as verified only when this edge's live registry holds it exactly; provider names the registry that verified it, and is null otherwise.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "OperatorEvidence".
 */
export interface OperatorEvidence {
  kind: "operator_binding";
  actor: ActorId;
  session_id: string | null;
  session_verified: "live_registry" | "none";
  provider: Provider | null;
  cwd: string;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceBindPayload".
 */
export interface SourceBindPayload {
  project_id: ProjectId;
  work_id: WorkId;
  return_mode: ReturnMode;
  thread: SlackThread | null;
  evidence: SourceEvidence;
}
/**
 * Edge → broker at `POST /v1/attention/sources`. The edge builds the evidence; a caller never names an actor as proof.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceBindCommand".
 */
export interface SourceBindCommand {
  schema_version: SchemaVersion;
  command_id: CommandId;
  action: "source_bind";
  payload: SourceBindPayload;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "PinnedRoute".
 */
export interface PinnedRoute {
  provider: Provider;
  home_edge: EdgeId;
  account_profile_fingerprint: string;
  session_id: string;
  cwd: string;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "PinnedContinuationTarget".
 */
export interface PinnedContinuationTarget {
  kind: "attention_return";
  protocol: 1;
  source_id: SourceId;
  resolution_command_id: CommandId;
  generation: ReturnGeneration;
  actor: ActorId;
  mode: "pinned_session";
  pinned: PinnedRoute;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ContextContinuationTarget".
 */
export interface ContextContinuationTarget {
  kind: "attention_return";
  protocol: 1;
  source_id: SourceId;
  resolution_command_id: CommandId;
  generation: ReturnGeneration;
  actor: ActorId;
  mode: "actor_context";
  pinned: null;
}
/**
 * Public source metadata. The local source handle never appears here.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceView".
 */
export interface SourceView {
  source_id: SourceId;
  provenance: SourceProvenance;
  edge_id: EdgeId;
  issuer_principal: string;
  owner_principal: string;
  actor: ActorId;
  provider: Provider;
  project_id: ProjectId;
  work_id: WorkId;
  return_mode: ReturnMode;
  session_id: string | null;
  session_absence: string | null;
  cwd: string | null;
  account_profile_fingerprint: string;
  source_delivery_id: number | null;
  thread: SlackThread | null;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: Reason | null;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ReturnView".
 */
export interface ReturnView {
  return_id: number;
  item_id: ItemId;
  resolution_command_id: CommandId;
  generation: ReturnGeneration;
  source_id: SourceId;
  mode: "pinned_session" | "actor_context";
  phase: ReturnPhase;
  reason: string | null;
  next_attempt_at: Timestamp | null;
  delivery_id: number | null;
  transport_status: TransportStatus | null;
  observed_at: Timestamp;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ItemView".
 */
export interface ItemView {
  item_id: ItemId;
  human_id: HumanId;
  owner_principal: string;
  origin: "seat" | "human";
  state: ItemState;
  revision: Revision;
  ready_sequence: number | null;
  deferred_until: Timestamp | null;
  packet: InterventionPacket;
  source: SourceView | null;
  return_mode: ReturnMode;
  created_at: Timestamp;
  updated_at: Timestamp;
  claimed_at: Timestamp | null;
  resolved_at: Timestamp | null;
  outcome: ResolutionOutcome | null;
  response: string | null;
  terminal_reason: string | null;
  return: ReturnView | null;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ItemRef".
 */
export interface ItemRef {
  item_id: ItemId;
  revision: Revision;
  state: ItemState;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ReturnRef".
 */
export interface ReturnRef {
  return_id: number;
  generation: ReturnGeneration;
  phase: ReturnPhase;
}
/**
 * What `next` (or a `--next` combined mutation) selected, as of the commit. The deterministic brief is part of the committed receipt.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Selection".
 */
export interface Selection {
  selection_reason: SelectionReason;
  item: ItemView | null;
  brief: string | null;
  eligible_count: number;
  deferred_count: number;
  next_deferred_at: Timestamp | null;
}
/**
 * Returned only after the transaction holding the state, its events and this receipt commits (I03). A replay returns the stored receipt with `replayed: true`.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Receipt".
 */
export interface Receipt {
  schema_version: SchemaVersion;
  broker_uuid: string;
  command_id: CommandId;
  action:
    | "summon"
    | "amend"
    | "withdraw"
    | "add"
    | "start"
    | "next"
    | "resolve"
    | "defer"
    | "requeue"
    | "cancel"
    | "retry_return"
    | "reroute_return"
    | "source_bind"
    | "source_revoke";
  result: ReceiptResult;
  replayed: boolean;
  as_of: Timestamp;
  item: ItemRef | null;
  active_item: ItemRef | null;
  return_effect: ReturnRef | null;
  selection: Selection | null;
  source: SourceView | null;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "QueueStatus".
 */
export interface QueueStatus {
  human_id: HumanId;
  active_item: ItemRef | null;
  eligible_count: number;
  deferred_count: number;
  oldest_eligible_at: Timestamp | null;
  next_deferred_at: Timestamp | null;
  returns_pending: number;
  returns_blocked: number;
  returns_failed: number;
  route_warnings: {
    item_id: ItemId;
    generation: ReturnGeneration;
    phase: ReturnPhase;
    reason: string;
  }[];
  observed_at: Timestamp;
}
/**
 * One keyset page. A moving queue is not a snapshot; refresh from the head for a newly ordered view.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "QueuePage".
 */
export interface QueuePage {
  as_of: Timestamp;
  status: QueueStatus;
  /**
   * @maxItems 100
   */
  items: ItemView[];
  next_cursor: string | null;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "EventView".
 */
export interface EventView {
  event_id: number;
  item_id: ItemId | null;
  source_id: SourceId | null;
  command_id: CommandId | null;
  principal: string;
  event_type: string;
  revision: Revision | null;
  created_at: Timestamp;
  payload: {};
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "Capabilities".
 */
export interface Capabilities {
  schema_version: SchemaVersion;
  broker_uuid: string;
  enabled: boolean;
  store_schema_version: number;
  human_id: HumanId;
  actions: string[];
  return_modes: ReturnMode[];
  edge_protocol: 1;
  disabled_note: string | null;
}
/**
 * Transport validation for a constrained inbox envelope immediately before emission. Session matching is the receiver's own, independent check.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ReturnGuard".
 */
export interface ReturnGuard {
  eligible: boolean;
  reason: string;
  as_of: Timestamp;
}
/**
 * The owner-only (0600) file `bind --out` writes. `handle` is the local secret; it is never sent to Slack, logs or the broker.
 *
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "SourceFile".
 */
export interface SourceFile {
  schema_version: SchemaVersion;
  broker_uuid: string;
  edge_id: EdgeId;
  source_id: SourceId;
  handle: string;
  actor: ActorId;
  project_id: ProjectId;
  work_id: WorkId;
  return_mode: ReturnMode;
  provenance: SourceProvenance;
}
/**
 * This interface was referenced by `AttentionContract`'s JSON-Schema
 * via the `definition` "ErrorEnvelope".
 */
export interface ErrorEnvelope {
  error: string;
  detail?: string;
  current?: ItemRef | null;
}
