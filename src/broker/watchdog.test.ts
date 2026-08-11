import assert from "node:assert/strict";
import test from "node:test";
import { SlackDeafnessWatchdog, type WatchdogPort } from "./watchdog.js";

const STALE_MS = 300_000;

interface PortState {
  nowMs: number;
  lastEventMs: number | null;
  lastConnectMs: number | null;
  active: boolean;
  restarts: number;
  exits: number[];
  logs: string[];
  /**
   * How a forced restart maps to transport liveness, mirroring production:
   *   "reconnects" — the socket re-establishes (a fresh `connected` fires) but,
   *      crucially, no event arrives, so `lastEventMs` is left untouched. This is
   *      the up-but-deaf shape the old test elided by never touching activity.
   *   "recovers"   — the reconnect re-establishes AND events resume.
   *   "wedged"     — the reconnect never re-establishes (no `connected`).
   */
  restartOutcome: "reconnects" | "recovers" | "wedged";
}

function makePort(overrides: Partial<PortState> = {}): { port: WatchdogPort; state: PortState } {
  const state: PortState = {
    nowMs: 1_000_000,
    lastEventMs: 1_000_000,
    lastConnectMs: 1_000_000,
    active: true,
    restarts: 0,
    exits: [],
    logs: [],
    restartOutcome: "reconnects",
    ...overrides,
  };
  const port: WatchdogPort = {
    lastEventAt: () => state.lastEventMs,
    lastConnectAt: () => state.lastConnectMs,
    hasActiveSubscription: () => state.active,
    restart: async () => {
      state.restarts += 1;
      // Production-faithful: SlackSocketIngress.start() stamps a `connected`
      // transition when the transport re-establishes, and events (if any) stamp
      // a separate event clock. The reconnect on its own never advances events.
      if (state.restartOutcome !== "wedged") state.lastConnectMs = state.nowMs;
      if (state.restartOutcome === "recovers") state.lastEventMs = state.nowMs;
    },
    exit: (code) => { state.exits.push(code); },
    now: () => state.nowMs,
    log: (message) => { state.logs.push(message); },
  };
  return { port, state };
}

test("watchdog does nothing while no subscription is live — silence is expected", async () => {
  const { port, state } = makePort({ active: false, lastEventMs: 0 });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "idle_no_subscription");
  assert.equal(state.restarts, 0);
  assert.deepEqual(state.exits, []);
});

test("watchdog is healthy while events are recent", async () => {
  const { port, state } = makePort({ lastEventMs: 1_000_000 - 1_000 });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "healthy");
  assert.equal(state.restarts, 0);
});

test("watchdog forces a reconnect on the first deaf cycle", async () => {
  const { port, state } = makePort({ lastEventMs: 1_000_000 - (STALE_MS + 1_000) });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  assert.equal(state.restarts, 1);
  assert.deepEqual(state.exits, []);
  assert.ok(state.logs.some((line) => line.includes("forcing a Socket Mode reconnect")));
});

test("an up-but-deaf link gets one more reconnect, then exits when still silent (2026-08-11 escalation)", async () => {
  // Incident 2026-08-11: in-process reconnects never recovered a deaf stream
  // (8+ consecutive deaf cycles); only a process restart did, three for three.
  // The watchdog therefore spends a bounded reconnect budget and then exits(1)
  // for the supervisor instead of self-healing forever.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    restartOutcome: "reconnects",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // A full window later the reconnect took (connected is fresh) but no event ever came.
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "reconnected_still_deaf");
  assert.deepEqual(state.exits, [], "budget not yet spent — one retry remains");
  assert.equal(state.restarts, 2);
  assert.ok(state.logs.some((line) => line.includes("up-but-deaf")));
  // Another full window and the second reconnect also brought no events: exit.
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1], "reconnect budget exhausted — escalate to supervisor restart");
  assert.equal(state.restarts, 2, "no third reconnect once we escalate to exit");
  assert.ok(state.logs.some((line) => line.includes("reconnects are exhausted")));
});

test("watchdog exits when a forced reconnect fails to re-establish the transport", async () => {
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    // Freeze the connect clock in the past so no reconnect can advance it.
    lastConnectMs: 1_000_000 - (STALE_MS + 1_000),
    restartOutcome: "wedged",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // The reconnect never re-established: connected is still stale one window later.
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1]);
  assert.equal(state.restarts, 1, "no second restart once we escalate to exit");
  assert.ok(state.logs.some((line) => line.includes("did not re-establish")));
});

test("watchdog recovery resets the streak — a reconnect that brings events back does not escalate", async () => {
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    restartOutcome: "recovers",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // Events resumed after the reconnect (restartOutcome "recovers" stamped the event clock).
  state.nowMs += 10_000;
  assert.equal(await watchdog.check(), "healthy");
  // A later silence starts a fresh streak — restart again, not an immediate exit.
  state.nowMs += STALE_MS + 1_000;
  assert.equal(await watchdog.check(), "restarted");
  assert.equal(state.restarts, 2);
  assert.deepEqual(state.exits, []);
});

test("a never-connected transport that also never received an event is exited", async () => {
  // Nothing ever came up: no event, and the reconnect can't re-establish either.
  const { port, state } = makePort({
    lastEventMs: null,
    lastConnectMs: null,
    restartOutcome: "wedged",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1]);
});
