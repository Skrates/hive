import assert from "node:assert/strict";
import test from "node:test";
import type { Policy, ReviewState, TransportRef } from "./contract.js";
import type { Clock } from "../time.js";
import { AT, finding, fixedClaim, hold, policy, request, SHA_A, SHA_B, state } from "./fixtures.js";
import {
  ReviewPublisher,
  type PublishableEffect,
  type PublisherStore,
  type ReviewGitHubPort,
  type SystemWakePort,
} from "./publisher.js";
import type { UnknownSourceRecord } from "./store.js";

class FakeClock implements Clock {
  constructor(private current = new Date(AT)) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

interface Row extends PublishableEffect {
  status: "pending" | "claimed" | "sent" | "obsolete" | "failed";
  nextAttemptAt: string | null;
}

/**
 * A ReviewStore-shaped fake (module map §3 `effects` surface + `readById` + `policy`). It
 * models exactly the contract the publisher relies on: one row per target from
 * `pendingByTarget` (newest pending refresh, oldest pending actionable), `claim` flips
 * pending → claimed once, `coalesceRefresh` obsoletes older pending refreshes.
 */
class FakeReviewStore implements PublisherStore {
  rows: Row[] = [];
  states = new Map<string, ReviewState>();
  policies = new Map<string, Policy>();
  reads = 0;
  /** What the publisher recorded, and — as the real store does — merged into the next read. */
  handles: Array<{ reviewId: string; handle: string; key: string; value: string | number }> = [];
  transport: Array<{ reviewId: string; effectId: string; requestId: string; ref: TransportRef }> = [];
  unknownRecords = new Map<string, UnknownSourceRecord[]>();

