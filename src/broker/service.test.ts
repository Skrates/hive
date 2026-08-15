import assert from "node:assert/strict";
import test from "node:test";
import type { ReplaySnapshot } from "../domain.js";
import { BrokerService, type SlackTransport } from "./service.js";
import { BrokerStore, SeatWakeRefusedError } from "./store.js";

test("overlapping outbox drains share one healthy in-process pass", async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  store.enqueueThreadNotice("C1", "100.1", "one durable notice");

  let replyCalls = 0;
  let markStarted!: () => void;
  let releaseReply!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseReply = resolve; });
  const slack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> {
      return { channelId: "C1", threadTs: "100.1", fetchedAt: new Date(0).toISOString(), cursor: null, messages: [] };
    },
    async reply(): Promise<string> {
      replyCalls += 1;
      markStarted();
      await blocked;
      return "100.2";
    },
    async react(): Promise<void> {},
  };
  const broker = new BrokerService(store, slack);

  const first = broker.drainOutbox();
  await started;
  const second = broker.drainOutbox();
  const third = broker.drainOutbox();
  releaseReply();

  assert.deepEqual(await Promise.all([first, second, third]), [1, 1, 1]);
  assert.equal(replyCalls, 1);
  assert.deepEqual(store.listUnsentOutbox(), []);

  // The single-flight latch clears after completion, so a future enqueue gets
  // its own pass instead of remaining attached to the completed promise.
  assert.equal(await broker.drainOutbox(), 0);
});

test("drain stamps the row's reaction on the wake message and a reaction failure never blocks the row", async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  store.createEdge("mac");
  store.upsertSubscription({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0-alpha.4",
    sessionId: null,
    homeEdge: "mac",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/taxis", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/home/user/.codex-hive",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 60_000,
    homeGraceMs: 2_000,
    spawnRateLimit: 1,
    maxAttempts: 3,
    expiresAt: null,
  });
  store.ingestEvent({
    eventId: "Ev1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | test",
    raw: { type: "message" },
    receivedAt: "2026-07-12T00:00:00.000Z",
  });
  // A second wake coalesces into the pending delivery; its message must be stamped too.
  store.ingestEvent({
    eventId: "Ev2",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.4",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | again",
    raw: { type: "message" },
    receivedAt: "2026-07-12T00:00:01.000Z",
  });
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.markDispatched(claimed.id, "mac", 1);

  const reactions: Array<{ ts: string; name: string }> = [];
  const slack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
    async reply(): Promise<string> { return "100.3"; },
    async react(_channel, ts, name): Promise<void> {
      reactions.push({ ts, name });
      throw new Error("reactions API down");
    },
  };
  const broker = new BrokerService(store, slack);
  assert.equal(await broker.drainOutbox(), 1);
  // The stamp targeted every wake message the delivery absorbed...
  assert.deepEqual(reactions, [{ ts: "100.2", name: "eyes" }, { ts: "100.4", name: "eyes" }]);
  // ...and its failure did not keep the row unsent (the text post is the contract).
  assert.deepEqual(store.listUnsentOutbox(), []);
});

test("a hung reactions call never stalls the serialized drain that claim() waits on", async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  store.createEdge("mac");
  store.upsertSubscription({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0-alpha.4",
    sessionId: null,
    homeEdge: "mac",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/taxis", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/home/user/.codex-hive",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 60_000,
    homeGraceMs: 2_000,
    spawnRateLimit: 1,
    maxAttempts: 3,
    expiresAt: null,
  });
  store.ingestEvent({
    eventId: "Ev1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | test",
    raw: { type: "message" },
    receivedAt: "2026-07-12T00:00:00.000Z",
  });
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.markDispatched(claimed.id, "mac", 1);

  const slack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
    async reply(): Promise<string> { return "100.3"; },
    // A reactions.add held forever (rate-limit retry loop, dead socket).
    react(): Promise<void> { return new Promise<void>(() => {}); },
  };
  const broker = new BrokerService(store, slack);
  // The drain resolves without the stamp: the wake-delivery path stays live.
  assert.equal(await broker.drainOutbox(), 1);
  assert.deepEqual(store.listUnsentOutbox(), []);
});

test("mint proves an alternate thread against Slack before the ledger commits", async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  store.createEdge("mac");
  store.createEdge("dev");
  store.upsertSubscription({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0-alpha.4",
    sessionId: null,
    homeEdge: "mac",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/taxis", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/home/user/.codex-hive",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 60_000,
    homeGraceMs: 2_000,
    spawnRateLimit: 1,
    maxAttempts: 3,
    expiresAt: null,
  });
  store.upsertSubscription({
    actor: "gnomon",
    provider: "claude",
    providerSurface: "app-server",
    providerVersion: "0.144.0-alpha.4",
    sessionId: null,
    homeEdge: "dev",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "dev", cwd: "/srv/taxis", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/home/hive/.hive/profiles/gnomon",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 60_000,
    homeGraceMs: 2_000,
    spawnRateLimit: 1,
    maxAttempts: 3,
    expiresAt: null,
  });
  store.ingestEvent({
    eventId: "Ev1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | test",
    raw: { type: "message" },
    receivedAt: "2026-07-12T00:00:00.000Z",
  });
  const source = store.claimNext("mac", 0)!;
  const seen: Array<{ channelId: string; threadTs: string }> = [];
  const slack: SlackTransport = {
    async replay(channelId, threadTs): Promise<ReplaySnapshot> {
      seen.push({ channelId, threadTs });
      if (threadTs === "200.1") {
        return { channelId, threadTs, fetchedAt: "2026-07-12T00:00:00.000Z", cursor: null, messages: [{ ts: threadTs }] };
      }
      throw new Error("thread_not_found");
    },
    async reply(): Promise<string> { throw new Error("not used"); },
    async react(): Promise<void> {},
  };
  const broker = new BrokerService(store, slack);

  const receipt = await broker.mintSeatWake({
    sourceDeliveryId: source.id,
    actor: "gnomon",
    text: "land it here",
    threadTs: "200.1",
  }, "mac");
  assert.equal(receipt.threadTs, "200.1");
  assert.deepEqual(seen, [{ channelId: "C1", threadTs: "200.1" }]);

  // The source thread is already known — Slack is not asked again.
  const same = await broker.mintSeatWake({
    sourceDeliveryId: source.id,
    actor: "gnomon",
    text: "stay put",
    threadTs: "100.1",
  }, "mac");
  assert.equal(same.threadTs, "100.1");
  assert.equal(seen.length, 1);

  await assert.rejects(
    () => broker.mintSeatWake({
      sourceDeliveryId: source.id,
      actor: "gnomon",
      text: "nowhere",
      threadTs: "999.1",
    }, "mac"),
    (error: unknown) => error instanceof SeatWakeRefusedError && error.code === "invalid_thread",
  );
});
