import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SYSTEM_WAKE_SENDER } from "../broker/store.js";
import type { ItemView, SourceView } from "./contract.js";
import { act, harness, liveSource, next, OPERATOR, resolve, seat, summon, THREAD, type Harness } from "./fixtures.js";
import { AttentionReturnPublisher, continuationText, MAX_CONTINUATION_CHARS, RETURN_BLOCKED_RETRY_MS } from "./returns.js";
import { profileFingerprint } from "./route.js";
import { AttentionRefusal } from "./store.js";

function publisher(h: Harness): AttentionReturnPublisher {
  return new AttentionReturnPublisher(h.store, h.broker, h.clock);
}

/** Summon, take, and resolve one item; return its id and the resolution command id. */
function resolvedItem(h: Harness, options: Parameters<typeof liveSource>[1] = {}, key = "candidate-selection") {
  const source = liveSource(h.store, options);
  const item = summon(h.store, source, { intervention_key: key }).item!;
  const taken = next(h.store);
  const commandId = randomUUID();
  const resolution = resolve(h.store, item.item_id, taken.item!.revision, false, commandId);
  return { source, itemId: item.item_id, commandId, resolution };
}

function refused(code: string) {
  return (error: unknown): boolean => error instanceof AttentionRefusal && error.code === code;
}

test("A21 resolving while Slack is unreachable commits the response and next claim with no network wait", async () => {
  const h = harness();
  const { itemId, resolution } = resolvedItem(h, { returnMode: "actor_context" });
  assert.equal(resolution.return_effect!.phase, "pending");
  // Nothing on the resolve path touched the outbox; the continuation is minted later and the
  // outbox carries it whenever Slack comes back.
  assert.equal(h.store.item(itemId)!.state, "resolved");
  const drained = await publisher(h).drainOnce();
  assert.deepEqual(drained, { minted: 1, blocked: 0, failed: 0, settled: 0 });
  const view = h.store.item(itemId)!;
  assert.equal(view.return!.phase, "minted");
  assert.equal(view.return!.transport_status, "pending");
  h.close();
});

test("the minted continuation carries its own identity, attribution, coalescing group and route", async () => {
  const h = harness();
  const { itemId, commandId } = resolvedItem(h);
  await publisher(h).drainOnce();
  const deliveryId = h.store.item(itemId)!.return!.delivery_id!;
  const delivery = h.broker.getDelivery(deliveryId);
  assert.equal(delivery.eventId, `attention:${commandId}:1`);
  assert.equal(delivery.event.senderId, "hive-attention");
  assert.equal(delivery.event.senderKind, "app");
  assert.equal(delivery.coalesceKey, `attention-return:${commandId}:1`);
  assert.equal(delivery.requiredEdgeProtocol, 1);
  assert.equal(delivery.continuationTarget!.mode, "pinned_session");
  assert.equal(delivery.continuationTarget!.pinned!.session_id, "session-fable-1");
  assert.equal(delivery.continuationTarget!.pinned!.account_profile_fingerprint, profileFingerprint(h.broker.getSubscription("fable")!));
  assert.equal(delivery.event.threadTs, THREAD.thread_ts, "the source's real thread, for traceability");
  assert.match(delivery.event.text, /Use candidate C; retain the current lighting\./u, "the exact human response");
  const render = h.broker.db.prepare("SELECT text FROM outbox WHERE delivery_id=?").get(deliveryId) as { text: string };
  assert.doesNotMatch(render.text, /retain the current lighting/u, "the commons render never carries the response body");
  assert.match(render.text, /attention return hive-attention → fable/u);
  h.close();
});

