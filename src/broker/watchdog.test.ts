import assert from "node:assert/strict";
import test from "node:test";
import type { ProbeOutcome } from "./probe.js";
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
  /**
   * What the link probe reports. The default is "silent" — the canaries were
   * posted and never came home — which is the only silence the escalation is
   * allowed to act on, so every deafness scenario below states it explicitly.
   */
  probeOutcome: ProbeOutcome;
  /** Probe rounds run, so a cycle that must not probe can be pinned. */
  probes: number;
  /** A probe implementation that throws instead of reporting an outcome. */
  probeThrows: boolean;
  /** Held by a test that needs a probe round still running when the next cycle fires. */
  probeGate: Promise<void> | null;
  /** A reconnect that never returns — a hung disconnect or Socket Mode handshake. */
  restartHangs: boolean;
  /** A reconnect that rejects outright. */
  restartThrows: boolean;
  /** A genuine Slack event lands while the probe is waiting on the link. */
  eventArrivesDuringProbe: boolean;
  /** Wall time the probe round consumes, so a short `staleMs` can outrun it. */
  probeTakesMs: number;
  /** The last live subscription goes away while the probe is running. */
  subscriptionEndsDuringProbe: boolean;
  /** Wall time a reconnect consumes before the transport comes up. */
  restartTakesMs: number;
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
    probeOutcome: "silent",
    probes: 0,
    probeThrows: false,
    probeGate: null,
    restartHangs: false,
    restartThrows: false,
    eventArrivesDuringProbe: false,
    probeTakesMs: 0,
    subscriptionEndsDuringProbe: false,
    restartTakesMs: 0,
    ...overrides,
  };
  const port: WatchdogPort = {
    lastEventAt: () => state.lastEventMs,
    lastConnectAt: () => state.lastConnectMs,
    hasActiveSubscription: () => state.active,
    probeLink: async () => {
      state.probes += 1;
      if (state.probeGate) await state.probeGate;
      if (state.eventArrivesDuringProbe) state.lastEventMs = state.nowMs;
      state.nowMs += state.probeTakesMs;
      if (state.subscriptionEndsDuringProbe) state.active = false;
      if (state.probeThrows) throw new Error("probe blew up");
      return state.probeOutcome;
    },
    restart: async () => {
      state.restarts += 1;
      if (state.restartHangs) return new Promise<void>(() => {});
      if (state.restartThrows) throw new Error("socket refused to come back");
      // A reconnect is not instant: the clock moves before the socket is up.
      state.nowMs += state.restartTakesMs;
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
  assert.equal(state.probes, 0, "no subscription — nothing to probe for");
});

test("watchdog is healthy while events are recent", async () => {
  const { port, state } = makePort({ lastEventMs: 1_000_000 - 1_000 });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "healthy");
  assert.equal(state.restarts, 0);
  assert.equal(state.probes, 0, "traffic is flowing — the link needs no canary");
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

test("a quiet channel whose canaries come home is not deaf — no reconnect, no exit (KRA-1357)", async () => {
  // 2026-09-05 05:35Z: three of these windows in a row exited the broker while
  // an addressed probe was answered in under a second. Silence is not evidence.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeOutcome: "alive",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "quiet_not_deaf");
  assert.ok(state.logs.some((line) => line.includes("quiet, not deaf")));
  // Two more silent windows: a quiet night must never accrue toward an exit.
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "quiet_not_deaf");
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "quiet_not_deaf");
  assert.equal(state.restarts, 0, "a live link is never reconnected");
  assert.deepEqual(state.exits, []);
  assert.equal(state.probes, 3, "every stale cycle asks the link, none assumes");
});

test("a link that stops carrying our canaries still escalates to exit", async () => {
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    restartOutcome: "reconnects",
    probeOutcome: "silent",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "reconnected_still_deaf");
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1]);
  assert.equal(state.probes, 3, "each escalation step is probed first");
});

