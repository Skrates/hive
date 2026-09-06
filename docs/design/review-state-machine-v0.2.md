# The review is a state machine — design v0.2

> **A Review records named obligations and the authoritative acts that discharge them. Neither missing
> prose, a newer timestamp, nor a successful delivery constitutes discharge.** — Hákon, 2026-09-06

**Status:** architecture approved by Hákon on 2026-09-06 (v0.1 review). v0.2 applies his rulings. Not
filed; implementation milestones and the acceptance bar are in §10–§11. **Author:** gnomon.

**What changed from v0.1** (each item is a ruling; the section that applies it is named):

1. One contract, authored in Pydantic, distributed as generated JSON Schema; the broker consumes it with
   Ajv and generated TypeScript types; no handwritten zod counterpart. Which constraints the schema
   carries and where the rest executes is stated. (§2)
2. Readiness consults the current subject's **review requirement** and every **pending required
   request**; an old CLEAN never satisfies a newer obligation. (§6.H)
3. Findings are **obligations with immutable ids**; they leave the standing set only by a named
   resolution — a closure answer must address every finding its request names; omission is
   non-answer, never resolution; the issuing reviewer may withdraw one finding. (§6.E–F)
4. **Identity ≠ matching**: fingerprints and title hashes are correlation evidence; links are explicit.
   **Subject ≠ PR lifecycle ≠ metadata**: one `ObservePR` act; closed pauses, reopened resumes, merged
   is terminal; internal identity is GitHub's repository id + PR number, `owner/repo#n` is display. (§3, §6.C)
5. **Webhooks are wake-ups, not commands**: a per-PR reconciliation fetches current facts and imports
   source records by id and version; persist before ack; bounded reconcile for gaps. (§7)
6. **Outbox effects have their own ids; projections refresh from current state**, serialized per target;
   actionable effects check applicability before dispatch. **Replay folds recorded transition batches**
   and never re-admits. (§6.B, §8)
7. Session custody for interactive seats; explicit reassignment on reviewer unavailability with a
   clearing rule; exhaustion as an **episode**; the request owns "answered", Hive owns transport; the
   retrospective is an obligation with an explicit deliverable; **one authorization table**. (§5, §6)
8. Round budget = **charges** recorded once per subject on its first complete accepted answer, kept on
   retraction; the KRA-1289 claim is qualified. (§6.G)
9. Logfire instrumentation from day one; dashboards deferred. (§8.5)
10. Existing Reviews keep their snapshotted policy; adopting a newer one is an explicit act. Finding
    resolutions drive the GitHub thread-resolution projection. (§6.I, §8.3)
11. Cutover: canary with one active controller → disable old automation including stragglers → enroll
    open PRs explicitly → verify → delete; template fan-out stopped first; **the first milestone is a
    vertical slice** before the GitHub adapter. (§10)
12. Facts softened where the evidence was the consumer, not the producer; `neutral` is never published;
    unknown severity stays visible and blocking. (§1, §8.1)

---

## 1. Facts this design rests on

Estate observations are from this Mac on 2026-09-06 with the command that produced them; public API
claims are marked and carry a verification item where the documentation is not settled.

