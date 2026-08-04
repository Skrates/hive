import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { ReplaySnapshot } from "../domain.js";
import { BrokerHttpServer } from "./http.js";
import { BrokerService, type SlackTransport } from "./service.js";
import { BrokerStore } from "./store.js";

const slack: SlackTransport = {
  async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
  async reply(): Promise<string> { throw new Error("not used"); },
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

  const started = Date.now();
  await server.stop(50); // short drain window, then force-close the in-flight request
  const elapsedMs = Date.now() - started;

  assert.ok(elapsedMs >= 50, `waited out the ${50}ms drain window before forcing (took ${elapsedMs}ms)`);
  assert.ok(elapsedMs < 2_000, `stop() still completed promptly, in ${elapsedMs}ms`);
  assert.equal(await longPollSettled, "aborted", "the in-flight long-poll was force-closed, not left to finish");
});
