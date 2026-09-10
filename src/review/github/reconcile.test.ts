import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Action, Policy, Receipt, Review, ReviewKey } from "../contract.js";
import { validateAction } from "../contract.js";
import type { Clock } from "../../time.js";
import { issueCommentRecord, reviewCommentRecord, reviewRecord, type GitHubChangedFile, type GitHubPort, type GitHubPullRequest, type GitHubRecord, type GitHubReaction, type MeterPort } from "./port.js";
import {
  ReconcileScheduler,
  buildObservePR,
  diffSha256,
  exemptionEvidence,
  reconcile,
  type ReconcileStore,
} from "./reconcile.js";
import type { ApplyInput, InboxDelivery, SourceRecordInput, SourceRecordRow } from "../store.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/codex");
const CODEX = "chatgpt-codex-connector[bot]";
const H1 = "9ae793d86be8a73a29717e55cb978ee120e72ad9";
const H2 = "4df54b1c368a31d3f617c2f4c0672479724ccdad";
const BASE = "b".repeat(40);
const KEY: ReviewKey = { repository_id: 1054, pr_number: 66 };

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
}

const POLICY: Policy = {
  version: 1,
  author_aliases: { "gnomon-seat": "gnomon" },
  burn_actor: "talos",
  closure_by_seat: true,
  codex_meter: null,
  exempt_roots: ["docs/notes/"],
  retrospective_actor: "theoros",
  reviewer_set: ["codex", "theoros"],
  routing_by_round: { first: "codex", later: "theoros" },
  slack: null,
  substitute_actor: "theoros",
};

class TickingClock implements Clock {
  private t = Date.parse("2026-09-06T18:00:00.000Z");
  now(): Date {
    this.t += 1000;
    return new Date(this.t);
  }
}

/** Records every apply; folds only what the adapter reads back (subject, subjects, id, revision). */
class FakeStore implements ReconcileStore {
  readonly applies: Array<{ key: ReviewKey; input: ApplyInput }> = [];
  readonly seenActs = new Map<string, string>();
  review: Review | null = null;
  policies = new Map<number, Policy>([[1054, POLICY]]);
  /** When set, refuses every matching action with this code (a test hook for §5.B4 handling). */
  refuse: ((action: Action) => "lifecycle" | null) | null = null;
  readonly records = new Map<string, SourceRecordRow>();
  readonly deliveries: InboxDelivery[] = [];
  readonly reconciled: Array<{ ids: string[]; runId: string }> = [];
  activeKeys: ReviewKey[] = [];
  publishedComments = new Set<number>();
  publishedSummon(commentId: number): boolean { return this.publishedComments.has(commentId); }

  apply(key: ReviewKey, input: ApplyInput): Receipt {
    this.applies.push({ key, input });
    const shape = validateAction(input.action);
    assert.equal(shape.ok, true, shape.ok ? "" : shape.detail);
    const batchId = this.seenActs.get(input.actId);
    if (batchId !== undefined) return { act_id: input.actId, review_id: this.review?.id ?? null, outcome: { replayed: true, revision_at_apply: this.review?.revision ?? 0, batch_id: batchId } };
    const code = this.refuse?.(input.action) ?? null;
    if (code !== null) {
      return { act_id: input.actId, review_id: this.review?.id ?? null, outcome: { refused: true, code, detail: "test refusal", current_revision: this.review?.revision ?? 0, state: null } };
    }
    const before = this.review?.revision ?? 0;
    if (input.action.kind === "ObservePR") this.fold(input.action, input.actId, input.display ?? "?");
    else if (this.review !== null) this.review.revision += 1;
    this.seenActs.set(input.actId, `bat_${input.actId}`);
    return { act_id: input.actId, review_id: this.review?.id ?? null, outcome: { applied: true, revision_before: before, revision_after: this.review?.revision ?? 0, batch_id: `bat_${input.actId}`, effects: [] } };
  }

