# Review state machine — module map (M0/M1 build contract)

**Authority:** `docs/design/review-state-machine-v0.2.md` (v0.2, approved 2026-09-06). Where this map
and the design disagree, the design wins; where this map and a builder's code disagree, this map wins
until the integrator amends it. **Author:** gnomon, 2026-09-06.

Five builders code in parallel against the signatures below. Every type named here comes from
`src/review/contract.ts` (which re-exports `contract.generated.ts`, generated from the vendored
`contracts/schemas/review-contract.schema.json`). Nobody handwrites a contract type; nobody imports
`contract.generated.ts` directly.

## 0. What is already landed (this commit)

| Path | What |
|---|---|
| `contracts/SOURCE` | weave-doctrine SHA + the exact export command |
| `contracts/schemas/review-contract.schema.json` | the one schema: `$defs` hold every model once; top level has one property per exported model |
| `contracts/conformance/{valid,invalid}/*.json` | the shared corpus (`{model, instance[, expect]}`); `model` is the schema's top-level property name |
| `scripts/gen-contract-types.mjs` | `$defs` → `src/review/contract.generated.ts` (json-schema-to-typescript); `bun run check:contracts` regenerates and fails on drift |
| `src/review/contract.ts` | Ajv 2020 strict, compiled once; `validateAction`, `validateExternalResult`, `validateReviewkitReport`, `validatePolicy`, `validateBatch`, `validateReceipt`, `validateReview`, `validateReviewState`, … each `(input: unknown) => Validated<T>`; `contractValidator<T>(defName)` for anything else |
| `src/review/contract.test.ts` | corpus through Ajv: valid ⇒ ok, invalid ⇒ `malformed` |

```ts
export type Validated<T> = { ok: true; value: T } | { ok: false; code: "malformed"; detail: string };
```

## 1. Shared vocabulary (read before coding)

- **Names that differ from the design prose** (the contract is authoritative): the action union's
  discriminator is `kind` on every verb, so `OpenRequest`'s obligation kind is `request_kind`; a
  `Hold` action carries `hold: HoldSpec` (discriminated on `hold.kind`); `ResolveFinding` carries
  `resolution: ResolutionRequest` (discriminated on `resolution.kind`, one variant per §F3 kind:
  `fixed{commits≥1}`, `refuted`, `withdrawn`, `product_gate`, `follow_up{ticket}`,
  `owner_decision{resolution_text}`, `same_as{other}`); `Answer` carries
  `submission: {arm:"reviewkit", report} | {arm:"testimony", testimony}`; `AdmitExternalResult`
  carries `result: ExternalResult`. Action *classes* are `<Verb>Action` (`AnswerAction`,
  `HoldAction`) because `Answer` and `Hold` name state records.
- **`Observed.mergeable: boolean | null`** is where §D8's GitHub tri-state lives; the reducer records
  a `mergeable_observed` consequence when it changes.
- **`Receipt.review_id` and `RefusedOutcome.state` are nullable**: a refusal before the Review exists
  (first act is not an adapter `ObservePR`) has no id and no state.
- **`ActorId`** is `^[a-z0-9-]+$`; `"codex"` is the reserved external reviewer.
- **Timestamps** are ISO-8601 UTC with `Z` (`Clock.now().toISOString()` conforms). **SHAs** are
  40-hex lowercase. **Subject key** is `` `${head_sha}:${base_ref}` ``.
- **Ids are minted by the reducer, deterministically** (§5.B3 replay never calls `decide`):
  `<prefix>_<actId>_<n>` where `n` counts from 1 within one batch — `req_`, `ans_`, `fnd_`, `hold_`,
  `ep_`, `eff_`; `batch_id = "bat_" + actId`; `review_id = "rev_" + actId` of the opening act. Ids may
  contain colons (adapter act ids are `obs:<run>` / `src:<record_key>:<version>`); the §8.1 target
  grammar tolerates that.
- **Effect target grammar (§8.1)** — `check:<owner/repo>:<head_sha>` · `board:<review_id>` ·
  `thread:<comment_id>` · `delivery:<actor>:<request_id>` · `summon:<request_id>` ·
  `announce:<review_id>`. `kind` is `refresh` for check/board/thread and `actionable` for
  delivery/summon/announce. `payload` is `null` for refreshes (a refresh re-renders from `read()`);
  actionable payloads are §4 of this map.