test("A22 a crash inside the mint transaction leaves one pending generation and no orphan delivery", async () => {
  const h = harness();
  const { itemId } = resolvedItem(h, { returnMode: "actor_context" });
  h.broker.db.exec("CREATE TRIGGER crash_mint BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  const lines: string[] = [];
  const crashing = new AttentionReturnPublisher(h.store, h.broker, h.clock, (line) => lines.push(line));
  assert.deepEqual(await crashing.drainOnce(), { minted: 0, blocked: 0, failed: 0, settled: 0 });
  assert.match(lines.join("\n"), /simulated crash/u);
  assert.equal(h.store.item(itemId)!.return!.phase, "pending");
  assert.equal(h.broker.listDeliveries().length, 0, "the delivery rolled back with the phase");
  h.broker.db.exec("DROP TRIGGER crash_mint");

  const reopened = h.reopen();
  await publisher(reopened).drainOnce();
  await publisher(reopened).drainOnce();
  assert.equal(reopened.broker.listDeliveries().length, 1, "one logical generation, one core delivery");
  assert.equal(reopened.store.item(itemId)!.return!.phase, "minted");
  reopened.close();
});

test("A23 review system wakes keep their exact identity, sender, coalescing and render", () => {
  const h = harness();
  const { deliveryId } = h.broker.mintSystemWake({ actor: "fable", channelId: THREAD.channel_id, threadTs: THREAD.thread_ts, text: "Burn the findings.", dedupeKey: "rev_1:eff_1" });
  const delivery = h.broker.getDelivery(deliveryId);
  assert.equal(delivery.eventId, "review:rev_1:eff_1");
  assert.equal(delivery.event.senderId, SYSTEM_WAKE_SENDER);
  assert.equal(delivery.event.messageTs.startsWith("review:"), true);
  assert.equal(delivery.coalesceKey, `fable:${THREAD.channel_id}:${THREAD.thread_ts}`);
  assert.equal(delivery.continuationTarget, null);
  assert.equal(delivery.requiredEdgeProtocol, 0);
  assert.deepEqual(delivery.event.raw, { type: "system_wake", source: "system", dedupeKey: "rev_1:eff_1" });
  const render = h.broker.db.prepare("SELECT text FROM outbox WHERE delivery_id=?").get(deliveryId) as { text: string };
  assert.equal(render.text, `🐝 review wake hive-review → fable (delivery ${deliveryId})\n\nBurn the findings.`);
  assert.equal(h.broker.mintSystemWake({ actor: "fable", channelId: THREAD.channel_id, threadTs: THREAD.thread_ts, text: "Burn the findings.", dedupeKey: "rev_1:eff_1" }).deliveryId, deliveryId);
  h.close();
});

test("A24 two attention responses and an ordinary wake in one thread stay three correlated deliveries", async () => {
  const h = harness();
  const source = liveSource(h.store, { returnMode: "actor_context" });
  const items = ["a", "b"].map((key) => summon(h.store, source, { intervention_key: key }).item!.item_id);
  for (const itemId of items) {
    const taken = next(h.store);
    resolve(h.store, itemId, taken.item!.revision);
  }
  await publisher(h).drainOnce();
  h.broker.ingestEvent({
    eventId: "EvOrdinary", workspaceId: "T1", channelId: THREAD.channel_id, threadTs: THREAD.thread_ts, messageTs: "1760259700.000300",
    senderId: "U1", senderKind: "user", actor: "fable", text: "also check the subtitles", raw: {}, receivedAt: h.clock.now().toISOString(),
  });
  h.broker.ingestEvent({
    eventId: "EvOrdinary2", workspaceId: "T1", channelId: THREAD.channel_id, threadTs: THREAD.thread_ts, messageTs: "1760259701.000400",
    senderId: "U1", senderKind: "user", actor: "fable", text: "and the credits", raw: {}, receivedAt: h.clock.now().toISOString(),
  });
  const deliveries = h.broker.listDeliveries();
  assert.equal(deliveries.length, 3);
  const ordinary = deliveries.find((delivery) => delivery.continuationTarget === null)!;
  assert.deepEqual(ordinary.coalescedMessages.map((message) => message.text), ["and the credits"], "ordinary wakes still coalesce with each other");
  for (const itemId of items) {
    const deliveryId = h.store.item(itemId)!.return!.delivery_id!;
    const delivery = h.broker.getDelivery(deliveryId);
    assert.equal(delivery.coalescedMessages.length, 0, "an attention response never absorbs, nor is absorbed by, another wake");
    assert.match(delivery.event.text, new RegExp(`ATN-${itemId} `, "u"));
  }
  h.close();
});

test("A33 a protocol-0 edge never claims an attention continuation, context-restored ones included", async () => {
  const h = harness();
  resolvedItem(h, { returnMode: "actor_context" });
  await publisher(h).drainOnce();
  assert.equal(h.broker.claimNext("edge-a", 0, [], 0), null);
  const claimed = h.broker.claimNext("edge-a", 0, [], 1);
  assert.ok(claimed);
  assert.equal(claimed.continuationTarget!.mode, "actor_context");
  h.close();
});

test("a pinned continuation is claimable only on its home edge", async () => {
  const h = harness({ seats: [seat("fable", { edgeWorkspaces: [{ edgeId: "edge-a", cwd: "/work", worktree: null }, { edgeId: "edge-b", cwd: "/work", worktree: null }] })] });
  resolvedItem(h);
  await publisher(h).drainOnce();
  h.clock.advance(31_000);
  assert.equal(h.broker.claimNext("edge-b", 0, [], 1), null, "even past the home grace, a pinned session never leaves its home edge");
  assert.ok(h.broker.claimNext("edge-a", 0, [], 1));
  h.close();
});

test("A29 a changed profile fails the pinned return visibly; it is never rerouted on its own", async () => {
  const h = harness();
  const { itemId } = resolvedItem(h);
  await publisher(h).drainOnce();
  h.broker.upsertSubscription(seat("fable", { accountProfile: "/profiles/fable-new" }));
  assert.equal(h.broker.claimNext("edge-a", 0, [], 1), null);
  const deliveryId = h.store.item(itemId)!.return!.delivery_id!;
  assert.equal(h.broker.getDelivery(deliveryId).status, "undeliverable");
  assert.equal(h.broker.getDelivery(deliveryId).reasons[0]!.code, "attention_profile_changed");
  assert.deepEqual(await publisher(h).drainOnce(), { minted: 0, blocked: 0, failed: 0, settled: 1 });
  const failed = h.store.item(itemId)!.return!;
  assert.equal(failed.phase, "failed");
  assert.equal(failed.transport_status, "undeliverable");
  assert.equal(h.store.status("hakon").route_warnings.length, 1);
  h.close();
});

test("A29 drift detected before minting fails the generation; the operator retries or reroutes explicitly", async () => {
  const h = harness();
  const { itemId, resolution } = resolvedItem(h);
  h.broker.upsertSubscription(seat("fable", { homeEdge: "edge-b", edgeWorkspaces: [{ edgeId: "edge-b", cwd: "/work", worktree: null }] }));
  await publisher(h).drainOnce();
  const failed = h.store.item(itemId)!.return!;
  assert.equal(failed.phase, "failed");
  assert.match(failed.reason!, /attention_home_edge_changed/u);
  const revision = h.store.item(itemId)!.revision;

  assert.throws(() => act(h.store, OPERATOR, "retry_return", { item_id: itemId, expected_revision: revision, return_generation: 2 }), refused("return_generation_conflict"));
  // A reroute never carries the decision into another work context: a source for another
  // project, or for another work in the same project, is refused and changes nothing.
  const otherProject = liveSource(h.store, { edgeId: "edge-b", returnMode: "actor_context", session: "s-p", project: "krepis" });
  const otherWork = liveSource(h.store, { edgeId: "edge-b", returnMode: "actor_context", session: "s-w", work: "parents-likeness-round-3" });
  for (const wrong of [otherProject, otherWork]) {
    assert.throws(() => act(h.store, OPERATOR, "reroute_return", {
      item_id: itemId, expected_revision: revision, return_generation: 1, source_id: wrong.sourceId, reason: "typo",
    }), refused("source_scope_mismatch"));
  }
  assert.equal(h.store.item(itemId)!.return!.generation, 1);
  assert.equal(h.store.item(itemId)!.return!.phase, "failed");
  assert.equal(h.broker.listDeliveries().length, 0, "a refused reroute mints nothing");
  const context = liveSource(h.store, { edgeId: "edge-b", returnMode: "actor_context", session: "session-fable-2" });
  const rerouted = act(h.store, OPERATOR, "reroute_return", {
    item_id: itemId, expected_revision: revision, return_generation: 1, source_id: context.sourceId, reason: "moved to edge-b",
  });
  assert.equal(rerouted.result, "return_rerouted");
  assert.equal(rerouted.return_effect!.generation, 2);
  await publisher(h).drainOnce();
  const minted = h.store.item(itemId)!.return!;
  assert.equal(minted.generation, 2);
  assert.equal(minted.mode, "actor_context");
  assert.equal(minted.phase, "minted");
  const delivery = h.broker.getDelivery(minted.delivery_id!);
  assert.equal(delivery.continuationTarget!.resolution_command_id, resolution.command_id, "the resolution coordinate is stable across generations");
  assert.match(delivery.event.text, /context restored/u);
  h.close();
});

test("A29 retry and reroute never duplicate an in-flight or processed return", async () => {
  const h = harness();
  const { itemId } = resolvedItem(h, { returnMode: "actor_context" });
  await publisher(h).drainOnce();
  const revision = h.store.item(itemId)!.revision;
  const inFlight = act(h.store, OPERATOR, "retry_return", { item_id: itemId, expected_revision: revision, return_generation: 1 });
  assert.equal(inFlight.result, "return_in_flight");
  const other = liveSource(h.store, { returnMode: "actor_context", session: "s2" });
  assert.throws(() => act(h.store, OPERATOR, "reroute_return", { item_id: itemId, expected_revision: revision, return_generation: 1, source_id: other.sourceId, reason: "x" }), refused("return_in_flight"));

  const claimed = h.broker.claimNext("edge-a", 0, [], 1)!;
  h.broker.finish(claimed.id, "edge-a", claimed.leaseGeneration!, "processed", [], "Rendering candidate C.");
  assert.throws(() => act(h.store, OPERATOR, "retry_return", { item_id: itemId, expected_revision: revision, return_generation: 1 }), refused("return_already_processed"));
  // A refusal commits nothing, the settlement it looked at included; the drain records it.
  await publisher(h).drainOnce();
  assert.equal(h.store.item(itemId)!.return!.phase, "processed");
  assert.equal(h.store.item(itemId)!.return!.transport_status, "processed");
  assert.equal(h.broker.listDeliveries().length, 1);
  h.close();
});

test("A29 a retired actor blocks the return for a bounded interval, and the response is retained", async () => {
  const h = harness();
  const { itemId } = resolvedItem(h, { returnMode: "actor_context" });
  h.broker.deleteSubscription("fable");
  assert.deepEqual(await publisher(h).drainOnce(), { minted: 0, blocked: 1, failed: 0, settled: 0 });
  const blocked = h.store.item(itemId)!.return!;
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.next_attempt_at, new Date(h.clock.now().getTime() + RETURN_BLOCKED_RETRY_MS).toISOString());
  assert.deepEqual(await publisher(h).drainOnce(), { minted: 0, blocked: 0, failed: 0, settled: 0 }, "no tight loop");
  h.broker.upsertSubscription(seat("fable"));
  h.clock.advance(RETURN_BLOCKED_RETRY_MS);
  assert.deepEqual(await publisher(h).drainOnce(), { minted: 1, blocked: 0, failed: 0, settled: 0 });
  assert.equal(h.store.item(itemId)!.response, "Use candidate C; retain the current lighting.");
  h.close();
});