  private fold(action: Extract<Action, { kind: "ObservePR" }>, actId: string, display: string): void {
    if (this.review === null) {
      this.review = {
        id: `rev_${actId}`,
        key: KEY,
        display,
        revision: 1,
        policy_version: 1,
        subject: action.subject,
        subjects: [action.subject],
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
      return;
    }
    this.review.revision += 1;
    this.review.observed = action.observed;
    this.review.lifecycle = action.lifecycle;
    if (this.review.subject.key !== action.subject.key) {
      this.review.subject = action.subject;
      this.review.subjects.push(action.subject);
    }
  }

  get(key: ReviewKey): Review | null {
    return key.repository_id === KEY.repository_id && key.pr_number === KEY.pr_number ? this.review : null;
  }
  policy(repositoryId: number): Policy | null {
    return this.policies.get(repositoryId) ?? null;
  }
  active(): ReviewKey[] {
    return this.activeKeys;
  }
  readonly inbox = {
    unreconciled: (): InboxDelivery[] => this.deliveries.filter((d) => !this.reconciled.some((r) => r.ids.includes(d.deliveryId))),
    markReconciled: (ids: string[], runId: string): void => {
      this.reconciled.push({ ids, runId });
    },
  };
  readonly sourceRecords = {
    upsert: (record: SourceRecordInput): "new" | "same" | "updated" => {
      const id = `${record.recordKey}@${record.version}`;
      const existing = this.records.get(id);
      if (existing !== undefined) return "same";
      const older = [...this.records.values()].some((r) => r.recordKey === record.recordKey);
      this.records.set(id, { ...record, classification: null, admittedActId: null });
      return older ? "updated" : "new";
    },
    unadmitted: (reviewId: string): SourceRecordRow[] => [...this.records.values()].filter((r) => r.reviewId === reviewId && r.admittedActId === null),
    markAdmitted: (recordKey: string, version: string, actId: string): void => {
      const row = this.records.get(`${recordKey}@${version}`);
      assert.ok(row !== undefined, `markAdmitted on unknown row ${recordKey}@${version}`);
      row.admittedActId = actId;
    },
    setClassification: (recordKey: string, version: string, classification: string): void => {
      const row = this.records.get(`${recordKey}@${version}`);
      assert.ok(row !== undefined, `setClassification on unknown row ${recordKey}@${version}`);
      row.classification = classification;
    },
  };
}

class FakePort implements GitHubPort {
  pr: GitHubPullRequest;
  files: GitHubChangedFile[] = [{ path: "src/review/github/port.ts", sha: "1".repeat(40), status: "modified" }];
  reviews: GitHubRecord[] = [];
  reviewComments: GitHubRecord[] = [];
  issueComments: GitHubRecord[] = [];
  prReactions: GitHubReaction[] = [];
  blobs = new Map<string, string>();
  failed: Array<{ id: number; guid: string }> = [];
  redelivered: number[] = [];
  pullRequestCalls: Array<string | undefined> = [];
  notModified = false;
  gate: Promise<void> | null = null;
  /** When set, the PR fetch rejects with it (a GitHub 5xx, a rate limit). */
  fail: Error | null = null;