  put(reviewState: ReviewState): void { this.states.set(reviewState.id, reviewState); }
  readById(reviewId: string): ReviewState | null {
    this.reads += 1;
    const stored = this.states.get(reviewId);
    if (stored === undefined) return null;
    const merged = structuredClone(stored);
    for (const h of this.handles.filter((candidate) => candidate.reviewId === reviewId)) {
      if (h.handle === "board_comment_id") merged.projection_handles.board_comment_id = Number(h.value);
      else if (h.handle === "check_run_id") merged.projection_handles.check_run_ids[h.key] = Number(h.value);
      else if (h.handle === "slack_thread_ts" && h.key === this.policy(merged.key.repository_id, merged.policy_version)?.slack?.channel_id) merged.projection_handles.slack_thread_ts = String(h.value);
    }
    for (const t of this.transport.filter((candidate) => candidate.reviewId === reviewId)) {
      merged.requests.find((r) => r.id === t.requestId)?.transport.push(t.ref);
    }
    return merged;
  }
  readonly projections = {
    recordBoardComment: (reviewId: string, commentId: number): void => { this.handles.push({ reviewId, handle: "board_comment_id", key: "", value: commentId }); },
    recordCheckRun: (reviewId: string, headSha: string, checkRunId: number): void => { this.handles.push({ reviewId, handle: "check_run_id", key: headSha, value: checkRunId }); },
    recordSlackThread: (reviewId: string, channelId: string, threadTs: string): void => { this.handles.push({ reviewId, handle: "slack_thread_ts", key: channelId, value: threadTs }); },
    recordSlackBoardOutbox: (reviewId: string, channelId: string, outboxId: number): void => { this.handles.push({ reviewId, handle: "slack_board_outbox_id", key: channelId, value: outboxId }); },
    slackBoardOutboxId: (reviewId: string, channelId: string): number | null => {
      const found = this.handles.find((h) => h.reviewId === reviewId && h.handle === "slack_board_outbox_id" && h.key === channelId);
      return found === undefined ? null : Number(found.value);
    },
    recordTransport: (reviewId: string, effectId: string, requestId: string, ref: TransportRef): void => {
      const existing = this.transport.findIndex((t) => t.effectId === effectId);
      if (existing >= 0) this.transport[existing] = { reviewId, effectId, requestId, ref };
      else this.transport.push({ reviewId, effectId, requestId, ref });
    },
  };
  readonly sourceRecords = {
    unknown: (reviewId: string): UnknownSourceRecord[] => this.unknownRecords.get(reviewId) ?? [],
  };
  policy(repositoryId: number, version: number | "latest"): Policy | null {
    return this.policies.get(`${repositoryId}:${version}`) ?? null;
  }
  add(row: Partial<Row> & Pick<Row, "effect_id" | "kind" | "target">): Row {
    const full: Row = {
      payload: null,
      reviewId: "rev_obs:run_1",
      attempts: 0,
      status: "pending",
      nextAttemptAt: null,
      ...row,
    };
    this.rows.push(full);
    return full;
  }
  row(effectId: string): Row {
    const found = this.rows.find((candidate) => candidate.effect_id === effectId);
    assert.ok(found, effectId);
    return found;
  }
  readonly effects = {
    pendingByTarget: (now: string): PublishableEffect[] => {
      const byTarget = new Map<string, Row>();
      const eligible = this.rows.filter((r) => r.status === "pending" && (r.nextAttemptAt === null || r.nextAttemptAt <= now));
      for (const row of eligible) {
        const current = byTarget.get(row.target);
        if (current === undefined) { byTarget.set(row.target, row); continue; }
        // Refresh: newest wins (effect ids are minted in order). Actionable: oldest wins.
        const newer = row.effect_id > current.effect_id;
        if ((row.kind === "refresh" && newer) || (row.kind === "actionable" && !newer)) byTarget.set(row.target, row);
      }
      return [...byTarget.values()].map((row) => ({ ...row }));
    },
    claim: (effectId: string): PublishableEffect | null => {
      const row = this.row(effectId);
      if (row.status !== "pending") return null;
      row.status = "claimed";
      return { ...row };
    },
    markSent: (effectId: string): void => { this.row(effectId).status = "sent"; },
    markObsolete: (effectId: string): void => { this.row(effectId).status = "obsolete"; },
    markFailed: (effectId: string, nextAttemptAt: string): void => {
      const row = this.row(effectId);
      row.status = "pending";
      row.attempts += 1;
      row.nextAttemptAt = nextAttemptAt;
    },
    coalesceRefresh: (target: string): number => {
      const pending = this.rows.filter((r) => r.target === target && r.kind === "refresh" && r.status === "pending");
      const newest = pending.reduce<Row | null>((best, r) => (best === null || r.effect_id > best.effect_id ? r : best), null);
      let count = 0;
      for (const row of pending) {
        if (row !== newest) { row.status = "obsolete"; count += 1; }
      }
      return count;
    },
  };
}

class FakeSlack implements SystemWakePort {
  wakes: Array<{ actor: string; channelId: string; threadTs: string | null; text: string; dedupeKey: string }> = [];
  lines: Array<{ channelId: string; threadTs: string | null; text: string }> = [];
  refuse: Error | null = null;
  mintSystemWake(input: { actor: string; channelId: string; threadTs: string | null; text: string; dedupeKey: string }): { deliveryId: number } {
    if (this.refuse !== null) throw this.refuse;
    const existing = this.wakes.findIndex((w) => w.dedupeKey === input.dedupeKey);
    if (existing >= 0) return { deliveryId: existing + 1 };
    this.wakes.push(input);
    return { deliveryId: this.wakes.length };
  }
  postBoardLine(input: { channelId: string; threadTs: string | null; text: string }): { outboxId: number } {
    this.lines.push(input);
    return { outboxId: this.lines.length };
  }
  /** Outbox rows the test has "drained": outbox id → posted ts. */
  posted = new Map<number, string>();
  outboxMessageTs(outboxId: number): string | null { return this.posted.get(outboxId) ?? null; }
}

class FakeGitHub implements ReviewGitHubPort {
  checks: Array<{ headSha: string; conclusion: "success" | "failure"; title: string; existingId: number | null }> = [];
  boards: Array<{ body: string; existingId: number | null }> = [];
  threads: Array<{ commentId: number; op: "resolve" | "unresolve" }> = [];
  comments: string[] = [];
  /** A gate the test releases to hold one publish mid-flight. */
  gate: Promise<void> | null = null;
  /** A port whose responses carry no id (the App port's `?? 0` fallback). */
  noIds = false;
  async createOrUpdateCheckRun(input: { headSha: string; existingId: number | null; conclusion: "success" | "failure"; title: string }): Promise<{ checkRunId: number }> {
    if (this.gate !== null) await this.gate;
    this.checks.push({ headSha: input.headSha, conclusion: input.conclusion, title: input.title, existingId: input.existingId });
    return { checkRunId: this.noIds ? 0 : input.existingId ?? this.checks.length };
  }
  async createOrUpdateBoardComment(input: { existingId: number | null; body: string }): Promise<{ commentId: number }> {
    this.boards.push({ body: input.body, existingId: input.existingId });
    return { commentId: this.noIds ? 0 : input.existingId ?? 500 };
  }
  async resolveThread(input: { commentId: number }): Promise<void> { this.threads.push({ commentId: input.commentId, op: "resolve" }); }
  async unresolveThread(input: { commentId: number }): Promise<void> { this.threads.push({ commentId: input.commentId, op: "unresolve" }); }
  async postComment(input: { body: string }): Promise<{ commentId: number; summonLogin: string }> {
    this.comments.push(input.body);
    return { commentId: 700 + this.comments.length, summonLogin: "RationallyPrime" };
  }
}

function fixture(options: { github?: boolean; threadReady?: boolean } = {}) {
  const store = new FakeReviewStore();
  const slack = new FakeSlack();
  const github = options.github === true ? new FakeGitHub() : null;
  const clock = new FakeClock();
  store.policies.set("42:1", policy());
  store.put(state());
  if (options.threadReady !== false) store.projections.recordSlackThread("rev_obs:run_1", "C0123ABCD", "1700.1");
  const publisher = new ReviewPublisher(store, { github, slack }, clock);
  return { store, slack, github, clock, publisher };
}

const CHECK = `check:skrates/hive:${SHA_A}`;

// §11 #5, publisher half: "ready refresh queued → Hold → delayed worker runs the earlier job":
// the check publishes failure(hold) because a refresh never carries a verdict — it renders
// from read() at dispatch, and the earlier job is coalesced into the newest.
test("a delayed worker never publishes an older verdict: the earlier refresh renders the current state", async () => {
  const { store, github, publisher } = fixture({ github: true });
  // Queued while the Review was ready …
  store.add({ effect_id: "eff_act1_1", kind: "refresh", target: CHECK });
  // … then a Hold lands, queueing another refresh for the same target and changing read().
  store.add({ effect_id: "eff_act2_1", kind: "refresh", target: CHECK });
  store.put(state({
    holds: [hold({ kind: "operator" })],
    readiness: { ready: false, subject_key: `${SHA_A}:main`, reasons: [{ hold: "operator" }] },
  }));

  const handled = await publisher.drainOnce();

  assert.equal(handled, 1);
  assert.deepEqual(github!.checks.map((c) => [c.conclusion, c.title]), [["failure", "hold: operator"]]);
  assert.equal(store.row("eff_act2_1").status, "sent");
  // The earlier job never runs: coalesced into the newest.
  assert.equal(store.row("eff_act1_1").status, "obsolete");
});

test("the earlier job, if it is the one a worker picks up, still renders from read() now", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.add({ effect_id: "eff_act1_1", kind: "refresh", target: CHECK });
  store.put(state({
    holds: [hold({ kind: "human_gate", release_on: "subject_change" })],
    readiness: { ready: false, subject_key: `${SHA_A}:main`, reasons: [{ hold: "human_gate" }] },
  }));
  await publisher.drainOnce();
  assert.deepEqual(github!.checks.map((c) => c.title), ["hold: human_gate"]);
});

