import assert from "node:assert/strict";
import test from "node:test";
import { CanaryIdentityUnboundError, CanaryRegistry, PROBE_EVENT_TYPE, type CanaryIdentity } from "./canary.js";

const TIMEOUT_MS = 50;

/** The broker's own bot user, in the probe channel — the only principal a canary may come back from. */
const SELF: CanaryIdentity = { userId: "UBOT", channelId: "C1" };

/** A registry bound to the broker's principal, as the ingress is at startup. */
function bound(): CanaryRegistry {
  const registry = new CanaryRegistry();
  registry.bind(SELF);
  return registry;
}

/** The shape a canary comes back in: the posted message, stamp and all. */
function envelope(nonce: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    event: {
      type: "message",
      channel: SELF.channelId,
      user: SELF.userId,
      text: `hive watchdog link canary ${nonce} — ignore`,
      metadata: { event_type: PROBE_EVENT_TYPE, event_payload: { nonce } },
      ...overrides,
    },
  };
}

/** Reaping a canary: Slack repeats the message's metadata under previous_message. */
function deletionEcho(nonce: string): unknown {
  return {
    event: {
      type: "message",
      subtype: "message_deleted",
      channel: SELF.channelId,
      previous_message: {
        user: SELF.userId,
        text: `hive watchdog link canary ${nonce} — ignore`,
        metadata: { event_type: PROBE_EVENT_TYPE, event_payload: { nonce } },
      },
    },
  };
}

test("a canary observed on the link settles its waiter", async () => {
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("nonce-1")), true, "the envelope is ours");
  assert.equal(await watch.arrived, true);
});

test("a canary that never arrives resolves false at its deadline", async () => {
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("someone-elses")), true, "still a canary, just not ours");
  assert.equal(await watch.arrived, false);
});

test("an ordinary envelope is never mistaken for a canary", async () => {
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe({ event: { type: "message", text: "WAKE: gnomon" } }), false);
  assert.equal(await watch.arrived, false);
});

test("a message that merely QUOTES a nonce is traffic, not a canary", async () => {
  // Message text is quotable by anyone in the channel. If quoting a nonce could
  // settle a probe, an unrelated message would mask a canary that a competing
  // Socket Mode consumer actually swallowed — and would itself be discounted
  // from the event clock. Identity is the metadata stamp, never the text.
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  const quote = { event: { type: "message", channel: "C1", text: "what is `hive watchdog link canary nonce-1`?" } };
  assert.equal(registry.observe(quote), false, "real traffic, and it stays on the event clock");
  assert.equal(await watch.arrived, false, "the probe was not settled by a quotation");
});

test("a probe cannot be armed before the broker's principal is bound", () => {
  // An unbound registry could never settle a waiter, so every round would time
  // out as `silent` and escalate a healthy link — refuse loudly instead.
  const registry = new CanaryRegistry();
  assert.throws(() => registry.watchCanary("nonce-1", TIMEOUT_MS), CanaryIdentityUnboundError);
});

test("a deletion echo is canary traffic but never an arrival", async () => {
  // Slack distributes the creation and deletion events independently. If a
  // competing consumer took the creation while this connection was handed the
  // `message_deleted` echo (an administrator reaping the canary mid-window),
  // settling on the echo would report a stolen stream as alive. The echo stays
  // off the event clock; only the original message proves the link.
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(deletionEcho("nonce-1")), true, "still ours, still off the clock");
  assert.equal(await watch.arrived, false, "a deletion is not the canary coming home");
});

test("an edited-message echo is canary traffic but never an arrival", async () => {
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  const edit = {
    event: {
      type: "message",
      subtype: "message_changed",
      channel: SELF.channelId,
      message: { user: SELF.userId, metadata: { event_type: PROBE_EVENT_TYPE, event_payload: { nonce: "nonce-1" } } },
    },
  };
  assert.equal(registry.observe(edit), true);
  assert.equal(await watch.arrived, false);
});

test("a stamped message from any other sender is a forgery: off the clock, and never proof", async () => {
  // The stamp and the nonce are content — any app in the channel can copy
  // them from the canary's visible text. `observe()` runs upstream of
  // admission, so the sender must be checked here: only the broker's own bot
  // user can prove the link carried OUR traffic.
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("nonce-1", { user: "UIMPOSTOR" })), true, "stamped, so not conversation");
  assert.equal(registry.observe(envelope("nonce-1", { user: undefined, bot_id: "B-other" })), true);
  assert.equal(await watch.arrived, false, "a forged canary settles nothing");
});

test("our own canary observed in another channel is never proof", async () => {
  // A canary posted to the probe channel cannot come back from elsewhere; a
  // stamped message of ours in a different channel is not this probe's answer.
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("nonce-1", { channel: "C-elsewhere" })), true);
  assert.equal(await watch.arrived, false);
});

test("the reaping echo of a settled canary is still recognised as ours", async () => {
  // Deleting a canary produces a `message_deleted` event carrying the same
  // metadata. If that echo counted as channel activity, the next watchdog cycle
  // would read the link as busy and skip the probe entirely.
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("nonce-1")), true);
  assert.equal(await watch.arrived, true);
  assert.equal(registry.observe(deletionEcho("nonce-1")), true, "the echo belongs to the canary");
});

test("a waiter that timed out is never rewritten by a late arrival", async () => {
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(await watch.arrived, false, "the deadline passed");
  // The canary turns up after its window: still recognised as ours, so it is
  // not counted as channel activity, and it settles nothing twice.
  assert.equal(registry.observe(envelope("nonce-1")), true);
  assert.equal(await watch.arrived, false, "a settled verdict is never rewritten");
});

test("a malformed envelope is treated as ordinary traffic, not swallowed", async () => {
  const registry = bound();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(null), false);
  assert.equal(registry.observe({ event: "not-an-object" }), false);
  assert.equal(registry.observe({ event: { metadata: { event_type: PROBE_EVENT_TYPE } } }), false, "stamped but nonce-less");
  assert.equal(await watch.arrived, false);
});