  constructor(headSha: string) {
    this.pr = {
      repositoryId: 1054, prNumber: 66, owner: "Skrates", repo: "hive", title: "feat(review): adapter", authorLogin: "gnomon-seat",
      draft: false, state: "open", merged: false, mergeable: true, headSha, headRef: "gnomon/rsm-adapter", baseRef: "main", baseSha: BASE, mergeBaseSha: BASE, etag: 'W/"e1"',
    };
  }
  async getPullRequest(_r: number, _n: number, etag?: string): Promise<GitHubPullRequest | "not_modified"> {
    this.pullRequestCalls.push(etag);
    if (this.gate !== null) await this.gate;
    if (this.fail !== null) throw this.fail;
    return this.notModified && etag !== undefined ? "not_modified" : this.pr;
  }
  async listReviews(): Promise<GitHubRecord[]> { return this.reviews; }
  async listReviewComments(): Promise<GitHubRecord[]> { return this.reviewComments; }
  async listIssueComments(): Promise<GitHubRecord[]> { return this.issueComments; }
  async listIssueReactions(): Promise<GitHubReaction[]> { return this.prReactions; }
  async listFiles(): Promise<GitHubChangedFile[]> { return this.files; }
  async getBlobSha(_r: number, _ref: string, path: string): Promise<string | null> { return this.blobs.get(path) ?? null; }
  async listFailedDeliveries(): Promise<Array<{ id: number; guid: string }>> { return this.failed; }
  async redeliver(id: number): Promise<void> { this.redelivered.push(id); }
}

function setup(headSha = H2) {
  const store = new FakeStore();
  const github = new FakePort(headSha);
  const clock = new TickingClock();
  return { store, github, clock, deps: { store, github, clock } };
}

const cleanComment = issueCommentRecord(fixture("hive-issue_comment-5560110170"));   // clean at 4df54b1c36 (H2)
const summaryComment = issueCommentRecord(fixture("hive-issue_comment-5560706393")); // status board
const workReport = issueCommentRecord(fixture("sokrates-issue_comment-5550157393"));  // ### Summary ⇒ unknown
const quotaComment = issueCommentRecord(fixture("sokrates-issue_comment-5350649768"));
const connectorComment = issueCommentRecord(fixture("sokrates-issue_comment-5301377491"));
const findingsReview = reviewRecord(fixture("hive-review-5125461304"));             // at H1, two members
const members = [reviewCommentRecord(fixture("hive-review_comment-3944094503")), reviewCommentRecord(fixture("hive-review_comment-3944094508"))];

const observations = (store: FakeStore) => store.applies.filter((a) => a.input.action.kind === "ObservePR");
const admissions = (store: FakeStore) => store.applies.filter((a) => a.input.action.kind === "AdmitExternalResult");

test("§7 step 1: the observation is the live PR under obs:<run> with the adapter principal", async () => {
  const { store, github, deps } = setup(H2);
  github.issueComments = [cleanComment];
  const summary = await reconcile(deps, KEY, "run-1");
  assert.equal(summary.observed, true);
  const obs = observations(store)[0];
  assert.ok(obs !== undefined);
  assert.equal(obs.input.actId, "obs:run-1");
  assert.equal(obs.input.expectedRevision, null);
  assert.equal(obs.input.display, "Skrates/hive#66");
  assert.deepEqual(obs.input.principal, { kind: "adapter", source: "github", reconcile_run: "run-1", event_login: "gnomon-seat" });
  assert.equal(obs.input.meter, null);
  const action = obs.input.action;
  assert.equal(action.kind, "ObservePR");
  if (action.kind !== "ObservePR") return;
  assert.equal(action.subject.key, `${H2}:main`);
  assert.equal(action.subject.head_sha, H2);
  assert.equal(action.subject.base_sha_at_first_sight, BASE);
  assert.deepEqual(action.subject.changed_paths, ["src/review/github/port.ts"]);
  assert.deepEqual(action.subject.author, { kind: "seat", actor: "gnomon" }, "policy author_aliases binds the login to a seat");
  assert.equal(action.subject.diff_sha256, diffSha256(github.files));
  assert.equal(action.lifecycle, "open");
  assert.equal(action.observed.mergeable, true);
  assert.equal(action.observed.base_sha_now, BASE);
  assert.equal(summary.durationMs >= 0, true);
});

test("§7 steps 2–3: records are imported by (kind,id)@version and an unadmitted Codex record is admitted once under src:<record_key>:<version>", async () => {
  const { store, github, deps } = setup(H2);
  github.issueComments = [cleanComment, { ...cleanComment, id: 1, authorLogin: "hakon", body: "looks good" }];
  const first = await reconcile(deps, KEY, "run-1");
  assert.equal(first.recordsImported, 2);
  const actId = `src:issue_comment:5560110170:${cleanComment.version}`;
  assert.deepEqual(first.admitted, [actId]);
  const admitted = admissions(store);
  assert.equal(admitted.length, 1);
  const admission = admitted[0];
  assert.ok(admission !== undefined);
  assert.equal(admission.input.actId, actId);
  assert.deepEqual(admission.input.principal, { kind: "adapter", source: "github", reconcile_run: "run-1", event_login: CODEX });
  assert.equal(admission.input.expectedRevision, null);
  const action = admission.input.action;
  assert.equal(action.kind, "AdmitExternalResult");
  if (action.kind !== "AdmitExternalResult") return;
  assert.equal(action.result.verdict, "clean");
  assert.equal(action.result.reviewed_head, H2);
  assert.deepEqual(action.result.source_record, { kind: "issue_comment", id: 5560110170, version: cleanComment.version });
  const row = store.records.get(`issue_comment:5560110170@${cleanComment.version}`);
  assert.equal(row?.classification, "clean");
  assert.equal(row?.admittedActId, actId);
  assert.equal(store.records.get(`issue_comment:1@${cleanComment.version}`)?.admittedActId, null, "a human comment is imported, never classified as Codex");

  const second = await reconcile(deps, KEY, "run-2");
  assert.equal(second.recordsImported, 0);
  assert.deepEqual(second.admitted, []);
  assert.equal(admissions(store).length, 1, "admitted once, never again at the same version");
  assert.equal(observations(store).length, 2, "every run observes");
});

test("§11 #4: a delayed older webhook observes the live PR — subject stays H2, no regression, no duplicate admission", async () => {
  const { store, github, deps } = setup(H1);
  github.reviews = [findingsReview];
  github.reviewComments = members;
  await reconcile(deps, KEY, "run-h1");
  assert.equal(store.review?.subject.head_sha, H1);
  assert.equal(admissions(store).length, 1, "the findings round at H1 is admitted once");

  // The author pushes H2; the H2 delivery is reconciled first.
  github.pr = { ...github.pr, headSha: H2, etag: 'W/"e2"' };
  github.issueComments = [cleanComment];
  await reconcile(deps, KEY, "run-h2");
  assert.equal(store.review?.subject.head_sha, H2);
  assert.deepEqual(store.review?.subjects.map((s) => s.head_sha), [H1, H2]);

  // Now the delayed H1 delivery arrives (webhook payload says H1) and wakes a reconcile.
  const delayed: InboxDelivery = { deliveryId: "late-h1", event: "pull_request", repositoryId: 1054, prNumber: 66, payload: { pull_request: { head: { sha: H1 } } }, receivedAt: "2026-09-06T18:30:00.000Z" };
  store.deliveries.push(delayed);
  const scheduler = new ReconcileScheduler({ ...deps, log: () => undefined });
  scheduler.drainInbox();
  await scheduler.stop();

  const last = observations(store).at(-1)?.input.action;
  assert.ok(last !== undefined && last.kind === "ObservePR");
  assert.equal(last.subject.head_sha, H2, "the reconcile observes the live PR, not the delivery's payload");
  assert.equal(last.subject, store.review?.subject, "an unchanged subject is passed through verbatim (§6.C1)");
  assert.deepEqual(store.review?.subjects.map((s) => s.head_sha), [H1, H2], "no regression to H1");
  assert.equal(admissions(store).length, 2, "one admission per Codex round; the late wake admits nothing new");
  assert.equal(store.reconciled.length, 1);
  assert.deepEqual(store.reconciled[0]?.ids, ["late-h1"]);
  assert.ok(store.applies.every((a) => !a.input.actId.includes("late-h1")), "the delivery id never becomes an act id");
  assert.equal(observations(store).at(-1)?.input.actId, `obs:${store.reconciled[0]?.runId}`);
});

test("§7 step 3: a findings review is one AdmitExternalResult carrying its member comments, which are marked admitted under the envelope's act", async () => {
  const { store, github, deps } = setup(H1);
  github.reviews = [findingsReview];
  github.reviewComments = [...members, { ...members[0]!, id: 77, authorLogin: "hakon", body: "human inline comment", raw: { ...(members[0]!.raw as object), id: 77, user: { login: "hakon" } } }];
  const summary = await reconcile(deps, KEY, "run-1");
  const envelopeAct = `src:review:5125461304:${findingsReview.version}`;
  assert.deepEqual(summary.admitted, [envelopeAct]);
  const admitted = admissions(store);
  assert.equal(admitted.length, 1);
  const action = admitted[0]?.input.action;
  assert.ok(action !== undefined && action.kind === "AdmitExternalResult");
  assert.equal(action.result.verdict, "findings");
  assert.equal(action.result.reviewed_head, H1);
  assert.deepEqual(action.result.findings.map((f) => [f.container_kind, f.container_id, f.locator, f.priority]), [["review_comment", 3944094503, 0, "P1"], ["review_comment", 3944094508, 0, "P2"]]);
  for (const member of members) {
    const row = store.records.get(`review_comment:${member.id}@${member.version}`);
    assert.equal(row?.admittedActId, envelopeAct);
    assert.equal(row?.classification, "member:review:5125461304");
  }
  assert.equal(store.records.get(`review_comment:77@${members[0]!.version}`)?.admittedActId, null);
});

test("§7 step 3: status and unknown records are recorded on the source record and never promoted", async () => {
  const { store, github, deps } = setup(H2);
  github.issueComments = [summaryComment, workReport];
  const summary = await reconcile(deps, KEY, "run-1");
  assert.deepEqual(summary.admitted, []);
  assert.equal(admissions(store).length, 0);
  assert.equal(store.applies.length, 1, "only the observation reached apply");
  assert.equal(store.records.get(`issue_comment:5560706393@${summaryComment.version}`)?.classification, "status");
  assert.equal(store.records.get(`issue_comment:5550157393@${workReport.version}`)?.classification, "unknown");
  for (const row of store.records.values()) assert.equal(row.admittedActId, null);
  await reconcile(deps, KEY, "run-2");
  assert.equal(admissions(store).length, 0, "still never promoted on a later run");
});

test("§6.D3: a quota refusal becomes SetReviewerAvailability(false, quota, until = meter resets_at); a connector error has no until", async () => {
  const { store, github, deps } = setup(H2);
  store.policies.set(1054, { ...POLICY, codex_meter: { pool: "codex", threshold: 0.9, url: "https://meter.example/codex" } });
  const meter: MeterPort = { read: async () => ({ reading: 0.95, threshold: 0.9, resetsAt: "2026-09-07T00:00:00Z" }) };
  github.issueComments = [quotaComment, connectorComment];
  const summary = await reconcile(deps.store === store ? { ...deps, meter } : deps, KEY, "run-1");
  assert.equal(observations(store)[0]?.input.meter?.reading, 0.95, "§6.D2: the meter reading rides on the observation");
  const availability = store.applies.filter((a) => a.input.action.kind === "SetReviewerAvailability").map((a) => a.input.action);
  assert.equal(availability.length, 2);
  const [quota, connector] = availability;
  assert.ok(quota !== undefined && quota.kind === "SetReviewerAvailability" && connector !== undefined && connector.kind === "SetReviewerAvailability");
  assert.equal(quota.reviewer, "codex");
  assert.equal(quota.available, false);
  assert.equal(quota.reason, "quota");
  assert.equal(quota.until, "2026-09-07T00:00:00Z");
  assert.ok(quota.evidence.startsWith("You have reached your Codex usage limits"));
  assert.equal(connector.reason, "connector");
  assert.equal(connector.until, null);
  assert.deepEqual(summary.admitted, [`src:issue_comment:5350649768:${quotaComment.version}`, `src:issue_comment:5301377491:${connectorComment.version}`]);
});

test("a refused admission is reported, not marked admitted; a replayed one is marked", async () => {
  const { store, github, deps } = setup(H2);
  github.issueComments = [cleanComment];
  await reconcile(deps, KEY, "run-0"); // creates the Review
  github.issueComments = [{ ...cleanComment, id: 2, version: "2026-09-06T16:00:00Z", raw: { ...(cleanComment.raw as object), id: 2, updated_at: "2026-09-06T16:00:00Z" } }];
  store.refuse = (action) => (action.kind === "AdmitExternalResult" ? "lifecycle" : null);
  const summary = await reconcile(deps, KEY, "run-1");
  assert.deepEqual(summary.refused, [{ actId: "src:issue_comment:2:2026-09-06T16:00:00Z", code: "lifecycle" }]);
  assert.equal(store.records.get("issue_comment:2@2026-09-06T16:00:00Z")?.admittedActId, null);
  assert.equal(store.records.get("issue_comment:2@2026-09-06T16:00:00Z")?.classification, "clean");
  store.refuse = null;
  store.seenActs.set("src:issue_comment:2:2026-09-06T16:00:00Z", "bat_prior"); // admitted by an earlier process: replay
  const replayed = await reconcile(deps, KEY, "run-2");
  assert.deepEqual(replayed.admitted, ["src:issue_comment:2:2026-09-06T16:00:00Z"]);
  assert.equal(store.records.get("issue_comment:2@2026-09-06T16:00:00Z")?.admittedActId, "src:issue_comment:2:2026-09-06T16:00:00Z");
});

test("an older version of an edited record is superseded, never admitted", async () => {
  const { store, github, deps } = setup(H2);
  github.issueComments = [summaryComment];
  await reconcile(deps, KEY, "run-1");
  const edited = { ...summaryComment, version: "2026-09-06T18:00:00Z", body: cleanComment.body, raw: { ...(summaryComment.raw as object), updated_at: "2026-09-06T18:00:00Z", body: cleanComment.body } };
  github.issueComments = [edited];
  const summary = await reconcile(deps, KEY, "run-2");
  assert.equal(store.records.get(`issue_comment:5560706393@${summaryComment.version}`)?.classification, "superseded");
  assert.equal(store.records.get("issue_comment:5560706393@2026-09-06T18:00:00Z")?.classification, "clean");
  assert.deepEqual(summary.admitted, ["src:issue_comment:5560706393:2026-09-06T18:00:00Z"]);
});

test("§6.C6: exemption evidence is computed when the subject changes, from skill roots, policy exempt_roots, or verbatim template blobs", async () => {
  assert.equal(exemptionEvidence([], POLICY.exempt_roots, null), null, "an empty file list is never exempt");
  assert.equal(exemptionEvidence([{ path: "skills/x/SKILL.md", sha: "1", status: "modified" }, { path: "src/a.ts", sha: "2", status: "modified" }], POLICY.exempt_roots, null), null);
  assert.equal(exemptionEvidence([{ path: ".claude/skills/x/SKILL.md", sha: "1", status: "added" }], POLICY.exempt_roots, null)?.reason, "skill_only");
  assert.equal(exemptionEvidence([{ path: "docs/notes/a.md", sha: "1", status: "added" }], POLICY.exempt_roots, null)?.reason, "exempt_paths");
  const blobs = new Map([[".github/scripts/review_loop.py", "7".repeat(40)]]);
  assert.equal(exemptionEvidence([{ path: ".github/scripts/review_loop.py", sha: "7".repeat(40), status: "modified" }], POLICY.exempt_roots, blobs)?.reason, "verbatim_copy");
  assert.equal(exemptionEvidence([{ path: ".github/scripts/review_loop.py", sha: "8".repeat(40), status: "modified" }], POLICY.exempt_roots, blobs), null, "a drifted blob is not verbatim");
  for (const status of ["removed", "renamed"]) {
    assert.equal(exemptionEvidence([{ path: ".github/scripts/review_loop.py", sha: "7".repeat(40), status }], POLICY.exempt_roots, blobs), null, "the old blob cannot exempt a removal or rename");
  }

  const { store, github, deps } = setup(H1);
  github.files = [{ path: ".github/scripts/review_loop.py", sha: "7".repeat(40), status: "modified" }];
  github.blobs.set(".github/scripts/review_loop.py", "7".repeat(40));
  const first = await reconcile({ ...deps, templates: { repositoryId: 999, ref: "84af72b31f0a9c98a2b3798a7345360cc4a29ca6" } }, KEY, "run-1");
  assert.equal(first.exemption?.reason, "verbatim_copy");
  // §6.C6 "the reconcile run computes it; the Review records the evidence": the observation carries it.
  const opening = observations(store)[0]?.input.action;
  assert.ok(opening !== undefined && opening.kind === "ObservePR");
  assert.deepEqual(opening.exemption, { ...first.exemption, subject_key: `${H1}:main` });
  const unchanged = await reconcile({ ...deps, templates: { repositoryId: 999, ref: "x" } }, KEY, "run-2");
  assert.equal(unchanged.exemption, null, "not recomputed while the subject is unchanged");
  github.pr = { ...github.pr, headSha: H2 };
  github.files = [{ path: "skills/new/SKILL.md", sha: "9".repeat(40), status: "added" }];
  const changed = await reconcile(deps, KEY, "run-3");
  assert.equal(changed.exemption?.reason, "skill_only");
  assert.equal(store.review?.subject.head_sha, H2);
  const moved = observations(store)[2]?.input.action;
  assert.ok(moved !== undefined && moved.kind === "ObservePR");
  assert.deepEqual(moved.exemption, { ...changed.exemption, subject_key: `${H2}:main` });
});

test("conditional GET: the etag cache is offered on the next run and a 304 reuses the cached facts", async () => {
  const { store, github, deps } = setup(H2);
  const etags = new Map();
  await reconcile({ ...deps, etags }, KEY, "run-1");
  github.notModified = true;
  github.pr = { ...github.pr, title: "should not be seen" };
  await reconcile({ ...deps, etags }, KEY, "run-2");
  assert.deepEqual(github.pullRequestCalls, [undefined, 'W/"e1"']);
  const last = observations(store).at(-1)?.input.action;
  assert.ok(last !== undefined && last.kind === "ObservePR");
  assert.equal(last.observed.title, "feat(review): adapter");
});

test("buildObservePR: merged and closed lifecycles, draft, and the human author fallback", () => {
  const pr = new FakePort(H2).pr;
  const now = "2026-09-06T18:00:00.000Z";
  const merged = buildObservePR({ ...pr, merged: true, state: "closed", authorLogin: "someone" }, [], null, POLICY, now, null);
  assert.ok(merged.kind === "ObservePR");
  assert.equal(merged.lifecycle, "merged");
  assert.deepEqual(merged.subject.author, { kind: "human", login: "someone" });
  const closed = buildObservePR({ ...pr, state: "closed", draft: true }, [], null, POLICY, now, null);
  assert.ok(closed.kind === "ObservePR");
  assert.equal(closed.lifecycle, "closed");
  assert.equal(closed.draft, true);
  assert.equal(validateAction(closed).ok, true);
});

test("no policy for the repository is a loud failure, not a silent default", async () => {
  const { store, deps } = setup(H2);
  store.policies.clear();
  await assert.rejects(() => reconcile(deps, KEY, "run-1"), /no review policy for repository 1054/u);
});

test("scheduler: wakes are serialized per key and coalesce while a run is in flight", async () => {
  const { store, github, deps } = setup(H2);
  let release: () => void = () => undefined;
  github.gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new ReconcileScheduler({ ...deps, log: () => undefined });
  scheduler.wake(KEY);
  scheduler.wake(KEY);
  scheduler.wake(KEY);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(github.pullRequestCalls.length, 1, "one run in flight");
  github.gate = null;
  release();
  await scheduler.idle();
  assert.equal(github.pullRequestCalls.length, 2, "the three wakes became one in-flight run plus one coalesced follow-up");
  assert.equal(observations(store).length, 2);
  await scheduler.stop();
});

test("scheduler: drainInbox groups deliveries per Review, skips PR-less deliveries, and marks each with the run that covered it", async () => {
  const { store, deps } = setup(H2);
  store.deliveries.push(
    { deliveryId: "d1", event: "pull_request", repositoryId: 1054, prNumber: 66, payload: {}, receivedAt: "t" },
    { deliveryId: "d2", event: "issue_comment", repositoryId: 1054, prNumber: 66, payload: {}, receivedAt: "t" },
    { deliveryId: "d3", event: "installation_repositories", repositoryId: null, prNumber: null, payload: {}, receivedAt: "t" },
  );
  const scheduler = new ReconcileScheduler({ ...deps, log: () => undefined });
  scheduler.drainInbox();
  await scheduler.stop();
  const skipped = store.reconciled.find((r) => r.ids.includes("d3"));
  assert.ok(skipped?.runId.startsWith("skip:"));
  const covered = store.reconciled.find((r) => r.ids.includes("d1"));
  assert.deepEqual(covered?.ids, ["d1", "d2"]);
  assert.equal(observations(store).length, 1);
  assert.equal(observations(store)[0]?.input.actId, `obs:${covered?.runId}`);
  assert.equal(store.inbox.unreconciled().length, 0);
});

test("scheduler: start asks for failed deliveries in the last 24 h and redelivers each; sweep wakes every active Review", async () => {
  const { store, github, deps } = setup(H2);
  github.failed = [{ id: 41, guid: "g41" }, { id: 42, guid: "g42" }];
  store.activeKeys = [KEY];
  const scheduler = new ReconcileScheduler({ ...deps, log: () => undefined, intervalMs: 60_000 });
  scheduler.start();
  scheduler.housekeeping();
  await scheduler.idle();
  await scheduler.stop();
  assert.deepEqual(github.redelivered, [41, 42]);
  assert.equal(observations(store).length, 1, "the start-up sweep reconciled the active Review");
});

// §7 "Gaps": a failed run has not covered its deliveries. They stay unreconciled so the next drain
// re-drives them; only a run that completed stamps them.
test("scheduler: a run that throws leaves its inbox deliveries unreconciled; the next drain re-drives them and a successful run marks them", async () => {
  const { store, github, deps } = setup(H2);
  store.deliveries.push({ deliveryId: "d1", event: "pull_request", repositoryId: 1054, prNumber: 66, payload: {}, receivedAt: "t" });
  github.fail = new Error("GitHub 503");
  const logs: string[] = [];
  const scheduler = new ReconcileScheduler({ ...deps, log: (line) => logs.push(line) });
  scheduler.drainInbox();
  await scheduler.idle();
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /failed: GitHub 503/u);
  assert.equal(store.reconciled.length, 0, "a failed run stamps nothing");
  assert.deepEqual(store.inbox.unreconciled().map((d) => d.deliveryId), ["d1"], "the delivery is still owed a run");
  assert.equal(observations(store).length, 0, "nothing was observed (no Review exists to be swept later)");

  github.fail = null;
  scheduler.drainInbox();
  await scheduler.idle();
  assert.equal(store.reconciled.length, 1);
  assert.deepEqual(store.reconciled[0]?.ids, ["d1"]);
  assert.equal(observations(store)[0]?.input.actId, `obs:${store.reconciled[0]?.runId}`);
  assert.deepEqual(store.inbox.unreconciled(), []);
  await scheduler.stop();
});