test("a transport row deleted before its outcome was snapshotted is named, never inferred processed", async () => {
  const h = harness();
  const { itemId } = resolvedItem(h, { returnMode: "actor_context" });
  await publisher(h).drainOnce();
  const claimed = h.broker.claimNext("edge-a", 0, [], 1)!;
  h.broker.finish(claimed.id, "edge-a", claimed.leaseGeneration!, "failed", [{ code: "provider_dispatch_unknown", detail: "x" }]);
  h.broker.deleteSubscription("fable");
  await publisher(h).drainOnce();
  const ret = h.store.item(itemId)!.return!;
  assert.equal(ret.phase, "failed");
  assert.equal(ret.transport_status, "transport_record_missing");
  h.close();
});

test("the return guard admits only the current generation's own dispatching delivery on its claiming edge", async () => {
  const h = harness();
  const { itemId, commandId } = resolvedItem(h);
  await publisher(h).drainOnce();
  const deliveryId = h.store.item(itemId)!.return!.delivery_id!;
  assert.equal(h.store.returnGuard("edge-a", commandId, 1, deliveryId).reason, "delivery_pending");
  const claimed = h.broker.claimNext("edge-a", 0, [], 1)!;
  h.broker.transition(claimed.id, "edge-a", claimed.leaseGeneration!, "claimed", "accepted_local");
  h.broker.transition(claimed.id, "edge-a", claimed.leaseGeneration!, "accepted_local", "dispatching");
  assert.deepEqual(h.store.returnGuard("edge-a", commandId, 1, deliveryId), { eligible: true, reason: "current_generation", as_of: h.clock.now().toISOString() });
  assert.equal(h.store.returnGuard("edge-b", commandId, 1, deliveryId).reason, "claimed_by_other_edge");
  assert.equal(h.store.returnGuard("edge-a", commandId, 1, deliveryId + 1).reason, "delivery_mismatch");
  assert.equal(h.store.returnGuard("edge-a", commandId, 2, deliveryId).reason, "return_unknown");
  h.broker.finish(claimed.id, "edge-a", claimed.leaseGeneration!, "undeliverable", [{ code: "attention_session_mismatch", detail: "x" }]);
  assert.equal(h.store.returnGuard("edge-a", commandId, 1, deliveryId).reason, "delivery_undeliverable");
  await publisher(h).drainOnce();
  const revision = h.store.item(itemId)!.revision;
  act(h.store, OPERATOR, "retry_return", { item_id: itemId, expected_revision: revision, return_generation: 1 });
  assert.equal(h.store.returnGuard("edge-a", commandId, 1, deliveryId).reason, "generation_superseded");
  h.close();
});

