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

test("stop() completes promptly even with an idle keep-alive connection held open", async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  const broker = new BrokerService(store, slack);
  const server = new BrokerHttpServer(broker, { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();

  // A keep-alive agent leaves its socket open in the pool after the response —
  // exactly the shape (an idle held-open connection, like an edge between
  // long-polls) that makes a plain server.close() hang until the keep-alive TTL.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health", agent }, (response) => {
      response.resume();
      response.on("end", resolve);
      response.on("error", reject);
    });
    request.on("error", reject);
  });

  const started = Date.now();
  await server.stop(50); // short drain window, then force-close the idle socket
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 2_000, `stop() resolved promptly, in ${elapsedMs}ms`);
  agent.destroy();
});