test("a canary that comes home mid-escalation resets the streak before the exit", async () => {
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeOutcome: "silent",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // The link answers on the next window: whatever the silence was, it is over.
  state.nowMs += STALE_MS;
  state.probeOutcome = "alive";
  assert.equal(await watchdog.check(), "quiet_not_deaf");
  // A later unexplained silence starts a FRESH streak — a reconnect, not an exit.
  state.nowMs += STALE_MS;
  state.probeOutcome = "silent";
  assert.equal(await watchdog.check(), "restarted");
  assert.equal(state.restarts, 2);
  assert.deepEqual(state.exits, [], "the streak was reset by live evidence");
});

test("a probe that cannot be posted proves nothing — escalation falls back to transport evidence", async () => {
  // Slack's Web API being unreachable is not evidence of a deaf socket. The old
  // behaviour is the honest fallback, and it says so in the log.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    restartOutcome: "reconnects",
    probeOutcome: "unavailable",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  assert.ok(state.logs.some((line) => line.includes("link probe was unavailable")));
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "reconnected_still_deaf");
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1]);
});

test("a throwing probe is unproven, never deaf — the cycle still decides", async () => {
  // A probe that raises must not abort the cycle: that would leave a genuinely
  // deaf broker undetected forever, which is the failure the watchdog exists for.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeThrows: true,
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  assert.equal(state.restarts, 1);
  assert.ok(state.logs.some((line) => line.includes("link probe was unavailable")));
});

test("a cycle that is still probing refuses the next one — silence is never counted twice", async () => {
  // The interval is `staleMs`, but a probe round waits on the link. Overlapping
  // cycles would post two canary rounds and double-count one silence.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeOutcome: "alive",
  });
  let release!: () => void;
  state.probeGate = new Promise<void>((resolve) => { release = resolve; });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  const first = watchdog.check();
  assert.equal(await watchdog.check(), "cycle_in_flight");
  assert.equal(state.probes, 1, "the overlapping cycle never probes");
  assert.ok(state.logs.some((line) => line.includes("still in flight")));
  release();
  assert.equal(await first, "quiet_not_deaf");
  assert.equal(state.restarts, 0);
  assert.deepEqual(state.exits, []);
});

/** Short bounds so the deadline tests run in milliseconds, not seconds. */
const FAST_PROBE_MS = 20;
const FAST_RESTART_MS = 20;

test("a forced reconnect that never returns does not wedge the cycle", async () => {
  // `restart()` awaits a WebSocket disconnect and a Socket Mode handshake,
  // neither bounded by the SDK. An unbounded await inside the single-flight
  // cycle would leave `cycleInFlight` true forever and skip every later
  // interval — the watchdog silently switched off.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    lastConnectMs: 1_000_000 - (STALE_MS + 1_000),
    restartHangs: true,
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS, FAST_PROBE_MS, FAST_RESTART_MS);
  assert.equal(await watchdog.check(), "restarted");
  assert.ok(state.logs.some((line) => line.includes("did not complete")));
  // The cycle released, so the next one runs — and the hung reconnect left the
  // connect clock stale, which is the wedged-transport evidence it exits on.
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
  assert.deepEqual(state.exits, [1]);
});

test("a forced reconnect that rejects is reported, not swallowed", async () => {
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    lastConnectMs: 1_000_000 - (STALE_MS + 1_000),
    restartThrows: true,
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS, FAST_PROBE_MS, FAST_RESTART_MS);
  assert.equal(await watchdog.check(), "restarted");
  assert.ok(state.logs.some((line) => line.includes("did not complete")));
  assert.ok(
    state.logs.every((line) => !line.includes("socket refused to come back")),
    "the error TYPE only — a transport error can carry body text",
  );
  state.nowMs += STALE_MS;
  assert.equal(await watchdog.check(), "exited");
});

