import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery } from "../domain.js";
import { EdgeStore } from "./store.js";

function delivery(generation: number): Delivery {
  return {
    id: 1,
    eventId: "Ev1",
    actor: "ariadne",
    status: "claimed",
    reasons: [],
    leaseGeneration: generation,
    claimedBy: "mac",
    attempts: generation,
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
      permissionProfile: "read-only", leaseTtlMs: 1_000, deliveryTtlMs: 5_000, homeGraceMs: 0,
      spawnRateLimit: 1, expiresAt: null, updatedAt: "2026-07-12T00:00:00.000Z",
	      bindingMode: "pinned", bindingSource: "operator", bindingRevision: 1,
	      egressPolicy: "receipt_only", egressChannelIds: [],
    },
    event: {
      eventId: "Ev1", workspaceId: "T1", channelId: "C1", threadTs: "1.0", messageTs: "1.1",
      senderId: "U1", senderKind: "user", actor: "ariadne", text: "WAKE: ariadne", raw: {},
      receivedAt: "2026-07-12T00:00:00.000Z",
    },
  };
}

test("a reconciled requeue replaces stale local generation state", () => {
  const store = new EdgeStore(":memory:");
  store.receive(delivery(1), 1);
  store.setStatus(1, 1, "ambiguous");
  const refreshed = store.receive(delivery(2), 2);
  assert.equal(refreshed.generation, 2);
  assert.equal(refreshed.status, "received");
  assert.equal(store.delivery(1)?.leaseGeneration, 2);
  store.close();
});

test("a dispatched spawn session remains available to restart recovery", () => {
	const store = new EdgeStore(":memory:");
	store.receive(delivery(1), 1);
	store.setStatus(1, 1, "dispatched", "spawn receipt", "observed-session-123");

	const recoverable = store.listAmbiguousAfterRestart();
	assert.equal(recoverable.length, 1);
	assert.equal(recoverable[0]?.status, "dispatched");
	assert.equal(recoverable[0]?.spawned_session_id, "observed-session-123");
	store.close();
});