- **Refusal** (what `decide` returns; the store wraps it into a `Receipt`):
  `{ refused: true; code: RefusalCode; detail: string }` — the generated `Refusal` type.
- **ReviewKey addressing**: an HTTP/CLI `:key` is either `<repository_id>:<pr_number>` (two
  integers) or the display `owner/repo#n`, resolved through `ReviewStore.findByDisplay`. Shared helper
  (cli builder writes it in `src/review/key.ts`, everyone imports it):

```ts
export function parseReviewKey(text: string): { kind: "key"; key: ReviewKey } | { kind: "display"; display: string } | null;
export function formatReviewKey(key: ReviewKey): string;            // "<repository_id>:<pr_number>"
```

## 2. `src/review/reducer.ts` — owner: **reducer builder**

Pure. No I/O, no `Date.now()`, no randomness. Everything it needs is in `ctx`.

```ts
import type { Action, Batch, Policy, Principal, Refusal, Review, ReviewState } from "./contract.js";

export interface ReviewIdentity { key: ReviewKey; display: string }   // §3.1; neither ObservePR nor the batch carries it

export interface DecideContext {
  now: string;                                      // ISO UTC; the only clock
  policy: Policy;                                   // the Review's version (§6.I), the repo's latest when state is null, or the adopted version for AdoptPolicy
  actId: string;
  principal: Principal;
  expectedRevision: number | null;                  // seat/operator must equal state.revision (§B1); adapter null
  meter: { reading: number; threshold: number } | null;   // §D2 routing input, fetched by the reconcile run
  identity?: ReviewIdentity;                        // required when state is null (the store always passes it)
}

/** §4 + §6: authorization table, lifecycle gate, revision fence, then the verb's own rules. */
export function decide(state: Review | null, action: Action, ctx: DecideContext): Batch | Refusal;

/** §5.B3: applies consequences only; never re-derives, never emits. `fold(fold(s,b1),b2)` is replay. The opening batch needs the identity. */
export function fold(state: Review | null, batch: Batch, identity?: ReviewIdentity): Review;

export const CODEX_LOGINS: ReadonlySet<string>;   // the connector's bot logins — the one definition; the adapter imports it

/** §3.6 / §6.H: requirement, blocking set, rounds, active holds, readiness with precedence-ordered reasons. */
export function read(state: Review, ctx: { now: string; policy: Policy }): ReviewState;

/** §3.1: `${owner}/${repo}#${n}` from the last observation. */
export function displayName(review: Review): string;