test("a wake that lands while the probe runs ends the cycle — even when the probe proves nothing", async () => {
  // The probe waits on the link for up to a full round. Real traffic arriving in
  // that window disproves the silence directly, and outranks a probe that could
  // not even be posted.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeOutcome: "unavailable",
    eventArrivesDuringProbe: true,
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "healthy");
  assert.equal(state.restarts, 0, "the link is demonstrably carrying events");
  assert.deepEqual(state.exits, []);
  assert.ok(state.logs.some((line) => line.includes("arrived while the link probe ran")));
});

test("an event that arrives during a probe longer than the stale window still counts", async () => {
  // `HIVE_WATCHDOG_STALE_MS` is allowed down to 10s while a probe round can wait
  // longer than that, so a wake landing early in the round is already "stale"
  // again by the time the round ends. Movement of the event clock is the proof,
  // not how recent it looks afterwards.
  const SHORT_STALE_MS = 10_000;
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (SHORT_STALE_MS + 1_000),
    probeOutcome: "silent",
    eventArrivesDuringProbe: true,
    probeTakesMs: 15_000,
  });
  const watchdog = new SlackDeafnessWatchdog(port, SHORT_STALE_MS);
  assert.equal(await watchdog.check(), "healthy");
  assert.equal(state.restarts, 0, "the link demonstrably carried an event");
  assert.deepEqual(state.exits, []);
});

test("a reconnect is judged after a full window, never on an early interval", async () => {
  // The driving interval is fixed while a cycle's own probing and restarting can
  // eat much of a stale window, so the next cycle can fire far less than a window
  // after the reconnect. Escalating there condemns a fresh transport for not
  // having received traffic nobody sent yet.
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeOutcome: "silent",
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // Half a window later the fixed interval fires again.
  state.nowMs += STALE_MS / 2;
  assert.equal(await watchdog.check(), "awaiting_reconnect");
  assert.equal(state.restarts, 1, "no second reconnect while the first is young");
  assert.deepEqual(state.exits, []);
  assert.ok(state.logs.some((line) => line.includes("giving it the rest of its window")));
  // Once the window is spent, the escalation proceeds exactly as before.
  state.nowMs += STALE_MS / 2;
  assert.equal(await watchdog.check(), "reconnected_still_deaf");
  assert.equal(state.restarts, 2);
});

test("a subscription that ends during the probe stops the cycle — nobody is left to wake", async () => {
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeOutcome: "silent",
    subscriptionEndsDuringProbe: true,
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "idle_no_subscription");
  assert.equal(state.restarts, 0);
  assert.deepEqual(state.exits, [], "exiting a broker nobody listens through is pure damage");
});

test("the fresh link's window starts when the reconnect finishes, not when it was asked for", async () => {
  // A reconnect can itself consume much of a stale window. Measuring the window
  // from the request would hand the new connection a fraction of one — and the
  // connect stamp must still be read against the REQUEST, or a good reconnect
  // would look like a leftover from the previous socket and exit as wedged.
  const RESTART_TAKES_MS = STALE_MS * 2 / 3;
  const { port, state } = makePort({
    lastEventMs: 1_000_000 - (STALE_MS + 1_000),
    probeOutcome: "silent",
    restartTakesMs: RESTART_TAKES_MS,
  });
  const watchdog = new SlackDeafnessWatchdog(port, STALE_MS);
  assert.equal(await watchdog.check(), "restarted");
  // A full window after the REQUEST is only a third of one after the connection
  // actually came up.
  state.nowMs = 1_000_000 + STALE_MS;
  assert.equal(await watchdog.check(), "awaiting_reconnect");
  assert.deepEqual(state.exits, []);
  // A full window after the connection came up, the escalation resumes — and it
  // still recognises the reconnect as having taken.
  state.nowMs = 1_000_000 + RESTART_TAKES_MS + STALE_MS;
  assert.equal(await watchdog.check(), "reconnected_still_deaf", "not read as a wedged transport");
  assert.equal(state.restarts, 2);
});