test("refreshes are serialized per target: one row per target per pass, and passes never overlap", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.add({ effect_id: "eff_a_1", kind: "refresh", target: CHECK });
  store.add({ effect_id: "eff_a_2", kind: "refresh", target: "board:rev_obs:run_1" });
  let release!: () => void;
  github!.gate = new Promise<void>((resolve) => { release = resolve; });

  const first = publisher.drainOnce();
  const second = publisher.drainOnce();
  assert.equal(first, second, "a concurrent drain joins the in-flight pass");
  release();
  assert.equal(await first, 2);
  assert.equal(github!.checks.length, 1);
  assert.equal(github!.boards.length, 1);
  // The pass is over; a new one finds nothing pending.
  assert.equal(await publisher.drainOnce(), 0);
});

test("board refresh in M0 (github: null) posts the Slack board line to the policy channel", async () => {
  const { store, slack, publisher } = fixture({ threadReady: false });
  store.add({ effect_id: "eff_1", kind: "refresh", target: "board:rev_obs:run_1" });
  assert.equal(await publisher.drainOnce(), 1);
  assert.equal(slack.lines.length, 1);
  assert.equal(slack.lines[0]!.channelId, "C0123ABCD");
  assert.equal(slack.lines[0]!.threadTs, null);
  assert.match(slack.lines[0]!.text, /^skrates\/hive#7 @ aaaaaaa · ready at aaaaaaa/);
  assert.equal(store.row("eff_1").status, "sent");
});

test("board refresh with a GitHub port edits the board comment in place and still posts the Slack line", async () => {
  const { store, slack, github, publisher } = fixture({ github: true, threadReady: false });
  store.put(state({ projection_handles: { board_comment_id: 314, check_run_ids: {}, slack_thread_ts: "1700.5" } }));
  store.add({ effect_id: "eff_1", kind: "refresh", target: "board:rev_obs:run_1" });
  await publisher.drainOnce();
  assert.equal(github!.boards[0]!.existingId, 314);
  assert.match(github!.boards[0]!.body, /^## Review skrates\/hive#7/);
  assert.equal(slack.lines[0]!.threadTs, "1700.5");
});

test("check refresh reuses the recorded check-run handle for the head and is obsolete for a stale head", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.put(state({ projection_handles: { board_comment_id: null, check_run_ids: { [SHA_A]: 99 }, slack_thread_ts: null } }));
  store.add({ effect_id: "eff_1", kind: "refresh", target: CHECK });
  store.add({ effect_id: "eff_2", kind: "refresh", target: `check:skrates/hive:${SHA_B}` });
  assert.equal(await publisher.drainOnce(), 2);
  assert.deepEqual(github!.checks.map((c) => [c.headSha, c.existingId]), [[SHA_A, 99]]);
  assert.equal(store.row("eff_1").status, "sent");
  assert.equal(store.row("eff_2").status, "obsolete");
});

test("thread refresh resolves a closed comment-sourced finding and unresolves a contested one", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.put(state({
    findings: [
      finding({ id: "fnd_1", source: { record_kind: "review_comment", comment_id: 9001 }, status: { open: false, resolution: fixedClaim() } }),
      finding({ id: "fnd_2", source: { record_kind: "review_comment", comment_id: 9002 }, status: { open: true, contested: { by: "codex", at: AT, prior: fixedClaim() } } }),
    ],
  }));
  store.add({ effect_id: "eff_1", kind: "refresh", target: "thread:9001" });
  store.add({ effect_id: "eff_2", kind: "refresh", target: "thread:9002" });
  store.add({ effect_id: "eff_3", kind: "refresh", target: "thread:9003" });
  assert.equal(await publisher.drainOnce(), 3);
  assert.deepEqual(github!.threads, [{ commentId: 9001, op: "resolve" }, { commentId: 9002, op: "unresolve" }]);
  assert.equal(store.row("eff_3").status, "obsolete");
});

