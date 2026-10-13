import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { BrokerStore } from "../broker/store.js";
import {
  act,
  harness,
  liveSource,
  next,
  OPERATOR,
  packet,
  resolve,
  seat,
  summon,
  THREAD,
} from "./fixtures.js";
import { AttentionRefusal, AttentionSchemaError, AttentionStore } from "./store.js";

function refused(code: string, status?: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AttentionRefusal, `expected AttentionRefusal(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

function outboxCount(h: { broker: BrokerStore }): number {
  return Number((h.broker.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n);
}

test("A01 a summons while the human is active queues silently: active item, revision and notifications unchanged", () => {
  const h = harness();
  const source = liveSource(h.store);
  summon(h.store, source, { intervention_key: "first" });
  const claimed = next(h.store);
  assert.equal(claimed.result, "claimed");
  const active = claimed.active_item!;
  const before = outboxCount(h);
  const deliveriesBefore = h.broker.listDeliveries().length;

  const rung = summon(h.store, source, { intervention_key: "second" });
  assert.equal(rung.result, "created");
  assert.equal(rung.item!.state, "queued");
  assert.deepEqual(rung.active_item, active, "the active slot is untouched");
  assert.deepEqual(h.store.item(active.item_id)!.revision, active.revision);
  assert.equal(outboxCount(h), before, "no Slack post, mention or notice");
  assert.equal(h.broker.listDeliveries().length, deliveriesBefore, "no human wake or actor delivery");
  h.close();
});

test("A02 FIFO order holds and an amendment never jumps the queue", () => {
  const h = harness();
  const source = liveSource(h.store);
  const a = summon(h.store, source, { intervention_key: "a" }).item!;
  const b = summon(h.store, source, { intervention_key: "b" }).item!;
  const c = summon(h.store, source, { intervention_key: "c" }).item!;
  const readyBefore = h.store.item(b.item_id)!.ready_sequence;
  const amended = act(h.store, source, "amend", { item_id: c.item_id, expected_revision: 1, fields: { title: "Newer, louder title" } });
  assert.equal(amended.result, "amended");
  assert.equal(amended.item!.revision, 2);
  assert.equal(h.store.item(b.item_id)!.ready_sequence, readyBefore);

  const order: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const taken = next(h.store);
    order.push(taken.item!.item_id);
    resolve(h.store, taken.item!.item_id, taken.item!.revision);
  }
  assert.deepEqual(order, [a.item_id, b.item_id, c.item_id]);
  h.close();
});

test("A03 an explicit pick is a visible override and leaves the remaining order", () => {
  const h = harness();
  const source = liveSource(h.store);
  const ids = ["a", "b", "c"].map((key) => summon(h.store, source, { intervention_key: key }).item!.item_id);
  const picked = next(h.store, ids[2]!);
  assert.equal(picked.selection!.selection_reason, "explicit_pick");
  assert.equal(picked.item!.item_id, ids[2]);
  resolve(h.store, ids[2]!, picked.item!.revision);
  assert.equal(next(h.store).item!.item_id, ids[0]);
  h.close();
});

test("A04 repeated next returns the active item, even when a different pick is asked for", () => {
  const h = harness();
  const source = liveSource(h.store);
  const a = summon(h.store, source, { intervention_key: "a" }).item!;
  const b = summon(h.store, source, { intervention_key: "b" }).item!;
  const first = next(h.store);
  const again = next(h.store);
  const pickedOther = next(h.store, b.item_id);
  for (const receipt of [again, pickedOther]) {
    assert.equal(receipt.result, "already_active");
    assert.equal(receipt.selection!.selection_reason, "already_active");
    assert.equal(receipt.item!.item_id, a.item_id);
    assert.equal(receipt.item!.revision, first.item!.revision, "a repeated next is not a new claim");
  }
  h.close();
});

test("A04 two connections racing next still yield one active item", () => {
  const h = harness();
  const source = liveSource(h.store);
  for (const key of ["a", "b", "c"]) summon(h.store, source, { intervention_key: key });
  const second = new BrokerStore(h.path, h.clock);
  const other = new AttentionStore({ broker: second, clock: h.clock, humanId: "hakon", enabled: true });
  const answers = [next(h.store), next(other), next(h.store), next(other)];
  assert.equal(new Set(answers.map((receipt) => receipt.item!.item_id)).size, 1);
  assert.equal(answers.filter((receipt) => receipt.result === "claimed").length, 1);
  second.close();
  h.close();
});

test("I01 the one-active invariant is enforced by SQLite itself, not only by the store", () => {
  const h = harness();
  const source = liveSource(h.store);
  summon(h.store, source, { intervention_key: "a" });
  const b = summon(h.store, source, { intervention_key: "b" }).item!;
  next(h.store);
  assert.throws(() => h.broker.db.prepare("UPDATE attention_items SET state='active' WHERE item_id=?").run(b.item_id), /UNIQUE constraint failed/u);
  h.close();
});

test("A04 independent processes racing next produce exactly one claim", async () => {
  const h = harness();
  const source = liveSource(h.store);
  for (const key of ["a", "b", "c", "d"]) summon(h.store, source, { intervention_key: key });
  h.close();
  const storeModule = new URL("./store.js", import.meta.url).href;
  const brokerModule = new URL("../broker/store.js", import.meta.url).href;
  const script = `
    const { BrokerStore } = await import(${JSON.stringify(brokerModule)});
    const { AttentionStore } = await import(${JSON.stringify(storeModule)});
    const { randomUUID } = await import("node:crypto");
    const broker = new BrokerStore(process.argv[1]);
    broker.db.pragma("busy_timeout = 5000");
    const store = new AttentionStore({ broker, clock: { now: () => new Date() }, humanId: "hakon", enabled: true });
    const seen = [];
    for (let i = 0; i < 15; i += 1) {
      const r = store.execute({ kind: "operator" }, { schema_version: 1, command_id: randomUUID(), action: "next", payload: { human_id: "hakon", item_id: null } }).receipt;
      seen.push([r.result, r.item.item_id]);
    }
    process.stdout.write(JSON.stringify(seen));
    broker.close();
  `;
  const runChild = (): Promise<Array<[string, number]>> => new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, h.path], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.once("close", (code) => code === 0 ? done(JSON.parse(out) as Array<[string, number]>) : fail(new Error(err)));
  });
  const [left, right] = await Promise.all([runChild(), runChild()]);
  const all = [...left, ...right];
  assert.equal(all.filter(([result]) => result === "claimed").length, 1, "exactly one process claimed");
  assert.equal(new Set(all.map(([, itemId]) => itemId)).size, 1, "every answer names the same active item");
  const check = new Database(h.path, { readonly: true });
  assert.equal((check.prepare("SELECT COUNT(*) AS n FROM attention_items WHERE state='active'").get() as { n: number }).n, 1);
  check.close();
});

test("A05 a claim survives a broker restart, and a replayed next returns the same receipt", () => {
  let h = harness();
  const source = liveSource(h.store);
  summon(h.store, source);
  const commandId = randomUUID();
  const claimed = next(h.store, null, commandId);
  h = h.reopen();
  const view = h.store.item(claimed.item!.item_id)!;
  assert.equal(view.state, "active");
  assert.equal(view.revision, claimed.item!.revision);
  const replay = next(h.store, null, commandId);
  assert.equal(replay.replayed, true);
  assert.deepEqual({ ...replay, replayed: false }, claimed);
  h.close();
});

test("A06 a replayed resolve --next returns the originally selected item, with one return and one claim", () => {
  const h = harness();
  const source = liveSource(h.store, { returnMode: "actor_context" });
  const a = summon(h.store, source, { intervention_key: "a" }).item!;
  const b = summon(h.store, source, { intervention_key: "b" }).item!;
  const taken = next(h.store);
  const commandId = randomUUID();
  const resolved = resolve(h.store, a.item_id, taken.item!.revision, true, commandId);
  assert.equal(resolved.result, "resolved");
  assert.equal(resolved.return_effect!.phase, "pending");
  assert.equal(resolved.selection!.item!.item_id, b.item_id);

  // The queue moves on: b is resolved and c arrives. The replay still names b.
  resolve(h.store, b.item_id, resolved.selection!.item!.revision);
  summon(h.store, source, { intervention_key: "c" });
  const replay = resolve(h.store, a.item_id, taken.item!.revision, true, commandId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.selection!.item!.item_id, b.item_id);
  const returns = h.broker.db.prepare("SELECT COUNT(*) AS n FROM attention_returns WHERE item_id=?").get(a.item_id) as { n: number };
  assert.equal(returns.n, 1);
  const claims = h.store.events(b.item_id).filter((event) => event.event_type === "claimed");
  assert.equal(claims.length, 1);
  h.close();
});

test("A07 a stale combined resolve commits neither the resolution, the return, nor a next selection", () => {
  const h = harness();
  const source = liveSource(h.store);
  const a = summon(h.store, source, { intervention_key: "a" }).item!;
  summon(h.store, source, { intervention_key: "b" });
  const taken = next(h.store);
  act(h.store, source, "amend", { item_id: a.item_id, expected_revision: taken.item!.revision, fields: { context: "The artifact changed." } });
  assert.throws(() => resolve(h.store, a.item_id, taken.item!.revision, true), (error: unknown) => {
    refused("revision_conflict", 409)(error);
    assert.equal((error as AttentionRefusal).current!.revision, taken.item!.revision + 1, "the 409 exposes the current revision");
    return true;
  });
  assert.equal(h.store.item(a.item_id)!.state, "active");
  assert.equal((h.broker.db.prepare("SELECT COUNT(*) AS n FROM attention_returns").get() as { n: number }).n, 0);
  assert.equal(h.store.status("hakon").eligible_count, 1);
  h.close();
});

test("A08 a deferral is absent before it is due, joins the FIFO tail when due, and an indefinite hold never promotes", () => {
  const h = harness();
  const source = liveSource(h.store);
  const a = summon(h.store, source, { intervention_key: "a" }).item!;
  const hold = summon(h.store, source, { intervention_key: "hold" }).item!;
  const taken = next(h.store);
  act(h.store, OPERATOR, "defer", {
    item_id: a.item_id, expected_revision: taken.item!.revision, reason: "Needs tomorrow's input", until: "2026-10-12T11:00:00+01:00", select_next: false,
  });
  act(h.store, OPERATOR, "defer", { item_id: hold.item_id, expected_revision: 1, reason: "parked", until: null, select_next: false });
  const b = summon(h.store, source, { intervention_key: "b" }).item!;

  const early = next(h.store);
  assert.equal(early.item!.item_id, b.item_id);
  resolve(h.store, b.item_id, early.item!.revision);
  const empty = next(h.store);
  assert.equal(empty.result, "empty");
  assert.equal(empty.selection!.deferred_count, 2);
  assert.equal(empty.selection!.next_deferred_at, "2026-10-12T10:00:00.000Z", "canonical UTC, earliest known");

  const c = summon(h.store, source, { intervention_key: "c" }).item!;
  h.clock.advance(60 * 60_000);
  // Due but not yet promoted (no `next` since): the queue already shows it as available work.
  const before = h.store.status("hakon");
  assert.equal(before.eligible_count, 2, "c and the due deferral a");
  assert.equal(before.deferred_count, 1, "only the indefinite hold");
  assert.equal(before.oldest_eligible_at, "2026-10-12T09:00:00.000Z", "c, ready before a came due at 10:00");
  const due = next(h.store);
  assert.equal(due.item!.item_id, c.item_id, "c was ready before a's deferral came due");
  assert.equal(h.store.status("hakon").oldest_eligible_at, h.clock.now().toISOString(), "a has been eligible since its promotion, not its summons");
  resolve(h.store, c.item_id, due.item!.revision);
  assert.equal(next(h.store).item!.item_id, a.item_id);

  h.clock.advance(365 * 24 * 60 * 60_000);
  assert.equal(h.store.item(hold.item_id)!.state, "deferred");
  h.close();
});

test("a deferral into the past is refused rather than silently promoted", () => {
  const h = harness();
  const a = summon(h.store, liveSource(h.store)).item!;
  assert.throws(() => act(h.store, OPERATOR, "defer", { item_id: a.item_id, expected_revision: 1, reason: "x", until: "2026-10-12T08:00:00Z", select_next: false }),
    refused("until_not_future", 422));
  h.close();
});

test("A09 human-first work starts, resolves and returns nothing without any agent", () => {
  const h = harness();
  const started = act(h.store, OPERATOR, "start", { packet: packet({ project_id: "rannis", work_id: "grant-2027", intervention_key: "argument", kind: "human_work" }), return_source_id: null });
  assert.equal(started.result, "started");
  assert.equal(started.active_item!.item_id, started.item!.item_id);
  const queued = act(h.store, OPERATOR, "add", { packet: packet({ project_id: "jobs", work_id: "application-x", intervention_key: "cover-letter", kind: "human_work" }), return_source_id: null });
  assert.equal(queued.item!.state, "queued");
  assert.throws(() => act(h.store, OPERATOR, "start", { packet: packet({ project_id: "other", intervention_key: "x" }), return_source_id: null }), refused("active_item_exists", 409));
  const done = act(h.store, OPERATOR, "resolve", { item_id: started.item!.item_id, expected_revision: 1, outcome: "completed", response: "Argument drafted.", select_next: true });
  assert.equal(done.return_effect, null);
  assert.equal(done.selection!.item!.item_id, queued.item!.item_id);
  assert.equal(h.broker.listDeliveries().length, 0);
  h.close();
});

test("A10 an empty queue says so with deferred metadata and invents nothing", () => {
  const h = harness();
  const receipt = next(h.store);
  assert.equal(receipt.result, "empty");
  assert.deepEqual(receipt.selection, { selection_reason: "empty", item: null, brief: null, eligible_count: 0, deferred_count: 0, next_deferred_at: null });
  assert.equal(receipt.item, null);
  h.close();
});

test("A11 a lost summons response is recovered by its command id, even after the source is revoked", () => {
  const h = harness();
  const source = liveSource(h.store);
  const commandId = randomUUID();
  const first = summon(h.store, source, {}, commandId);
  act(h.store, OPERATOR, "source_revoke", { source_id: source.sourceId, reason: "seat retired" });
  const again = summon(h.store, source, {}, commandId);
  assert.equal(again.replayed, true);
  assert.equal(again.item!.item_id, first.item!.item_id);
  assert.throws(() => summon(h.store, source, { intervention_key: "fresh" }), refused("source_revoked", 403));
  assert.equal(h.store.status("hakon").eligible_count, 1, "queued work and its provenance survive revocation");
  h.close();
});

test("A12 the same command id with different content conflicts and changes nothing", () => {
  const h = harness();
  const source = liveSource(h.store);
  const commandId = randomUUID();
  summon(h.store, source, {}, commandId);
  assert.throws(() => summon(h.store, source, { title: "Something else" }, commandId), refused("command_id_conflict", 409));
  assert.throws(() => act(h.store, OPERATOR, "next", { human_id: "hakon", item_id: null }, commandId), refused("command_id_conflict", 409));
  assert.equal(h.store.queue("hakon").items.length, 1);
  h.close();
});

test("A13 a changed packet under an existing key must amend; identical content returns the item, never reopening it", () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source).item!;
  assert.equal(summon(h.store, source).result, "existing");
  assert.throws(() => summon(h.store, source, { context: "different" }), refused("item_exists_use_amend", 409));
  const taken = next(h.store);
  resolve(h.store, item.item_id, taken.item!.revision);
  const late = summon(h.store, source);
  assert.equal(late.result, "existing");
  assert.equal(late.item!.state, "resolved", "terminal work is never reopened");
  h.close();
});

test("A14 a new round is a new key with a valid predecessor; an unknown predecessor is refused", () => {
  const h = harness();
  const source = liveSource(h.store);
  const round1 = summon(h.store, source).item!;
  const round2 = summon(h.store, source, { intervention_key: "candidate-selection-r2", predecessor_item_id: round1.item_id });
  assert.notEqual(round2.item!.item_id, round1.item_id);
  assert.throws(() => summon(h.store, source, { intervention_key: "r3", predecessor_item_id: 999 }), refused("unknown_predecessor", 422));
  h.close();
});

test("A15 a source cannot touch a peer's item, select work or resolve", () => {
  const h = harness();
  const mine = liveSource(h.store);
  const peer = liveSource(h.store, { actor: "ariadne", provider: "codex", session: "thread-ari" });
  const item = summon(h.store, mine).item!;
  assert.throws(() => act(h.store, peer, "amend", { item_id: item.item_id, expected_revision: 1, fields: { title: "hijack" } }), refused("not_item_owner", 403));
  assert.throws(() => act(h.store, peer, "withdraw", { item_id: item.item_id, expected_revision: 1, reason: "x" }), refused("not_item_owner", 403));
  assert.throws(() => act(h.store, mine, "next", { human_id: "hakon", item_id: null }), refused("action_not_permitted", 403));
  assert.throws(() => act(h.store, mine, "resolve", { item_id: item.item_id, expected_revision: 1, outcome: "approved", response: "self-approve", select_next: false }), refused("action_not_permitted", 403));
  // A re-enrolled source for the same actor does not silently inherit write access.
  const rebound = liveSource(h.store);
  assert.throws(() => act(h.store, rebound, "amend", { item_id: item.item_id, expected_revision: 1, fields: { title: "t" } }), refused("not_item_owner", 403));
  // A source on another edge is not this edge's to use.
  assert.throws(() => summon(h.store, { ...mine, edgeId: "edge-b" }, { intervention_key: "x" }), refused("source_foreign_edge", 403));
  h.close();
});

test("A15 a source may only summon for the project and work it was bound to", () => {
  const h = harness();
  const source = liveSource(h.store);
  assert.throws(() => summon(h.store, source, { project_id: "krepis" }), refused("source_scope_mismatch", 403));
  h.close();
});

test("A16 an active item cannot be withdrawn from under the human", () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source).item!;
  const taken = next(h.store);
  assert.throws(() => act(h.store, source, "withdraw", { item_id: item.item_id, expected_revision: taken.item!.revision, reason: "never mind" }), refused("item_active", 409));
  const queued = summon(h.store, source, { intervention_key: "other" }).item!;
  assert.equal(act(h.store, source, "withdraw", { item_id: queued.item_id, expected_revision: 1, reason: "superseded" }).result, "withdrawn");
  h.close();
});

test("I11 attention history cannot be deleted and a source's identity cannot change", () => {
  const h = harness();
  const source = liveSource(h.store);
  summon(h.store, source);
  for (const table of ["attention_items", "attention_events", "attention_commands", "attention_sources"]) {
    assert.throws(() => h.broker.db.prepare(`DELETE FROM ${table}`).run(), /attention_history_immutable/u, table);
  }
  assert.throws(() => h.broker.db.prepare("UPDATE attention_sources SET actor='ariadne'").run(), /attention_source_immutable/u);
  h.close();
});

test("a human item's return source must return somewhere", () => {
  const h = harness();
  const silent = liveSource(h.store, { returnMode: "none" });
  assert.throws(() => act(h.store, OPERATOR, "add", { packet: packet(), return_source_id: silent.sourceId }), refused("source_has_no_return", 422));
  h.close();
});

test("an exact-session binding is refused when the session or cwd is unknown, or the actor runs slots", () => {
  const h = harness({ seats: [seat("fable"), seat("talos", { provider: "grok", wakePolicy: "spawn", turnSlots: 4, edgeWorkspaces: [{ edgeId: "edge-a", cwd: "/work/{slot}", worktree: null }] })] });
  assert.throws(() => liveSource(h.store, { cwd: null }), refused("pinned_unavailable", 422));
  assert.throws(() => h.store.bindSource({ edgeId: "edge-a", operator: true }, {
    schema_version: 1, command_id: randomUUID(), action: "source_bind",
    payload: { project_id: "p", work_id: "w", return_mode: "pinned_session", thread: THREAD,
      evidence: { kind: "operator_binding", actor: "fable", session_id: "guessed", session_verified: "none", provider: null, cwd: "/work" } },
  }), refused("pinned_unavailable", 422), "an unverified session cannot claim pinned return");
  const operatorBound = h.store.bindSource({ edgeId: "edge-a", operator: true }, {
    schema_version: 1, command_id: randomUUID(), action: "source_bind",
    payload: { project_id: "p", work_id: "w", return_mode: "actor_context", thread: THREAD,
      evidence: { kind: "operator_binding", actor: "talos", session_id: null, session_verified: "none", provider: null, cwd: "/work/1" } },
  });
  assert.equal(operatorBound.receipt.source!.return_mode, "actor_context");
  assert.equal(operatorBound.receipt.source!.session_absence, "no_session_named");
  assert.throws(() => h.store.bindSource({ edgeId: "edge-a", operator: false }, {
    schema_version: 1, command_id: randomUUID(), action: "source_bind",
    payload: { project_id: "p", work_id: "w", return_mode: "actor_context", thread: THREAD,
      evidence: { kind: "operator_binding", actor: "talos", session_id: null, session_verified: "none", provider: null, cwd: "/work/1" } },
  }), refused("operator_required", 403));
  h.close();
});

test("A17 a dispatch-backed source outlives its delivery and names the actor from the ledger", () => {
  const h = harness();
  h.broker.ingestEvent({
    eventId: "Ev1", workspaceId: "T1", channelId: THREAD.channel_id, threadTs: THREAD.thread_ts, messageTs: "1760259601.000200",
    senderId: "U1", senderKind: "user", actor: "fable", text: "WAKE: fable render the batch", raw: {}, receivedAt: h.clock.now().toISOString(),
  });
  const claimed = h.broker.claimNext("edge-a", 0)!;
  const bind = (generation: number) => h.store.bindSource({ edgeId: "edge-a", operator: false }, {
    schema_version: 1, command_id: randomUUID(), action: "source_bind",
    payload: { project_id: "birthday-film", work_id: "parents-likeness-round-2", return_mode: "actor_context", thread: null,
      evidence: { kind: "dispatch", source_delivery_id: claimed.id, generation, route: "spawn", session_id: null, cwd: "/work" } },
  });
  assert.throws(() => bind(claimed.leaseGeneration! + 1), refused("source_evidence_rejected", 403));
  const bound = bind(claimed.leaseGeneration!).receipt.source!;
  assert.equal(bound.actor, "fable");
  assert.equal(bound.provenance, "dispatch");
  assert.deepEqual(bound.thread, THREAD, "the delivery's own real thread");
  assert.equal(bound.session_absence, "spawned_session_not_captured");
  h.broker.finish(claimed.id, "edge-a", claimed.leaseGeneration!, "processed", []);
  const rung = summon(h.store, { kind: "source", edgeId: "edge-a", sourceId: bound.source_id });
  assert.equal(rung.result, "created", "the binding outlives the turn; no lease is held for the human");
  assert.equal(h.broker.getDelivery(claimed.id).status, "processed");
  h.close();
});

test("a turn resuming a captured session can bind from it; mismatched pinned evidence is refused", () => {
  const h = harness();
  const source = liveSource(h.store, { session: "session-captured" });
  const item = summon(h.store, source).item!;
  const taken = next(h.store);
  resolve(h.store, item.item_id, taken.item!.revision);
  const ret = h.store.dueReturns()[0]!;
  const target = JSON.parse(ret.target_json);
  const { deliveryId } = h.broker.mintSystemWake({ origin: "attention", actor: "fable", channelId: THREAD.channel_id, threadTs: THREAD.thread_ts, text: "t", render: "r", dedupeKey: "d:1", continuationTarget: target });
  const claimed = h.broker.claimNext("edge-a", 0, [], 1)!;
  assert.equal(claimed.id, deliveryId);
  const bind = (sessionId: string) => h.store.bindSource({ edgeId: "edge-a", operator: false }, {
    schema_version: 1, command_id: randomUUID(), action: "source_bind",
    payload: { project_id: "birthday-film", work_id: "round-3", return_mode: "pinned_session", thread: null,
      evidence: { kind: "dispatch", source_delivery_id: claimed.id, generation: claimed.leaseGeneration!, route: "pinned_resume", session_id: sessionId, cwd: "/work/hive" } },
  });
  assert.throws(() => bind("session-other"), refused("source_evidence_rejected", 403));
  const bound = bind("session-captured").receipt.source!;
  assert.equal(bound.session_id, "session-captured");
  assert.equal(bound.return_mode, "pinned_session");
  h.close();
});

test("A35 actor retirement still works beside attention history, which stays readable", () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source).item!;
  assert.equal(h.broker.deleteSubscription("fable"), true);
  const view = h.store.item(item.item_id)!;
  assert.equal(view.source!.actor, "fable");
  assert.equal(view.source!.source_id, source.sourceId);
  h.close();
});

test("A33 the additive migration keeps the broker generation, existing rows, and refuses a newer attention store", () => {
  const path = harness().path;
  const legacy = new BrokerStore(path);
  const deliveriesBefore = legacy.listDeliveries().length;
  assert.equal(legacy.db.pragma("user_version", { simple: true }), 5);
  const tables = (legacy.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'attention_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  assert.deepEqual(tables, ["attention_commands", "attention_events", "attention_items", "attention_returns", "attention_schema", "attention_sources"]);
  assert.ok(legacy.getSubscription("fable"));
  assert.equal(legacy.listDeliveries().length, deliveriesBefore);
  legacy.db.prepare("UPDATE attention_schema SET version=2").run();
  assert.throws(() => new AttentionStore({ broker: legacy, clock: { now: () => new Date() }, humanId: "hakon", enabled: true }), AttentionSchemaError);
  legacy.close();
});

test("A33 a disabled store refuses new mutations but answers reads and replays", () => {
  const h = harness();
  const source = liveSource(h.store);
  const commandId = randomUUID();
  const first = summon(h.store, source, {}, commandId);
  h.store.enabled = false;
  assert.equal(summon(h.store, source, {}, commandId).replayed, true);
  assert.throws(() => next(h.store), refused("attention_disabled", 503));
  assert.throws(() => liveSource(h.store), refused("attention_disabled", 503));
  assert.equal(h.store.item(first.item!.item_id)!.state, "queued");
  h.close();
});

test("the queue pages by keyset in a stable order and reports status", () => {
  const h = harness();
  const source = liveSource(h.store);
  for (let i = 0; i < 5; i += 1) summon(h.store, source, { intervention_key: `k${i}` });
  next(h.store);
  const first = h.store.queue("hakon", { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0]!.state, "active");
  assert.ok(first.next_cursor);
  const second = h.store.queue("hakon", { limit: 2, after: first.next_cursor });
  const third = h.store.queue("hakon", { limit: 2, after: second.next_cursor });
  const ids = [...first.items, ...second.items, ...third.items].map((item) => item.item_id);
  assert.equal(new Set(ids).size, 5);
  assert.equal(third.next_cursor, null);
  assert.equal(first.status.eligible_count, 4);
  assert.throws(() => h.store.queue("hakon", { after: "nonsense" }), refused("invalid_cursor", 400));
  h.close();
});
