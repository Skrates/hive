import assert from "node:assert/strict";
import test from "node:test";
import { CANARY_MEMORY_MS, CanaryRegistry } from "./canary.js";

const TIMEOUT_MS = 50;

/** The shape a canary comes back in: an events_api payload carrying its text. */
function envelope(nonce: string): unknown {
  return { event: { type: "message", channel: "C1", text: `hive watchdog link canary ${nonce} — ignore` } };
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
  assert.equal(registry.observe(envelope("someone-elses")), false, "ordinary traffic is not ours");
  assert.equal(await watch.arrived, false);
});

test("an ordinary envelope is never mistaken for a canary", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe({ event: { type: "message", text: "WAKE: gnomon" } }), false);
  assert.equal(await watch.arrived, false);
});

test("the reaping echo of a settled canary is still recognised as ours", async () => {
  // Deleting a canary produces a `message_deleted` event whose `previous_message`
  // carries the same nonce. If that echo counted as channel activity, the next
  // watchdog cycle would read the link as busy and skip the probe entirely.
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  assert.equal(registry.observe(envelope("nonce-1")), true);
  assert.equal(await watch.arrived, true);
  const deletion = { event: { type: "message", subtype: "message_deleted", previous_message: { text: `canary nonce-1` } } };
  assert.equal(registry.observe(deletion), true, "the echo belongs to the canary, not to the channel");
});

test("a canary is forgotten once its memory window passes", () => {
  let nowMs = 1_000_000;
  const registry = new CanaryRegistry(() => nowMs);
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  watch.cancel();
  nowMs += TIMEOUT_MS + CANARY_MEMORY_MS + 1;
  assert.equal(
    registry.observe(envelope("nonce-1")),
    false,
    "an old nonce must not discount real traffic forever",
  );
});

test("a cancelled waiter resolves false and a late arrival cannot contradict it", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  watch.cancel();
  assert.equal(await watch.arrived, false);
  // The canary turns up anyway (its post failed but Slack delivered it): the
  // registry still recognises it as ours, and settles nothing twice.
  assert.equal(registry.observe(envelope("nonce-1")), true);
  assert.equal(await watch.arrived, false, "a settled verdict is never rewritten");
});

test("an unserialisable envelope is treated as ordinary traffic, not swallowed", async () => {
  const registry = new CanaryRegistry();
  const watch = registry.watchCanary("nonce-1", TIMEOUT_MS);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(registry.observe(circular), false);
  assert.equal(await watch.arrived, false);
});

test("nothing is inspected while no canary is in flight", () => {
  const registry = new CanaryRegistry();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(registry.observe(circular), false, "the common path never touches the payload");
});
