import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import { completeCodexDelivery, completeDesktopDelivery } from "./live.js";

test("a completed live turn becomes a processed provider receipt", async () => {
  const budgets: number[] = [];
  const client = {
    async deliver(_threadId: string, _framed: string, _deliveryId: number, timeoutMs?: number) {
      budgets.push(timeoutMs ?? 0);
      return { turnId: "turn-35", mode: "start" as const };
    },
    async waitForCompletion(_threadId: string, _turnId: string, timeoutMs: number) {
      budgets.push(timeoutMs);
      return { status: "completed" as const, assistantText: "  Outcome closed automatically.  " };
    },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const result = await completeCodexDelivery(client, "thread-1", delivery(now), "wake", () => now);
  assert.equal(result.processed, true);
  assert.deepEqual(budgets, [60_000, 60_000]);
  assert.deepEqual(JSON.parse(result.receipt), {
    type: "item.completed",
    item: { type: "agent_message", text: "Outcome closed automatically." },
  });
});

test("a failed live turn never becomes a processed outcome", async () => {
  const client = {
    async deliver() { return { turnId: "turn-failed", mode: "steer" as const }; },
    async waitForCompletion() { return { status: "failed" as const, assistantText: null }; },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  await assert.rejects(
    () => completeCodexDelivery(client, "thread-1", delivery(now), "wake", () => now),
    /turn-failed failed/,
  );
});

test("a completed Desktop turn becomes the same processed provider receipt", async () => {
  const client = {
    async deliver() {
      return { turnId: "desktop-turn-41", clientUserMessageId: "hive-delivery-41", mode: "steer" as const };
    },
    async waitForTurnCompletion() {
      return { turnId: "desktop-turn-41", status: "completed" as const, assistantText: "  Foreground reply.  " };
    },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const result = await completeDesktopDelivery(client, "foreground-task", delivery(now), "wake", () => now);
  assert.deepEqual(JSON.parse(result.receipt), {
    type: "item.completed",
    item: { type: "agent_message", text: "Foreground reply." },
  });
});

test("an interrupted Desktop turn never becomes a processed outcome", async () => {
  const client = {
    async deliver() {
      return { turnId: "desktop-turn-42", clientUserMessageId: "hive-delivery-42", mode: "start" as const };
    },
    async waitForTurnCompletion() {
      return { turnId: "desktop-turn-42", status: "interrupted" as const, assistantText: null };
    },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  await assert.rejects(
    () => completeDesktopDelivery(client, "foreground-task", delivery(now), "wake", () => now),
    /desktop-turn-42 interrupted/,
  );
});

function delivery(now: number): Delivery {
  const subscription: Subscription = {
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "test",
    sessionId: "thread-1",
    homeEdge: "mac",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
    wakePolicy: "live_only",
    permissionProfile: "read-only",
    accountProfile: "/profiles/ariadne",
    leaseTtlMs: 30_000,
    deliveryTtlMs: 60_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    maxAttempts: 5,
    expiresAt: null,
    updatedAt: new Date(now).toISOString(),
  };
  return {
    id: 35,
    eventId: "Ev35",
    actor: "ariadne",
    status: "dispatching",
    reasons: [],
    leaseGeneration: 1,
    claimedBy: "mac",
    attempts: 1,
    nextAttemptAt: null,
    coalesceKey: "ariadne:C1:100.1",
    coalescedEventIds: ["Ev35"],
    coalescedMessages: [],
    initialSnapshot: null,
    snapshotTs: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    subscription,
    event: {
      eventId: "Ev35",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100.1",
      messageTs: "100.1",
      senderId: "U1",
      senderKind: "user",
      actor: "ariadne",
      text: "WAKE: ariadne",
      raw: {},
      receivedAt: new Date(now).toISOString(),
    },
  };
}
