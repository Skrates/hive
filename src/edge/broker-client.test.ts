import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import { BROKER_REQUEST_TIMEOUT_CODE, BrokerClient } from "./broker-client.js";

/**
 * A broker that accepts the TCP connection and then answers nothing — the
 * half-open shape that parked the cx53 edge inside a single `claim()` for 58
 * minutes on 2026-08-15. Node's `fetch` has no default timeout, so without a
 * bound this request neither resolves nor rejects, and a run loop waiting on it
 * is indistinguishable from one holding a healthy long-poll open.
 */
function silentBroker(): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer(() => {
    // Deliberately never respond and never destroy the socket.
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const TOKEN = "t".repeat(32);

function delivery(): Delivery {
  return {
    id: 1,
    eventId: "Ev1",
    actor: "gnomon",
    status: "claimed",
    reasons: [],
    leaseGeneration: 7,
    claimedBy: "cx53",
    attempts: 1,
    nextAttemptAt: null,
    coalesceKey: "gnomon:C1:100.1",
    coalescedEventIds: ["Ev1"],
    coalescedMessages: [],
    initialSnapshot: null,
    snapshotTs: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    subscription: {} as Subscription,
    event: {
      eventId: "Ev1",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100.1",
      messageTs: "100.2",
      senderId: "U1",
      senderKind: "user",
      actor: "gnomon",
      text: "WAKE: gnomon",
      raw: {},
      receivedAt: "2026-08-15T00:00:00.000Z",
    },
  };
}

test("a claim against a broker that never answers rejects at the bound instead of hanging", async (t) => {
  const broker = await silentBroker();
  t.after(() => broker.close());
  const client = new BrokerClient(broker.url, "cx53", TOKEN, 200);

  const startedAt = Date.now();
  await assert.rejects(
    () => client.claim(0, 0),
    (error: Error) => {
      assert.match(error.message, new RegExp(BROKER_REQUEST_TIMEOUT_CODE));
      // The classifier reads this message; an opaque one is how the incident's
      // journal collapsed to `edge_iteration_failed` and told the operator nothing.
      assert.match(error.message, /GET .*exceeded 200ms/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 5_000, "rejected promptly, not on some outer timeout");
});

test("the long-poll bound is the declared wait window plus the margin, not the margin alone", async (t) => {
  // A claim legitimately holds open for `wait_ms`. Bounding it at the plain
  // request timeout would abort every healthy long-poll — a fix that breaks
  // claiming outright is not a fix.
  const broker = await silentBroker();
  t.after(() => broker.close());
  const client = new BrokerClient(broker.url, "cx53", TOKEN, 200);

  const startedAt = Date.now();
  await assert.rejects(() => client.claim(0, 600), (error: Error) => {
    assert.match(error.message, /exceeded 800ms/);
    return true;
  });
  assert.ok(Date.now() - startedAt >= 600, "the declared wait window was honoured before the bound applied");
});

test("every other broker call carries the bound too, not just the long-poll", async (t) => {
  // `renew` runs inside the lease heartbeat and `release` runs on the failure
  // path: an unbounded wait in either is another place a dispatch can be lost.
  const broker = await silentBroker();
  t.after(() => broker.close());
  const client = new BrokerClient(broker.url, "cx53", TOKEN, 200);

  await assert.rejects(() => client.renew(delivery()), new RegExp(BROKER_REQUEST_TIMEOUT_CODE));
  await assert.rejects(
    () => client.release(delivery(), { code: "provider_dispatch_unknown", detail: "test" }),
    new RegExp(BROKER_REQUEST_TIMEOUT_CODE),
  );
});
