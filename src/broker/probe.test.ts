import assert from "node:assert/strict";
import test from "node:test";
import { CanaryRegistry, PROBE_EVENT_TYPE, type CanaryIdentity } from "./canary.js";
import { CANARY_SPACING_MS, PROBE_CANARIES, SlackLinkProbe, type ProbePoster } from "./probe.js";

/** The broker's own bot user in the probe channel — what the registry is bound to at startup. */
const SELF: CanaryIdentity = { userId: "UBOT", channelId: "C1" };

/** The envelope Slack sends back for a canary the app posted. */
function canaryEnvelope(nonce: string): unknown {
  return {
    event: {
      type: "message",
      channel: SELF.channelId,
      user: SELF.userId,
      text: `hive watchdog link canary ${nonce} — ignore`,
      metadata: { event_type: PROBE_EVENT_TYPE, event_payload: { nonce } },
    },
  };
}

/** Short enough to keep a lost canary cheap, long enough to survive a slow CI box. */
const PROBE_MS = 200;

interface PosterState {
  posted: string[];
  /** Reading of the test's own clock at each post, so pacing is checkable exactly. */
  postedAt: number[];
  deleted: string[];
  logs: string[];
  /** Advanced only by the injected pace — no wall clock, no flake. */
  clockMs: number;
}

/**
 * A poster wired to a real {@link CanaryRegistry}: `echo` decides whether the
 * canary comes back over the "link", exactly as an inbound envelope would.
 * Using the real registry (rather than a stub watcher) is deliberate — it is
 * what makes the register-before-post ordering falsifiable here.
 */
function makeProbe(options: {
  echo: "sync" | "async" | "never" | ((nonce: string, registry: CanaryRegistry) => void);
  postFails?: boolean;
  /** The post never settles — the Slack SDK retrying for half an hour. */
  postHangs?: boolean;
  /** Slack delivered the canary, then the post's own response was lost. */
  postFailsAfterDelivery?: boolean;
  deleteFails?: boolean;
  /** Gap between canaries; tests use a few milliseconds, production ~1.2s. */
  spacingMs?: number;
}): { probe: SlackLinkProbe; state: PosterState; registry: CanaryRegistry } {
  const state: PosterState = { posted: [], postedAt: [], deleted: [], logs: [], clockMs: 0 };
  const registry = new CanaryRegistry();
  registry.bind(SELF);
  const poster: ProbePoster = {
    async postCanary(nonce) {
      if (options.postHangs) return new Promise<string>(() => {});
      if (options.postFails) throw new Error("slack said no");
      if (options.postFailsAfterDelivery) {
        state.posted.push(nonce);
        registry.observe(canaryEnvelope(nonce));
        throw new Error("response lost");
      }
      state.posted.push(nonce);
      state.postedAt.push(state.clockMs);
      if (typeof options.echo === "function") options.echo(nonce, registry);
      // Sync: the envelope beats chat.postMessage's own HTTP response home.
      if (options.echo === "sync") registry.observe(canaryEnvelope(nonce));
      if (options.echo === "async") {
        setTimeout(() => registry.observe(canaryEnvelope(nonce)), 1);
      }
      return `ts-${state.posted.length}`;
    },
    async deleteCanary(messageTs) {
      if (options.deleteFails) throw new Error("delete refused");
      state.deleted.push(messageTs);
    },
  };
  return {
    probe: new SlackLinkProbe(poster, registry, (message) => state.logs.push(message), {
      spacingMs: options.spacingMs ?? 0,
      sleep: async (ms) => { state.clockMs += ms; },
    }),
    state,
    registry,
  };
}

