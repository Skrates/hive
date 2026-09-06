/**
 * Reconciliation (design §7 "Reconciliation, per Review, serialized" and "Gaps").
 *
 * A wake — an inbox row, the 5-minute sweep, or `hive review reconcile` — runs
 * `reconcile(key)`, which always observes the *live* PR and imports the *live* records:
 *   1. fetch the PR (conditional GET) → `ObservePR(current facts)` under act id `obs:<run>`;
 *   2. import reviews, review comments and issue comments into `source_records` keyed
 *      `(kind, id)` with `version = updated_at / submitted_at`, idempotently;
 *   3. for every Codex record not yet admitted at its version: classify once and admit
 *      `AdmitExternalResult` (clean / findings) or `SetReviewerAvailability` (quota refusal /
 *      connector error) under act id `src:<record_key>:<version>`; `status` and `unknown`
 *      are recorded on the source record and never promoted;
 *   4. compute exemption evidence (§6.C6) when the subject changed.
 *
 * A delayed older webhook therefore observes the current PR and nothing regresses (F-14,
 * §11 #4). The three ids stay distinct: the delivery id never becomes an act id.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Action, Policy, Principal, Receipt, RefusalCode, Review, ReviewKey, Subject } from "../contract.js";
import type { Clock } from "../../time.js";
import { CODEX_LOGINS, classifyCodexRecord } from "./classify.js";
import type { GitHubChangedFile, GitHubPort, GitHubPullRequest, GitHubRecord, MeterPort } from "./port.js";
import type { InboxDelivery } from "./webhook.js";

// ---------------------------------------------------------------------------------------
// The store slice (module map §3), declared here because `store.ts` is another builder's
// file; `ReviewStore` satisfies it structurally.
// ---------------------------------------------------------------------------------------

export interface ApplyInput {
  actId: string;
  principal: Principal;
  expectedRevision: number | null;
  action: Action;
  display?: string;
  meter?: { reading: number; threshold: number } | null;
}

export interface SourceRecordInput { recordKey: string; version: string; reviewId: string; authorLogin: string; body: unknown }
export interface SourceRecordRow extends SourceRecordInput { classification: string | null; admittedActId: string | null }

export interface ReconcileStore {
  apply(key: ReviewKey, input: ApplyInput): Receipt;
  get(key: ReviewKey): Review | null;
  policy(repositoryId: number, version: number | "latest"): Policy | null;
  active(since: string): ReviewKey[];
  readonly inbox: {
    unreconciled(limit?: number): InboxDelivery[];
    markReconciled(deliveryIds: string[], runId: string): void;
  };
  readonly sourceRecords: {
    upsert(record: SourceRecordInput): "new" | "same" | "updated";
    unadmitted(reviewId: string): SourceRecordRow[];
    markAdmitted(recordKey: string, version: string, actId: string): void;
    setClassification(recordKey: string, version: string, classification: string): void;
  };
}

/** Roots the current helper treats as skill documents (`review_loop.py::SKILL_PATH_PREFIXES`). */
export const SKILL_ROOTS: readonly string[] = ["skills/", ".agents/skills/", ".claude/skills/"];

export interface ExemptionEvidence { reason: "skill_only" | "exempt_paths" | "verbatim_copy"; evidence: string }

export interface ReconcileDeps {
  store: ReconcileStore;
  github: GitHubPort;
  clock: Clock;
  meter?: MeterPort;
  /** Conditional GET cache: display key → last etag and the facts it stood for. */
  etags?: Map<string, { etag: string; pr: GitHubPullRequest }>;
  /** §6.C6 `verbatim_copy`: where the canonical templates live (repository id + ref). Absent ⇒ never verbatim. */
  templates?: { repositoryId: number; ref: string };
}

export interface ReconcileSummary {
  runId: string;
  key: ReviewKey;
  observed: boolean;
  recordsImported: number;
  admitted: string[];
  refused: Array<{ actId: string; code: RefusalCode }>;
  /** §7 step 4; computed when the subject changed, null otherwise or when no root covers every path. */
  exemption: ExemptionEvidence | null;
  durationMs: number;
}

