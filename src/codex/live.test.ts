import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import {
  assertPinnedDesktopAccount,
  completeCodexDelivery,
  completeDesktopDelivery,
  DesktopFollowerRetirement,
  desktopDeliveryKey,
  liveRuntimeHome,
} from "./live.js";

test("an obsolete Desktop follower is retired only after its in-flight delivery settles", async () => {
  const unfollowed: string[] = [];
  const retirement = new DesktopFollowerRetirement((sessionId) => unfollowed.push(sessionId));
  let finish!: () => void;
  const operation = new Promise<void>((resolve) => { finish = resolve; });

  retirement.keep("task-a");
  const inFlight = retirement.whileInUse("task-a", () => operation);
  retirement.retire("task-a");
  assert.deepEqual(unfollowed, []);

  finish();
  await inFlight;
  assert.deepEqual(unfollowed, ["task-a"]);

  retirement.retire("task-b");
  assert.deepEqual(unfollowed, ["task-a", "task-b"]);
});

test("reactivating a Desktop task cancels its pending follower retirement", async () => {
  const unfollowed: string[] = [];
  const retirement = new DesktopFollowerRetirement((sessionId) => unfollowed.push(sessionId));
  let finish!: () => void;
  const operation = new Promise<void>((resolve) => { finish = resolve; });

  const inFlight = retirement.whileInUse("task-a", () => operation);
  retirement.retire("task-a");
  retirement.keep("task-a");
  finish();
  await inFlight;

  assert.deepEqual(unfollowed, []);
  retirement.retire("task-a");
  assert.deepEqual(unfollowed, ["task-a"]);
});

test("a completed live turn returns its final text separately from the diagnostic receipt", async () => {
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
  assert.equal(result.outcome, "Outcome closed automatically.");
  assert.deepEqual(budgets, [60_000, 60_000]);
  assert.deepEqual(JSON.parse(result.receipt), {
    type: "hive.live.completed",
    surface: "app-server",
    turnId: "turn-35",
    mode: "start",
    deliveryId: 35,
    status: "completed",
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

test("a completed Desktop turn returns its final text separately from the diagnostic receipt", async () => {
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
  assert.equal(result.outcome, "Foreground reply.");
  assert.deepEqual(JSON.parse(result.receipt), {
    type: "hive.live.completed",
    surface: "desktop",
    turnId: "desktop-turn-41",
    mode: "steer",
    deliveryId: 35,
    status: "completed",
  });
});

test("a long Desktop outcome remains verbatim within the live outcome budget", async () => {
  const answer = "F".repeat(9_471);
  const client = {
    async deliver() {
      return { turnId: "desktop-turn-long", clientUserMessageId: "hive-delivery-long", mode: "steer" as const };
    },
    async waitForDeliveryOutcome() {
      return { turnId: "desktop-turn-long", status: "completed" as const, assistantText: answer };
    },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const result = await completeDesktopDelivery(client, "foreground-task", delivery(now), "wake", () => now);
  assert.equal(result.outcome, answer);
  assert.ok(result.receipt.length < 4_000);
});

test("a Desktop outcome truncates only above the 30,000 character live budget", async () => {
  const answer = "x".repeat(30_001);
  const client = {
    async deliver() {
      return { turnId: "desktop-turn-bounded", clientUserMessageId: "hive-delivery-bounded", mode: "start" as const };
    },
    async waitForDeliveryOutcome() {
      return { turnId: "desktop-turn-bounded", status: "completed" as const, assistantText: answer };
    },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const result = await completeDesktopDelivery(client, "foreground-task", delivery(now), "wake", () => now);
  assert.equal(result.outcome.length, 30_000);
  assert.ok(result.outcome.endsWith("…"));
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
  const desktop = join(root, "desktop");
  const pinned = join(root, "profiles", "ariadne");
  const other = join(root, "profiles", "someone-else");
  await mkdir(desktop, { recursive: true });
  await mkdir(pinned, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(join(desktop, "auth.json"), "desktop-account", { mode: 0o600 });
  await symlink(join(desktop, "auth.json"), join(pinned, "auth.json"));
  await writeFile(join(other, "auth.json"), "other-account", { mode: 0o600 });

  // Desktop keeps its own state home while the Hive profile pins the exact
  // same account credential through its auth link.
  await assertPinnedDesktopAccount(desktop, pinned);
  await assert.rejects(
    () => assertPinnedDesktopAccount(desktop, other),
    /account_profile_mismatch/,
  );
  // An unresolvable home or profile is a hard failure, never a pass-through.
  await assert.rejects(
    () => assertPinnedDesktopAccount(desktop, join(root, "missing")),
    /account_profile_mismatch/,
  );

  const insecureDesktop = join(root, "insecure-desktop");
  const insecurePinned = join(root, "profiles", "insecure");
  await mkdir(insecureDesktop, { recursive: true });
  await mkdir(insecurePinned, { recursive: true });
  const insecureAuth = join(insecureDesktop, "auth.json");
  await writeFile(insecureAuth, "insecure-account", { mode: 0o600 });
  await chmod(insecureAuth, 0o644);
  await symlink(insecureAuth, join(insecurePinned, "auth.json"));
  await assert.rejects(
    () => assertPinnedDesktopAccount(insecureDesktop, insecurePinned),
    /account_profile_mismatch/,
  );
});

test("a foreground Desktop attachment binds to the Desktop home, not the pinned profile", () => {
  assert.equal(liveRuntimeHome("desktop", "/Users/hakon/.codex", "/Users/hakon/.hive/profiles/codex-1"), "/Users/hakon/.codex");
  assert.equal(liveRuntimeHome("dedicated", "/Users/hakon/.codex", "/Users/hakon/.hive/profiles/codex-1"), "/Users/hakon/.hive/profiles/codex-1");
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