// §6.D7: a summon whose request is no longer pending at the current subject is obsolete.
test("an obsolete summon is marked obsolete and never posted", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.put(state({ requests: [request({ id: "req_1", status: "answered", answered_by: "ans_1" })] }));
  store.add({
    effect_id: "eff_1", kind: "actionable", target: "summon:req_1",
    payload: { request_id: "req_1", subject_key: `${SHA_A}:main`, text: "@codex review" },
  });
  assert.equal(await publisher.drainOnce(), 1);
  assert.deepEqual(github!.comments, []);
  assert.equal(store.row("eff_1").status, "obsolete");
});

test("an applicable summon posts the comment; a summon at a superseded subject is obsolete", async () => {
  const { store, github, publisher } = fixture({ github: true });
  const moved = state({ requests: [request({ id: "req_1" }), request({ id: "req_2", subject_key: `${SHA_B}:main` })] });
  moved.subject = { ...moved.subject, key: `${SHA_B}:main`, head_sha: SHA_B };
  store.put(moved);
  store.add({ effect_id: "eff_1", kind: "actionable", target: "summon:req_1", payload: { request_id: "req_1", subject_key: `${SHA_A}:main`, text: "@codex review" } });
  store.add({ effect_id: "eff_2", kind: "actionable", target: "summon:req_2", payload: { request_id: "req_2", subject_key: `${SHA_B}:main`, text: "@codex review" } });
  assert.equal(await publisher.drainOnce(), 2);
  assert.equal(github!.comments.length, 1);
  assert.match(github!.comments[0]!, /^@codex review\n\nHive request req_2; effect eff_2; attempt 1\./u);
  assert.equal(store.row("eff_1").status, "obsolete");
  assert.equal(store.row("eff_2").status, "sent");
});

test("without a GitHub port a summon waits, unclaimed and unmarked", async () => {
  const { store, publisher } = fixture();
  store.put(state({ requests: [request({ id: "req_1" })] }));
  store.add({ effect_id: "eff_1", kind: "actionable", target: "summon:req_1", payload: { request_id: "req_1", subject_key: `${SHA_A}:main`, text: "@codex review" } });
  assert.equal(await publisher.drainOnce(), 0);
  assert.equal(store.row("eff_1").status, "pending");
  assert.equal(store.row("eff_1").attempts, 0);
});

// §6.D8: `mergeable === false` withholds transport — pending, not obsolete, not attempted.
test("mergeable false keeps summons and deliveries pending, not obsolete", async () => {
  const { store, slack, github, publisher } = fixture({ github: true });
  const conflicting = state({ requests: [request({ id: "req_1" }), request({ id: "req_2", assignee: "talos" })] });
  conflicting.observed = { ...conflicting.observed, mergeable: false };
  store.put(conflicting);
  store.add({ effect_id: "eff_1", kind: "actionable", target: "summon:req_1", payload: { request_id: "req_1", subject_key: `${SHA_A}:main`, text: "@codex review" } });
  store.add({ effect_id: "eff_2", kind: "actionable", target: "delivery:talos:req_2", payload: { actor: "talos", request_id: "req_2", text: "please burn", dedupe_key: "eff_2" } });

  assert.equal(await publisher.drainOnce(), 0);
  assert.equal(store.row("eff_1").status, "pending");
  assert.equal(store.row("eff_2").status, "pending");
  assert.equal(store.row("eff_2").attempts, 0);
  assert.deepEqual(github!.comments, []);
  assert.deepEqual(slack.wakes, []);

  // The flip to true resumes transport.
  const mergeable = state({ requests: conflicting.requests });
  store.put(mergeable);
  assert.equal(await publisher.drainOnce(), 2);
  assert.equal(github!.comments.length, 1);
  assert.match(github!.comments[0]!, /^@codex review\n\nHive request req_1; effect eff_1; attempt 1\./u);
  assert.equal(slack.wakes.length, 1);
});