export function isRefusal(result: Batch | Refusal): result is Refusal;
```

Rules the reducer must implement and test, by name (each is one `node:test` case at minimum):
§4 authorization table (every row, both allowed and refused principal), B1 `stale_revision`,
C1–C6 (C6: the exemption is `ObservePRAction.exemption`, computed by the reconcile run, recorded on a
subject change, never recomputed by the reducer), D1 (enforced inside the one `open()` every opener
uses, so the auto-request, a reassignment and the exhaustion episode honour it too), D2 routing
(`policy.routing_by_round`, availability, meter), D3 clearing on admitted signal / `until` passed at
decision time, D4 reassignment with `supersedes`, D6 stall housekeeping (runs inside every `ObservePR`
— the §7 sweep is the cadence, §A4 forbids a separate command — measuring `stall_window_s` from the last
transport the reducer queued, recording `request_retransported` up to `transport_bound`, then
`request_transport_exhausted` + `Hold(transport_exhausted, blocks summons)` — neither discharges the
obligation, the request stays pending; paused transport never stalls; an answer arriving anyway releases
the hold as the system), D9 the one outstanding-obligation predicate (`isOutstanding`, used by
readiness, housekeeping, answer matching and restoration), D10 `restoreObligations` (the one
invariant-restoration point, called from `observe`, `release`, `grantRounds`, `cancelRequest`,
`setAvailability` and `adoptPolicy`; holds withhold transport, never creation; an operator's
`cancellation` at the current subject is not resurrected), D8 `mergeable_observed`
+ transport withheld (effects not emitted while `mergeable === false`; emitted on flip to `true`),
E1–E7, F1–F5, G1–G5, H readiness, I `AdoptPolicy`. Cross-item and process rules listed in the
contract module's docstring (`weave_reviewkit/contract.py`) are refused `malformed` here — the store
already ran Ajv, so `decide` may assume shape. `decide` on `state === null` admits only
`ObservePR` from an adapter/system principal; everything else is `no_such_target`.

Effects `decide` emits (ids `eff_<actId>_<n>`): on every applied batch one `refresh` for
`board:<review_id>` and one for `check:<display-repo>:<head_sha>`; `thread:<comment_id>` refresh
when a finding whose source container is a `review_comment` changes status (the target is the
container, not the finding; an `issue_comment` container has no review thread); `delivery:<assignee>:<request_id>` on
`request_opened` to a seat; `summon:<request_id>` on `request_opened` to `codex`;
`announce:<review_id>` on `lifecycle_changed → merged`. G4's episode emits exactly one
`delivery:<author>:<request_id>` (author seat) plus the retrospective request's own delivery.

Acceptance sequences §11 #1, #2, #3, #6, #7 (pure part), #8, #9, #10 are the reducer builder's tests
(`src/review/reducer.test.ts`, one test per sequence, named by number).

## 3. `src/review/store.ts` — owner: **store builder**

Owns the §9.3 DDL verbatim (plus indexes), `apply`/`read`, the batch log, replay, outbox rows, the
GitHub inbox, source records, policies, operators. Runs against the broker's existing
`better-sqlite3` handle (`BrokerStore.db`) — **new tables only, never a change to an existing one**.

```ts
import type Database from "better-sqlite3";
import type { Clock } from "../time.js";
import type { Action, Batch, Effect, Policy, Principal, Receipt, Review, ReviewKey, ReviewState, ExternalResult } from "./contract.js";
import type { DecideContext, ReviewIdentity } from "./reducer.js";   // re-exported by store.ts

export interface ReviewStoreDeps {
  decide: typeof import("./reducer.js").decide;
  fold: typeof import("./reducer.js").fold;
  read: typeof import("./reducer.js").read;
  clock: Clock;
}
// The store builds `ctx.identity` from the key and `ApplyInput.display` (or the reviews row) and hands the same
// identity to `fold` on apply and on the first batch of `replay()`. `AdoptPolicy` decides under the adopted
// version (`policy(repo, action.version)`), every other act under the Review's own version.

export interface ApplyInput {
  actId: string;
  principal: Principal;
  expectedRevision: number | null;
  action: Action;                                   // already shape-valid? NO — apply runs validateAction first (§E2)
  display?: string;                                 // required when the Review does not exist yet (ObservePR)
  meter?: DecideContext["meter"];
}

export type EffectStatus = "pending" | "claimed" | "sent" | "obsolete" | "failed";

export interface EffectRow extends Effect {
  reviewId: string; revision: number; status: EffectStatus;
  attempts: number; nextAttemptAt: string | null; sentAt: string | null; obsoleteAt: string | null;
}

export interface InboxDelivery { deliveryId: string; event: string; repositoryId: number | null; prNumber: number | null; payload: unknown; receivedAt: string }
export interface SourceRecordInput { recordKey: string; version: string; reviewId: string; authorLogin: string; body: unknown }
export interface SourceRecordRow extends SourceRecordInput { classification: string | null; admittedActId: string | null }

export class ReviewStore {
  constructor(db: Database.Database, deps: ReviewStoreDeps);   // CREATE TABLE IF NOT EXISTS …, same style as BrokerStore.migrate

  /** One transaction: Ajv → replay check by act_id → decide → fold → persist batch, state, effects → Receipt. */
  apply(key: ReviewKey, input: ApplyInput): Receipt;
  read(key: ReviewKey): ReviewState | null;
  readById(reviewId: string): ReviewState | null;              // an effect row names its Review by id (publisher)
  get(key: ReviewKey): Review | null;
  findByDisplay(display: string): ReviewKey | null;
  /** §5.B3 truth: fold over review_batches in revision order; never calls decide, never emits. */
  replay(key: ReviewKey): Review;
  batches(key: ReviewKey): Batch[];
  /** Reviews with a pending request or activity in the last 24 h (§7 bounded reconcile). */
  active(since: string): ReviewKey[];

