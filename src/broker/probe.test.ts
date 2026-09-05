import assert from "node:assert/strict";
import test from "node:test";
import { CanaryRegistry } from "./canary.js";
import { PROBE_CANARIES, SlackLinkProbe, type ProbePoster } from "./probe.js";

/** Short enough to keep a lost canary cheap, long enough to survive a slow CI box. */
const PROBE_MS = 200;

interface PosterState {
  posted: string[];
  deleted: string[];
  logs: string[];
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
  deleteFails?: boolean;
}): { probe: SlackLinkProbe; state: PosterState; registry: CanaryRegistry } {
  const state: PosterState = { posted: [], deleted: [], logs: [] };
  const registry = new CanaryRegistry();
  const poster: ProbePoster = {
    async postCanary(nonce) {
      if (options.postFails) throw new Error("slack said no");
      state.posted.push(nonce);
      if (typeof options.echo === "function") options.echo(nonce, registry);
      // Sync: the envelope beats chat.postMessage's own HTTP response home.
      if (options.echo === "sync") registry.observe({ event: { text: `canary ${nonce}` } });
      if (options.echo === "async") {
        setTimeout(() => registry.observe({ event: { text: `canary ${nonce}` } }), 1);
      }
      return `ts-${state.posted.length}`;
    },
    async deleteCanary(messageTs) {
      if (options.deleteFails) throw new Error("delete refused");
      state.deleted.push(messageTs);
    },
  };
  return {
    probe: new SlackLinkProbe(poster, registry, (message) => state.logs.push(message)),
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
      if (seen % 2 === 1) registry.observe({ event: { text: `canary ${nonce}` } });
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