test("a disabled store publishes nothing new but still records terminal outcomes", async () => {
  const h = harness();
  const first = resolvedItem(h, { returnMode: "actor_context" }, "a");
  await publisher(h).drainOnce();
  const second = resolvedItem(h, { returnMode: "actor_context", session: "s2" }, "b");
  h.store.enabled = false;
  const claimed = h.broker.claimNext("edge-a", 0, [], 1)!;
  h.broker.finish(claimed.id, "edge-a", claimed.leaseGeneration!, "processed", [], "done");
  assert.deepEqual(await publisher(h).drainOnce(), { minted: 0, blocked: 0, failed: 0, settled: 1 });
  assert.equal(h.store.item(second.itemId)!.return!.phase, "pending");
  assert.equal(h.store.item(first.itemId)!.return!.phase, "processed");
  h.close();
});

test("a human-first item with no return source mints nothing", async () => {
  const h = harness();
  const started = act(h.store, OPERATOR, "start", { packet: { ...summonPacket(), project_id: "rannis", intervention_key: "x" }, return_source_id: null });
  act(h.store, OPERATOR, "resolve", { item_id: started.item!.item_id, expected_revision: 1, outcome: "completed", response: "done", select_next: false });
  assert.deepEqual(await publisher(h).drainOnce(), { minted: 0, blocked: 0, failed: 0, settled: 0 });
  assert.equal(h.broker.listDeliveries().length, 0);
  h.close();
});

