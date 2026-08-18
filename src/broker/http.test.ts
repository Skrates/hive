import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { ReplaySnapshot } from "../domain.js";
import { BrokerClient } from "../edge/broker-client.js";
import { BrokerHttpServer } from "./http.js";
import { BrokerService, type SlackTransport } from "./service.js";
import { BrokerStore } from "./store.js";

const slack: SlackTransport = {
  async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
  async reply(): Promise<string> { throw new Error("not used"); },
  async react(): Promise<void> { throw new Error("not used"); },
};

test("disconnecting a stalled claim does not lease work to the gone edge", { timeout: 5_000 }, async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("edge-1");
  store.upsertSubscription({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0-alpha.4",
    sessionId: null,
    homeEdge: "edge-1",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "edge-1", cwd: "/work/taxis", worktree: null }],
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
    eventId: "Ev-http-claim",
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
  store.enqueueThreadNotice("C1", "100.1", "one durable notice");

  let releaseReply!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseReply = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const hungSlack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
    async reply(): Promise<string> {
      markStarted();
      await blocked;
      return "100.3";
    },
    async react(): Promise<void> {},
  };
  const broker = new BrokerService(store, hungSlack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(() => server.stop());

  const request = http.get(
    {
      host: "127.0.0.1",
      port,
      path: "/v1/deliveries?wait_ms=30000",
      headers: { "x-hive-edge": "edge-1", authorization: `Bearer ${edgeToken}` },
    },
    (response) => { response.resume(); },
  );
  request.on("error", () => {});
  await started;
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseReply();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.claimNext("edge-1", 0)?.claimedBy, "edge-1", "the abandoned handler must not have leased the wake");
});

test("a BrokerClient fetch timeout does not lease work to the gone edge", { timeout: 5_000 }, async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("edge-1");
  store.upsertSubscription({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0-alpha.4",
    sessionId: null,
    homeEdge: "edge-1",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "edge-1", cwd: "/work/taxis", worktree: null }],
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
    eventId: "Ev-fetch-timeout",
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
  store.enqueueThreadNotice("C1", "100.1", "one durable notice");

  let releaseReply!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseReply = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const hungSlack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
    async reply(): Promise<string> {
      markStarted();
      await blocked;
      return "100.3";
    },
    async react(): Promise<void> {},
  };
  const broker = new BrokerService(store, hungSlack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(() => server.stop(50));

  const client = new BrokerClient(`http://127.0.0.1:${port}`, "edge-1", edgeToken, 80);
  const pending = assert.rejects(() => client.claim(0, 50), /broker_request_timeout/);
  await started;
  await pending;
  releaseReply();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.claimNext("edge-1", 0)?.claimedBy, "edge-1", "the timed-out fetch must not have leased the wake");
});

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