// §6.D8: the conflict notice explains the pause, so the pause must not hold it back.
test("the conflict notice is dispatched while the summons and deliveries it explains stay withheld", async () => {
  const { store, slack, github, publisher } = fixture({ github: true });
  const conflicting = state({ requests: [request({ id: "req_1" }), request({ id: "req_2", assignee: "talos" })] });
  conflicting.observed = { ...conflicting.observed, mergeable: false };
  store.put(conflicting);
  store.add({ effect_id: "eff_1", kind: "actionable", target: "summon:req_1", payload: { request_id: "req_1", subject_key: `${SHA_A}:main`, text: "@codex review" } });
  store.add({ effect_id: "eff_2", kind: "actionable", target: "delivery:talos:req_2", payload: { actor: "talos", request_id: "req_2", text: "please burn", dedupe_key: "eff_2" } });
  store.add({
    effect_id: "eff_3",
    kind: "actionable",
    target: `notice:talos:${SHA_A}:main`,
    payload: { actor: "talos", text: "conflicting against main tip abc", dedupe_key: `conflicting:${conflicting.id}:${SHA_A}:main` },
  });

  assert.equal(await publisher.drainOnce(), 1, "only the notice leaves");
  assert.equal(store.row("eff_3").status, "sent");
  assert.equal(store.row("eff_1").status, "pending");
  assert.equal(store.row("eff_2").status, "pending");
  assert.equal(store.row("eff_2").attempts, 0);
  assert.deepEqual(github!.comments, []);
  assert.deepEqual(slack.wakes, [{
    actor: "talos",
    channelId: "C0123ABCD",
    threadTs: "1700.1",
    text: "conflicting against main tip abc",
    dedupeKey: `conflicting:${conflicting.id}:${SHA_A}:main`,
  }]);
  // It is not request transport: nothing is recorded on a request.
  assert.deepEqual(store.transport, []);

  // A notice for a subject the Review has left is moot, not withheld.
  const moved = state({ requests: conflicting.requests });
  moved.subject = { ...moved.subject, key: `${SHA_B}:main`, head_sha: SHA_B };
  moved.observed = { ...moved.observed, mergeable: false };
  store.put(moved);
  store.row("eff_3").status = "pending";
  // The stale request rows go obsolete with the subject (§D7); the stale notice goes with them.
  assert.equal(await publisher.drainOnce(), 3);
  assert.equal(store.row("eff_3").status, "obsolete");
  assert.equal(slack.wakes.length, 1);
});

// §8.1 / R-3: a delivery is a system-origin Hive wake, self-identifying by its dedupe key;
// a redelivery of the same effect is a replay at the port, never a second wake.
test("a delivery mints a system wake with the payload's dedupe key, and re-dispatch is a replay", async () => {
  const { store, slack, publisher } = fixture({ threadReady: false });
  store.put(state({ requests: [request({ id: "req_2", assignee: "talos" })], projection_handles: { board_comment_id: null, check_run_ids: {}, slack_thread_ts: "1700.5" } }));
  store.add({ effect_id: "eff_2", kind: "actionable", target: "delivery:talos:req_2", payload: { actor: "talos", request_id: "req_2", text: "please burn", dedupe_key: "eff_2" } });
  assert.equal(await publisher.drainOnce(), 1);
  assert.deepEqual(slack.wakes, [{ actor: "talos", channelId: "C0123ABCD", threadTs: "1700.5", text: "please burn", dedupeKey: "eff_2" }]);
  assert.equal(store.row("eff_2").status, "sent");

  // At-least-once: the same effect re-queued (say the sent mark was lost) reaches the port
  // with the same key and produces no second wake.
  store.row("eff_2").status = "pending";
  assert.equal(await publisher.drainOnce(), 1);
  assert.equal(slack.wakes.length, 1);
});

test("a refused delivery is marked failed behind backoff, attempts counted, and retried later", async () => {
  const { store, slack, clock, publisher } = fixture();
  store.put(state({ requests: [request({ id: "req_2", assignee: "talos" })] }));
  store.add({ effect_id: "eff_2", kind: "actionable", target: "delivery:talos:req_2", payload: { actor: "talos", request_id: "req_2", text: "please burn", dedupe_key: "eff_2" } });
  slack.refuse = new Error("no live subscription for actor `talos`");
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await publisher.drainOnce(), 0);
  } finally {
    console.error = quiet;
  }
  const row = store.row("eff_2");
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt !== null && row.nextAttemptAt > AT, "backoff scheduled");
  // Not yet due: the next pass skips it.
  assert.equal(await publisher.drainOnce(), 0);
  slack.refuse = null;
  clock.advance(60_000);
  assert.equal(await publisher.drainOnce(), 1);
  assert.equal(store.row("eff_2").status, "sent");
});

test("a delivery without a Slack channel in the Review's policy fails visibly instead of vanishing", async () => {
  const { store, slack, publisher } = fixture();
  store.policies.set("42:1", policy({ slack: null }));
  store.put(state({ requests: [request({ id: "req_2", assignee: "talos" })] }));
  store.add({ effect_id: "eff_2", kind: "actionable", target: "delivery:talos:req_2", payload: { actor: "talos", request_id: "req_2", text: "please burn", dedupe_key: "eff_2" } });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await publisher.drainOnce(), 0);
  } finally {
    console.error = quiet;
  }
  assert.equal(store.row("eff_2").attempts, 1);
  assert.deepEqual(slack.wakes, []);
});