  putPolicy(repositoryId: number, policy: Policy): void;       // version must be latest+1
  policy(repositoryId: number, version: number | "latest"): Policy | null;

  readonly effects: {
    pendingByTarget(now: string, limit?: number): EffectRow[];   // one row per target: the newest pending refresh, or the oldest pending actionable
    claim(effectId: string): EffectRow | null;                    // pending → claimed; null if already claimed
    markSent(effectId: string): void;
    markObsolete(effectId: string): void;
    markFailed(effectId: string, nextAttemptAt: string): void;    // attempts+1; terminal after OUTBOX_MAX_ATTEMPTS-style bound
    coalesceRefresh(target: string): number;                      // marks every pending refresh for target but the newest obsolete; returns count
  };

  readonly inbox: {
    put(delivery: InboxDelivery): boolean;                        // false on duplicate delivery_id (§7 persist-before-ack)
    unreconciled(limit?: number): InboxDelivery[];
    markReconciled(deliveryIds: string[], runId: string): void;
  };

  readonly sourceRecords: {
    upsert(record: SourceRecordInput): "new" | "same" | "updated";   // keyed (record_key, version)
    unadmitted(reviewId: string): SourceRecordRow[];
    markAdmitted(recordKey: string, version: string, actId: string): void;
    setClassification(recordKey: string, version: string, classification: string): void;
    unknown(reviewId: string): UnknownSourceRecord[];             // §7 step 3: live records classified `unknown`, for the board
  };

  /**
   * Projection facts (§8.1 handles, §6.D5 transport references): what a port answered, recorded by
   * the publisher outside the fold — no verb produces them (§4 closed, §A4). Merged into get/read/
   * readById; never in state_json or replay() (§11 #7 compares the pure fold).
   */
  readonly projections: {
    recordBoardComment(reviewId: string, commentId: number): void;
    recordCheckRun(reviewId: string, headSha: string, checkRunId: number): void;
    recordSlackThread(reviewId: string, threadTs: string): void;
    recordSlackBoardOutbox(reviewId: string, outboxId: number): void;   // the first board line's outbox row, until its ts is known
    slackBoardOutboxId(reviewId: string): number | null;
    recordTransport(reviewId: string, effectId: string, requestId: string, ref: TransportRef): void;
  };

  readonly operators: {
    create(operatorId: string): string;                          // returns the raw token exactly once; stores sha256
    verify(token: string): string | null;                        // operator_id or null; constant-time compare
  };
}
```

Behaviours to implement and test (`src/review/store.test.ts`): B2 idempotence — same `act_id` ⇒
`{replayed: true}` with the original batch id and no new effects; B4 — a refusal writes
`review_attempts`, revision unchanged, `Receipt.outcome.refused.state` is the current `read()`;
apply is serialized per Review (a `db.transaction`); `state_json` equals `replay()` after every
apply (test rebuilds with a different clock and policy — §11 #7); `pendingByTarget` never returns
two rows for one target; `coalesceRefresh` (§11 #5, store half); `inbox.put` duplicate ⇒ false;
`operators.create` never stores the raw token. `apply` refuses `malformed` from
`validateAction` before touching the reducer (§E2), and refuses `no_such_target` with
`review_id: null` when the Review does not exist and the action is not `ObservePR`.

DDL: §9.3 verbatim, plus `CREATE INDEX IF NOT EXISTS reviews_display_idx ON reviews(display)`,
`review_effects_status_idx ON review_effects(status, next_attempt_at)`,
`github_inbox_unreconciled_idx ON github_inbox(reconciled_run) WHERE reconciled_run IS NULL`,
`source_records_review_idx ON source_records(review_id, admitted_act_id)`, and the two projection-fact
tables `review_projection_handles(review_id, handle, key, value, recorded_at)` and
`review_transport(effect_id PK, review_id, request_id, ref_json, recorded_at)`.

## 4. `src/review/effects.ts`, `render.ts`, `publisher.ts` — owner: **effects builder**

The only builder who edits `src/broker/store.ts` (to add `SystemWakePort`).

```ts
// effects.ts — target grammar (§8.1)
export type EffectTarget =
  | { kind: "check"; repo: string; headSha: string }
  | { kind: "board"; reviewId: string }
  | { kind: "thread"; commentId: number }
  | { kind: "delivery"; actor: string; requestId: string }
  | { kind: "summon"; requestId: string }
  | { kind: "announce"; reviewId: string };
