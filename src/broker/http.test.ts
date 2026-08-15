import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { SubscriptionInputSchema, type ReplaySnapshot, type SubscriptionInput } from "../domain.js";
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

test("POST /v1/wakes mints a seat wake, and refuses one that cannot be delivered", async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const edgeToken = store.createEdge("dev");
  const broker = new BrokerService(store, slack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(() => server.stop());

  const base: SubscriptionInput = SubscriptionInputSchema.parse({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0",
    sessionId: "thread-1",
    homeEdge: "dev",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "dev", cwd: "/srv/taxis", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/home/user/.codex-hive",
  });
  store.upsertSubscription(base);
  store.upsertSubscription({ ...base, actor: "gnomon", provider: "claude", sessionId: null });
  store.ingestEvent({
    eventId: "Ev1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | go",
    raw: {},
    receivedAt: "2026-08-15T00:00:00.000Z",
  });
  const source = store.claimNext("dev", 0)!;

  const post = (body: unknown, token = edgeToken): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/wakes",
        headers: {
          "x-hive-edge": "dev",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(payload);
    });

  // The mint is an edge-authenticated act like every other seat act.
  const unauthorized = await post({ sourceDeliveryId: source.id, actor: "gnomon", text: "go" }, "wrong-token");
  assert.equal(unauthorized.status, 401);

  const minted = await post({ sourceDeliveryId: source.id, actor: "gnomon", text: "please verify the gate set" });
  assert.equal(minted.status, 201);
  const receipt = JSON.parse(minted.body) as { deliveryId: number; from: string; actor: string };
  assert.equal(receipt.from, "ariadne");
  assert.equal(receipt.actor, "gnomon");
  assert.equal(store.getDelivery(receipt.deliveryId).actor, "gnomon");

  // R-3: a refusal answers with its code AND its reason, never a bare 400.
  const refused = await post({ sourceDeliveryId: source.id, actor: "theoros", text: "hello" });
  assert.equal(refused.status, 422);
  const error = JSON.parse(refused.body) as { error: string; detail: string };
  assert.equal(error.error, "unroutable_actor");
  assert.match(error.detail, /no live subscription/);

  // A body that cannot even name a mint is a validation failure, not a refusal.
  const invalid = await post({ sourceDeliveryId: source.id, actor: "gnomon", text: "" });
  assert.equal(invalid.status, 400);
});
