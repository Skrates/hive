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
import { BrokerStore, InvalidTransitionError, OUTBOX_MAX_ATTEMPTS, StaleLeaseError } from "./store.js";

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

/** A claimed delivery whose lease is long enough that only the test ends it. */
function seedClaimedDelivery(store: BrokerStore, eventId: string) {
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
    leaseTtlMs: 60_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    maxAttempts: 1,
    expiresAt: null,
  } satisfies SubscriptionInput);
  store.ingestEvent({
    eventId,
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | renew spans",
    raw: {},
    receivedAt: "2026-08-01T00:00:00.000Z",
  } satisfies SlackEventInput);
  return store.claimNext("mac", 0)!;
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

  const queued = store.listUnsentOutbox().find((entry) => entry.deliveryId === deliveryId);
  assert.ok(queued, "recordOutcome must persist the outcome on the outbox");
  assert.equal(queued.traceparent, parent);
});

test("drainOutboxOnce sends under the persisted delivery trace, including a failed send", async (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());

  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const deliveryId = seedDispatchedDelivery(store);
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  const tracestate = "congo=t61rcWkgMzE";
  rememberDeliveryTraceparent(deliveryId, parent, tracestate);

  const exporter = new InMemorySpanExporter();
  logfire.configure({
    serviceName: "hive-test-outbox",
    sendToLogfire: false,
    console: false,
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  installObservabilitySdkForTests(logfire);

  new BrokerService(store, unusedSlack).recordOutcome(deliveryId, "done: shipped the fix");
  const queued = store.listUnsentOutbox().find((entry) => /shipped the fix/.test(entry.text));
  assert.ok(queued);
  assert.equal(queued.traceparent, parent);
  assert.equal(queued.tracestate, tracestate);

  let replies = 0;
  const failingSlack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
    async reply(): Promise<string> {
      replies += 1;
      throw new Error("slack down");
    },
    async react(): Promise<void> {},
  };
  assert.equal(await new BrokerService(store, failingSlack).drainOutbox(), 0);
  assert.equal(replies, 1);

  const send = exporter.getFinishedSpans().find((span) => span.name === "hive.broker.outbox.send");
  assert.ok(send, "drain must emit hive.broker.outbox.send");
  assert.equal(send.spanContext().traceId, "ab".repeat(16));
  assert.equal(send.attributes.delivery_id, deliveryId);
  assert.equal(send.attributes.channel_id, "C1");
  assert.equal(send.attributes.thread_ts, "100.1");
  assert.equal(send.attributes.outcome, "attempt_failed");
  const row = store.db.prepare(
    "SELECT sent_at, abandoned_at, attempts FROM outbox WHERE outbox_id=?",
  ).get(queued.outboxId) as { sent_at: string | null; abandoned_at: string | null; attempts: number };
  assert.equal(row.sent_at, null);
  assert.equal(row.abandoned_at, null);
  assert.equal(row.attempts, 1);

  store.db.prepare("UPDATE outbox SET attempts=?, next_attempt_at=NULL WHERE outbox_id=?")
    .run(OUTBOX_MAX_ATTEMPTS - 1, queued.outboxId);
  exporter.reset();
  assert.equal(await new BrokerService(store, failingSlack).drainOutbox(), 0);
  const abandoned = exporter.getFinishedSpans().find((span) => span.name === "hive.broker.outbox.send");
  assert.ok(abandoned, "exhausting drain must emit hive.broker.outbox.send");
  assert.equal(abandoned.attributes.outcome, "abandoned");
  const exhausted = store.db.prepare(
    "SELECT sent_at, abandoned_at, attempts FROM outbox WHERE outbox_id=?",
  ).get(queued.outboxId) as { sent_at: string | null; abandoned_at: string | null; attempts: number };
  assert.equal(exhausted.sent_at, null);
  assert.ok(exhausted.abandoned_at);
  assert.equal(exhausted.attempts, OUTBOX_MAX_ATTEMPTS);
});