// §11 #6: distinct effect ids each dispatch once — two deliveries to the same actor for two
// requests are two wakes with two dedupe keys.
test("distinct effect ids dispatch distinctly: the gate delivery and the retrospective delivery are two wakes", async () => {
  const { store, slack, publisher } = fixture();
  store.put(state({
    requests: [
      request({ id: "req_gate", assignee: "talos" }),
      request({ id: "req_retro", kind: "retrospective", mode: null, assignee: "theoros", required: false }),
    ],
  }));
  store.add({ effect_id: "eff_g4_1", kind: "actionable", target: "delivery:talos:req_gate", payload: { actor: "talos", request_id: "req_gate", text: "rounds exhausted", dedupe_key: "eff_g4_1" } });
  store.add({ effect_id: "eff_g4_2", kind: "actionable", target: "delivery:theoros:req_retro", payload: { actor: "theoros", request_id: "req_retro", text: "retrospective please", dedupe_key: "eff_g4_2" } });
  assert.equal(await publisher.drainOnce(), 2);
  assert.deepEqual(slack.wakes.map((w) => [w.actor, w.dedupeKey]), [["talos", "eff_g4_1"], ["theoros", "eff_g4_2"]]);
});

test("announce posts on merged and is obsolete otherwise", async () => {
  const { store, slack, publisher } = fixture();
  store.add({ effect_id: "eff_1", kind: "actionable", target: "announce:rev_obs:run_1", payload: { review_id: "rev_obs:run_1", text: "merged skrates/hive#7" } });
  assert.equal(await publisher.drainOnce(), 1);
  assert.equal(store.row("eff_1").status, "obsolete");
  assert.equal(slack.lines.length, 0);

  store.put(state({ lifecycle: "merged" }));
  store.add({ effect_id: "eff_2", kind: "actionable", target: "announce:rev_obs:run_1", payload: { review_id: "rev_obs:run_1", text: "merged skrates/hive#7" } });
  assert.equal(await publisher.drainOnce(), 1);
  assert.deepEqual(slack.lines.map((l) => l.text), ["merged skrates/hive#7"]);
});

test("a row already claimed elsewhere is skipped, and a row whose Review is gone is obsolete", async () => {
  const { store, publisher } = fixture();
  store.add({ effect_id: "eff_1", kind: "refresh", target: "board:rev_obs:run_1", status: "claimed" });
  store.add({ effect_id: "eff_2", kind: "refresh", target: "board:rev_gone", reviewId: "rev_gone" });
  assert.equal(await publisher.drainOnce(), 1);
  assert.equal(store.row("eff_1").status, "claimed");
  assert.equal(store.row("eff_2").status, "obsolete");
});

// §8.1 "one per Review, created once, edited in place through projection_handles": the id the
// port answers is recorded, and the next refresh carries it as existingId (POST once, PATCH after).
test("the board comment is created once: the first refresh POSTs, records the id, and the next refresh PATCHes with it", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.add({ effect_id: "eff_1", kind: "refresh", target: "board:rev_obs:run_1" });
  assert.equal(await publisher.drainOnce(), 1);
  assert.deepEqual(github!.boards.map((b) => b.existingId), [null]);
  assert.deepEqual(store.handles.filter((h) => h.handle === "board_comment_id"), [{ reviewId: "rev_obs:run_1", handle: "board_comment_id", key: "", value: 500 }]);
  store.add({ effect_id: "eff_2", kind: "refresh", target: "board:rev_obs:run_1" });
  assert.equal(await publisher.drainOnce(), 1);
  assert.deepEqual(github!.boards.map((b) => b.existingId), [null, 500]);
  assert.equal(store.handles.filter((h) => h.handle === "board_comment_id").length, 1, "recorded once, not per refresh");
});

test("check-run ids are recorded per head: POST once, PATCH after, and a new head POSTs its own", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.add({ effect_id: "eff_1", kind: "refresh", target: CHECK });
  await publisher.drainOnce();
  store.add({ effect_id: "eff_2", kind: "refresh", target: CHECK });
  await publisher.drainOnce();
  assert.deepEqual(github!.checks.map((c) => [c.headSha, c.existingId]), [[SHA_A, null], [SHA_A, 1]]);
  const moved = state();
  moved.subject = { ...moved.subject, key: `${SHA_B}:main`, head_sha: SHA_B };
  store.put(moved);
  store.add({ effect_id: "eff_3", kind: "refresh", target: `check:skrates/hive:${SHA_B}` });
  await publisher.drainOnce();
  assert.deepEqual(github!.checks.at(-1), { headSha: SHA_B, conclusion: "success", title: `ready at ${SHA_B.slice(0, 7)}`, existingId: null });
  assert.deepEqual(store.handles.filter((h) => h.handle === "check_run_id").map((h) => [h.key, h.value]), [[SHA_A, 1], [SHA_B, 3]]);
});

