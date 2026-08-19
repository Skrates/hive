import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import { prepareSocketPath, udsRequestJson } from "../local/uds.js";
import {
  assertPinnedDesktopAccount,
  completeCodexDelivery,
  completeDesktopDelivery,
  DesktopFollowerRetirement,
  desktopDeliveryKey,
  handleCodexLiveRequest,
  liveRuntimeHome,
  LiveDeliveryCancellations,
  parseLiveCancelPayload,
  parseLiveDeliveryPayload,
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
    async interrupt() {},
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
    async interrupt() {},
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
    async interrupt() {},
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
    async interrupt() {},
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
    async interrupt() {},
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
    async interrupt() {},
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  await assert.rejects(
    () => completeDesktopDelivery(client, "foreground-task", delivery(now), "wake", () => now),
    /desktop-turn-42 interrupted/,
  );
});

test("the edge dispatch deadline caps the live turn below the subscription TTL", async () => {
  const budgets: number[] = [];
  const client = {
    async deliver(_threadId: string, _framed: string, _deliveryId: number, timeoutMs?: number) {
      budgets.push(timeoutMs ?? 0);
      return { turnId: "turn-capped", mode: "start" as const };
    },
    async waitForCompletion(_threadId: string, _turnId: string, timeoutMs: number) {
      budgets.push(timeoutMs);
      return { status: "completed" as const, assistantText: "Capped." };
    },
    async interrupt() {},
  };
  const desktopBudgets: number[] = [];
  const desktopClient = {
    async deliver(_sessionId: string, _framed: string, _key: string, timeoutMs?: number) {
      desktopBudgets.push(timeoutMs ?? 0);
      return { turnId: "turn-capped", clientUserMessageId: "k", mode: "steer" as const };
    },
    async waitForDeliveryOutcome(_sessionId: string, _accepted: unknown, timeoutMs: number) {
      desktopBudgets.push(timeoutMs);
      return { turnId: "turn-capped", status: "completed" as const, assistantText: "Capped." };
    },
    async interrupt() {},
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  // Subscription TTL is 60s; the edge will release at 5s.
  await completeCodexDelivery(client, "thread-1", delivery(now), "wake", () => now, { deadlineAt: now + 5_000 });
  await completeDesktopDelivery(desktopClient, "foreground-task", delivery(now), "wake", () => now, {
    deadlineAt: now + 5_000,
  });
  assert.deepEqual(budgets, [5_000, 5_000]);
  assert.deepEqual(desktopBudgets, [5_000, 5_000]);
});

test("aborting after accept interrupts the exact accepted turn on both surfaces", async () => {
  const interrupted: string[] = [];
  const controller = new AbortController();
  let waiting = 0;
  const client = {
    async deliver() { return { turnId: "turn-live", mode: "start" as const }; },
    async waitForCompletion(_threadId: string, _turnId: string, _timeoutMs: number, signal?: AbortSignal) {
      waiting += 1;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Codex live delivery aborted")), { once: true });
      });
      return { status: "completed" as const, assistantText: "too late" };
    },
    async interrupt(_threadId: string, turnId: string) { interrupted.push(`app:${turnId}`); },
  };
  const desktopClient = {
    async deliver() {
      return { turnId: "turn-desktop", clientUserMessageId: "k", mode: "steer" as const };
    },
    async waitForDeliveryOutcome(
      _sessionId: string,
      _accepted: unknown,
      _timeoutMs: number,
      signal?: AbortSignal,
    ) {
      waiting += 1;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Codex live delivery aborted")), { once: true });
      });
      return { turnId: "turn-desktop", status: "completed" as const, assistantText: "too late" };
    },
    async interrupt(_sessionId: string, turnId: string) { interrupted.push(`desktop:${turnId}`); },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const reported: boolean[] = [];
  const app = completeCodexDelivery(client, "thread-1", delivery(now), "wake", () => now, {
    signal: controller.signal,
    onInterrupt: (confirmed) => reported.push(confirmed),
  });
  const desktop = completeDesktopDelivery(
    desktopClient,
    "foreground-task",
    delivery(now),
    "wake",
    () => now,
    { signal: controller.signal, onInterrupt: (confirmed) => reported.push(confirmed) },
  );
  const deadline = Date.now() + 1_000;
  while (waiting < 2 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting, 2, "both surfaces accepted a turn before abort");
  controller.abort();
  await assert.rejects(() => app, /aborted/);
  await assert.rejects(() => desktop, /aborted/);
  assert.deepEqual(interrupted, ["app:turn-live", "desktop:turn-desktop"]);
  // Both surfaces report the interrupt, not only the one a finding happened to
  // cite: the cancel receipt is a property of the class.
  assert.deepEqual(reported, [true, true]);
});

