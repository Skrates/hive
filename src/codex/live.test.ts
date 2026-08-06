import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import {
  assertPinnedDesktopAccount,
  completeCodexDelivery,
  completeDesktopDelivery,
  desktopDeliveryKey,
} from "./live.js";

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
    async waitForDeliveryOutcome() {
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
    async waitForDeliveryOutcome() {
      return { turnId: "desktop-turn-42", status: "interrupted" as const, assistantText: null };
    },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  await assert.rejects(
    () => completeDesktopDelivery(client, "foreground-task", delivery(now), "wake", () => now),
    /desktop-turn-42 interrupted/,
  );
});

test("a late-claimed delivery gets a full post-claim turn budget", async () => {
  const budgets: number[] = [];
  const appClient = {
    async deliver(_threadId: string, _framed: string, _deliveryId: number, timeoutMs?: number) {
      budgets.push(timeoutMs ?? 0);
      return { turnId: "turn-late", mode: "steer" as const };
    },
    async waitForCompletion(_threadId: string, _turnId: string, timeoutMs: number) {
      budgets.push(timeoutMs);
      return { status: "completed" as const, assistantText: "Answered." };
    },
  };
  const desktopBudgets: number[] = [];
  const desktopClient = {
    async deliver(_sessionId: string, _framed: string, _key: string, timeoutMs?: number) {
      desktopBudgets.push(timeoutMs ?? 0);
      return { turnId: "turn-late", clientUserMessageId: "k", mode: "steer" as const };
    },
    async waitForDeliveryOutcome(_sessionId: string, _accepted: unknown, timeoutMs: number) {
      desktopBudgets.push(timeoutMs);
      return { turnId: "turn-late", status: "completed" as const, assistantText: "Answered." };
    },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  // Claimed 59s into a 60s pre-claim TTL — anchoring on `createdAt` would leave
  // a 1s budget for the whole turn.
  const claimedLate = delivery(now, now - 59_000);

  await completeCodexDelivery(appClient, "thread-1", claimedLate, "wake", () => now);
  await completeDesktopDelivery(desktopClient, "foreground-task", claimedLate, "wake", () => now);

  assert.deepEqual(budgets, [60_000, 60_000]);
  assert.deepEqual(desktopBudgets, [60_000, 60_000]);
});

test("the Desktop idempotency key carries the full Slack dedupe coordinate", () => {
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const first = delivery(now);
  const key = desktopDeliveryKey(first);
  assert.equal(key, "hive-delivery-T1-C1-100.1:35");
  // A recreated ledger reissuing the same integer for a different Slack message
  // must not collide with the recorded answer of the first one.
  const reissued: Delivery = { ...first, event: { ...first.event, messageTs: "200.2" } };
  assert.notEqual(desktopDeliveryKey(reissued), key);
});

test("a Desktop delivery is refused unless its home is the pinned account profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-codex-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pinned = join(root, "profiles", "ariadne");
  const other = join(root, "profiles", "someone-else");
  const linked = join(root, "desktop-home");
  await mkdir(pinned, { recursive: true });
  await mkdir(other, { recursive: true });
  await symlink(pinned, linked);

  // The same profile reached through a symlink is the same account.
  await assertPinnedDesktopAccount(linked, pinned);
  await assert.rejects(
    () => assertPinnedDesktopAccount(other, pinned),
    /is not the subscription's pinned account profile/,
  );
  // An unresolvable home or profile is a hard failure, never a pass-through.
  await assert.rejects(
    () => assertPinnedDesktopAccount(join(root, "missing"), pinned),
    /Cannot verify the Codex Desktop account profile binding/,
  );
});

function delivery(now: number, createdAt: number = now): Delivery {
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
    createdAt: new Date(createdAt).toISOString(),
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
