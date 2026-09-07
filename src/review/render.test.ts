import assert from "node:assert/strict";
import test from "node:test";
import type { Reason, ReviewState } from "./contract.js";
import { validateReview, validateReviewState } from "./contract.js";
import { AT, finding, fixedClaim, hold, request, review, SHA_A, SHA_FIX, seat, state } from "./fixtures.js";
import { boardComment, checkRun, describeResolution, firstReason, slackBoardLine, threadOps, threadState } from "./render.js";

function notReady(reasons: [Reason, ...Reason[]], overrides: Partial<ReviewState> = {}): ReviewState {
  return state({ ...overrides, readiness: { ready: false, subject_key: `${SHA_A}:main`, reasons } });
}

test("fixtures conform to the vendored contract", () => {
  const validReview = validateReview(review({ requests: [request()], findings: [finding()], holds: [hold()] }));
  assert.equal(validReview.ok, true, validReview.ok ? "" : validReview.detail);
  const validState = validateReviewState(notReady([{ hold: "operator" }, "draft"], { holds: [hold()] }));
  assert.equal(validState.ok, true, validState.ok ? "" : validState.detail);
});

// §8.1: success ⇔ readiness.ready. Nothing about the rest of the state changes that.
test("check run is success exactly when readiness.ready, whatever else the state holds", () => {
  const ready = state({ findings: [finding({ priority: "P3" })], holds: [hold({ released: { by: seat("x"), at: AT, reason: "done" } })] });
  const render = checkRun(ready);
  assert.equal(render.name, "weave/review");
  assert.equal(render.conclusion, "success");
  assert.match(render.title, /^ready at aaaaaaa$/);
  assert.match(render.summary, /Blocking findings: none/);
});

// §8.1 precedence: merged > closed > hold > exhausted > required request pending >
// requirement unsatisfied > blocking findings > draft. Each row hands the renderer the
// reasons in the WRONG order and expects the higher-precedence one in the title.
const PRECEDENCE_TABLE: Array<{ lower: Reason; higher: Reason; title: RegExp }> = [
  { lower: "closed", higher: "merged", title: /^merged$/ },
  { lower: { hold: "operator" }, higher: "closed", title: /^closed$/ },
  { lower: "exhausted", higher: { hold: "human_gate" }, title: /^hold: human_gate$/ },
  { lower: { required_request_pending: ["req_1"] }, higher: "exhausted", title: /rounds exhausted/ },
  { lower: { requirement_unsatisfied: [`${SHA_A}:main`] }, higher: { required_request_pending: ["req_1"] }, title: /^required request pending: req_1$/ },
  { lower: { blocking_findings: ["fnd_1"] }, higher: { requirement_unsatisfied: [`${SHA_A}:main`] }, title: /^requirement unsatisfied at/ },
  { lower: "draft", higher: { blocking_findings: ["fnd_1", "fnd_2"] }, title: /^blocking findings: fnd_1, fnd_2$/ },
  { lower: "incomplete_answer", higher: "draft", title: /^draft$/ },
];

test("check run failure title is the first reason in §8.1 precedence, not in listed order", () => {
  for (const row of PRECEDENCE_TABLE) {
    const render = checkRun(notReady([row.lower, row.higher]));
    assert.equal(render.conclusion, "failure");
    assert.match(render.title, row.title, JSON.stringify(row));
    assert.deepEqual(firstReason([row.lower, row.higher]), row.higher);
  }
  // The full ladder at once: merged wins over everything.
  const everything: [Reason, ...Reason[]] = [
    "draft", { blocking_findings: ["f"] }, { requirement_unsatisfied: ["s"] },
    { required_request_pending: ["r"] }, "exhausted", { hold: "stack" }, "closed", "merged",
  ];
  assert.equal(checkRun(notReady(everything)).title, "merged");
});

// F-15: the conclusion type admits only success | failure. This test pins the runtime
// value set across every reachable branch so a future "neutral for drafts" cannot slip in.
test("check run never publishes neutral or skipped", () => {
  const states = [
    state(),
    notReady(["draft"]),
    notReady(["closed"]),
    notReady(["merged"], { lifecycle: "merged" }),
    notReady(["incomplete_answer"]),
    notReady([{ hold: "exhaustion" }, "exhausted"]),
  ];
  for (const candidate of states) {
    const { conclusion } = checkRun(candidate);
    assert.ok(conclusion === "success" || conclusion === "failure", conclusion);
  }
});