test("the Slack thread: the first board line opens it; once the outbox has posted it, later lines and deliveries thread under it", async () => {
  const { store, slack, publisher } = fixture({ threadReady: false });
  store.put(state({ requests: [request({ id: "req_2", assignee: "talos" })] }));
  store.add({ effect_id: "eff_1", kind: "refresh", target: "board:rev_obs:run_1" });
  await publisher.drainOnce();
  assert.equal(slack.lines[0]!.threadTs, null, "the first line is the thread's top-level post");
  assert.equal(store.projections.slackBoardOutboxId("rev_obs:run_1", "C0123ABCD"), 1);
  // The outbox has not drained yet: the next line still posts at the top level rather than waiting or vanishing.
  store.add({ effect_id: "eff_2", kind: "refresh", target: "board:rev_obs:run_1" });
  await publisher.drainOnce();
  assert.equal(slack.lines[1]!.threadTs, null);
  assert.equal(store.projections.slackBoardOutboxId("rev_obs:run_1", "C0123ABCD"), 1, "the first row stays the thread opener");
  // Drained: the ts is learned, recorded once, and everything after threads under it.
  slack.posted.set(1, "1700.1");
  store.add({ effect_id: "eff_3", kind: "refresh", target: "board:rev_obs:run_1" });
  store.add({ effect_id: "eff_4", kind: "actionable", target: "delivery:talos:req_2", payload: { actor: "talos", request_id: "req_2", text: "please burn", dedupe_key: "eff_4" } });
  assert.equal(await publisher.drainOnce(), 2);
  assert.equal(slack.lines[2]!.threadTs, "1700.1");
  assert.equal(slack.wakes[0]!.threadTs, "1700.1");
  assert.deepEqual(store.handles.filter((h) => h.handle === "slack_thread_ts"), [{ reviewId: "rev_obs:run_1", handle: "slack_thread_ts", key: "C0123ABCD", value: "1700.1" }]);
  assert.equal(store.readById("rev_obs:run_1")?.projection_handles.slack_thread_ts, "1700.1");
});

// §6.D5: "The request stores references (delivery_id / summon_comment_id)".
test("a dispatched delivery records {delivery_id} and a summon records {summon_comment_id} on the request; a re-dispatch updates, never doubles", async () => {
  const { store, github, publisher } = fixture({ github: true });
  store.put(state({ requests: [request({ id: "req_1" }), request({ id: "req_2", assignee: "talos" })] }));
  store.add({ effect_id: "eff_1", kind: "actionable", target: "summon:req_1", payload: { request_id: "req_1", subject_key: `${SHA_A}:main`, text: "@codex review" } });
  store.add({ effect_id: "eff_2", kind: "actionable", target: "delivery:talos:req_2", payload: { actor: "talos", request_id: "req_2", text: "please burn", dedupe_key: "eff_2" } });
  assert.equal(await publisher.drainOnce(), 2);
  assert.equal(github!.comments.length, 1);
  assert.match(github!.comments[0]!, /^@codex review\n\nHive request req_1; effect eff_1; attempt 1\./u);
  const read = store.readById("rev_obs:run_1");
  assert.deepEqual(read?.requests.find((r) => r.id === "req_1")?.transport, [{ summon_comment_id: 701, summon_login: "RationallyPrime" }]);
  assert.deepEqual(read?.requests.find((r) => r.id === "req_2")?.transport, [{ delivery_id: 1 }]);
  // At-least-once: the same effect re-queued reaches the port again and the reference stays one.
  store.row("eff_2").status = "pending";
  await publisher.drainOnce();
  assert.deepEqual(store.readById("rev_obs:run_1")?.requests.find((r) => r.id === "req_2")?.transport, [{ delivery_id: 1 }]);
  assert.equal(store.transport.length, 2);
});

test("a port that answers without an id fails the row visibly instead of recording nothing", async () => {
  const { store, github, publisher } = fixture({ github: true, threadReady: false });
  github!.noIds = true;
  store.add({ effect_id: "eff_1", kind: "refresh", target: "board:rev_obs:run_1" });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await publisher.drainOnce(), 0);
  } finally {
    console.error = quiet;
  }
  assert.equal(store.row("eff_1").status, "pending");
  assert.equal(store.row("eff_1").attempts, 1);
  assert.deepEqual(store.handles, []);
});