export function recordKey(record: Pick<GitHubRecord, "kind" | "id">): string {
  return `${record.kind}:${record.id}`;
}

export function displayOf(pr: Pick<GitHubPullRequest, "owner" | "repo" | "prNumber">): string {
  return `${pr.owner}/${pr.repo}#${pr.prNumber}`;
}

function adapterPrincipal(runId: string, eventLogin: string): Principal {
  return { kind: "adapter", source: "github", reconcile_run: runId, event_login: eventLogin === "" ? "unknown" : eventLogin };
}

/** The subject's content digest: blob shas of the changed files, deterministic for a head. */
export function diffSha256(files: GitHubChangedFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.status}\t${file.path}\t${file.sha}\n`);
  }
  return hash.digest("hex");
}

/**
 * §3.3 `Subject` from the live PR. An unchanged `(head_sha, base_ref)` keeps the recorded
 * subject verbatim (§6.C1: an unchanged subject preserves judgments; §6.C5: the base
 * advancing is not a subject change); a new key records first-sight facts now.
 */
export function buildSubject(pr: GitHubPullRequest, files: GitHubChangedFile[], existing: Review | null, policy: Policy, now: string): Subject {
  const key = `${pr.headSha}:${pr.baseRef}`;
  if (existing !== null && existing.subject.key === key) return existing.subject;
  const seat = policy.author_aliases[pr.authorLogin];
  return {
    key,
    head_sha: pr.headSha,
    base_ref: pr.baseRef,
    base_sha_at_first_sight: pr.baseSha,
    merge_base_sha: pr.mergeBaseSha,
    diff_sha256: diffSha256(files),
    changed_paths: files.map((file) => file.path),
    author: seat === undefined ? { kind: "human", login: pr.authorLogin } : { kind: "seat", actor: seat },
    first_seen_at: now,
  };
}

/** §4 `ObservePR`: the whole-state observation the reducer diffs (§6.C1). */
export function buildObservePR(pr: GitHubPullRequest, files: GitHubChangedFile[], existing: Review | null, policy: Policy, now: string): Action {
  return {
    kind: "ObservePR",
    subject: buildSubject(pr, files, existing, policy, now),
    lifecycle: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
    draft: pr.draft,
    observed: {
      title: pr.title,
      author_login: pr.authorLogin,
      head_ref: pr.headRef,
      base_sha_now: pr.baseSha,
      mergeable: pr.mergeable,
      seen_at: now,
    },
  };
}

function underRoots(paths: string[], roots: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => roots.some((root) => path.startsWith(root)));
}

/**
 * §6.C6: every changed path under a skill root ⇒ `skill_only`; under a declared exempt root
 * ⇒ `exempt_paths`; every changed blob equal to the canonical template blob ⇒
 * `verbatim_copy`. An empty file list is never exempt (exemption is never inferred from
 * nothing). Precedence follows the design's listing order.
 */
export function exemptionEvidence(
  files: GitHubChangedFile[],
  exemptRoots: readonly string[],
  templateBlobs: ReadonlyMap<string, string | null> | null,
): ExemptionEvidence | null {
  const paths = files.map((file) => file.path);
  if (underRoots(paths, SKILL_ROOTS)) return { reason: "skill_only", evidence: `every changed path under ${SKILL_ROOTS.join(", ")}: ${paths.join(", ")}` };
  if (underRoots(paths, exemptRoots)) return { reason: "exempt_paths", evidence: `every changed path under policy exempt_roots ${exemptRoots.join(", ")}: ${paths.join(", ")}` };
  if (templateBlobs !== null && files.length > 0 && files.every((file) => templateBlobs.get(file.path) === file.sha)) {
    return { reason: "verbatim_copy", evidence: `every changed blob equals the canonical template blob: ${files.map((f) => `${f.path}@${f.sha}`).join(", ")}` };
  }
  return null;
}

function isCodex(login: string): boolean {
  return CODEX_LOGINS.has(login);
}

function reviewIdOf(record: GitHubRecord): number | null {
  const raw = record.raw;
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as { pull_request_review_id?: unknown }).pull_request_review_id;
  return typeof value === "number" ? value : null;
}

export async function reconcile(deps: ReconcileDeps, key: ReviewKey, runId: string): Promise<ReconcileSummary> {
  const startedAt = deps.clock.now().getTime();
  const summary: ReconcileSummary = { runId, key, observed: false, recordsImported: 0, admitted: [], refused: [], exemption: null, durationMs: 0 };
  const finish = (): ReconcileSummary => {
    summary.durationMs = deps.clock.now().getTime() - startedAt;
    return summary;
  };

  const existing = deps.store.get(key);
  const policy = existing === null ? deps.store.policy(key.repository_id, "latest") : deps.store.policy(key.repository_id, existing.policy_version);
  if (policy === null) throw new Error(`no review policy for repository ${key.repository_id}; adopt one before reconciling`);

  // 1. observe the live PR
  const cacheKey = `${key.repository_id}:${key.pr_number}`;
  const cached = deps.etags?.get(cacheKey);
  const fetched = await deps.github.getPullRequest(key.repository_id, key.pr_number, cached?.etag);
  let pr: GitHubPullRequest;
  if (fetched === "not_modified") {
    if (cached === undefined) throw new Error(`GitHub answered 304 for ${cacheKey} without a cached etag`);
    pr = cached.pr;
  } else {
    pr = fetched;
    if (pr.etag !== null) deps.etags?.set(cacheKey, { etag: pr.etag, pr });
  }
  const files = await deps.github.listFiles(key.repository_id, key.pr_number);
  const meterReading = policy.codex_meter !== null && deps.meter !== undefined ? await deps.meter.read(policy.codex_meter) : null;
  const now = deps.clock.now().toISOString();
  const observe = buildObservePR(pr, files, existing, policy, now);
  const subjectChanged = existing === null || (observe.kind === "ObservePR" && existing.subject.key !== observe.subject.key);
  const observation = deps.store.apply(key, {
    actId: `obs:${runId}`,
    principal: adapterPrincipal(runId, pr.authorLogin),
    expectedRevision: null,
    action: observe,
    display: displayOf(pr),
    meter: meterReading === null ? null : { reading: meterReading.reading, threshold: meterReading.threshold },
  });
  if ("refused" in observation.outcome) {
    summary.refused.push({ actId: observation.act_id, code: observation.outcome.code });
  } else {
    summary.observed = true;
  }
  const review = deps.store.get(key);
  if (review === null) return finish();

  // 2. import source records
  const [reviews, reviewComments, issueComments] = await Promise.all([
    deps.github.listReviews(key.repository_id, key.pr_number),
    deps.github.listReviewComments(key.repository_id, key.pr_number),
    deps.github.listIssueComments(key.repository_id, key.pr_number),
  ]);
  const records = [...reviews, ...reviewComments, ...issueComments];
  const live = new Map<string, GitHubRecord>();
  for (const record of records) {
    live.set(recordKey(record), record);
    const outcome = deps.store.sourceRecords.upsert({ recordKey: recordKey(record), version: record.version, reviewId: review.id, authorLogin: record.authorLogin, body: record.raw });
    if (outcome !== "same") summary.recordsImported += 1;
  }

  // 3. classify and admit unadmitted Codex records at their live version
  const codexReviews = new Map<number, GitHubRecord>();
  for (const record of reviews) if (isCodex(record.authorLogin)) codexReviews.set(record.id, record);
  const membersOf = (reviewId: number): GitHubRecord[] => reviewComments.filter((c) => isCodex(c.authorLogin) && reviewIdOf(c) === reviewId);
  const heads = [...new Set([review.subject.head_sha, ...review.subjects.map((s) => s.head_sha)])];
  const context = { headSha: review.subject.head_sha, heads, repository: `${pr.owner}/${pr.repo}` };
  const unadmitted = deps.store.sourceRecords.unadmitted(review.id).filter((row) => isCodex(row.authorLogin));
  const rank = (row: SourceRecordRow): number => (row.recordKey.startsWith("review:") ? 0 : 1);
  unadmitted.sort((a, b) => rank(a) - rank(b));

  for (const row of unadmitted) {
    const record = live.get(row.recordKey);
    if (record === undefined || record.version !== row.version) {
      // An older version of an edited record, or a record GitHub no longer returns: the live version is the one admitted.
      deps.store.sourceRecords.setClassification(row.recordKey, row.version, "superseded");
      continue;
    }
    const parent = record.kind === "review_comment" ? reviewIdOf(record) : null;
    if (parent !== null && codexReviews.has(parent)) {
      // A finding inside a Codex review is admitted through its envelope (one ExternalResult per round).
      const envelope = codexReviews.get(parent);
      if (envelope === undefined) continue;
      deps.store.sourceRecords.setClassification(row.recordKey, row.version, `member:${recordKey(envelope)}`);
      deps.store.sourceRecords.markAdmitted(row.recordKey, row.version, `src:${recordKey(envelope)}:${envelope.version}`);
      continue;
    }
    const classified = classifyCodexRecord(record, { ...context, members: record.kind === "review" ? membersOf(record.id) : [] });
    deps.store.sourceRecords.setClassification(row.recordKey, row.version, classified.classification);
    let action: Action;
    if (classified.external !== undefined) {
      action = { kind: "AdmitExternalResult", result: classified.external };
    } else if (classified.availability !== undefined) {
      const until = classified.availability.reason === "quota" ? meterReading?.resetsAt ?? null : null;
      action = { kind: "SetReviewerAvailability", reviewer: "codex", available: false, reason: classified.availability.reason, until, evidence: classified.availability.evidence };
    } else {
      continue; // `status` / `unknown`: recorded, surfaced, never promoted (§7)
    }
    const actId = `src:${row.recordKey}:${row.version}`;
    const receipt = deps.store.apply(key, { actId, principal: adapterPrincipal(runId, record.authorLogin), expectedRevision: null, action });
    if ("refused" in receipt.outcome) {
      summary.refused.push({ actId, code: receipt.outcome.code });
      continue;
    }
    deps.store.sourceRecords.markAdmitted(row.recordKey, row.version, actId);
    summary.admitted.push(actId);
    if (record.kind === "review") {
      for (const member of membersOf(record.id)) {
        deps.store.sourceRecords.setClassification(recordKey(member), member.version, `member:${row.recordKey}`);
        deps.store.sourceRecords.markAdmitted(recordKey(member), member.version, actId);
      }
    }
  }

  // 4. exemption evidence when the subject changed (§6.C6)
  if (subjectChanged) {
    let templateBlobs: Map<string, string | null> | null = null;
    if (deps.templates !== undefined && deps.github.getBlobSha !== undefined) {
      templateBlobs = new Map();
      for (const file of files) {
        templateBlobs.set(file.path, await deps.github.getBlobSha(deps.templates.repositoryId, deps.templates.ref, file.path));
      }
    }
    summary.exemption = exemptionEvidence(files, policy.exempt_roots, templateBlobs);
  }
  return finish();
}

// ---------------------------------------------------------------------------------------
// Scheduler (§7 "Gaps")
// ---------------------------------------------------------------------------------------

export interface ReconcileSchedulerDeps extends ReconcileDeps {
  /** The bounded sweep period; design: five minutes. */
  intervalMs?: number;
  /** How often the inbox is drained into wakes. */
  inboxPollMs?: number;
  log?: (line: string) => void;
}

const DAY_MS = 24 * 60 * 60_000;

interface Lane { running: Promise<void> | null; pending: boolean; after: Array<(runId: string) => void> }

/**
 * Serializes reconcile per Review (one lane per key; a wake during a run coalesces into one
 * follow-up run), drains the inbox into wakes and marks deliveries reconciled with the run
 * that covered them, sweeps every active Review on the interval, and on start asks the App's
 * redelivery API for failed deliveries in the last 24 h.
 */
export class ReconcileScheduler {
  private readonly lanes = new Map<string, Lane>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private readonly deps: ReconcileSchedulerDeps) {}

  private log(line: string): void {
    (this.deps.log ?? ((text: string) => console.error(text)))(line);
  }

  private mintRunId(): string {
    return `${this.deps.clock.now().getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  wake(key: ReviewKey, after?: (runId: string) => void): void {
    const laneKey = `${key.repository_id}:${key.pr_number}`;
    const lane = this.lanes.get(laneKey) ?? { running: null, pending: false, after: [] };
    this.lanes.set(laneKey, lane);
    if (after !== undefined) lane.after.push(after);
    if (lane.running !== null) {
      lane.pending = true;
      return;
    }
    lane.running = this.drive(key, lane).finally(() => {
      lane.running = null;
    });
  }

  private async drive(key: ReviewKey, lane: Lane): Promise<void> {
    do {
      lane.pending = false;
      const runId = this.mintRunId();
      const callbacks = lane.after.splice(0);
      try {
        const summary = await reconcile(this.deps, key, runId);
        if (summary.refused.length > 0) this.log(`reconcile ${runId} ${key.repository_id}:${key.pr_number} refused ${JSON.stringify(summary.refused)}`);
      } catch (error) {
        this.log(`reconcile ${runId} ${key.repository_id}:${key.pr_number} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const callback of callbacks) callback(runId);
    } while (lane.pending && !this.stopped);
  }

  /** Every unreconciled delivery becomes a wake for its Review; deliveries with no PR are marked and skipped. */
  drainInbox(): void {
    const deliveries = this.deps.store.inbox.unreconciled();
    if (deliveries.length === 0) return;
    const byKey = new Map<string, { key: ReviewKey; ids: string[] }>();
    const orphans: string[] = [];
    for (const delivery of deliveries) {
      if (delivery.repositoryId === null || delivery.prNumber === null) {
        orphans.push(delivery.deliveryId);
        continue;
      }
      const laneKey = `${delivery.repositoryId}:${delivery.prNumber}`;
      const group = byKey.get(laneKey) ?? { key: { repository_id: delivery.repositoryId, pr_number: delivery.prNumber }, ids: [] };
      group.ids.push(delivery.deliveryId);
      byKey.set(laneKey, group);
    }
    if (orphans.length > 0) this.deps.store.inbox.markReconciled(orphans, `skip:${this.mintRunId()}`);
    for (const group of byKey.values()) {
      this.wake(group.key, (runId) => this.deps.store.inbox.markReconciled(group.ids, runId));
    }
  }

  /** §7 "Gaps": every Review with a pending request or activity in the last 24 h. */
  sweep(): void {
    const since = new Date(this.deps.clock.now().getTime() - DAY_MS).toISOString();
    for (const key of this.deps.store.active(since)) this.wake(key);
  }

  /** §7 "Gaps": on start, ask the App for failed deliveries in the last 24 h and redeliver each. */
  async requestRedeliveries(): Promise<number> {
    const since = new Date(this.deps.clock.now().getTime() - DAY_MS).toISOString();
    let count = 0;
    try {
      for (const delivery of await this.deps.github.listFailedDeliveries(since)) {
        await this.deps.github.redeliver(delivery.id);
        count += 1;
      }
    } catch (error) {
      this.log(`redelivery request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return count;
  }

  start(): void {
    this.stopped = false;
    void this.requestRedeliveries();
    this.drainInbox();
    this.sweep();
    const poll = setInterval(() => this.drainInbox(), this.deps.inboxPollMs ?? 5_000);
    const sweep = setInterval(() => this.sweep(), this.deps.intervalMs ?? 5 * 60_000);
    poll.unref();
    sweep.unref();
    this.timers = [poll, sweep];
  }

  /** Resolves once every lane is idle, coalesced follow-ups included (a test and CLI convenience). */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.lanes.values()].map((lane) => lane.running).filter((run): run is Promise<void> => run !== null);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  /** Stops the timers, lets in-flight runs finish, and drops coalesced follow-ups (the next start sweeps). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.all([...this.lanes.values()].map((lane) => lane.running ?? Promise.resolve()));
  }
}