test("check run summary lists blocking findings, pending requests, holds, rounds and conflicts", () => {
  const pendingRequest = request({ id: "req_x", assignee: "ariadne", required: true });
  const blocker = finding({ id: "fnd_9", priority: "P0", title: "Leaks the token" });
  const conflicting = notReady([{ blocking_findings: ["fnd_9"] }], {
    requests: [pendingRequest],
    findings: [blocker],
    holds: [hold({ kind: "operator", id: "hold_7" })],
    charges: [{ subject_key: `${SHA_A}:main`, answer_id: "ans_1", at: AT }],
  });
  conflicting.observed = { ...conflicting.observed, mergeable: false };
  const { summary } = checkRun(conflicting);
  assert.match(summary, /Blocking findings: fnd_9 \(P0\) Leaks the token/);
  assert.match(summary, /Pending requests: req_x → ariadne \(required\)/);
  assert.match(summary, /Holds: operator \(hold_7\)/);
  assert.match(summary, /Rounds: 1\/7 rounds consumed/);
  assert.match(summary, /Conflicting against main @ bbbbbbb/);
});

// §8.1 board: "fixed, claimed by talos @ sha, unconfirmed" — a claim is never dressed as a
// confirmation; a confirmed fix names the closure answer.
test("board renders an unconfirmed fixed claim as a claim, and a confirmed one as confirmed", () => {
  const claimed = finding({ id: "fnd_1", status: { open: false, resolution: fixedClaim() } });
  const confirmed = finding({ id: "fnd_2", status: { open: false, resolution: fixedClaim({ confirmed_by: "ans_3" }) } });
  const board = boardComment(state({ findings: [claimed, confirmed] }));
  assert.match(board, /fnd_1[^\n]*fixed, claimed by talos @ 1234567, unconfirmed/);
  assert.match(board, /fnd_2[^\n]*fixed, claimed by talos @ 1234567, confirmed by ans_3/);
  assert.equal(describeResolution(fixedClaim()), `fixed, claimed by talos @ ${SHA_FIX.slice(0, 7)}, unconfirmed`);
});

// §8.1 / V-4: unknown-severity findings prominently — their own section, ahead of everything.
test("board puts unknown-severity findings in their own section before the blocking list", () => {
  const unknown = finding({ id: "fnd_u", priority: "unknown", title: "No badge on this one" });
  const blocker = finding({ id: "fnd_b", priority: "P1" });
  const board = boardComment(state({ findings: [blocker, unknown] }));
  const unknownAt = board.indexOf("Findings of unknown severity");
  const blockingAt = board.indexOf("### Blocking findings");
  assert.ok(unknownAt >= 0, "has the unknown-severity section");
  assert.ok(unknownAt < blockingAt, "unknown section precedes blocking section");
  assert.match(board.slice(unknownAt, blockingAt), /fnd_u[^\n]*No badge on this one/);
});