test("A30 the continuation text is bounded, carries the stable coordinate, and never truncates the response", () => {
  const response = "R".repeat(4_000);
  const item = {
    item_id: 42, outcome: "selected", response,
    packet: { ...summonPacket(), artifacts: Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, uri: `https://example.invalid/${"x".repeat(1_900)}${i}` })) },
  } as unknown as ItemView;
  const source = { actor: "fable", session_id: "s", cwd: "/w" } as SourceView;
  const text = continuationText("00000000-0000-4000-8000-000000000000", item, source, { resolution_command_id: "5c0f2c1e-8b8e-4c55-a3a6-0e5c8f8f2d10", generation: 3, mode: "actor_context" });
  assert.ok(text.length <= MAX_CONTINUATION_CHARS);
  assert.ok(text.includes(response));
  assert.match(text, /resolution 5c0f2c1e-8b8e-4c55-a3a6-0e5c8f8f2d10, generation 3/u);
  assert.match(text, /Artifacts: 12 — listed in full by `hive attention show 42 --json`/u);
  assert.match(text, /NOT the original provider session/u);
});

function summonPacket() {
  return {
    human_id: "hakon", project_id: "birthday-film", work_id: "w", intervention_key: "k", kind: "selection" as const,
    title: "t", requested_action: "a", context: "c", unblocks: "u", artifacts: [], estimate_minutes: null, deadline_at: null, predecessor_item_id: null,
  };
}
