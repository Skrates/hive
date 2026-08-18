import assert from "node:assert/strict";
import http from "node:http";
import * as logfire from "@pydantic/logfire-node";
import test from "node:test";
import type { ReplaySnapshot, SubscriptionInput } from "../domain.js";
import {
  installObservabilitySdkForTests,
  rememberDeliveryTraceparent,
  resetObservabilityForTests,
  withSpan,
} from "../observability.js";
import { BrokerHttpServer } from "./http.js";
import { BrokerService, type SlackTransport } from "./service.js";
import { BrokerStore } from "./store.js";

const slack: SlackTransport = {
  async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
  async reply(): Promise<string> { throw new Error("not used"); },
  async react(): Promise<void> { throw new Error("not used"); },
};

test("stop() force-closes an in-flight long-poll instead of hanging on it", { timeout: 5_000 }, async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("edge-1");
  const broker = new BrokerService(store, slack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();

  // A real edge long-poll: with no delivery pending, the broker holds this GET
  // open server-side for up to wait_ms. This is the shape that makes a plain
  // server.close() pend indefinitely — the request is genuinely in flight, not
  // an idle keep-alive socket that Node closes in ~1ms. Only closeAllConnections()
  // can retire it, so removing the force-close would make this test time out
  // (the { timeout: 5_000 } deadline) rather than pass.
  const longPoll = new Promise<void>((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/deliveries?wait_ms=30000",
        headers: { "x-hive-edge": "edge-1", authorization: `Bearer ${edgeToken}` },
      },
      (response) => {
        response.resume();
        response.on("end", resolve);
        response.on("error", reject);
      },
    );
    request.on("error", reject);
  });
  // The response is expected to abort when stop() force-closes the socket.
  const longPollSettled = longPoll.then(() => "ended", () => "aborted");

  // Give the server a beat to accept the request and enter the long-poll wait.
  await new Promise((resolve) => setTimeout(resolve, 150));

  // The drain window is asserted by ordering, not by duration: the in-flight
  // long-poll must still be open at a probe taken near the end of the window,
  // and aborted once stop() returns. Reading a wall-clock lower bound instead
  // would flake — a setTimeout(50) can be observed as 49ms of Date.now() —
  // while an early force-close (or a drain cap well below drainMs) aborts the
  // poll before this probe fires. The probe sits only a scheduling margin
  // before drainMs so a substantially shorter window fails the race.
  const drainMs = 400;
  const schedulingMarginMs = 50;
  const probeMs = drainMs - schedulingMarginMs;
  const started = Date.now();
  const stopping = server.stop(drainMs);
  const midWindow = await Promise.race([
    longPollSettled,
    new Promise<"open">((resolve) => { setTimeout(() => resolve("open"), probeMs); }),
  ]);
  assert.equal(midWindow, "open", `the long-poll was still draining ${probeMs}ms into the ${drainMs}ms window, not force-closed on entry`);

  await stopping;
  const elapsedMs = Date.now() - started;

  assert.ok(elapsedMs < 2_000, `stop() still completed promptly, in ${elapsedMs}ms`);
  assert.equal(await longPollSettled, "aborted", "the in-flight long-poll was force-closed, not left to finish");
});

function subscription(): SubscriptionInput {
  return {
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "test",
    sessionId: "thread-1",
    homeEdge: "edge-1",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "edge-1", cwd: "/work/hive", worktree: null }],
    wakePolicy: "live_only",
    permissionProfile: "full-access",
    accountProfile: "/profiles/ariadne",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 5_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    maxAttempts: 5,
    expiresAt: null,
  };
}

test("claim response carries the stored delivery traceparent", async (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("edge-1");
  store.upsertSubscription(subscription());
  store.ingestEvent({
    eventId: "Ev-trace",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | metadata only",
    raw: {},
    receivedAt: "2026-08-01T00:00:00.000Z",
  });
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  rememberDeliveryTraceparent(1, parent);

  const broker = new BrokerService(store, slack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`http://127.0.0.1:${port}/v1/deliveries?wait_ms=0`, {
    headers: { "x-hive-edge": "edge-1", authorization: `Bearer ${edgeToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("traceparent"), parent);
  assert.equal(response.headers.get("tracestate"), null);
  const body = await response.json() as { id: number; eventId: string };
  assert.equal(body.id, 1);
  assert.equal(body.eventId, "Ev-trace");
});

test("claim response carries stored tracestate alongside traceparent", async (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("edge-1");
  store.upsertSubscription(subscription());
  store.ingestEvent({
    eventId: "Ev-tracestate",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | metadata only",
    raw: {},
    receivedAt: "2026-08-01T00:00:00.000Z",
  });
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  const tracestate = "congo=t61rcWkgMzE";
  rememberDeliveryTraceparent(1, parent, tracestate);

  const broker = new BrokerService(store, slack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`http://127.0.0.1:${port}/v1/deliveries?wait_ms=0`, {
    headers: { "x-hive-edge": "edge-1", authorization: `Bearer ${edgeToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("traceparent"), parent);
  assert.equal(response.headers.get("tracestate"), tracestate);
});

test("claim response restores the persisted delivery traceparent after a broker restart", async (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("edge-1");
  store.upsertSubscription(subscription());
  logfire.configure({
    serviceName: "hive-test-claim-restart",
    sendToLogfire: false,
    console: false,
  });
  installObservabilitySdkForTests(logfire);
  withSpan("hive.test.ingest", {}, () => {
    store.ingestEvent({
      eventId: "Ev-restart",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100.1",
      messageTs: "100.2",
      senderId: "U1",
      senderKind: "user",
      actor: "ariadne",
      text: "WAKE: ariadne | metadata only",
      raw: {},
      receivedAt: "2026-08-01T00:00:00.000Z",
    });
  });
  const persisted = store.db.prepare(
    "SELECT traceparent, tracestate FROM deliveries WHERE delivery_id=1",
  ).get() as { traceparent: string | null; tracestate: string | null };
  assert.ok(persisted.traceparent, "ingest under a span must persist a traceparent");
  resetObservabilityForTests();

  const broker = new BrokerService(store, slack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`http://127.0.0.1:${port}/v1/deliveries?wait_ms=0`, {
    headers: { "x-hive-edge": "edge-1", authorization: `Bearer ${edgeToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("traceparent"), persisted.traceparent);
  if (persisted.tracestate !== null) {
    assert.equal(response.headers.get("tracestate"), persisted.tracestate);
  }
});

test("claim response has no traceparent when none was stored", async (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("edge-1");
  store.upsertSubscription(subscription());
  store.ingestEvent({
    eventId: "Ev-plain",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | no stored context",
    raw: {},
    receivedAt: "2026-08-01T00:00:00.000Z",
  });

  const broker = new BrokerService(store, slack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(() => server.stop());

  const response = await fetch(`http://127.0.0.1:${port}/v1/deliveries?wait_ms=0`, {
    headers: { "x-hive-edge": "edge-1", authorization: `Bearer ${edgeToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("traceparent"), null);
});
