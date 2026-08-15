import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { Delivery } from "../domain.js";
import { EdgeStore, type AttestationBinding } from "./store.js";

/** These tests exercise generation/attempt fencing, not attestation binding. */
const unbound: AttestationBinding = { attestationId: null, doctrineCommit: null, absence: "no_attestation_file" };


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
    coalescedMessages: [],
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
  store.receive(delivery(1), 1, unbound);
  store.setStatus(1, 1, "released");
  const refreshed = store.receive(delivery(2), 2, unbound);
  assert.equal(refreshed.generation, 2);
  assert.equal(refreshed.status, "received");
  assert.equal(store.delivery(1)?.leaseGeneration, 2);
  store.close();
});

test("a redelivered higher attempt replaces stale local state within one lease generation", () => {
  const store = new EdgeStore(":memory:");
  store.receive(delivery(1, 1), 1, unbound);
  store.setStatus(1, 1, "released");

  const refreshed = store.receive(delivery(1, 2), 1, unbound);

  assert.equal(refreshed.generation, 1);
  assert.equal(refreshed.status, "received");
  assert.equal(store.delivery(1)?.attempts, 2);
  store.close();
});

test("a claimed delivery is bound to the seat attestation it will run under", () => {
  const store = new EdgeStore(":memory:");
  const row = store.receive(delivery(1), 1, {
    attestationId: "sha256:" + "f".repeat(64),
    doctrineCommit: "b".repeat(40),
    absence: null,
  });
  assert.equal(row.attestation_id, "sha256:" + "f".repeat(64));
  assert.equal(row.doctrine_commit, "b".repeat(40));
  assert.equal(row.attestation_absence, null);
  store.close();
});

test("a redelivery rebinds to the attestation live at the new claim", () => {
  // A seat reinstalled between attempts ran the second attempt under different
  // artifacts; carrying the first attempt's id forward would be a false trace.
  const store = new EdgeStore(":memory:");
  store.receive(delivery(1), 1, { attestationId: "sha256:old", doctrineCommit: "a".repeat(40), absence: null });
  const row = store.receive(delivery(2), 2, { attestationId: "sha256:new", doctrineCommit: "c".repeat(40), absence: null });
  assert.equal(row.attestation_id, "sha256:new");
  assert.equal(row.doctrine_commit, "c".repeat(40));
  store.close();
});

test("a redelivery keeps the prior attempt's attestation and receipt", () => {
  // At-least-once means the uncertain first attempt may have produced effects.
  // Rebinding the current columns must not erase that earlier self-identifying try.
  const store = new EdgeStore(":memory:");
  store.receive(delivery(1, 1), 1, { attestationId: "sha256:old", doctrineCommit: "a".repeat(40), absence: null });
  store.setStatus(1, 1, "released", "receipt-a");
  const row = store.receive(delivery(1, 2), 1, { attestationId: "sha256:new", doctrineCommit: "c".repeat(40), absence: null });
  assert.equal(row.attestation_id, "sha256:new");
  assert.equal(row.provider_receipt, null);
  const history = JSON.parse(row.attestation_history ?? "[]") as Array<{
    attempt: number;
    attestationId: string | null;
    receipt: string | null;
  }>;
  assert.equal(history.length, 1);
  assert.equal(history[0]?.attempt, 1);
  assert.equal(history[0]?.attestationId, "sha256:old");
  assert.equal(history[0]?.receipt, "receipt-a");
  store.close();
});

test("an unattested delivery records why, never a bare null", () => {
  const store = new EdgeStore(":memory:");
  const row = store.receive(delivery(1), 1, {
    attestationId: null,
    doctrineCommit: null,
    absence: "no_attestation_file",
  });
  assert.equal(row.attestation_id, null);
  assert.equal(row.attestation_absence, "no_attestation_file");
  store.close();
});

test("an edge upgraded in place gains the attestation columns", () => {
  // CREATE TABLE IF NOT EXISTS is a no-op on an existing table: without the
  // ALTER migration a live edge would keep the pre-attestation shape forever
  // and every bound write would fail at runtime.
  const path = join(mkdtempSync(join(tmpdir(), "hive-edge-upgrade-")), "edge.sqlite");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE local_deliveries (
      delivery_id INTEGER PRIMARY KEY,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider_receipt TEXT,
      delivery_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.prepare(
    "INSERT INTO local_deliveries VALUES (?,?,?,?,?,?)",
  ).run(9, 1, "processed", "receipt", JSON.stringify(delivery(1)), "2026-08-15T00:00:00.000Z");
  legacy.close();

  const store = new EdgeStore(path);
  assert.equal(store.get(9)!.attestation_id, null);
  const row = store.receive(delivery(2), 2, {
    attestationId: "sha256:migrated",
    doctrineCommit: "d".repeat(40),
    absence: null,
  });
  assert.equal(row.attestation_id, "sha256:migrated");
  store.close();
});