test("board renders requests with transport references, holds, charges and the gate text", () => {
  const withTransport = request({
    id: "req_1",
    assignee: "codex",
    transport: [{ summon_comment_id: 5150, summon_login: "RationallyPrime" }],
  });
  const seatRequest = request({
    id: "req_2",
    assignee: "talos",
    mode: "closure",
    names: ["fnd_1"],
    supersedes: "req_0",
    transport: [{ delivery_id: 88 }],
  });
  const exhausted = state({
    requests: [withTransport, seatRequest],
    holds: [hold({ id: "hold_e", kind: "exhaustion", by: { kind: "system", caused_by: "act_9" }, reason: "rounds spent", blocks: { readiness: true, summons: true } })],
    charges: [{ subject_key: `${SHA_A}:main`, answer_id: "ans_1", at: AT }],
    episodes: [{ id: "ep_1", opened_at: AT, hold_id: "hold_e", closed: null }],
    findings: [finding()],
    availability: { codex: { available: false, since: AT, reason: "quota", until: null, evidence: "429 from the connector" } },
  });
  const board = boardComment(exhausted);
  assert.match(board, /req_1[^\n]*review\/initial → codex[^\n]*summon comment 5150/);
  assert.match(board, /req_2[^\n]*review\/closure → talos[^\n]*naming fnd_1 \(supersedes req_0\)[^\n]*delivery 88/);
  assert.match(board, /hold_e[^\n]*exhaustion by system[^\n]*rounds spent[^\n]*blocks summons/);
  assert.match(board, /charged at 2026-09-06T12:00:00.000Z by answer `ans_1`/);
  assert.match(board, /### 🛑 Review rounds exhausted/);
  assert.match(board, /Episode `ep_1`[^\n]*grants rounds/);
  assert.match(board, /codex unavailable since[^\n]*quota[^\n]*429 from the connector/);
});

// §11 #9: the board shows the prior claim on a contested finding.
test("board shows the prior claim on a contested finding and its same_as links", () => {
  const contested = finding({
    id: "fnd_1",
    status: { open: true, contested: { by: "codex", at: AT, prior: fixedClaim() } },
    links: [{ other: "fnd_2", relation: "same_as", by: seat("talos"), at: AT }],
  });
  const board = boardComment(state({ findings: [contested] }));
  assert.match(board, /fnd_1[^\n]*same as fnd_2[^\n]*contested by codex[^\n]*prior claim: fixed, claimed by talos @ 1234567, unconfirmed/);
});

test("board says conflicting while mergeable is false (§D8)", () => {
  const conflicting = state();
  conflicting.observed = { ...conflicting.observed, mergeable: false };
  assert.match(boardComment(conflicting), /Conflicting against `main` @ bbbbbbb/);
  assert.doesNotMatch(boardComment(state()), /Conflicting/);
});

test("slack board line is one line naming the review, head, readiness, rounds and what is pending", () => {
  const line = slackBoardLine(notReady([{ required_request_pending: ["req_1"] }], {
    requests: [request({ id: "req_1", assignee: "codex" })],
    findings: [finding({ priority: "unknown" })],
    holds: [hold({ kind: "stack", release_on: "subject_change" })],
  }));
  assert.equal(line.includes("\n"), false);
  assert.match(line, /^skrates\/hive#7 @ aaaaaaa · not ready — required request pending: req_1 · rounds 0\/7 · blocking 1 · unknown-severity 1 · pending req_1→codex · holds stack$/);
  assert.match(slackBoardLine(state()), /^skrates\/hive#7 @ aaaaaaa · ready at aaaaaaa · rounds 0\/7 · blocking 0$/);
});

// §8.1 (ruled): a container's thread resolves once every finding in it is closed, and
// un-resolves as soon as any is open or contested; only a `review_comment` container has one.
test("thread ops: resolve on close, unresolve on contest or re-open, nothing for reviewkit sources", () => {
  const at = (locator: number) => ({ container_kind: "review_comment" as const, comment_id: 9001, locator });
  const open = finding({ id: "fnd_1", source: at(0) });
  const closed = finding({ id: "fnd_1", source: at(0), status: { open: false, resolution: fixedClaim() } });
  const contested = finding({
    id: "fnd_1",
    source: at(0),
    status: { open: true, contested: { by: "codex", at: AT, prior: fixedClaim() } },
  });
  const kitOpen = finding({ id: "fnd_k", source: { fingerprint: "fp", semantic_key: "sk" } });
  const kitClosed = finding({ id: "fnd_k", source: { fingerprint: "fp", semantic_key: "sk" }, status: { open: false, resolution: fixedClaim() } });

  assert.deepEqual(threadOps(review({ findings: [open, kitOpen] }), review({ findings: [closed, kitClosed] })), [{ comment_id: 9001, op: "resolve" }]);
  assert.deepEqual(threadOps(review({ findings: [closed] }), review({ findings: [contested] })), [{ comment_id: 9001, op: "unresolve" }]);
  assert.deepEqual(threadOps(review({ findings: [closed] }), review({ findings: [open] })), [{ comment_id: 9001, op: "unresolve" }]);
  // A freshly admitted open finding and an unchanged one produce nothing.
  assert.deepEqual(threadOps(null, review({ findings: [open] })), []);
  assert.deepEqual(threadOps(review({ findings: [open] }), review({ findings: [open] })), []);
  // A finding that first appears already closed still resolves its thread.
  assert.deepEqual(threadOps(null, review({ findings: [closed] })), [{ comment_id: 9001, op: "resolve" }]);

  // The refresh view: the thread's desired state from the Review now.
  assert.equal(threadState(review({ findings: [closed] }), 9001), "resolve");
  assert.equal(threadState(review({ findings: [contested] }), 9001), "unresolve");
  assert.equal(threadState(review({ findings: [kitClosed] }), 9001), null);
  const issue = finding({ source: { container_kind: "issue_comment", comment_id: 9001, locator: 0 } });
  assert.equal(threadState(review({ findings: [issue, closed] }), 9001), "resolve", "issue and review comments have separate numeric id namespaces");
});

// §8.1 (ruled): the container is the thread, not the finding — one `review_comment` can carry
// more than one finding, and an `issue_comment` container carries no thread at all.
test("a container's thread follows all of its findings, and an issue-comment container has none", () => {
  const reviewComment = (locator: number, closedAt: boolean) =>
    finding({
      id: `fnd_${locator}`,
      source: { container_kind: "review_comment", comment_id: 9001, locator },
      ...(closedAt ? { status: { open: false, resolution: fixedClaim() } as const } : {}),
    });
  const bothOpen = review({ findings: [reviewComment(0, false), reviewComment(1, false)] });
  const oneClosed = review({ findings: [reviewComment(0, true), reviewComment(1, false)] });
  const bothClosed = review({ findings: [reviewComment(0, true), reviewComment(1, true)] });

  // All-findings rule: one open finding keeps the whole container un-resolved.
  assert.equal(threadState(bothOpen, 9001), "unresolve");
  assert.equal(threadState(oneClosed, 9001), "unresolve", "the first finding closing is not the container closing");
  assert.equal(threadState(bothClosed, 9001), "resolve");

  // One op per container, on the container's flip — never one per finding.
  assert.deepEqual(threadOps(bothOpen, oneClosed), []);
  assert.deepEqual(threadOps(oneClosed, bothClosed), [{ comment_id: 9001, op: "resolve" }]);
  assert.deepEqual(threadOps(bothClosed, oneClosed), [{ comment_id: 9001, op: "unresolve" }]);
  assert.deepEqual(threadOps(bothOpen, bothClosed), [{ comment_id: 9001, op: "resolve" }], "two findings, one resolve");

  // An issue comment carries many findings and no review thread: it is never a thread target.
  const inline = (locator: number) =>
    finding({
      id: `fnd_i${locator}`,
      source: { container_kind: "issue_comment", comment_id: 5420521329, locator },
      status: { open: false, resolution: fixedClaim() },
    });
  const inlineOpen = review({ findings: [finding({ id: "fnd_i0", source: { container_kind: "issue_comment", comment_id: 5420521329, locator: 0 } })] });
  const inlineClosed = review({ findings: [inline(0)] });
  assert.deepEqual(threadOps(inlineOpen, inlineClosed), []);
  assert.equal(threadState(inlineClosed, 5420521329), null);
});

// §7 step 3: `unknown` is surfaced on the board, never promoted — ahead of the findings, with a link.
test("board and Slack line surface Codex records the classifier could not read, ahead of the findings", () => {
  const records = [
    { recordKey: "issue_comment:5550157393", version: "2026-09-06T16:00:00Z", authorLogin: "chatgpt-codex-connector[bot]", htmlUrl: "https://github.com/skrates/hive/pull/7#issuecomment-5550157393", excerpt: "### Summary" },
    { recordKey: "review:5125461304", version: "2026-09-05T10:00:00Z", authorLogin: "chatgpt-codex-connector[bot]", htmlUrl: null, excerpt: "" },
  ];
  const board = boardComment(state({ findings: [finding()] }), records);
  const unknownAt = board.indexOf("Codex records the classifier could not read");
  const blockingAt = board.indexOf("### Blocking findings");
  assert.ok(unknownAt >= 0 && unknownAt < blockingAt, "the unreadable-records section precedes the findings");
  assert.match(board, /\[issue_comment:5550157393\]\(https:\/\/github\.com\/skrates\/hive\/pull\/7#issuecomment-5550157393\) by chatgpt-codex-connector\[bot\] @ 2026-09-06T16:00:00Z — "### Summary"/u);
  assert.match(board, /`review:5125461304` by chatgpt-codex-connector\[bot\] @ 2026-09-05T10:00:00Z\n/u);
  assert.doesNotMatch(boardComment(state()), /could not read/u);
  assert.match(slackBoardLine(state(), records), /unreadable codex records 2 \(issue_comment:5550157393 review:5125461304\)/u);
  assert.doesNotMatch(slackBoardLine(state()), /unreadable/u);
});

// §6.D6: the board says how often housekeeping re-transported and when.
test("board shows a request's re-transports", () => {
  const board = boardComment(state({ requests: [request({ id: "req_1", retransports: [AT, "2026-09-06T12:20:00.000Z"] })] }));
  assert.match(board, /req_1[^\n]*no transport yet; re-transported 2× \(last 2026-09-06T12:20:00.000Z\)/u);
  assert.doesNotMatch(boardComment(state({ requests: [request({ id: "req_1" })] })), /re-transported/u);
});
