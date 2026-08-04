import assert from "node:assert/strict";
import test from "node:test";
import { SlackDeafnessWatchdog, type WatchdogPort } from "./watchdog.js";

const STALE_MS = 300_000;

interface PortState {
  nowMs: number;
  lastMs: number | null;
  active: boolean;
  restarts: number;
  exits: number[];
  logs: string[];
}

function makePort(overrides: Partial<PortState> = {}): { port: WatchdogPort; state: PortState } {
  const state: PortState = {
    nowMs: 1_000_000,
    lastMs: 1_000_000,
    active: true,
    restarts: 0,
    exits: [],
    logs: [],
    ...overrides,
  };
  const port: WatchdogPort = {
    lastActivityAt: () => state.lastMs,
    hasActiveSubscription: () => state.active,
    restart: async () => { state.restarts += 1; },
    exit: (code) => { state.exits.push(code); },
    now: () => state.nowMs,
    log: (message) => { state.logs.push(message); },
  };
  return { port, state };
}

test("watchdog does nothing while no subscription is live — silence is expected", async () => {
  const { port, state } = makePort({ active: false, lastMs: 0 });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "idle_no_subscription");
  assert.equal(state.restarts, 0);
  assert.deepEqual(state.exits, []);
});

test("watchdog is healthy while events are recent", async () => {
  const { port, state } = makePort({ lastMs: 1_000_000 - 1_000 });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "healthy");
  assert.equal(state.restarts, 0);
});

test("watchdog forces a reconnect on the first deaf cycle", async () => {
  const { port, state } = makePort({ lastMs: 1_000_000 - (STALE_MS + 1_000) });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  assert.equal(state.restarts, 1);
  assert.deepEqual(state.exits, []);
  assert.ok(state.logs.some((line) => line.includes("forcing a Socket Mode reconnect")));
});

test("watchdog exits on a second consecutive deaf cycle", async () => {
  const { port, state } = makePort({ lastMs: 1_000_000 - (STALE_MS + 1_000) });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // The reconnect brought no events; the link is still silent one cycle later.
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1]);
  assert.equal(state.restarts, 1, "no second restart once we escalate to exit");
  assert.ok(state.logs.some((line) => line.includes("exiting(1)")));
});

test("watchdog recovery resets the streak — a reconnect that works does not escalate", async () => {
  const { port, state } = makePort({ lastMs: 1_000_000 - (STALE_MS + 1_000) });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // An event arrives after the reconnect: activity is fresh again.
  state.nowMs += 10_000;
  state.lastMs = state.nowMs;
  assert.equal(await watchdog.check(), "healthy");
  // A later silence starts a fresh streak — restart again, not an immediate exit.
  state.nowMs += STALE_MS + 1_000;
  assert.equal(await watchdog.check(), "restarted");
  assert.equal(state.restarts, 2);
  assert.deepEqual(state.exits, []);
});

test("watchdog treats never-having-received an event as deaf", async () => {
  const { port, state } = makePort({ lastMs: null });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1]);
});
