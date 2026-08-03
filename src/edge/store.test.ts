import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery } from "../domain.js";
import { EdgeStore } from "./store.js";

function delivery(generation: number, attempts = generation): Delivery {
  return {
    id: 1,
    eventId: "Ev1",
    actor: "ariadne",
    status: "claimed",
    reasons: [],
    leaseGeneration: generation,
    claimedBy: "mac",
    attempts,
    nextAttemptAt: null,
    coalesceKey: "ariadne:C1:1.0",
    coalescedEventIds: ["Ev1"],
    initialSnapshot: null,
    snapshotTs: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    subscription: {
      actor: "ariadne", provider: "codex", providerSurface: "app-server", providerVersion: "test",
      sessionId: "thread-1", homeEdge: "mac", workspace: "hive",
      edgeWorkspaces: [{ edgeId: "mac", cwd: "/tmp", worktree: null }], wakePolicy: "resume",
      permissionProfile: "read-only", accountProfile: "/profiles/ariadne", leaseTtlMs: 1_000, deliveryTtlMs: 5_000, homeGraceMs: 0,
      spawnRateLimit: 1, maxAttempts: 5, expiresAt: null, updatedAt: "2026-07-12T00:00:00.000Z",
    },
    event: {
      eventId: "Ev1", workspaceId: "T1", channelId: "C1", threadTs: "1.0", messageTs: "1.1",
      senderId: "U1", senderKind: "user", actor: "ariadne", text: "WAKE: ariadne", raw: {},
      receivedAt: "2026-07-12T00:00:00.000Z",
    },
  };
}

test("a redelivered higher generation replaces stale local state", () => {
  const store = new EdgeStore(":memory:");
  store.receive(delivery(1), 1);
  store.setStatus(1, 1, "released");
  const refreshed = store.receive(delivery(2), 2);
  assert.equal(refreshed.generation, 2);
  assert.equal(refreshed.status, "received");
  assert.equal(store.delivery(1)?.leaseGeneration, 2);
  store.close();
});

test("a redelivered higher attempt replaces stale local state within one lease generation", () => {
  const store = new EdgeStore(":memory:");
  store.receive(delivery(1, 1), 1);
  store.setStatus(1, 1, "released");

  const refreshed = store.receive(delivery(1, 2), 1);

  assert.equal(refreshed.generation, 1);
  assert.equal(refreshed.status, "received");
  assert.equal(store.delivery(1)?.attempts, 2);
  store.close();
});