test("an abort that arrives while deliver() is accepting still interrupts the acquired turn", async () => {
  const interrupted: string[] = [];
  const controller = new AbortController();
  let finishApp!: (value: { turnId: string; mode: "start" }) => void;
  let finishDesktop!: (value: { turnId: string; clientUserMessageId: string; mode: "steer" }) => void;
  let accepting = 0;
  const client = {
    async deliver() {
      accepting += 1;
      return await new Promise<{ turnId: string; mode: "start" }>((resolve) => { finishApp = resolve; });
    },
    async waitForCompletion() { throw new Error("should not wait after a late abort"); },
    async interrupt(_threadId: string, turnId: string) { interrupted.push(`app:${turnId}`); },
  };
  const desktopClient = {
    async deliver() {
      accepting += 1;
      return await new Promise<{ turnId: string; clientUserMessageId: string; mode: "steer" }>((resolve) => {
        finishDesktop = resolve;
      });
    },
    async waitForDeliveryOutcome() { throw new Error("should not wait after a late abort"); },
    async interrupt(_sessionId: string, turnId: string) { interrupted.push(`desktop:${turnId}`); },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const app = completeCodexDelivery(client, "thread-1", delivery(now), "wake", () => now, {
    signal: controller.signal,
  });
  const desktop = completeDesktopDelivery(
    desktopClient,
    "foreground-task",
    delivery(now),
    "wake",
    () => now,
    { signal: controller.signal },
  );
  const deadline = Date.now() + 1_000;
  while (accepting < 2 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepting, 2, "both surfaces are awaiting provider acceptance");
  controller.abort();
  finishApp({ turnId: "turn-late-accept", mode: "start" });
  finishDesktop({ turnId: "turn-desktop-late", clientUserMessageId: "k", mode: "steer" });
  await assert.rejects(() => app, /aborted/);
  await assert.rejects(() => desktop, /aborted/);
  assert.deepEqual(interrupted, ["app:turn-late-accept", "desktop:turn-desktop-late"]);
});

test("an already-aborted live bound fails before a provider turn is started", async () => {
  let started = false;
  const client = {
    async deliver() {
      started = true;
      return { turnId: "turn-aborted", mode: "start" as const };
    },
    async waitForCompletion() {
      return { status: "completed" as const, assistantText: "too late" };
    },
    async interrupt() {},
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => completeCodexDelivery(client, "thread-1", delivery(now), "wake", () => now, { signal: controller.signal }),
    /aborted/,
  );
  assert.equal(started, false);
});

test("parseLiveDeliveryPayload accepts an optional finite deadlineAt", () => {
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const parsed = parseLiveDeliveryPayload({
    delivery: delivery(now),
    framed: "wake",
    deadlineAt: now + 5_000,
  });
  assert.equal(parsed.deadlineAt, now + 5_000);
  assert.equal(parseLiveDeliveryPayload({ delivery: delivery(now), framed: "wake" }).deadlineAt, undefined);
  assert.throws(
    () => parseLiveDeliveryPayload({ delivery: delivery(now), framed: "wake", deadlineAt: "soon" }),
    /live_delivery_invalid/,
  );
});

test("closing the live HTTP client aborts the in-flight provider wait", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-live-disconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "live.sock");
  prepareSocketPath(socketPath);

  let seenSignal: AbortSignal | undefined;
  const server = createServer((request, response) => {
    void handleCodexLiveRequest(
      request,
      response,
      () => ({ actor: "ariadne", mode: "dedicated" }),
      async (_delivery, _framed, bound) => {
        seenSignal = bound.signal;
        await new Promise(() => {});
        return { receipt: "x", outcome: "y", processed: true };
      },
      new LiveDeliveryCancellations(),
    ).catch(() => {});
  });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  t.after(() => server.close());

  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const payload = JSON.stringify({ delivery: delivery(now), framed: "wake", deadlineAt: now + 5_000 });
  const client = httpRequest({
    socketPath,
    method: "POST",
    path: "/deliver",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  });
  client.on("error", () => {});
  client.end(payload);

  const waitStarted = Date.now();
  while (seenSignal === undefined && Date.now() - waitStarted < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(seenSignal, "the live handler accepted the delivery");
  assert.equal(seenSignal!.aborted, false);

  client.destroy();
  const waitAborted = Date.now();
  while (!seenSignal!.aborted && Date.now() - waitAborted < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(seenSignal!.aborted, true);
});

test("the cancel answer waits for the tracked delivery to stop, and reports the interrupt", async () => {
  // Aborting the UDS client is a send, not a receipt. The edge releases the
  // delivery's broker fence on this answer and the first retry is 5s behind it,
  // so the answer may not arrive until the accepted turn has actually stopped.
  const cancellations = new LiveDeliveryCancellations();
  const client = new AbortController();
  const order: string[] = [];
  const tracked = cancellations.track(77, client.signal, async (bound) => {
    await new Promise<void>((resolve) => {
      bound.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // The far side takes its time interrupting; the answer must not overtake it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    bound.onInterrupt?.(true);
    order.push("stopped");
    throw new Error("Codex live delivery aborted");
  });
  tracked.catch(() => {});

  const answer = await cancellations.cancel(77);
  order.push("answered");
  assert.deepEqual(order, ["stopped", "answered"]);
  assert.deepEqual(answer, { cancelled: true, interrupted: true });
  assert.deepEqual(
    await cancellations.cancel(77),
    { cancelled: false, interrupted: null },
    "a settled delivery leaves no record here — including whatever it knew about its"
      + " interrupt — so this answer says only 'not in flight', never 'it stopped';"
      + " the edge reads it as an unconfirmed cancellation",
  );
});

test("a failed interrupt reaches the cancel answer, not only the log", async () => {
  // The interrupt is the only thing that stops an accepted turn. Swallowing its
  // failure into console.error told the edge the turn was gone when it was not.
  const cancellations = new LiveDeliveryCancellations();
  const client = {
    async deliver() { return { turnId: "turn-stuck", mode: "start" as const }; },
    async waitForCompletion(_threadId: string, _turnId: string, _timeoutMs: number, signal?: AbortSignal) {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Codex live delivery aborted")), { once: true });
      });
      return { status: "completed" as const, assistantText: "unreachable" };
    },
    async interrupt() { throw new Error("app-server connection is gone"); },
  };
  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const clientSignal = new AbortController();
  const tracked = cancellations.track(78, clientSignal.signal, (bound) =>
    completeCodexDelivery(client, "thread-1", delivery(now), "wake", () => now, bound));
  tracked.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await cancellations.cancel(78), { cancelled: true, interrupted: false });
});

