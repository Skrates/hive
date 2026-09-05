import assert from "node:assert/strict";
import test from "node:test";
import { CanaryRegistry, PROBE_EVENT_TYPE } from "./canary.js";

const TIMEOUT_MS = 50;

/** The shape a canary comes back in: the posted message, stamp and all. */
function envelope(nonce: string): unknown {
  return {
    event: {
      type: "message",
      channel: "C1",
      text: `hive watchdog link canary ${nonce} — ignore`,
      metadata: { event_type: PROBE_EVENT_TYPE, event_payload: { nonce } },
    },
  };
}

/** Reaping a canary: Slack repeats the message's metadata under previous_message. */
function deletionEcho(nonce: string): unknown {
  return {
    event: {
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      previous_message: {
        text: `hive watchdog link canary ${nonce} — ignore`,
        metadata: { event_type: PROBE_EVENT_TYPE, event_payload: { nonce } },
      },
    },
  };
}

test("a canary observed on the link settles its waiter", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("nonce-1")), true, "the envelope is ours");
  assert.equal(await watch.arrived, true);
});

test("a canary that never arrives resolves false at its deadline", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("someone-elses")), true, "still a canary, just not ours");
  assert.equal(await watch.arrived, false);
});

test("an ordinary envelope is never mistaken for a canary", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe({ event: { type: "message", text: "WAKE: gnomon" } }), false);
  assert.equal(await watch.arrived, false);
});

test("a message that merely QUOTES a nonce is traffic, not a canary", async () => {
  // Message text is quotable by anyone in the channel. If quoting a nonce could
  // settle a probe, an unrelated message would mask a canary that a competing
  // Socket Mode consumer actually swallowed — and would itself be discounted
  // from the event clock. Identity is the metadata stamp, never the text.
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  const quote = { event: { type: "message", channel: "C1", text: "what is `hive watchdog link canary nonce-1`?" } };
  assert.equal(registry.observe(quote), false, "real traffic, and it stays on the event clock");
  assert.equal(await watch.arrived, false, "the probe was not settled by a quotation");
});

test("the reaping echo of a settled canary is still recognised as ours", async () => {
  // Deleting a canary produces a `message_deleted` event carrying the same
  // metadata. If that echo counted as channel activity, the next watchdog cycle
  // would read the link as busy and skip the probe entirely.
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("nonce-1")), true);
  assert.equal(await watch.arrived, true);
  assert.equal(registry.observe(deletionEcho("nonce-1")), true, "the echo belongs to the canary");
});

test("a waiter that timed out is never rewritten by a late arrival", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(await watch.arrived, false, "the deadline passed");
  // The canary turns up after its window: still recognised as ours, so it is
  // not counted as channel activity, and it settles nothing twice.
  assert.equal(registry.observe(envelope("nonce-1")), true);
  assert.equal(await watch.arrived, false, "a settled verdict is never rewritten");
});

test("a malformed envelope is treated as ordinary traffic, not swallowed", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(null), false);
  assert.equal(registry.observe({ event: "not-an-object" }), false);
  assert.equal(registry.observe({ event: { metadata: { event_type: PROBE_EVENT_TYPE } } }), false, "stamped but nonce-less");
  assert.equal(await watch.arrived, false);
});
