import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import type { Delivery } from "../domain.js";
import { BrokerClient } from "./broker-client.js";

interface Captured { path: string; body: Record<string, unknown> }

/** A broker stand-in that records every request body and answers with the delivery it was given. */
async function withBroker<T>(
  answer: unknown,
  body: (client: BrokerClient, captured: Captured[]) => Promise<T>,
): Promise<T> {
  const captured: Captured[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push({ path: request.url ?? "", body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await body(new BrokerClient(`http://127.0.0.1:${port}`, "cx53", "edge-token"), captured);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const delivery = { id: 42, leaseGeneration: 7, status: "dispatching" } as unknown as Delivery;

test("KRA-1414: markDispatched puts its notices on the wire; the plain call sends none", async () => {
  await withBroker({ ...delivery, status: "dispatched" }, async (client, captured) => {
    await client.markDispatched(delivery, [{ code: "effort_overlay_unused", detail: "conflict:low,max — nothing applied" }]);
    // Without this leg the edge's disposition dies between the two tested
    // halves: the service test asserts what it hands the client, and the
    // broker's HTTP test asserts what it does with a body that names notices.
    assert.equal(captured[0]?.path, "/v1/deliveries/42/dispatched");
    assert.equal(captured[0]?.body.generation, 7);
    assert.deepEqual(captured[0]?.body.notices, [
      { code: "effort_overlay_unused", detail: "conflict:low,max — nothing applied" },
    ]);

    await client.markDispatched(delivery);
    assert.deepEqual(captured[1]?.body.notices, []);
  });
});

test("a transition's generation is the client's own and cannot be displaced by an extra field", async () => {
  await withBroker(delivery, async (client, captured) => {
    await client.accept(delivery);
    assert.deepEqual(captured[0]?.body, { generation: 7 });
    await client.beginDispatch(delivery);
    assert.deepEqual(captured[1]?.body, { generation: 7 });
    await client.renew(delivery);
    assert.deepEqual(captured[2]?.body, { generation: 7 });
  });
});
