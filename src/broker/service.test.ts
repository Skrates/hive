import assert from "node:assert/strict";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as logfire from "@pydantic/logfire-node";
import test from "node:test";
import type { ReplaySnapshot, SlackEventInput, SubscriptionInput } from "../domain.js";
import {
  installObservabilitySdkForTests,
  peekDeliveryTraceparent,
  rememberDeliveryTraceparent,
  resetObservabilityForTests,
} from "../observability.js";
import { BrokerService, type SlackTransport } from "./service.js";
import { BrokerStore } from "./store.js";

const unusedSlack: SlackTransport = {
  async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
  async reply(): Promise<string> { throw new Error("not used"); },
  async react(): Promise<void> { throw new Error("not used"); },
};

function seedDispatchedDelivery(store: BrokerStore): number {
  store.createEdge("mac");
  store.upsertSubscription({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "test",
    sessionId: null,
    homeEdge: "mac",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/profiles/ariadne",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 5_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    maxAttempts: 5,
    expiresAt: null,
  } satisfies SubscriptionInput);
  store.ingestEvent({
    eventId: "Ev-outcome",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | report via hive reply",
    raw: {},
    receivedAt: "2026-08-01T00:00:00.000Z",
  } satisfies SlackEventInput);
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.transition(claimed.id, "mac", 1, "dispatching", "dispatched");
  return claimed.id;
}

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

test("recordOutcome restores the stored delivery context, spans, and forgets the parent", (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());

  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const deliveryId = seedDispatchedDelivery(store);
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  rememberDeliveryTraceparent(deliveryId, parent);

  const exporter = new InMemorySpanExporter();
  logfire.configure({
    serviceName: "hive-test-outcome",
    sendToLogfire: false,
    console: false,
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  installObservabilitySdkForTests(logfire);

  const reported = new BrokerService(store, unusedSlack).recordOutcome(deliveryId, "done: shipped the fix");
  assert.equal(reported.status, "processed");
  assert.equal(peekDeliveryTraceparent(deliveryId), undefined);

  const outcome = exporter.getFinishedSpans().find((span) => span.name === "hive.broker.outcome");
  assert.ok(outcome, "recordOutcome must emit hive.broker.outcome");
  assert.equal(outcome.spanContext().traceId, "ab".repeat(16));
  assert.equal(outcome.attributes.delivery_id, deliveryId);
  assert.equal(outcome.attributes.actor, "ariadne");
  assert.equal(outcome.attributes.channel_id, "C1");
  assert.equal(outcome.attributes.thread_ts, "100.1");
  assert.equal(outcome.attributes.dedupe_key, "Ev-outcome");
});