export function parseTarget(target: string): EffectTarget;      // throws on a string the contract pattern would refuse
export function formatTarget(target: EffectTarget): string;

// actionable payloads (what decide puts in Effect.payload; the publisher reads them back)
export interface DeliveryPayload { actor: string; request_id: string; text: string; dedupe_key: string }
export interface SummonPayload { request_id: string; subject_key: string; text: string }        // "@codex review"
export interface AnnouncePayload { review_id: string; text: string }

// render.ts — pure
export function checkRun(state: ReviewState): { name: "weave/review"; conclusion: "success" | "failure"; title: string; summary: string };
export function boardComment(state: ReviewState, unknownRecords?: readonly UnknownSourceRecord[]): string;   // §7 step 3: unreadable Codex records, ahead of the findings
export function slackBoardLine(state: ReviewState, unknownRecords?: readonly UnknownSourceRecord[]): string;
// One op per `review_comment` *container* whose all-findings state flipped (§8.1): resolve once
// every finding in it is closed, unresolve as soon as any is open or contested. An `issue_comment`
// container has no review thread and yields none.
export function threadOps(before: Review | null, after: Review): Array<{ comment_id: number; op: "resolve" | "unresolve" }>;

// publisher.ts
export interface ReviewGitHubPort {
  createOrUpdateCheckRun(input: { repositoryId: number; headSha: string; existingId: number | null; name: string; conclusion: "success" | "failure"; title: string; summary: string }): Promise<{ checkRunId: number }>;
  createOrUpdateBoardComment(input: { repositoryId: number; prNumber: number; existingId: number | null; body: string }): Promise<{ commentId: number }>;
  resolveThread(input: { repositoryId: number; commentId: number }): Promise<void>;
  unresolveThread(input: { repositoryId: number; commentId: number }): Promise<void>;
  postComment(input: { repositoryId: number; prNumber: number; body: string }): Promise<{ commentId: number }>;   // summons
}

/** Implemented on BrokerStore by the effects builder: system-origin Hive deliveries (§8.1 Slack). */
export interface SystemWakePort {
  mintSystemWake(input: { actor: string; channelId: string; threadTs: string | null; text: string; dedupeKey: string }): { deliveryId: number };
  postBoardLine(input: { channelId: string; threadTs: string | null; text: string }): { outboxId: number };
  outboxMessageTs(outboxId: number): string | null;   // the ts the outbox posted a row as (BrokerStore.outbox.message_ts); the Review's thread
}

/** The slice of ReviewStore the publisher uses (readById, policy, effects.*, projections.*, sourceRecords.unknown); ReviewStore satisfies it structurally. */
export interface PublisherStore { … }