test("drainOutboxOnce records sent on a successful outbox span", async (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());

  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const deliveryId = seedDispatchedDelivery(store);
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  rememberDeliveryTraceparent(deliveryId, parent);

  const exporter = new InMemorySpanExporter();
  logfire.configure({
    serviceName: "hive-test-outbox-sent",
    sendToLogfire: false,
    console: false,
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  installObservabilitySdkForTests(logfire);

  new BrokerService(store, unusedSlack).recordOutcome(deliveryId, "done: shipped the fix");
  const sendingSlack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
    async reply(): Promise<string> { return "100.9"; },
    async react(): Promise<void> {},
  };
  assert.equal(await new BrokerService(store, sendingSlack).drainOutbox(), 1);
  const send = exporter.getFinishedSpans().find((span) => span.name === "hive.broker.outbox.send");
  assert.ok(send, "drain must emit hive.broker.outbox.send");
  assert.equal(send.attributes.outcome, "sent");
});

test("accept and release emit broker transition spans", (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());

  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
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
    maxAttempts: 1,
    expiresAt: null,
  } satisfies SubscriptionInput);
  store.ingestEvent({
    eventId: "Ev-transition",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | transition spans",
    raw: {},
    receivedAt: "2026-08-01T00:00:00.000Z",
  } satisfies SlackEventInput);
  const claimed = store.claimNext("mac", 0)!;

  const exporter = new InMemorySpanExporter();
  logfire.configure({
    serviceName: "hive-test-transition",
    sendToLogfire: false,
    console: false,
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  installObservabilitySdkForTests(logfire);

  const broker = new BrokerService(store, unusedSlack);
  broker.accept(claimed.id, "mac", claimed.leaseGeneration!);
  broker.renew(claimed.id, "mac", claimed.leaseGeneration!);
  broker.release(claimed.id, "mac", claimed.leaseGeneration!, {
    code: "provider_dispatch_unknown",
    detail: "test uncertainty",
  });

  const names = exporter.getFinishedSpans().map((span) => span.name);
  assert.ok(names.includes("hive.broker.accept"), `expected accept span, got ${names.join(",")}`);
  assert.ok(names.includes("hive.broker.release"), `expected release span, got ${names.join(",")}`);
  assert.ok(!names.includes("hive.broker.renew"), `renew must not emit a span, got ${names.join(",")}`);
});

test("a failed renewal emits the authority-loss span a healthy one withholds", (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());

  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const claimed = seedClaimedDelivery(store, "Ev-renew-stale");

  const exporter = new InMemorySpanExporter();
  logfire.configure({
    serviceName: "hive-test-renew-stale",
    sendToLogfire: false,
    console: false,
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  installObservabilitySdkForTests(logfire);

  const broker = new BrokerService(store, unusedSlack);
  const generation = claimed.leaseGeneration!;
  // A stolen lease bumps the generation, so this edge's heartbeat is stale.
  assert.throws(() => broker.renew(claimed.id, "mac", generation + 1), StaleLeaseError);
  // The failure is not swallowed to buy the span: the 409 the edge sees still happens.
  broker.renew(claimed.id, "mac", generation);

  const renews = exporter.getFinishedSpans().filter((span) => span.name === "hive.broker.renew");
  assert.equal(renews.length, 1, "only the failed renewal is spanned");
  assert.equal(renews[0]!.attributes.outcome, "stale_lease");
  assert.equal(renews[0]!.attributes.delivery_id, claimed.id);
});

test("renewing a terminal delivery spans the invalid transition", (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());

  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const claimed = seedClaimedDelivery(store, "Ev-renew-terminal");
  const generation = claimed.leaseGeneration!;
  // The lease outlives the terminal transition, so a heartbeat tick that races
  // the end of the turn reaches renew with authority intact and nothing to renew.
  store.finish(claimed.id, "mac", generation, "processed", []);

  const exporter = new InMemorySpanExporter();
  logfire.configure({
    serviceName: "hive-test-renew-terminal",
    sendToLogfire: false,
    console: false,
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  installObservabilitySdkForTests(logfire);

  assert.throws(
    () => new BrokerService(store, unusedSlack).renew(claimed.id, "mac", generation),
    InvalidTransitionError,
  );

  const renews = exporter.getFinishedSpans().filter((span) => span.name === "hive.broker.renew");
  assert.equal(renews.length, 1, "the invalid transition is spanned");
  assert.equal(renews[0]!.attributes.outcome, "invalid_transition");
});