// §7 step 3: an `unknown` Codex record is surfaced on the board and the Slack line, never promoted.
test("Codex records the classifier could not read reach the board comment and the Slack board line", async () => {
  const { store, slack, github, publisher } = fixture({ github: true });
  store.unknownRecords.set("rev_obs:run_1", [{
    recordKey: "issue_comment:5550157393",
    version: "2026-09-06T16:00:00Z",
    authorLogin: "chatgpt-codex-connector[bot]",
    htmlUrl: "https://github.com/skrates/hive/pull/7#issuecomment-5550157393",
    excerpt: "### Summary",
  }]);
  store.add({ effect_id: "eff_1", kind: "refresh", target: "board:rev_obs:run_1" });
  await publisher.drainOnce();
  assert.match(github!.boards[0]!.body, /could not read[\s\S]*\[issue_comment:5550157393\]\(https:\/\/github\.com\/skrates\/hive\/pull\/7#issuecomment-5550157393\) by chatgpt-codex-connector\[bot\][^\n]*### Summary/u);
  assert.match(slack.lines[0]!.text, /unreadable codex records 1 \(issue_comment:5550157393\)/u);
});


test("conflict notices leave without a pending review request and obsolete when the subject changes", async () => {
  const { store, slack, publisher } = fixture({ github: true });
  const current = state({ requests: [] });
  current.observed.mergeable = false;
  store.put(current);
  const payload = { actor: "ariadne", subject_key: current.subject.key, text: "Resolve the conflict", dedupe_key: "conflict-1" };
  store.add({ effect_id: "notice-1", kind: "actionable", target: `notice:ariadne:${current.subject.key}`, payload });
  assert.equal(await publisher.drainOnce(), 1);
  assert.equal(slack.wakes.length, 1);
  assert.equal(store.transport.length, 0, "a notice is not review-request transport");
  const oldSubject = current.subject.key;
  current.subject = { ...current.subject, key: `${SHA_B}:main`, head_sha: SHA_B };
  store.put(current);
  store.add({ effect_id: "notice-2", kind: "actionable", target: `notice:ariadne:${oldSubject}`, payload });
  assert.equal(await publisher.drainOnce(), 1);
  assert.equal(store.row("notice-2").status, "obsolete");
  assert.equal(slack.wakes.length, 1);
});

test("missing publication destinations leave board and announcement effects failed", async () => {
  const { store, publisher } = fixture();
  store.policies.set("42:1", policy({ slack: null }));
  const current = state({ lifecycle: "merged" });
  store.put(current);
  store.add({ effect_id: "board-no-sink", reviewId: current.id, kind: "refresh", target: `board:${current.id}` });
  store.add({ effect_id: "announce-no-sink", reviewId: current.id, kind: "actionable", target: `announce:${current.id}`, payload: { review_id: "rev_obs:run_1", text: "merged" } });
  assert.equal(await publisher.drainOnce(), 0);
  for (const id of ["board-no-sink", "announce-no-sink"]) {
    assert.equal(store.row(id).status, "pending");
    assert.equal(store.row(id).attempts, 1);
    assert.ok(store.row(id).nextAttemptAt !== null);
  }
});

test("an uncertain summon retry carries the same request and effect identity with a new attempt", async () => {
  const { store, github, publisher, clock } = fixture({ github: true });
  store.put(state({ requests: [request({ id: "req_1" })] }));
  const post = github!.postComment.bind(github);
  let loseResponse = true;
  github!.postComment = async input => {
    const result = await post(input);
    if (loseResponse) { loseResponse = false; throw new Error("response lost after GitHub accepted POST"); }
    return result;
  };
  store.add({ effect_id: "eff_retry", kind: "actionable", target: "summon:req_1", payload: { request_id: "req_1", subject_key: `${SHA_A}:main`, text: "@codex review" } });
  await publisher.drainOnce();
  assert.equal(store.row("eff_retry").status, "pending");
  clock.advance(60_000);
  await publisher.drainOnce();
  assert.equal(store.row("eff_retry").status, "sent");
  assert.equal(github!.comments.length, 2, "at-least-once permits a duplicate after uncertainty");
  assert.match(github!.comments[0]!, /request req_1; effect eff_retry; attempt 1\./u);
  assert.match(github!.comments[1]!, /request req_1; effect eff_retry; attempt 2\./u);
});

test("a rerouted wake waits for the replacement channel's board parent without spending attempts", async () => {
  const { store, slack, publisher } = fixture();
  store.policies.set("42:2", { ...policy(), version: 2, slack: { channel_id: "C_NEW" } });
  store.put(state({ policy_version: 2, requests: [request({ id: "req_new", assignee: "ariadne" })] }));
  store.add({ effect_id: "eff_wake", kind: "actionable", target: "delivery:ariadne:req_new", payload: { actor: "ariadne", request_id: "req_new", text: "review", dedupe_key: "eff_wake" } });
  store.add({ effect_id: "eff_board", kind: "refresh", target: "board:rev_obs:run_1" });
  await publisher.drainOnce();
  assert.equal(slack.lines.length, 1);
  assert.equal(slack.lines[0]!.channelId, "C_NEW");
  assert.equal(slack.lines[0]!.threadTs, null);
  assert.equal(slack.wakes.length, 0);
  assert.equal(store.row("eff_wake").status, "pending");
  assert.equal(store.row("eff_wake").attempts, 0);
  slack.posted.set(1, "1800.1");
  await publisher.drainOnce();
  assert.equal(slack.wakes.length, 1);
  assert.equal(slack.wakes[0]!.channelId, "C_NEW");
  assert.equal(slack.wakes[0]!.threadTs, "1800.1");
  assert.equal(store.row("eff_wake").status, "sent");
});
