import assert from "node:assert/strict";
import test from "node:test";
import { EdgeLivenessWatchdog, type EdgeWatchdogPort } from "./watchdog.js";

const STALE_MS = 300_000;

interface Harness {
  port: EdgeWatchdogPort;
  logs: string[];
  exits: number[];
  setPoll(at: number | null): void;
  setSaturated(value: boolean): void;
  advance(ms: number): void;
}

function harness(initial: { pollAt?: number | null; saturated?: boolean } = {}): Harness {
  let clock = 1_000_000;
  let pollAt: number | null = initial.pollAt === undefined ? clock : initial.pollAt;
  let saturated = initial.saturated ?? false;
  const logs: string[] = [];
  const exits: number[] = [];
  return {
    logs,
    exits,
    setPoll: (at) => { pollAt = at; },
    setSaturated: (value) => { saturated = value; },
    advance: (ms) => { clock += ms; },
    port: {
      lastPollAt: () => pollAt,
      saturated: () => saturated,
      exit: (code) => { exits.push(code); },
      now: () => clock,
      log: (message) => { logs.push(message); },
    },
  };
}

test("a poll inside the window is healthy and never exits", () => {
  const h = harness();
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  h.advance(STALE_MS - 1);
  assert.equal(watchdog.check(), "healthy");
  assert.deepEqual(h.exits, []);
});

test("two consecutive stale cycles exit for the supervisor; one does not", () => {
  const h = harness();
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  h.advance(STALE_MS);
  // First stale cycle logs loudly and holds — a single broker blip must not
  // bounce every edge on the tailnet.
  assert.equal(watchdog.check(), "stale");
  assert.deepEqual(h.exits, []);
  assert.ok(h.logs.some((line) => /stale cycle 1 of 2/.test(line)));

  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "exited");
  assert.deepEqual(h.exits, [1]);
  assert.ok(h.logs.some((line) => /the edge is deaf; exiting\(1\)/.test(line)));
});

test("a completed poll between stale cycles resets the budget", () => {
  const h = harness();
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "stale");
  // The loop recovered on its own and reached the broker.
  h.advance(1_000);
  h.setPoll(h.port.now());
  assert.equal(watchdog.check(), "healthy");
  // The next stale window must start a fresh budget, not inherit the old streak.
  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "stale");
  assert.deepEqual(h.exits, []);
});

test("a saturated edge is never exited, however long since its last poll", () => {
  // Every dispatch slot is running a turn, so the loop is legitimately not
  // polling. Silence proves nothing here; the dispatch deadline is what keeps
  // this window finite.
  const h = harness({ saturated: true });
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  h.advance(STALE_MS * 100);
  assert.equal(watchdog.check(), "saturated");
  assert.equal(watchdog.check(), "saturated");
  assert.equal(watchdog.check(), "saturated");
  assert.deepEqual(h.exits, []);
});

test("saturation does not forgive the windows it covered — a still-deaf edge after it exits", () => {
  // Deliberate: the polls genuinely did not happen. Resetting the streak on
  // saturation would let an edge that alternates saturated/stale never escalate.
  const h = harness();
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "stale");
  h.setSaturated(true);
  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "saturated");
  h.setSaturated(false);
  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "exited");
  assert.deepEqual(h.exits, [1]);
});

test("a poll that recovered before the slots filled resets the streak even while saturated", () => {
  // Stale once, then the broker comes back and the edge fills every slot
  // before the next check. The early saturated return used to skip lastPollAt
  // and keep streak=1; the first free-slot check then exited a recovered edge
  // before its next long-poll could complete.
  const h = harness();
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "stale");

  h.advance(1_000);
  h.setPoll(h.port.now());
  h.setSaturated(true);
  assert.equal(watchdog.check(), "saturated");

  h.advance(STALE_MS);
  h.setSaturated(false);
  assert.equal(watchdog.check(), "stale");
  assert.deepEqual(h.exits, []);
});

test("a still-fresh poll timestamp resets the streak on a saturated check even without advancement", () => {
  // The first observation of lastPollAt used to skip the reset (seenPollAt is
  // undefined). A stale cycle, then a check that sees the same fresh stamp
  // while saturated, must not keep streak=1 for the next free-slot window.
  const h = harness();
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  h.advance(STALE_MS);
  assert.equal(watchdog.check(), "stale");

  const recoveredAt = h.port.now() + 1_000;
  h.advance(1_000);
  h.setPoll(recoveredAt);
  h.setSaturated(true);
  assert.equal(watchdog.check(), "saturated");
  // Same lastPollAt as the saturated observation — no advancement — but still
  // inside the window. The next desaturated check must start a fresh budget.
  h.advance(1);
  assert.equal(watchdog.check(), "saturated");

  h.advance(STALE_MS);
  h.setSaturated(false);
  assert.equal(watchdog.check(), "stale");
  assert.deepEqual(h.exits, []);
});

test("an edge that has never completed a poll since boot is stale, not healthy", () => {
  // The wedge shape: the very first claim never returns. Treating "no evidence"
  // as health is exactly the mistake that kept the cx53 edge alive and deaf.
  const h = harness({ pollAt: null });
  const watchdog = new EdgeLivenessWatchdog(h.port, STALE_MS);
  assert.equal(watchdog.check(), "stale");
  assert.equal(watchdog.check(), "exited");
  assert.deepEqual(h.exits, [1]);
  assert.ok(h.logs.some((line) => /no completed poll since boot/.test(line)));
});
