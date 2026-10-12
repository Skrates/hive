import assert from "node:assert/strict";
import test from "node:test";
import { decide, type ActCaller, type ItemFacts } from "./reducer.js";
import { duePromotions, selectNext } from "./selector.js";

const operator: ActCaller = { kind: "operator" };
const owner: ActCaller = { kind: "source", sourceId: "src_a", ownerPrincipal: "seat:fable" };
const item = (state: ItemFacts["state"], revision = 1): ItemFacts => ({ state, revision, ownerPrincipal: "seat:fable", sourceId: "src_a" });

test("FIFO-1 orders by ready sequence then item id; an explicit pick is honoured or refused, never replaced", () => {
  assert.deepEqual(selectNext([{ itemId: 9, readySequence: 30 }, { itemId: 3, readySequence: 10 }, { itemId: 2, readySequence: 10 }]), { kind: "selected", itemId: 2, reason: "fifo" });
  assert.deepEqual(selectNext([{ itemId: 9, readySequence: 30 }], 9), { kind: "selected", itemId: 9, reason: "explicit_pick" });
  assert.deepEqual(selectNext([{ itemId: 9, readySequence: 30 }], 4), { kind: "not_eligible", itemId: 4 });
  assert.deepEqual(selectNext([]), { kind: "empty" });
});

test("due promotions come out in (deferred_until, item_id) order, excluding the not-yet-due", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  assert.deepEqual(duePromotions([
    { itemId: 5, deferredUntil: "2026-10-12T09:30:00.000Z" },
    { itemId: 1, deferredUntil: "2026-10-12T09:30:00.000Z" },
    { itemId: 2, deferredUntil: "2026-10-12T08:00:00.000Z" },
    { itemId: 3, deferredUntil: "2026-10-12T10:00:00.001Z" },
  ], now).map((entry) => entry.itemId), [2, 1, 5]);
});

test("refusals come in a fixed order: authority, revision, state, argument", () => {
  const stranger: ActCaller = { kind: "source", sourceId: "src_b", ownerPrincipal: "seat:fable" };
  assert.equal((decide(item("queued"), { kind: "claim" }, owner, 9) as { error: string }).error, "operator_only");
  assert.equal((decide(item("queued"), { kind: "amend" }, stranger, 9) as { error: string }).error, "not_item_owner");
  assert.equal((decide(item("resolved"), { kind: "amend" }, owner, 9) as { error: string }).error, "revision_conflict");
  assert.equal((decide(item("resolved"), { kind: "amend" }, owner, 1) as { error: string }).error, "item_terminal");
  assert.equal((decide(item("queued"), { kind: "defer", until: "2026-01-01T00:00:00Z", now: "2026-10-12T00:00:00Z" }, operator, 1) as { error: string }).error, "until_not_future");
  assert.equal((decide(item("queued"), { kind: "withdraw" }, operator, 1) as { error: string }).error, "producer_only");
});

test("the transition table matches the specification", () => {
  const ok = (state: ItemFacts["state"], act: Parameters<typeof decide>[1], caller: ActCaller = operator) => {
    const decision = decide(item(state), act, caller, 1);
    return decision.ok ? decision.to : decision.error;
  };
  assert.equal(ok("queued", { kind: "claim" }), "active");
  assert.equal(ok("active", { kind: "claim" }), "item_not_eligible");
  assert.equal(ok("active", { kind: "resolve" }), "resolved");
  assert.equal(ok("queued", { kind: "resolve" }), "item_not_active");
  assert.equal(ok("active", { kind: "defer", until: null, now: "2026-10-12T00:00:00Z" }), "deferred");
  assert.equal(ok("deferred", { kind: "defer", until: null, now: "2026-10-12T00:00:00Z" }), "item_not_deferrable");
  assert.equal(ok("deferred", { kind: "requeue" }), "queued");
  assert.equal(ok("active", { kind: "cancel" }), "cancelled");
  assert.equal(ok("cancelled", { kind: "cancel" }), "item_terminal");
  assert.equal(ok("deferred", { kind: "withdraw" }, owner), "cancelled");
  assert.equal(ok("active", { kind: "withdraw" }, owner), "item_active");
  assert.equal(ok("active", { kind: "amend" }, owner), "active", "an amendment keeps state and focus ownership");
});