export class ReviewPublisher {
  constructor(store: PublisherStore, ports: { github: ReviewGitHubPort | null; slack: SystemWakePort }, clock: Clock);
  /** One pass: claim pending effects by target, render refreshes from read(), check actionable applicability (§D7), dispatch, mark. Returns effects handled. */
  drainOnce(): Promise<number>;
}
```

Rules to implement and test (`render.test.ts`, `publisher.test.ts`, fake ports): §8.1 check
precedence merged > closed > hold > exhausted > required request pending > requirement unsatisfied >
blocking findings > draft; `neutral`/`skipped` never; board renders unknown-severity findings
prominently and "fixed, claimed by X @ sha, unconfirmed"; thread ops = closed ⇒ resolve,
contested/re-opened ⇒ unresolve, only for comment-sourced findings; refresh coalescing and
"a delayed worker never publishes an older verdict" (§11 #5, publisher half); actionable
applicability — a summon whose request is no longer pending at the current subject is marked
`obsolete`; a delivery uses `dedupeKey` so at-least-once is self-identifying; `mergeable === false`
keeps summons/deliveries pending (not obsolete). M0 ships with `github: null` and the Slack board
line only. What a port answers is recorded through `store.projections` before the row is marked sent:
the board comment id on its first create (later refreshes PATCH it — §8.1 "one per Review"), the check
run id per head, the Slack thread (the first board line's outbox row, resolved to its `message_ts`
once drained; later lines and deliveries thread under it), and `{delivery_id}` / `{summon_comment_id}`
on the request (§6.D5). A port answering without an id fails the row visibly.

`SystemWakePort` on `BrokerStore`: a `system`-origin `ingestEvent` (`senderKind: "app"`,
`senderId: "hive-review"`, `eventId: "review:" + dedupeKey`) that reuses the ordinary ledger/outbox
(R-3/R-6); `postBoardLine` is `enqueueThreadNotice`. Tests live in `src/broker/store.test.ts`
appended, not rewritten.

## 5. `src/review/github/{webhook,port,classify,reconcile}.ts` — owner: **adapter builder**

```ts
// webhook.ts
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean;   // X-Hub-Signature-256, timing-safe
export function handleWebhook(store: ReviewStore, secret: string, input: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }, clock?: Clock):
  { status: 200 | 401 | 400; outcome: "accepted" | "duplicate" | "hmac_rejected" | "malformed" };   // persists to github_inbox and nothing else (§7)

// port.ts
export interface GitHubPullRequest { repositoryId: number; prNumber: number; owner: string; repo: string; title: string; authorLogin: string; draft: boolean; state: "open" | "closed"; merged: boolean; mergeable: boolean | null; headSha: string; headRef: string; baseRef: string; baseSha: string; mergeBaseSha: string; etag: string | null }
export interface GitHubRecord { kind: "review" | "review_comment" | "issue_comment"; id: number; version: string; authorLogin: string; body: string; path: string | null; line: number | null; commitId: string | null; raw: unknown }
export interface GitHubPort {
  getPullRequest(repositoryId: number, prNumber: number, etag?: string): Promise<GitHubPullRequest | "not_modified">;
  listReviews(repositoryId: number, prNumber: number): Promise<GitHubRecord[]>;
  listReviewComments(repositoryId: number, prNumber: number): Promise<GitHubRecord[]>;
  listIssueComments(repositoryId: number, prNumber: number): Promise<GitHubRecord[]>;
  listFiles(repositoryId: number, prNumber: number): Promise<Array<{ path: string; sha: string; status: string }>>;
  getBlobSha?(repositoryId: number, ref: string, path: string): Promise<string | null>;               // §C6 verbatim_copy
  listFailedDeliveries(since: string): Promise<Array<{ id: number; guid: string }>>;
  redeliver(id: number): Promise<void>;
}
export interface MeterPort { read(policy: NonNullable<Policy["codex_meter"]>): Promise<{ reading: number; threshold: number; resetsAt: string | null } | null> }

// classify.ts — one classification, fixture-driven (V-6 fixtures under test/fixtures/codex/)
// "status" is the connector's in-place-edited progress board (verdict-less, never promoted; fixture-corrected).
export type CodexClassification = "clean" | "findings" | "incomplete" | "quota_refusal" | "connector_error" | "status" | "unknown";
export function classifyCodexRecord(record: GitHubRecord, context: { headSha: string; heads: string[]; repository: string; members: GitHubRecord[] }): {
  classification: CodexClassification;
  external?: ExternalResult;                                                       // clean | findings | incomplete
  availability?: { available: false; reason: "quota" | "connector"; until: string | null; evidence: string };
};
// CODEX_LOGINS lives in reducer.ts (§2); the adapter imports it.