test("the live surface answers /cancel over its own socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-live-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "live.sock");
  prepareSocketPath(socketPath);

  const cancellations = new LiveDeliveryCancellations();
  let accepted: ((value: unknown) => void) | null = null;
  const server = createServer((request, response) => {
    void handleCodexLiveRequest(
      request,
      response,
      () => ({ actor: "ariadne", mode: "dedicated" }),
      async (_delivery, _framed, bound) => {
        await new Promise((resolve) => { accepted = resolve; bound.signal.addEventListener("abort", () => resolve(null), { once: true }); });
        bound.onInterrupt?.(true);
        throw new Error("Codex live delivery aborted");
      },
      cancellations,
    ).catch(() => {
      // The real surface answers a failed delivery with its error body; a test
      // server that stayed silent would leave the client hanging instead.
      const body = JSON.stringify({ error: "live_delivery_failed" });
      response.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  t.after(() => server.close());

  const now = Date.parse("2026-08-06T11:26:45.000Z");
  const inFlight = udsRequestJson(socketPath, "POST", "/deliver", { delivery: delivery(now), framed: "wake" })
    .catch(() => null);
  const started = Date.now();
  while (accepted === null && Date.now() - started < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(accepted, "the delivery is in flight on the surface");

  const answer = await udsRequestJson<{ cancelled: boolean; interrupted: boolean | null }>(
    socketPath,
    "POST",
    "/cancel",
    { deliveryId: delivery(now).id },
  );
  assert.deepEqual(answer, { cancelled: true, interrupted: true });
  await inFlight;
  assert.throws(() => parseLiveCancelPayload({ deliveryId: 0 }), /live_delivery_invalid/);
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
    async interrupt() {},
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
    async interrupt() {},
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