| # | Fact | Source / status |
|---|---|---|
| F-1 | **Creating check runs is a GitHub App capability.** The docs' overview says only Apps can; the endpoint page lists fine-grained PATs with `Checks: write`. Conflicting docs ⇒ **V-0** live probe. The App is recommended regardless (one identity, one implementation). | docs.github.com/rest/checks/runs |
| F-2 | **The Weave owns no GitHub App.** Skrates org installations: `chatgpt-codex-connector`, `claude`, `grok-by-xai`, `linear-code`, `vercel`. | `gh api orgs/Skrates/installations` |
| F-3 | **Every open PR on weave-doctrine and hive is `BLOCKED`** with `required_approving_review_count: 0`, no required checks, no review decision. The ruleset's `update` rule (restrict updates to bypass actors) blocks; the sole bypass actor is the admin role. **Every merge to these mains is an admin bypass today.** `require_extra_approval_for_unattributed_changes` concerns Copilot-authored PRs, not seat commits. | `gh pr list --json mergeStateStatus`; `gh api .../rules/branches/main`; rulesets docs |
| F-4 | **Skrates is on the Free plan**; rulesets and protection are unavailable on its private repos (`Skrates/sokrates` → 403). RationallyPrime's private repos (weave-doctrine, krepis) have rulesets. | `gh api repos/Skrates/sokrates/rulesets`; `gh api orgs/Skrates` |
| F-5 | **The broker is tailnet-only** (`HIVE_BROKER_HOST=100.x`, "never 0.0.0.0"); edges are outbound-only; broker credentials never leave the dev box. | `deploy/machines/broker-devbox/broker.env.example`; ADR-0003 |
| F-6 | **Adopters:** private → weave-doctrine, sokrates, krepis, timaeus-deploy (Actions on the `cx53` runner, a tailnet member); public → hive, morphe, agent-affordances, ai-usage (`ubuntu-latest`, no tailnet). | `gh api repos/<r>`; `review-loop.yml` |
| F-7 | Every Weave box runs a remotely-managed Cloudflare Tunnel; the dev box's is `sokrates-pk`; `cloudflare-tunnel-route` publishes hostname → service in one run. | skill `cloudflare-tunnel-route` |
| F-8 | **What the current helper accepts as Codex's clean signal**: the comment `Codex Review: Didn't find any major issues.` with a `**Reviewed commit:**` footer, or a `## Review verdict` body opening "no blocking findings"/"no findings" naming its head. This is the consumer's contract, not proof of the producer's; OpenAI's docs also describe a 👍 acknowledgement and make auto-review configuration-dependent ⇒ **V-6** captured producer fixtures. | `review_loop.py`; `weave_reviewkit/verdicts.py`; OpenAI Codex GitHub docs |
| F-9 | Codex refuses summons from `github-actions[bot]`; the nudge posts `@codex review` under the connected user's PAT. App-identity summons: **V-1**. | `review-loop.yml` |
| F-10 | The belt today: 7,897-line helper + 15,356-line test file + 14.6 KB workflow, byte-identical in 7 repos, each holding the Slack bot token and four other secrets plus five `REVIEW_*` variables; 12 marker families; 404 tests. | `git ls-tree -l`; `MARKER_INVENTORY` |
| F-11 | reviewkit already types the result (`ReviewReport`, `Finding`, `ReviewResolution`, `FindingResolution`) and ships JSON Schemas. `Finding` requires fingerprint, semantic key, contract basis, evidence and falsifier — fields Codex never supplies. | `weave_reviewkit/models.py`; `skills/code-review/schemas/` |
| F-12 | The broker's custody primitive for a seat act: `hive wake` → edge UDS with `HIVE_DELIVERY_TOKEN` → `POST /v1/wakes` (edge bearer) → `assertLease` → actor resolved from the ledger → idempotent by `mint:<source>:<digest>`. The edge also keeps a **live-session registry** (`/live/register`: actor, provider, session id, profile attestation). | `src/cli.ts`; `src/broker/store.ts`; `src/edge/control.ts`, `attestation.ts` |
| F-13 | Rounds today = distinct heads with a result; bound 7; exhaustion posts a gate and wakes Theoros; holds are head-scoped and self-clear on push. | `review_loop.py` |
| F-14 | **GitHub webhooks may be delivered out of order, and failed deliveries are not automatically redelivered** (redelivery is an API/UI act). | GitHub webhooks docs (Hákon's check) |
| F-15 | **`neutral`, `skipped` and `success` all satisfy a required status check.** | GitHub docs (Hákon's check) |
| F-16 | Rulesets let a required check name its **expected source app**; the app must hold `statuses: write`, have recently posted a check, and the check must already be required. ⇒ **V-3** prove on weave-doctrine. | rulesets docs |

---

## 2. One contract

### 2.1 Authoring and distribution

```text
Pydantic models  (weave_reviewkit.contract — the authoring authority)
   → reviewkit schema export → JSON Schema set  (skills/code-review/schemas/*.schema.json)
   → hive/contracts/: vendored schemas + generated TypeScript types (json-schema-to-typescript)
   → Ajv validation at the broker's admission boundary
   → `hive review` argument schemas and the operator API, generated from the same files
```

- The contract package covers everything the broker admits or emits: `Subject`, `Lifecycle`, `Action`
  (the closed union), `Receipt`, `Policy`, `ReviewState`, `ReviewkitReport`, `ExternalResult`,
  `ReviewResolution`, `Testimony`, `NormalizedResult`.
- hive vendors the exported files with the source SHA recorded in `contracts/SOURCE`; `bun run check`
  regenerates the TypeScript from the vendored schemas and fails on drift. Drift between hive's copy and
  weave-doctrine's export is a ticket and a re-vendor PR, never a tolerant reader.
- **Conformance corpus**: `schemas/conformance/{valid,invalid}/*.json` with the expected refusal code per
  invalid case. Both CIs run it — pydantic in weave-doctrine, Ajv + the reducer in hive. This, not the
  schema file alone, is what makes it one contract.

### 2.2 Which constraint lives where

Ajv proves shape. It does not run a Python validator (Hákon's qualification of E1). So every constraint
is assigned one home, and the Pydantic models keep **no `model_validator` that the exported schema cannot
carry**:

| Constraint class | Examples from today's `models.py` | Home |
|---|---|---|
| Shape: types, enums, patterns, min/max lengths, required, `additionalProperties: false` | 40-hex SHAs, `ifp-sha256:` fingerprints, actor token, `Priority`, `Disposition` | **Schema**, as generated |
| Structural invariants expressible as types | "P3 cannot be must-fix", "low confidence cannot be must-fix", "reviewer-designed ⇔ remedy authority" | **Schema**, by re-authoring the Pydantic types as discriminated unions / `Literal` variants so the generated schema carries them (no handwritten `if/then`) |
| Cross-item invariants | unique finding ids and fingerprints; coverage rows reference known findings | **Reducer** admission rule (`malformed`), tested by the corpus |
| Process rules | initial ⇒ generation 0; closure/appeal ⇒ generation 1, terminal, parent ids present; closure findings carry parent fingerprints; appeal ≤ 1 finding; self-review ban; terminal ⇔ no blockers | **Reducer** — these are rules about the review *process*, which is exactly what `apply` owns; they leave the report model |

Consequence for producers: `reviewkit validate` proves shape locally; process refusals come back in the
broker's receipt, which is the "malformed submission → error, still pending" behaviour by construction.

### 2.3 One normalized interpretation of every answer

Both report arms are evidence. The reducer reads them through one shape and never branches on the arm
again:

```ts
interface NormalizedResult {
  completion: "complete" | "incomplete";
  verdict: "clean" | "findings";                 // derived: any blocking finding ⇒ findings
  findings: AdmittedFinding[];                   // §3.5 — each with provenance
  answers: FindingAnswer[];                      // closure/appeal: one per finding the request named
  reviewer: ActorId | "codex";
  subject_key: string;
  provenance: { arm: "reviewkit" | "external"; record: SourceRef; report_ref: string };
}
type FindingAnswer = { finding_id: string; answer: "fixed" | "standing" | "refuted" | "referred"; evidence: string };
```

`ExternalResult` (the new arm, authored in the contract package; F-11):

```ts
interface ExternalResult {
  schema_version: "1"; source: "codex";
  reviewed_head: Sha; verdict: "clean" | "findings" | "incomplete";
  findings: ExternalFinding[];
  source_record: SourceRef;                      // review id or comment id + version
  submitted_at: string;
}
interface ExternalFinding {
  source_comment_id: number; path: string; line: number | null;
  priority: "P0" | "P1" | "P2" | "P3" | "unknown";   // badge-less ⇒ unknown, admitted, visible, blocking (§6.F5)
  title: string; body: string;
}
```

No fingerprint, falsifier or evidence is invented for Codex. Provenance is the comment.

---

## 3. The shape

### 3.1 Identity

```ts
interface ReviewKey { repository_id: number; pr_number: number }     // GitHub's stable ids; survives renames
type ReviewId = string;                                              // ulid minted at open
displayName(review) = `${owner}/${repo}#${n}`                        // a name, refreshed from observation
```

### 3.2 Principals

```ts
type Principal =
  | { kind: "seat"; actor: ActorId; custody: { delivery_id: number } | { session_id: string } }
  | { kind: "operator"; id: string }
  | { kind: "adapter"; source: "github"; reconcile_run: string; event_login: string }
  | { kind: "system"; caused_by: string };                            // act id of the admitted command
```

Seat custody is either **delivery** (F-12, unchanged) or **session**: the edge's live-session registry
already binds a running interactive session to an actor and its profile attestation; the edge issues that
registration a session token, and `hive review` writes present it instead of a delivery token. The broker
records which custody was used. The same-user boundary caveat documented for delivery tokens applies
unchanged — session custody is not weaker than delivery custody. If M2 (§10) cannot bind a session to one
actor on a shared box, interactive writes on that box are declared deferred, not silently downgraded.

### 3.3 The Review

```ts
interface Review {
  id: ReviewId; key: ReviewKey; display: string;
  revision: number;
  policy_version: number;                         // §6.I

  subject: Subject;                               // current code binding
  subjects: Subject[];                            // history
  lifecycle: "open" | "closed" | "merged";        // §6.C
  draft: boolean;
  observed: { title: string; author_login: string; head_ref: string; base_sha_now: Sha; seen_at: string };

  requests: Request[];                            // obligations (§3.4)
  answers: Answer[];                              // discharges of requests
  findings: AdmittedFinding[];                    // obligations (§3.5)
  holds: Hold[];
  charges: Charge[];                              // budget ledger (§6.G)
  budget: { rounds_max: number; granted: number };
  episodes: ExhaustionEpisode[];
  availability: Record<ActorId | "codex", Availability>;
  exemption: null | { reason: "skill_only" | "exempt_paths" | "verbatim_copy"; evidence: string; subject_key: string };
  projection_handles: { board_comment_id: number | null; check_run_ids: Record<Sha, number> };
}

interface Subject {
  key: string;                                    // `${head_sha}:${base_ref}` — currency
  head_sha: Sha; base_ref: string;
  base_sha_at_first_sight: Sha; merge_base_sha: Sha; diff_sha256: string;
  changed_paths: string[];
  author: { kind: "seat"; actor: ActorId } | { kind: "human"; login: string };
  first_seen_at: string;
}
```

### 3.4 Requests — the obligations

```ts
interface Request {
  id: string;
  kind: "review" | "retrospective";
  mode: "initial" | "closure" | "appeal" | null;  // review only
  assignee: ActorId | "codex";
  subject_key: string;
  required: boolean;                              // counts toward readiness (§6.H)
  names: string[];                                // finding ids this request must answer (closure/appeal)
  status: "pending" | "answered" | "cancelled" | "unanswerable";
  opened_by: Principal; opened_at: string; reason: string;
  supersedes: string | null;                      // reassignment (§6.D4)
  transport: TransportRef[];                      // references only: {delivery_id} | {summon_comment_id}; Hive owns attempts
  answered_by: string | null;                     // answer id
}
interface Answer {
  id: string; request_id: string; subject_key: string;
  principal: Principal; admitted_at: string;
  normalized: NormalizedResult | Testimony;
  status: "standing" | "retracted";
}
interface Testimony { cause: string | null; scars: string[]; deliverable: { comment_id: number } | { report_ref: string } }
```

### 3.5 Findings — the other obligations

```ts
interface AdmittedFinding {
  id: string;                                     // immutable, minted at admission
  review_id: ReviewId; subject_key: string;       // where it was raised
  raised_by: ActorId | "codex"; answer_id: string | null;   // null for unsolicited external evidence
  source: { fingerprint: string; semantic_key: string } | { record_kind: "review_comment" | "issue_comment"; comment_id: number };   // native identity, retained
  priority: "P0" | "P1" | "P2" | "P3" | "unknown";
  reviewer_disposition: "must-fix" | "owner-decision" | "follow-up" | "noise" | null;   // reviewkit only
  title: string; path: string; line: number | null;
  status:
    | { open: true }
    | { open: false; resolution: Resolution }
    | { open: true; contested: { by: string; at: string; prior: Resolution } };
  links: Array<{ other: string; relation: "same_as"; by: Principal; at: string }>;   // explicit correlation
  correlation_hints: string[];                    // fingerprint / normalized-title matches — evidence, no authority
}
interface Resolution {
  kind: "fixed" | "refuted" | "withdrawn" | "product_gate" | "follow_up" | "owner_decision";
  by: Principal; at: string; evidence: string;
  commits: Sha[]; ticket: string | null; resolution_text: string | null;
  confirmed_by: string | null;                    // answer id of the closure that confirmed a fix, if any
}
interface Hold {
  id: string; kind: "human_gate" | "owner_decision" | "exhaustion" | "unanswerable" | "operator" | "stack";
  by: Principal; at: string; reason: string;
  release_on: "explicit" | "subject_change";      // subject_change only where the change invalidates the reason
  blocks: { readiness: true; summons: boolean };
  released: null | { by: Principal; at: string; reason: string };
}
interface Charge { subject_key: string; answer_id: string; at: string }
interface ExhaustionEpisode { id: string; opened_at: string; hold_id: string; closed: null | { at: string; by: Principal } }
type Availability = { available: true } | { available: false; since: string; reason: "quota" | "connector" | "meter"; until: string | null; evidence: string };
```

### 3.6 What `read()` derives

```ts
interface ReviewState extends Review {
  requirement: { subject_key: string; status: "satisfied"; by: string[] /* answer ids */ }
             | { subject_key: string; status: "exempt" }
             | { subject_key: string; status: "unsatisfied"; pending: string[] /* request ids */ };
  blocking_findings: AdmittedFinding[];           // open ∧ blocking (§6.F5)
  advisories: AdmittedFinding[];
  rounds_consumed: number;                        // charges.length
  rounds_remaining: number;
  active_holds: Hold[];
  readiness: { ready: true; subject_key: string } | { ready: false; subject_key: string; reasons: Reason[] };
}
type Reason = "merged" | "closed" | "draft" | { hold: Hold["kind"] } | "exhausted"
            | { requirement_unsatisfied: string[] } | { required_request_pending: string[] }
            | { blocking_findings: string[] } | "incomplete_answer";
```

---

## 4. The action set and the one authorization table

```
apply(review_key, expected_revision | null, act_id, principal, action) -> Receipt
read(review_key) -> ReviewState
```

| Action | Payload | Consequences the reducer derives |
|---|---|---|
| `ObservePR` | `subject, lifecycle, draft, observed` (current facts, fetched) | subject change; lifecycle transition; draft flip; exemption; auto-request; hold releases |
| `AdmitExternalResult` | `ExternalResult` | answers the pending external request at that subject if one existed at admission; else unsolicited evidence; admits findings |
| `SetReviewerAvailability` | `reviewer, available, reason, until, evidence` | reassignment of the pending request (§6.D4) |
| `OpenRequest` | `kind, mode, assignee, subject_key, required, names, reason` | delivery effect |
| `CancelRequest` | `request_id, reason` | — |
| `Answer` | `request_id, subject_key, report \| testimony` | admits findings; answers named findings; charge; exhaustion check |
| `RetractAnswer` | `answer_id, reason` | request re-opened; charge kept |
| `ResolveFinding` | `finding_id, kind, evidence, commits?, ticket?, resolution_text?, same_as?` | thread projection; owner_decision hold |
| `ClassifyFinding` | `finding_id, priority` | — |
| `Hold` / `Release` | `kind, reason, release_on, blocks` / `hold_id, reason` | — |
| `GrantRounds` | `n, reason` | closes the exhaustion episode |
| `AdoptPolicy` | `version` | — |

Thirteen verbs, closed. **Authorization is this table and nothing else** — no caller adds an exception:

| Action (kind) | seat | operator | adapter | system |
|---|---|---|---|---|
| `ObservePR` | – | – | ✓ | ✓ (reconcile) |
| `AdmitExternalResult` | – | – | ✓ (Codex login only) | – |
| `SetReviewerAvailability` | – | ✓ | ✓ | ✓ |
| `OpenRequest` review | ✓ (not for self) | ✓ | – | ✓ |
| `OpenRequest` retrospective | – | ✓ | – | ✓ |
| `CancelRequest` | – | ✓ | – | ✓ |
| `Answer` | ✓ (assignee only) | – | – | – |
| `RetractAnswer` | ✓ (its own) | ✓ | – | – |
| `ResolveFinding` fixed / refuted / product_gate | ✓ (burn or author seat; never the raiser) | ✓ | – | – |
| `ResolveFinding` withdrawn | ✓ (the raiser only) | ✓ | – | – |
| `ResolveFinding` follow_up | ✓ only if `reviewer_disposition = follow-up` | ✓ | – | – |
| `ResolveFinding` owner_decision, same_as | same_as: ✓ (any seat) | ✓ | – | – |
| `ClassifyFinding` | ✓ (raiser) | ✓ | – | – |
| `Hold` human_gate / stack | ✓ | ✓ | – | – |
| `Hold` operator | – | ✓ | – | – |
| `Hold` exhaustion / unanswerable / owner_decision | – | – | – | ✓ |
| `Release` | ✓ (its own holds) | ✓ | – | ✓ (subject_change, unanswerable answered) |
| `GrantRounds`, `AdoptPolicy` | – | ✓ | – | – |

**Receipt:**

```ts
interface Receipt {
  review_id: ReviewId; act_id: string;
  outcome:
    | { applied: true; revision_before: number; revision_after: number; batch_id: string; effects: string[] }
    | { replayed: true; revision_at_apply: number; batch_id: string }
    | { refused: true; code: RefusalCode; detail: string; current_revision: number; state: ReviewState };
}
type RefusalCode = "stale_revision" | "unauthorized" | "lifecycle" | "unknown_subject" | "self_review"
                 | "malformed" | "unanswered_findings" | "not_assignee" | "duplicate_request" | "no_such_target";
```

---

## 5. Custody, admission, replay

- **A1 Seat custody.** A seat act arrives through its edge with delivery custody (F-12) or session custody
  (§3.2). The body never names the actor; the edge names it; the broker fences it. Cold sessions on a box
  whose edge cannot attest them read only, and the CLI says so.
- **A2 Operator custody.** An operator credential (`operators` table) lives in Hákon's own profile, never
  in a seat profile. The CLI refuses `--as-operator` when `HIVE_DELIVERY_TOKEN` or `HIVE_SESSION_TOKEN`
  is present in the environment: the human credential does not run inside an agent's execution
  environment. A later phone surface calls the same operator API.
- **A3 Adapter custody.** Adapter acts are produced only by the broker's own reconciliation runs (§7), each
  named by `reconcile_run`; the GitHub login that authored a source record is provenance, never authority.
- **A4 System acts** are consequences inside the admitted command's transition batch, never separate
  commands.
- **B1 Revisions.** Seat and operator acts must carry `expected_revision == revision`, else
  `stale_revision` with the current state. Adapter acts carry `null`: they are observations reconciled
  against GitHub (§7), and the reconcile run is serialized per Review.
- **B2 Idempotence.** `act_id` is the key. Seat/operator: a client ULID. Adapter: `src:<record_key>:<version>`
  for source-record admissions and `obs:<reconcile_run>` for observations — never the webhook delivery id
  (a notification is not a record is not an act).
- **B3 Transition batch.** `decide(state, command, clock, policy) → Batch | Refusal` is pure.
  `fold(state, batch) → state` is pure. A batch is `{batch_id, revision, command, admitted_at,
  policy_version, consequences[], effects[]}` where `consequences` are the materialized state changes
  (request opened with its id, hold placed with its id, charge added, episode opened…) and `effects` are
  the outbox rows. **Replay = fold over stored batches**; it never calls `decide` again and never re-emits
  effects. A test rebuilds `state_json` from the batches under a different clock and policy and gets the
  same state.
- **B4 Attempts.** A refusal appends to `review_attempts` (visible, non-revising) — the modelled
  "malformed submission → still pending".

---

## 6. The rules `apply` enforces

### C. Observation, subject, lifecycle

- **C1** `ObservePR` is a whole-state observation: the reducer diffs it against the Review and derives
  each consequence independently — a subject change, a lifecycle transition, a draft flip, a metadata
  refresh. An unchanged subject preserves judgments; it never suppresses the other consequences (the v0.1
  no-op defect). When only the observation time changes, the audit batch records the observation
  without refreshing projections or renewing the Review's activity window.
- **C2** Subject change: pending requests at the old subject are cancelled (`subject_changed`); holds with
  `release_on: subject_change` release; the exemption is recomputed; then, unless draft, exempt, closed,
  merged, or a summons-blocking hold is active, the system opens the initial required request per policy
  and routing (§D).
- **C3** Lifecycle: `open → closed` pauses (pending requests stay pending, transport paused, readiness
  false); `closed → open` resumes with history intact and opens the initial request if the Review
  was first observed closed and has never had a review request at this subject; `→ merged` is terminal for new work: every act but
  `read`, `Release`, `ResolveFinding(follow_up)` and `RetractAnswer` (lineage hygiene) is refused
  `lifecycle`.
- **C4** Draft: no auto-request while draft; `draft → ready-for-review` at an unchanged subject opens the
  initial request. Readiness false while draft.
- **C5** The base branch advancing under an unchanged `(head, base_ref)` is not a subject change; a
  retarget is (F-6 ruled). Integration with the current base is the merge boundary's job and is made real
  in §9.
- **C6** Exemption at subject change: all changed paths under skill or declared roots ⇒ `skill_only` /
  `exempt_paths`; file blobs equal to the canonical templates at the recorded source SHA ⇒ `verbatim_copy`
  (the reconcile run computes it; the Review records the evidence). An exemption satisfies the review
  requirement. It does not release a hold.

### D. Requests, routing, availability, transport

- **D1** At most one pending request per `(assignee, subject_key, kind)`; a duplicate is `duplicate_request`.
- **D2** Routing is round-aware by standing ruling (Hákon, 2026-08-16, KRA-1131: Codex holds round one
  only; the substitute holds every later round — first-pass meticulousness, credit economics, and
  cross-model-family review of Claude-authored code). The initial request on a Review's first charged
  subject goes to `codex` unless `availability.codex.available = false` at decision time or the meter
  reading (fetched by the reconcile run and recorded in the batch) is at or above the threshold; every
  request after the first charge goes to the policy's substitute. `Policy.routing_by_round` carries this
  as data so a repo can override it; the reason is recorded on the request.
- **D3** Availability is a recorded condition with a clearing rule, never a bare flag:
  `SetReviewerAvailability(false, reason, until)` is set by the adapter on a quota refusal / connector error
  (`until` = the meter's `resets_at` when known) or by the system on a meter breach; it **clears** on the
  earliest of: any admitted signal from that reviewer, `until` passing (evaluated at the next routing
  decision, recorded as a system consequence), or an operator `SetReviewerAvailability(true)`.
- **D4** Unavailability while a request to that reviewer is pending **reassigns explicitly**: the pending
  request is cancelled (`reviewer_unavailable`) and a new request to the substitute is opened with
  `supersedes` set — one consequence, recorded, once.
- **D5** Transport is Hive's: opening a request queues one effect — a Hive delivery to a seat assignee
  (the broker mints a `system`-origin event; the delivery ledger owns attempts, redelivery and failure) or a
  summon comment for `codex`. The request stores **references** (`delivery_id` / `summon_comment_id`),
  never its own retry ledger.
- **D6** Stall handling is housekeeping over pending requests: after the policy's stall window with no
  answer, one more transport effect is queued (a summon for Codex, a redelivery for a seat), bounded by
  policy; when the bound is spent the request becomes `unanswerable` and the system places
  `Hold(unanswerable, blocks summons)`. `Release` is the operator's, or the system's when an answer
  arrives anyway.
- **D7** A summon effect checks applicability at dispatch: the request must still be pending at the
  current subject, else the effect is marked `obsolete` and not sent.
- **D8** (ruled 2026-09-06: F-12 → (a)) Conflict-aware summons. `ObservePR` carries GitHub's `mergeable`
  (`true | false | null`). While it is `false`, request transport is withheld (the request stays pending,
  attempts paused, the board and check say `conflicting against <base tip>`), and the author seat gets
  **one** notice per subject saying so — a `notice:` effect, dispatched while the summons stay withheld,
  emitted whether or not a request is pending; `null` (not yet computed) never withholds. When `mergeable`
  flips to `true` transport resumes. No round is charged for a head nobody reviewed. This is KRA-1362's
  fork 1(a) plus fork 2(b) — the cheap detection the ticket verified, sited where the summons are.

### E. Answers — explicit completion

- **E1** `Answer` binds `request_id`, the request's `assignee` (must equal the principal's actor),
  `subject_key` (must equal the request's and the report's head/base), and the report. Any mismatch is
  refused (`not_assignee`, `unknown_subject`, `malformed`). Nothing else discharges a request.
- **E2** Validation: schema (Ajv) then the reducer's cross-item and process rules (§2.2). Failure ⇒
  `malformed`, the request stays pending, the attempt is logged; a corrected `Answer` is admitted.
- **E3** A request whose `names` is non-empty (closure/appeal) is answered only by a report whose
  resolutions address **every** named finding (`FindingAnswer` per id: fixed / standing / refuted /
  referred). A report that omits one is refused `unanswered_findings` with the ids. The machine checks
  that the questions were answered; the reviewer decides the answers.
- **E4** An `AdmitExternalResult` answers the pending Codex request at that subject **that existed at
  admission time**; otherwise it is unsolicited evidence: findings are admitted, nothing is answered, and
  no request opened later is answered by it.
- **E5** Answers at one subject accumulate; a later clean answer withdraws nothing (F-7 ruled: union).
- **E6** `completion: incomplete` (or external `incomplete`) does not satisfy the requirement, charges
  nothing, and leaves the request pending with the attempt recorded.
- **E7** `RetractAnswer` re-opens the request it answered and removes the answer from the requirement;
  findings it raised stay admitted (they are records) but are marked `withdrawn` only by an explicit
  `ResolveFinding(withdrawn)`; the charge stays (§G).

### F. Findings — identity, resolution, classification

- **F1** Every admitted finding gets an immutable id and keeps its native source identity (§3.5).
  Fingerprints, semantic keys and normalized titles populate `correlation_hints` — evidence shown to
  reviewers, never authority to move a resolution.
- **F2** `ResolveFinding(same_as: F-old)` links explicitly. If `F-old` is resolved, the link marks it
  **contested** (prior resolution retained as history; the finding is open and blocking again). Two
  observations stay two observations until someone links them.
- **F3** Resolution kinds and what they do: `fixed(commits)` — the burn or author seat's named claim; it
  closes the finding with `confirmed_by: null` visible on the board; when a closure request names the
  finding, the closure answer's `fixed` sets `confirmed_by`, `standing` re-opens it, `refuted` closes it
  as refuted, `referred` opens `Hold(owner_decision)`. `refuted(evidence)` — closes with counterevidence.
  `withdrawn` — the raiser retracts one claim without touching the report. `product_gate(question)` —
  closes the finding's blocking status and opens `Hold(owner_decision, explicit)`; the operator's
  `ResolveFinding(owner_decision, resolution_text)` releases it. `follow_up(ticket)` — allowed to a seat
  only when the raiser's own disposition was `follow-up`; otherwise operator-only (F-9 ruled: scope and
  authority govern deferral, not the ticket string). The ticket id is format-checked; Linear I/O stays out
  of the transaction.
- **F4** A resolution never transfers by matching: a new observation with the same fingerprint or title is
  a new open finding with a hint, until linked (§F2).
- **F5** Blocking ⇔ open ∧ (priority ∈ {P0, P1, P2, unknown}) ∧ (reviewer_disposition ∈ {must-fix,
  owner-decision, null}). P3 is advisory from every source (F-11 ruled). `unknown` is admitted, shown,
  and blocking until `ClassifyFinding` by the raiser or the operator — it never vanishes.

### G. Budget, holds, exhaustion

- **G1** A **charge** is recorded when a subject receives its first complete accepted answer to a review
  request. Same-subject re-answers charge nothing. Retraction keeps the charge. `rounds_consumed =
  charges.length`; a retarget is a new subject and may charge. `GrantRounds` changes the allowance, not
  history.
- **G2** KRA-1289, qualified: a byte-identical *head* (same SHA) never charges twice; a *new* SHA with an
  identical patch is re-reviewed and charged (F-5 ruled). This is a deliberate policy change, not the old
  behaviour preserved.
- **G3** Holds: closed kinds (§3.5). Any active hold ⇒ not ready. `blocks.summons` pauses transport for
  requests. `release_on: subject_change` is permitted only for `human_gate` and `stack`, whose reason a
  new subject can invalidate; `exhaustion`, `owner_decision`, `unanswerable` and `operator` release only
  explicitly (F-8 ruled).
- **G4** Exhaustion is an **episode**: when, after admitting an answer, `blocking_findings ≠ ∅ ∧
  rounds_consumed ≥ rounds_max + granted` and no episode is open, the reducer opens one — one
  `Hold(exhaustion)`, one gate projection, one delivery to the author seat, one retrospective request to
  the policy's retrospective actor (each a distinct effect id). While the episode is open the predicate
  holding again emits nothing. `GrantRounds` closes the episode and releases the hold.
- **G5** The retrospective is a `Request(kind: retrospective)` with `required: false`; its `Answer` is a
  `Testimony` naming its deliverable (the PR comment or report it wrote). It never gates, repairs or
  re-reviews; its transport and stall handling are §D5–D6 like any request.

### H. Readiness

```
ready ⇔ lifecycle = open ∧ ¬draft
      ∧ ∄ active hold
      ∧ requirement(current subject) ∈ { satisfied, exempt }
      ∧ ∄ request with required = true ∧ status = pending at the current subject
      ∧ ∄ blocking finding
```
`requirement.satisfied` ⇔ ∃ standing, complete `Answer` to a review request (`initial` or `closure`) at
the current subject. Unsolicited evidence satisfies nothing. Readiness speaks for the review limb only.

### I. Policy versions

`review_policies` is versioned per repository. A Review records `policy_version` at open and keeps it;
`AdoptPolicy(version)` is an operator act, recorded, and re-derives routing for pending requests. `decide`
reads the policy by the Review's version; the batch records it (§B3).

---

## 7. The GitHub adapter: durable ingress, reconciliation

- **Identity.** One GitHub App, `weave-review`, installed on both orgs (Hákon's act), private key and
  webhook secret as tier-2 secrets on the dev box. Subscribed events: `pull_request`,
  `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `installation_repositories`.
- **Ingress.** `POST /v1/github/webhook` on the broker, reached through the dev box tunnel at one hostname
  and path; HMAC (`X-Hub-Signature-256`) is the authentication. The handler verifies, **persists the
  delivery to `github_inbox` and acknowledges 200 — nothing else**. Everything after is the reconciler.
- **Reconciliation, per Review, serialized.** A wake (inbox row, timer, or CLI `hive review reconcile`)
  runs `reconcile(repository_id, pr_number)`:
  1. fetch the live PR (REST, conditional) → `ObservePR(current facts)`;
  2. import source records — reviews, review comments, issue comments — into `source_records` keyed
     `(kind, id)` with `version = updated_at/submitted_at`, idempotently;
  3. for each Codex record not yet admitted at its version: classify (clean / findings / incomplete /
     quota refusal / connector error / unknown) and admit `AdmitExternalResult` or
     `SetReviewerAvailability`; `unknown` is recorded on the source record and surfaced on the board,
     never promoted;
  4. compute exemption evidence (§C6) when the subject changed.
  A delayed older webhook therefore triggers a reconcile that observes the *current* PR; nothing regresses
  (F-14). The three ids stay distinct: `github_inbox.delivery_id` (notification), `source_records`
  (record), `act_id` (admitted op).
- **Gaps.** Failed deliveries are not auto-redelivered (F-14): a bounded reconcile runs every 5 minutes for
  every Review with a pending request or activity in the last 24 h, and on broker start the App's
  redelivery API is asked for failed deliveries in the last 24 h. This is the adapter's one recovery
  responsibility; it is not the seven-repo sweep.
- **Codex classification** lives here once, with **captured producer fixtures** (V-6): the last 30 Codex
  reviews/comments across adopters, stored under `hive/test/fixtures/codex/`, including the 👍
  acknowledgement, the clean comment, the verdict body, a quota refusal and a connector error. The
  current helper's predicates are the starting point, not the evidence.
- **Summons** are effects (§D5) posted under the App if V-1 proves Codex honours it, else under the
  connected user's PAT held on the dev box; `summon_login` is recorded.

---

## 8. Projections, outbox, observability

### 8.1 Effects and publication

- Every effect row has its own `effect_id`, a `target` (`check:<repo>:<head>`, `board:<review>`,
  `thread:<comment_id>`, `delivery:<actor>:<request>`, `summon:<request>`, `announce:<review>`,
  `notice:<actor>:<subject_key>`) and a kind: **refresh** (check, board, thread) or **actionable**
  (delivery, summon, announce, notice).
- A `notice` is a standing message to an actor about a subject, named by the subject rather than by a
  request. It is **not request transport**: the §D8 pause never withholds it (it is what explains the
  pause), and it goes obsolete only when the Review has left the subject it names. Its payload is
  exactly `actor`, `text`, and `dedupe_key`; the subject is carried by the target.
- A refresh job means "re-render this target from `read()` now"; per-target publication is serialized and
  pending refreshes for the same target coalesce into the newest. A delayed worker can never publish an
  older verdict because it never carries one.
- An actionable job re-checks applicability against the current Review before dispatch (§D7) and marks
  itself `obsolete` otherwise. At-least-once remains; summon comments identify the request,
  `effect_id`, and attempt. Interrupted claims retry after backoff; the 50th failed attempt
  atomically queues a durable failure notice in the Review's Slack thread (or the broker channel
  when the Review has no Slack channel).
- **Check run `weave/review`** at the current head: `success` ⇔ `readiness.ready`; otherwise `failure`
  with the first reason in precedence order: merged > closed > hold > exhausted > required request pending
  > requirement unsatisfied > blocking findings > draft. **`neutral`/`skipped` are never published**
  (F-15). The summary lists blocking findings, pending requests, holds, rounds.
- **Board comment**: one per Review, created once, edited in place through `projection_handles`; it is the
  only comment the belt writes and it carries no marker. It renders open and resolved findings with their
  resolutions (including "fixed, claimed by talos @ sha, unconfirmed"), requests with transport
  references, holds, charges, the exhaustion gate text, and unknown-severity findings prominently.
- **Thread resolution** (ruled): a finding whose source is a GitHub `review_comment` gets its review thread resolved
  when its status becomes closed and un-resolved when it becomes contested or re-opened — GraphQL
  `resolveReviewThread`/`unresolveReviewThread` under the App. The merge skill's "zero open threads" limb
  stays and now agrees with the Review by construction. `issue_comment` findings never emit a
  review-thread operation. Slack thread and opener handles are keyed by channel, so adopting a
  policy with a different channel opens a thread in that channel.
- **Slack**: deliveries to seats (burn digest, clean wake, gate, retrospective) are Hive deliveries minted
  with a `system` origin — a small `ingestEvent` extension, otherwise the ordinary ledger, outbox, R-3/R-6.
  The merge announcement (today's `announce-machine-merge` job) is the `announce` effect of
  `ObservePR(lifecycle: merged)`.

### 8.2 The merge boundary reads the Review, not the check

`merge-pull-requests` readiness limb 2 becomes `hive review read` and a comparison of `readiness.subject_key`
with the live head and base ref; the green check is corroboration, never authorization. Limb "green
required checks" is made to cover integration with the current base (C5): where a ruleset exists the
required check uses the strict (up-to-date branch) policy; everywhere the skill requires
`mergeStateStatus = CLEAN` (which encodes `BEHIND`) before `--match-head-commit`.

### 8.3 Observability from day one

The broker gains a Logfire token (tier-2, dev box) and exports spans through the existing project
(`sokrates`, service `review`): `review.ingress` (accepted / hmac_rejected / malformed), `review.reconcile`
(records imported, admissions, duration, GitHub rate state), `review.admit` (code, refusal reason),
`review.publish` (target, outcome, GitHub status), `review.housekeeping` (stalls, reassignments,
unanswerable), `review.outbox` (stuck rows, retries). Dashboards and the baseline's SQL rewrite are
deferred; visibility of the machinery is not.

---

## 9. Affordances, policy, store

### 9.1 `hive review`

```
hive review read      <owner/repo>#<n> [--json]
hive review reconcile <owner/repo>#<n>                                   # adapter wake, any seat
hive review answer    <owner/repo>#<n> --request <id> --report <file> --expect <rev>
hive review resolve   <owner/repo>#<n> <finding-id> fixed|refuted|withdrawn|product-gate|follow-up|same-as
                      --evidence <text> [--commit <sha>]… [--ticket KRA-n] [--other <finding-id>] --expect <rev>
hive review classify  <owner/repo>#<n> <finding-id> P0|P1|P2|P3 --expect <rev>
hive review request   <owner/repo>#<n> --assignee <actor> --mode closure --names F1,F2 --reason <t> --expect <rev>
hive review hold      <owner/repo>#<n> --kind human-gate|stack --reason <t> [--release-on subject-change] --expect <rev>
hive review release   <owner/repo>#<n> <hold-id> --reason <t> --expect <rev>
hive review retract   <owner/repo>#<n> <answer-id> --reason <t> --expect <rev>
# operator credential only (never inside an agent environment)
hive review grant-rounds <owner/repo>#<n> <k> --reason <t>
hive review rule         <owner/repo>#<n> <finding-id> --resolution <t>           # owner_decision
hive review availability <owner/repo>#<n> <reviewer> --available|--unavailable --reason <t>
hive review adopt-policy <owner/repo>#<n> <version>
```
Writes need delivery or session custody and `--expect`; reads need the edge socket. Argument schemas are
generated from the contract (§2.1).

### 9.2 Policy (versioned rows; replaces the `REVIEW_*` variables and constants)

```ts
interface Policy {
  version: number;
  rounds_max: 7;
  reviewer_set: ActorId[]; substitute_actor: ActorId; burn_actor: ActorId; retrospective_actor: ActorId;
  closure_by_seat: boolean;                        // open a named closure request to a seat after a burn (true where a seat reviewer exists)
  routing_by_round: { first: "codex" | ActorId; later: ActorId };   // default {first: "codex", later: substitute_actor} — KRA-1131
  exempt_roots: string[]; author_aliases: Record<string, ActorId>;
  stall_window_s: 1200; transport_bound: 2;
  codex_meter: { url; pool; threshold } | null;
}
```

### 9.3 Store (the broker's SQLite)

```sql
CREATE TABLE reviews (review_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL, pr_number INTEGER NOT NULL,
  display TEXT NOT NULL, revision INTEGER NOT NULL, policy_version INTEGER NOT NULL,
  state_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repository_id, pr_number));
CREATE TABLE review_batches (review_id TEXT NOT NULL, revision INTEGER NOT NULL, batch_id TEXT NOT NULL UNIQUE,
  act_id TEXT NOT NULL UNIQUE, command_json TEXT NOT NULL, consequences_json TEXT NOT NULL,
  policy_version INTEGER NOT NULL, admitted_at TEXT NOT NULL, PRIMARY KEY(review_id, revision));
CREATE TABLE review_attempts (attempt_id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT, act_id TEXT NOT NULL,
  command_json TEXT NOT NULL, refusal_json TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE review_effects (effect_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, revision INTEGER NOT NULL,
  kind TEXT NOT NULL, target TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, sent_at TEXT, obsolete_at TEXT);
CREATE INDEX review_effects_target_idx ON review_effects(target, status, effect_id);
CREATE TABLE github_inbox (delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, repository_id INTEGER, pr_number INTEGER,
  payload_json TEXT NOT NULL, received_at TEXT NOT NULL, reconciled_run TEXT);
CREATE TABLE source_records (record_key TEXT NOT NULL, version TEXT NOT NULL, review_id TEXT NOT NULL,
  author_login TEXT NOT NULL, body_json TEXT NOT NULL, classification TEXT, admitted_act_id TEXT,
  PRIMARY KEY(record_key, version));
CREATE TABLE review_policies (repository_id INTEGER NOT NULL, version INTEGER NOT NULL, policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(repository_id, version));
CREATE TABLE operators (operator_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
```
`state_json` is a cache; `review_batches` is the truth; the replay test proves it.

---

## 10. Retirement, cutover, milestones

### 10.1 What it retires (unchanged from v0.1 in substance; corrected where ruled)

All 12 marker families and the inventory; the helper, its tests, the workflow template and their
template-sync rows; the backfill tool (baseline frozen as a report); reviewkit's marker readers in
`lineage.py` and the vendored verdict-predicate region; the `announce-machine-merge` / `belt-terminal*`
jobs (folded into effects and the batch log; the daily cross-repo `merge-digest` stays); per-adopter
secrets `HIVE_BOT_TOKEN`, `CODEX_REVIEW_PAT`, belt `LOGFIRE_TOKEN`, `AI_USAGE_READ_TOKEN` and the five
`REVIEW_*` variables; the marker steps in `merge-pull-requests`, `code-review/weave-integration.md`,
`talos-burn`; `adopt-review-loop` (replaced by a short "adopt review" procedure); universe/40's review
section. **Tickets, reconciled against Linear on 2026-09-06** (bodies read through the connector):

| Ticket | Status in Linear | Fate under this design |
|---|---|---|
| KRA-1325 concurrency slot drops verdict routing | Done (wd#172) | retired by construction: no concurrency groups; reconcile is serialized per Review (§7) |
| KRA-1368 sweep contradicts a landed verdict | Done (wd#201) | retired: B1/E4 and refresh-from-current-state publication (§8.1) |
| KRA-1379 corrected verdict after malformed | Done (wd#216) | retired: E2 attempts |
| KRA-1363 marker inventory | Done (wd#195) | dies with the helper |
| KRA-1380 template-sync matrix dup | Done (wd#217) | unaffected |
| KRA-1323 lane token (publisher ≠ reviewer); KRA-1337 is its duplicate | Backlog, needs-grill | retired: there is no publisher — the reviewer is the principal (A1) and `Answer.principal` is the record; close 1337 as duplicate |
| KRA-1361 substitute actor cannot post a verdict | Backlog | retired: seats answer through their edge, no GitHub login needed |
| KRA-1121 helper drift | In Progress (folded into wd#167) | retired: no vendored helper exists |
| KRA-1127 verbatim-sync PRs never CLEAN | Backlog | retired: C6 `verbatim_copy` exemption (still needed for the non-belt template files) |
| KRA-1362 conflict-aware loop | Backlog, needs-grill (two forks) | folded as D8 / fork F-12; the checks limb stays with the merge boundary (§8.2) |
| KRA-1389 exhaustion gate re-fires per head | open | retired: exhaustion episodes (G4) |
| KRA-1340 / KRA-1326 held head auto-summoned | open | retired: holds block summons (G3, D5) |
| KRA-1353 ticket-only burn re-woken forever | open | retired: `follow_up` resolution + request answered (F3, D1) |
| KRA-1124 two CLEAN classifiers disagree | open | retired: one classification in the adapter (§7) |
| KRA-1122 exhaustion-gate staleness under a changed bound | open | retired: policy versions (§6.I) and episodes |
| KRA-1105 stale findings union overrides a later clean | open | becomes explicit: a finding a later clean does not mention stays open until resolved (F-7 ruled) |
| KRA-1226 verdict on a merged PR wakes the seat | Done | retired: lifecycle (C3) |
| KRA-1131 round-aware find-half policy (Hákon's 2026-08-16 ruling) | open | encoded as the D2 default and `Policy.routing_by_round`; close when M2 lands |
| **KRA-1289 byte-identical head spends no round; folds 1121** | **In Progress — Theoros, wd#167 open** | **conflicts with F-5**: wd#167 builds verdict inheritance by patch equality into the helper; this design re-reviews and charges (G2). Needs your word: hold or close wd#167 as superseded |

### 10.2 Cutover (ruled sequence; one active controller per repo at every moment)

0. **Stop the fan-out first**: remove the three belt files from weave-doctrine's managed-helper table
   (KRA-1378) so template-sync can never recreate them.
1. **Prove the new path on the canary** (`Skrates/hive`, its own PRs) with the old workflow already
   disabled there.
2. Per adopter, in order hive → weave-doctrine → sokrates → the four: **disable old automation
   completely** — `gh workflow disable review-loop.yml`, cancel queued and in-progress runs, delete
   `HIVE_BOT_TOKEN` and `CODEX_REVIEW_PAT` from the repo so a straggler cannot post — before the App is
   installed on that repo.
3. **Enroll open PRs explicitly**: a bounded reconcile over the repo's open PRs creates each Review at its
   current subject with a fresh initial requirement. No legacy approval is inferred. Standing human holds
   or granted rounds that must survive are **re-entered by the operator** with `hive review hold` /
   `grant-rounds` — deliberate acts, not an importer.
4. **Verify**: board comments and check runs present on every open PR; one live summon round-trip.
5. **Ruleset** (where the plan allows): add required check `weave/review` pinned to the App with the
   strict policy; keep the PR-required, deletion and non-fast-forward rules; **remove the blanket `update`
   restriction only after step 4 is proven**; admin bypass stays an intentional override.
6. **Delete** the belt files and remaining variables in one PR reviewed by the new belt; record adoption.

### 10.3 Milestones (vertical slice first, as ruled)

| M | Content | Proves |
|---|---|---|
| **M0** | Contract package + schema export + conformance corpus; hive: vendored contracts, `decide`/`fold`, store, `apply`/`read` over HTTP with edge custody; `hive review answer/resolve/read` through the edge; **one visible projection: the Slack board line via the existing outbox** | authenticated submission → transition → durable state → read → visible projection, with the acceptance sequences (§11) green |
| **M1** | GitHub App, tunnel route (V-2), inbox + reconcile, Codex fixtures (V-6) and classification, check run (V-0/V-3), board comment, thread resolution, announce | the adapter and refresh publication |
| **M2** | Housekeeping: stalls, availability/reassignment, exhaustion episodes, retrospective request, session custody (or its deferral), operator CLI, Logfire spans | the process end to end |
| **M3** | Cutover per §10.2; skills rewrite; deletions | the belt is the Review |

---

## 11. Acceptance — Hákon's sequences, run through the core's own runner (`bun test`)

| # | Sequence | Required result |
|---|---|---|
| 1 | CLEAN answer → required re-review opened → malformed `Answer` → corrected `Answer` | `ready = false` with `required_request_pending` until the corrected answer is admitted; then true |
| 2 | Finding F raised at H1 → unrelated push H2 → complete answer at H2 that does not mention F | F is still open and blocking; readiness false with `blocking_findings: [F]` |
| 3 | Draft → ready-for-review at unchanged head; open → closed → reopened | initial request opened on the draft flip; requests and findings intact across close/reopen; readiness false while closed |
| 4 | Observe H2 → delayed webhook for H1 arrives | reconcile observes the live PR; subject stays H2; no regression, no duplicate request |
| 5 | Ready refresh queued → `Hold` → delayed worker runs the earlier job | the check publishes `failure(hold)`; the earlier job coalesced or re-rendered from current state |
| 6 | Exhaustion predicate becomes true → another answer at the same subject | exactly one episode, one hold, one gate, one author delivery and one retrospective request, each with a distinct effect id |
| 7 | Replay all batches under a different clock and the current policy | identical `state_json`; zero effects emitted |
| 8 | Unsolicited Codex re-sample at H → request opened later at H | findings admitted; the later request stays pending |
| 9 | `fixed` claim on F → new subject → Codex raises F′ → `same_as F` | F contested and open; F′ linked; board shows the prior claim |
| 10 | Codex request pending → quota refusal → later Codex signal | one reassignment to the substitute with `supersedes`; availability clears on the later signal |

### Verification items (facts to establish, not forks)

- **V-0** live probe: can a fine-grained PAT create a check run today? (Decides nothing; records the truth.)
- **V-1 — verified 2026-09-06: no.** App summon [5561560923](https://github.com/Skrates/hive/pull/68#issuecomment-5561560923) received the connector's connect-account refusal. Codex summons therefore use the connected user token from `HIVE_GITHUB_SUMMON_TOKEN_FILE`; the returned `summon_login` is recorded with the comment id. App credentials continue to own all projections.
- **V-2** can the dev box tunnel reach the host-network broker (ingress → tailnet IP or a host `cloudflared`)?
- **V-3** required check pinned to the App on weave-doctrine's ruleset, strict policy, proven with a real PR.
- **V-4** what fraction of historical Codex findings are badge-less (the adapter keeps them as `unknown`).
- **V-5** does the connector still auto-review on push for App-installed repos, or must the first request summon?
- **V-6** captured producer fixtures: the last 30 Codex outputs across adopters, including the 👍 form.

### Rulings recorded (the eleven forks and the two additions)

F-1 App at the broker boundary with durable ingress and reconciliation · F-2 Pydantic canonical, generated
schema distributed, non-schema validation assigned (§2.2) · F-3 operator API/CLI now, credential outside
agent environments, phone later on the same API · F-4 pinned required check; PR-required and other
restrictions kept; `update` removed only after proof; bypass = override · F-5 re-review the identical patch;
deterministic derivation admissible later on equal declared inputs · F-6 base advance is not a subject
change; the merge boundary must cover integration (§8.2) · F-7 union; explicit withdrawal or resolution
only · F-8 explicit release default; subject-change release only where invalidated · F-9 format-checked
ticket; scope and authority govern `follow_up` · F-10 hive → weave-doctrine → sokrates → rest, with the
§10.2 mechanism · F-11 P3 advisory from every source, provenance kept · Policy: Reviews keep their version;
`AdoptPolicy` is explicit · Threads: resolutions drive the thread-resolution projection.

**Ruled 2026-09-06 (evening, from the F-12/wd#167 docket):** F-12 → (a): transport withheld while
`mergeable = false`, one author delivery per subject, no charge, transport resumes on the flip; `null` never
withholds (D8). The author notice must leave while the conflict stands — it is not request transport and the
publisher must not pause it (hive#68 follow-up). wd#167 was closed by Hákon at 14:39; KRA-1289, KRA-1121 and
KRA-1362 are cancelled as superseded (§6.G2, §10.1, D8); the identical-patch re-exhaustion concern is carried
as a cutover verification line (§10.2 step 4), not a ticket.

### Formerly open (ruled 2026-09-06, recorded above)

- **F-12 Conflict-aware summons (D8, from KRA-1362)** — ruled (a). (b) summon and charge, and (c) summon
  without charging, were declined; (c) would have created a second uncharged-head class beside G2.
- **wd#167 (KRA-1289 + KRA-1121)** — closed by Hákon; tickets cancelled as superseded.