/** Let the fire-and-forget reap settle before asserting on it. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test("a round where every canary comes home reports the link alive", async () => {
  const { probe, state } = makeProbe({ echo: "async" });
  assert.equal(await probe.run(PROBE_MS), "alive");
  assert.equal(state.posted.length, PROBE_CANARIES, "the whole round is spent proving liveness");
  await settle();
  assert.deepEqual(state.deleted.length, PROBE_CANARIES, "every canary is reaped from the commons");
});

test("a canary observed before its own post returns is still counted (the real race)", async () => {
  // Register-before-post is load-bearing: on a healthy link the Socket Mode
  // envelope arrives before chat.postMessage's HTTP response does.
  const { probe } = makeProbe({ echo: "sync" });
  assert.equal(await probe.run(PROBE_MS), "alive");
});

test("one lost canary is enough — the round short-circuits as silent", async () => {
  const { probe, state } = makeProbe({ echo: "never" });
  assert.equal(await probe.run(PROBE_MS), "silent");
  assert.equal(state.posted.length, 1, "nothing left to prove after the first loss");
  await settle();
  assert.deepEqual(state.deleted, ["ts-1"], "even a lost canary is reaped");
  assert.ok(state.logs.some((line) => line.includes("did not return within")));
});

test("a stream a thief wins half of fails the round", async () => {
  // The thief shape: each event goes to exactly one of the app's connections, so
  // some canaries come home and some do not. A round is alive only if ALL do.
  let seen = 0;
  const { probe, state } = makeProbe({
    echo: (nonce, registry) => {
      seen += 1;
      if (seen % 2 === 1) registry.observe(canaryEnvelope(nonce));
    },
  });
  assert.equal(await probe.run(PROBE_MS), "silent");
  assert.equal(state.posted.length, 2, "the second canary was stolen and ended the round");
});

test("a canary that cannot be posted is unavailable, never silent", async () => {
  // A refusing Web API says nothing about the socket. Reporting it as deafness
  // would exit the broker on a Slack outage.
  const { probe, state } = makeProbe({ echo: "never", postFails: true });
  assert.equal(await probe.run(PROBE_MS), "unavailable");
  assert.deepEqual(state.posted, []);
  assert.deepEqual(state.deleted, [], "nothing was posted, so nothing is reaped");
  assert.ok(state.logs.some((line) => line.includes("could not be posted")));
  assert.ok(
    state.logs.every((line) => !line.includes("slack said no")),
    "the error TYPE only — a Slack error can carry body text",
  );
});

test("a canary that cannot be reaped is logged and does not change the verdict", async () => {
  const { probe, state } = makeProbe({ echo: "async", deleteFails: true });
  assert.equal(await probe.run(PROBE_MS), "alive");
  await settle();
  assert.ok(state.logs.some((line) => line.includes("could not be removed from the commons")));
});

test("a canary post that never settles is bounded by the probe window", async () => {
  // The Slack WebClient retries for about half an hour by default. An unbounded
  // post would hold the watchdog cycle in flight across many intervals and skip
  // every one of them — disabling the detector this probe exists to serve.
  const { probe, state } = makeProbe({ echo: "never", postHangs: true });
  const startedAt = Date.now();
  assert.equal(await probe.run(PROBE_MS), "unavailable");
  assert.ok(Date.now() - startedAt < PROBE_MS * 4, "the round returns on its own deadline");
  assert.deepEqual(state.posted, [], "the post never completed");
  assert.ok(state.logs.some((line) => line.includes("could not be posted")));
});

test("a canary that arrives while its own post fails is proof, not an outage", async () => {
  // Slack accepted the post and delivered the event; only the HTTP response was
  // lost. Direct evidence that the link carried our traffic outranks that.
  const { probe, state } = makeProbe({ echo: "never", postFailsAfterDelivery: true });
  assert.equal(await probe.run(PROBE_MS), "alive");
  assert.equal(state.posted.length, PROBE_CANARIES);
  await settle();
  assert.deepEqual(state.deleted, [], "no message ts came back, so nothing can be reaped");
  assert.ok(state.logs.some((line) => line.includes("although its post failed")));
});

test("canaries are paced so a round cannot rate-limit itself", async () => {
  // chat.postMessage allows roughly one message per second per channel and the
  // canary client fails fast rather than waiting out a 429. An unpaced round on
  // a healthy link — where each canary returns in milliseconds — would trip that
  // limit and report `unavailable`, manufacturing the false positive the probe
  // exists to prevent.
  assert.ok(CANARY_SPACING_MS >= 1_000, "the production gap clears the per-channel rate");
  const SPACING_MS = 1_000;
  const { probe, state } = makeProbe({ echo: "sync", spacingMs: SPACING_MS });
  assert.equal(await probe.run(PROBE_MS), "alive");
  assert.deepEqual(
    state.postedAt,
    [0, SPACING_MS, SPACING_MS * 2],
    "each canary waits out the gap before the next is posted",
  );
});