// reconcile.ts
export interface ReconcileSummary { runId: string; key: ReviewKey; observed: boolean; recordsImported: number; admitted: string[]; refused: Array<{ actId: string; code: RefusalCode }>; durationMs: number }
export function reconcile(deps: { store: ReviewStore; github: GitHubPort; clock: Clock; meter?: MeterPort }, key: ReviewKey, runId: string): Promise<ReconcileSummary>;
export class ReconcileScheduler {
  constructor(deps: { store: ReviewStore; github: GitHubPort; clock: Clock; meter?: MeterPort; intervalMs?: number });
  wake(key: ReviewKey): void;                     // serialized per key; coalesces while one is running
  start(): void; stop(): Promise<void>;           // inbox drain + 5-minute bounded sweep over store.active(now-24h) + start-up redelivery ask
}
```

Rules to implement and test (fake port, recorded fixtures): HMAC accept/reject, duplicate delivery
⇒ `duplicate` and one inbox row, malformed ⇒ 400 and nothing persisted; reconcile step order §7
(observe → import records → classify+admit unadmitted Codex records → exemption evidence); adapter
act ids `obs:<run>` and `src:<record_key>:<version>` — never the delivery id; §11 #4 (delayed older
webhook observes the live PR: subject unchanged, no duplicate request); classification of every
fixture class including `unknown` recorded on the source record and never promoted; a quota refusal
becomes `SetReviewerAvailability(false, "quota", until)`. The adapter principal is
`{ kind: "adapter", source: "github", reconcile_run: runId, event_login }`.

## 6. `src/review/http.ts`, `src/review/cli.ts`, `src/review/key.ts`, edge plumbing — owner: **cli builder**

The only builder who edits `src/broker/http.ts`, `src/cli.ts`, `src/edge/*`.

```ts
// http.ts — mounted from BrokerHttpServer.route before its 404: `if (await routeReview(request, response, url, deps)) return;`
export interface ReviewHttpDeps {
  store: ReviewStorePort;                           // the slice of ReviewStore the routes use (apply/read/findByDisplay/putPolicy/operators)
  broker: BrokerStore;                              // assertLease / getDelivery for delivery custody; live registry for session custody
  webhook: WebhookHandler | null;                   // handleWebhook bound to store + secret by runtime.ts; null ⇒ /v1/github/webhook is 404
  adminToken: string;
  reconcile: ((key: ReviewKey) => void) | null;     // scheduler.wake; null while the adapter is disabled ⇒ POST …/reconcile is 503
}
export async function routeReview(request: IncomingMessage, response: ServerResponse, url: URL, deps: ReviewHttpDeps): Promise<boolean>;
```

Routes and custody (§5.A1–A2, one authorization table — custody only *names* the principal; the
reducer decides): 
- `GET /v1/review/:key` — edge bearer (`requireEdge`) or operator bearer; returns `ReviewState`.
- `POST /v1/review/:key/acts` — body `{ act_id, expected_revision, action, custody }` where custody is
  `{ delivery_id, generation }` (fenced with `broker.assertLease(deliveryId, edgeId, generation)`;
  actor = that delivery's actor) or `{ session_token }` (edge-attested live session ⇒ actor; refused
  `unauthorized` when the edge cannot attest — M2 may declare session custody deferred) or an
  operator bearer (`Authorization: Operator <token>` ⇒ `{ kind: "operator", id }` — a distinct scheme so an
  operator token is never read as an edge credential). The body
  never names the actor. Returns the `Receipt` (HTTP 200 applied/replayed, 409 refused).
- `POST /v1/review/:key/reconcile` — edge bearer; `{ kind: "system", caused_by: act_id }` wake to the
  scheduler; 202.
- `POST /v1/github/webhook` — HMAC only; `handleWebhook` (adapter builder's function).
- `PUT /v1/admin/review-policies/:repositoryId` — admin token; `validatePolicy` then `putPolicy`.
- `POST /v1/admin/operators` — admin token; `{ operator_id }` ⇒ `{ token }` once.

```ts
// cli.ts
export function registerReviewCommands(program: Command): void;   // adds the §9.1 verbs under `hive review …`
```

Custody in the CLI: writes present `HIVE_DELIVERY_TOKEN` (the edge resolves it to
`{delivery_id, generation}` exactly as `hive wake` does, via the edge socket) or
`HIVE_SESSION_TOKEN`; `--expect <rev>` is mandatory on every write; operator verbs
(`grant-rounds`, `rule`, `availability`, `adopt-policy`) read the token from the 0600 file named by
`HIVE_OPERATOR_TOKEN_FILE`, refuse when the file mode is wider, and refuse `--as-operator` outright
when `HIVE_DELIVERY_TOKEN` or `HIVE_SESSION_TOKEN` is set (§A2). Argument shapes are built from the
contract types, never re-declared. Edge plumbing: a `POST /review/act` on the edge UDS that turns
the dispatch token into delivery custody and forwards to the broker with the edge bearer
(mirrors `/wake` in `src/edge/control.ts`).

Tests (`http.test.ts`, `cli.test.ts`): a body naming an actor is ignored; a stale lease ⇒ 401 via
`StaleLeaseError`; operator bearer with a wrong token ⇒ 401; `--as-operator` with a seat token in
the environment ⇒ refused before any request; `--expect` missing ⇒ refused; key parsing both forms.

## 7. Ownership table

| Path | Owner | Others |
|---|---|---|
| `src/review/contract.ts`, `contract.generated.ts`, `contract.test.ts`, `contracts/**`, `scripts/gen-contract-types.mjs` | integrator (gnomon) | read only; a needed contract change is a weave-doctrine PR + re-vendor |
| `src/review/reducer.ts`, `reducer.test.ts` | reducer builder | — |
| `src/review/store.ts`, `store.test.ts` | store builder | — |
| `src/review/effects.ts`, `render.ts`, `publisher.ts` + tests; **`src/broker/store.ts`** (append `SystemWakePort` only) | effects builder | nobody else touches `src/broker/store.ts` |
| `src/review/github/**`, `test/fixtures/codex/**` | adapter builder | — |
| `src/review/http.ts`, `cli.ts`, `key.ts` + tests; **`src/broker/http.ts`**, **`src/cli.ts`**, **`src/edge/*`** | cli builder | nobody else touches these |
| `package.json`, `bun.lock`, `tsconfig.json`, `AGENTS.md`, `docs/**` | integrator only | builders request changes in their report |

No builder edits another's files. A cross-cutting need (a signature here is wrong) goes in the
builder's `deviations` output and the integrator amends this map; do not work around it with a shim
(INV-35). Every rule named in §2–§6 above without a test is not implemented.

## 8. Wiring (integrator, landed)

`src/review/runtime.ts` — `bootReviewRuntime({ broker: BrokerStore, clock, adminToken, env, log })` — constructs
`new ReviewStore(broker.db, { decide, fold, read, clock })`, the `ReviewPublisher` over `{ github, slack: broker }`
(`BrokerStore` is the `SystemWakePort`), and, when the GitHub App is configured, the `AppGitHubPort`, the webhook
handler bound to the secret, and the `ReconcileScheduler`; it returns the `ReviewHttpDeps` the `broker` command
hands to `BrokerHttpServer`. The publisher drains on the broker's 5-second housekeeping tick ahead of the outbox
drain (its Slack deliveries land in that outbox); `review.start()` arms the scheduler after Slack is up and
`review.stop()` joins the shutdown.

Env (broker): `HIVE_GITHUB_WEBHOOK_SECRET_FILE`, `HIVE_GITHUB_APP_ID`, `HIVE_GITHUB_APP_KEY_FILE` — secrets are
owner-only (0600) files read by `src/review/secret-file.ts`, never bare values; all three or none. With none set
the broker boots with the adapter disabled and logs it once (webhook 404, reconcile 503, Slack board line only —
M0); a partial set, a named file that does not exist, or a file readable beyond its owner is a boot failure (§7
tier-2 secrets; AGENTS.md "a missing profile is a hard pre-dispatch failure, never a fallback").
CLI (operator only): `HIVE_OPERATOR_TOKEN_FILE`, same reader.

The acceptance runner for §11 is `src/review/acceptance.test.ts`: the real `BrokerStore` database, the real store
with the real reducer, the real publisher over fake GitHub/Slack ports, and `reconcile` over a fake `GitHubPort`;
one test per sequence (#1–#10) plus the M0 slice and the §B1/§B2 fence through the store.