test("scheduler records own publication webhooks as skipped without reconciling", async () => {
  const { store, github, deps } = setup(H2);
  store.deliveries.push({ deliveryId: "own-board", event: "issue_comment", repositoryId: 1054, prNumber: 66,
    payload: { sender: { login: "weave-review[bot]" }, action: "edited" }, receivedAt: "t" });
  store.publishedComments.add(777);
  store.deliveries.push({ deliveryId: "own-user-summon", event: "issue_comment", repositoryId: 1054, prNumber: 66, payload: { sender: { login: "RationallyPrime" }, comment: { id: 777 } }, receivedAt: "t" });
  const scheduler = new ReconcileScheduler({ ...deps, log: () => undefined });
  scheduler.drainInbox();
  await scheduler.idle();
  assert.equal(github.pullRequestCalls.length, 0);
  assert.ok(store.reconciled[0]?.runId.startsWith("skip:own-publication:"));
  store.deliveries.push({ deliveryId: "codex-result", event: "issue_comment", repositoryId: 1054, prNumber: 66,
    payload: { sender: { login: CODEX }, action: "edited" }, receivedAt: "t" });
  scheduler.drainInbox();
  await scheduler.idle();
  assert.equal(github.pullRequestCalls.length, 1, "other senders still trigger reconciliation");
  await scheduler.stop();
});

test("unenrolled traffic cannot starve a later enrolled PR behind the inbox page", async () => {
  const { store, github, deps } = setup(H2);
  const all = store.inbox.unreconciled;
  store.inbox.unreconciled = () => all().slice(0, 100);
  for (let n = 0; n < 100; n += 1) store.deliveries.push({ deliveryId: `unenrolled-${n}`, event: "pull_request",
    repositoryId: 99, prNumber: n + 1, payload: {}, receivedAt: "t" });
  store.deliveries.push({ deliveryId: "enrolled", event: "pull_request", repositoryId: 1054, prNumber: 66, payload: {}, receivedAt: "t" });
  const scheduler = new ReconcileScheduler({ ...deps, log: () => undefined });
  scheduler.drainInbox();
  await scheduler.idle();
  scheduler.drainInbox();
  await scheduler.idle();
  assert.equal(github.pullRequestCalls.length, 1);
  assert.ok(store.reconciled.some(r => r.runId.startsWith("skip:unenrolled:") && r.ids.length === 100));
  assert.equal(store.inbox.unreconciled().length, 0);
  await scheduler.stop();
});
