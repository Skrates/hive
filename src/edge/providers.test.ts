import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import { prepareSocketPath } from "../local/uds.js";
import type { LiveIngress } from "./live-registry.js";
import { delimiter, dirname } from "node:path";
import { CancellationUnconfirmedError, ClaudeProvider, claudePromptSlotArgs, codexPermissionArgs, CodexProvider, composeChildEnv, dispatchDeadlineAt, GrokProvider, grokPermissionArgs, LIVE_CANCEL_OUTCOMES, prependPathEntry, ProviderPreDispatchError, requireAccountProfile, stampDispatchDeadline } from "./providers.js";

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "1.0.0",
    sessionId: "thread-1",
    homeEdge: "mac",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/taxis", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/nonexistent/profile",
    leaseTtlMs: 30_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    maxAttempts: 5,
    expiresAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function delivery(id: number): Delivery {
  return {
    id,
    eventId: `Ev${id}`,
    actor: "ariadne",
    status: "dispatching",
    reasons: [],
    leaseGeneration: 1,
    claimedBy: "mac",
    attempts: 2,
    nextAttemptAt: null,
    coalesceKey: "ariadne:C1:100.1",
    coalescedEventIds: [],
    coalescedMessages: [],
    initialSnapshot: null,
    snapshotTs: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    subscription: subscription(),
    event: {
      eventId: `Ev${id}`,
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100.1",
      messageTs: `100.${id}`,
      senderId: "U1",
      senderKind: "user",
      actor: "ariadne",
      text: "hello",
      raw: {},
      receivedAt: "2026-08-01T00:00:00.000Z",
    },
  };
}

test("prependPathEntry puts the runtime dir first and never duplicates it", () => {
  assert.equal(prependPathEntry("/usr/bin:/bin", "/opt/node"), `/opt/node${delimiter}/usr/bin${delimiter}/bin`);
  // An entry already present is hoisted to the front, not duplicated.
  assert.equal(prependPathEntry(`/usr/bin${delimiter}/opt/node${delimiter}/bin`, "/opt/node"), `/opt/node${delimiter}/usr/bin${delimiter}/bin`);
  // An empty or undefined base yields the entry alone.
  assert.equal(prependPathEntry(undefined, "/opt/node"), "/opt/node");
  assert.equal(prependPathEntry("", "/opt/node"), "/opt/node");
});

test("composeChildEnv prepends the running runtime's directory to the child PATH", () => {
  const runtimeDir = dirname(process.execPath);
  const env = composeChildEnv({ CLAUDE_CONFIG_DIR: "/profiles/ariadne" });
  assert.ok(env.PATH, "composed env carries a PATH");
  assert.ok(env.PATH!.startsWith(`${runtimeDir}${delimiter}`) || env.PATH === runtimeDir, "PATH starts with the runtime dir");
  // The pinned profile env is preserved alongside the PATH fix.
  assert.equal(env.CLAUDE_CONFIG_DIR, "/profiles/ariadne");
  // The runtime dir appears exactly once even if it was already on the inherited PATH.
  assert.equal(env.PATH!.split(delimiter).filter((part) => part === runtimeDir).length, 1);
});

test("an invalid permission profile is a deterministic pre-dispatch failure", () => {
  const codex = new CodexProvider();
  assert.throws(
    () => codex.preflight(subscription({ permissionProfile: "yolo" })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "provider_permission_profile_invalid",
  );
});

test("Grok Build maps all three Hive profiles onto --permission-mode; unknowns fail pre-dispatch", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-grok-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const grok = new GrokProvider();

  assert.deepEqual(grokPermissionArgs("read-only"), ["--permission-mode", "plan"]);
  assert.deepEqual(grokPermissionArgs("workspace-write"), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(grokPermissionArgs("danger-full-access"), ["--permission-mode", "bypassPermissions"]);
  grok.preflight(subscription({ provider: "grok", permissionProfile: "danger-full-access", accountProfile: directory }));

  assert.throws(
    () => grok.preflight(subscription({ provider: "grok", permissionProfile: "yolo", accountProfile: directory })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "provider_permission_profile_invalid",
  );
});

test("Claude prompt-slot flags compose exactly when the rendered artifact exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-prompt-slot-"));
  try {
    // No rendered artifact → the spawn stays byte-identical to today's.
    assert.deepEqual(claudePromptSlotArgs(dir), []);

    // weave-doctrine install.py rendered the seat's doctrine into the slot
    // artifact → the edge composes append + exclude, and nothing else.
    const appendFile = join(dir, "system-prompt-append.md");
    writeFileSync(appendFile, "doctrine\n");
    assert.deepEqual(claudePromptSlotArgs(dir), [
      "--append-system-prompt-file",
      appendFile,
      "--exclude-dynamic-system-prompt-sections",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Grok Build live delivery terminalizes loudly; resume without a session id is a hard error", async () => {
  const grok = new GrokProvider();
  await assert.rejects(grok.deliverLive(), /no live-ingress surface/);
  await assert.rejects(
    async () => grok.resume(subscription({ provider: "grok", sessionId: null }), "/tmp", "framed"),
    /resume target missing/,
  );
});

test("Codex permission arguments grant only the Hive edge socket on spawn and resume", () => {
  const socketPath = "/tmp/hive edge.sock";
  assert.deepEqual(codexPermissionArgs("read-only", socketPath), [
    "-c", "features.network_proxy=true",
    "-c", 'permissions.hive-read-only.extends=":read-only"',
    "-c", "permissions.hive-read-only.network.enabled=true",
    "-c", 'permissions.hive-read-only.network.domains={"hive.invalid"="allow"}',
    "-c", 'permissions.hive-read-only.network.unix_sockets={"/tmp/hive edge.sock"="allow"}',
    "-c", 'default_permissions="hive-read-only"',
  ]);
  assert.deepEqual(codexPermissionArgs("workspace-write", socketPath), [
    "-c", "features.network_proxy=true",
    "-c", 'permissions.hive-workspace.extends=":workspace"',
    "-c", "permissions.hive-workspace.network.enabled=true",
    "-c", 'permissions.hive-workspace.network.domains={"hive.invalid"="allow"}',
    "-c", 'permissions.hive-workspace.network.unix_sockets={"/tmp/hive edge.sock"="allow"}',
    "-c", 'default_permissions="hive-workspace"',
  ]);
  assert.deepEqual(codexPermissionArgs("danger-full-access"), ["--dangerously-bypass-approvals-and-sandbox"]);
});

test("a missing account profile is a hard pre-dispatch failure, never a fallback (ADR-0003 R-5)", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.throws(
    () => requireAccountProfile(subscription({ accountProfile: join(directory, "does-not-exist") })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "account_profile_missing",
  );
  // An existing profile directory passes and is returned verbatim for env pinning.
  assert.equal(requireAccountProfile(subscription({ accountProfile: directory })), directory);

  const codex = new CodexProvider();
  assert.throws(
    () => codex.preflight(subscription({ accountProfile: join(directory, "missing") })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "account_profile_missing",
  );
  const claude = new ClaudeProvider({ ingressRoot: directory });
  assert.throws(
    () => claude.preflight(subscription({ provider: "claude", accountProfile: join(directory, "missing") })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "account_profile_missing",
  );
});

test("Claude boundary delivery lands a durable, self-identifying inbox file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-inbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claude = new ClaudeProvider({ ingressRoot: root });
  const ingress = {} as LiveIngress;

  const result = await claude.deliverLive(ingress, delivery(9), "Message from U1: hello");
  assert.equal(result.processed, false);
  assert.match(result.receipt, /^claude-inbox:/);

  const names = readdirSync(join(root, "ariadne"));
  assert.deepEqual(names, ["delivery-9-attempt-2.json"]);
  const payload = JSON.parse(readFileSync(join(root, "ariadne", names[0]!), "utf8")) as Record<string, unknown>;
  assert.equal(payload.deliveryId, 9);
  assert.equal(payload.attempt, 2);
  assert.equal(payload.dedupe, "100.9:9");
  assert.equal(payload.framed, "Message from U1: hello");

  // A redelivery of the same attempt overwrites idempotently rather than erroring.
  await claude.deliverLive(ingress, delivery(9), "Message from U1: hello");
  assert.deepEqual(readdirSync(join(root, "ariadne")).filter((name) => !name.startsWith(".")), ["delivery-9-attempt-2.json"]);
});

test("Codex live delivery travels over the surface's owner-only UDS socket", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-uds-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);

  const seen: unknown[] = [];
  const longOutcome = "F".repeat(9_471);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const body = JSON.stringify({
        receipt: JSON.stringify({ type: "hive.live.completed", surface: "desktop", turnId: "turn-11" }),
        outcome: longOutcome,
        processed: true,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  t.after(() => server.close());

  const codex = new CodexProvider();
  const ingress: LiveIngress = {
    actor: "ariadne",
    provider: "codex",
    socketPath,
    sessionId: "thread-1",
    surfaceVersion: "test",
    expiresAt: Date.now() + 60_000,
  };
  const result = await codex.deliverLive(ingress, delivery(11), "framed body");
  assert.match(result.receipt, /hive\.live\.completed/);
  assert.equal(result.outcome, longOutcome);
  assert.equal(result.processed, true);
  const payload = seen[0] as { delivery: { id: number }; framed: string; deadlineAt?: number };
  assert.equal(payload.delivery.id, 11);
  assert.equal(payload.framed, "framed body");
  assert.equal(payload.deadlineAt, undefined);
});

test("Codex live delivery forwards the stamped dispatch deadline to the live server", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-uds-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);

  const seen: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        receipt: JSON.stringify({ type: "hive.live.completed", surface: "app-server", turnId: "turn-deadline" }),
        outcome: "done",
        processed: true,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  t.after(() => server.close());

  const controller = new AbortController();
  stampDispatchDeadline(controller.signal, 1_700_000_000_000);
  assert.equal(dispatchDeadlineAt(controller.signal), 1_700_000_000_000);

  const codex = new CodexProvider();
  const ingress: LiveIngress = {
    actor: "ariadne",
    provider: "codex",
    socketPath,
    sessionId: "thread-1",
    surfaceVersion: "test",
    expiresAt: Date.now() + 60_000,
  };
  await codex.deliverLive(ingress, delivery(11), "framed body", controller.signal);
  const payload = seen[0] as { deadlineAt?: number };
  assert.equal(payload.deadlineAt, 1_700_000_000_000);
});

/**
 * A live surface stub that holds every `/deliver` open until it is cancelled,
 * and answers `/cancel` with whatever the test wants the far side to report.
 */
function cancellableSurface(
  socketPath: string,
  cancelAnswer: (deliveryId: number) => { status: number; body: unknown },
  answerDelayMs = 30,
): { server: ReturnType<typeof createServer>; cancels: number[]; ready: Promise<void> } {
  const cancels: number[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        deliveryId?: number;
        delivery?: { id: number };
      };
      if (request.url === "/cancel") {
        cancels.push(payload.deliveryId!);
        // The far side takes time to interrupt; only then does it answer, and
        // only then may the `/deliver` request fail.
        setTimeout(() => {
          const answer = cancelAnswer(payload.deliveryId!);
          const body = JSON.stringify(answer.body);
          for (const open of held.splice(0)) {
            const failure = JSON.stringify({ error: "live_delivery_failed" });
            open.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(failure) });
            open.end(failure);
          }
          response.writeHead(answer.status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
          response.end(body);
        }, answerDelayMs);
        return;
      }
      held.push(response);
    });
  });
  const ready = new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  return { server, cancels, ready };
}

function liveIngress(socketPath: string): LiveIngress {
  return {
    actor: "ariadne",
    provider: "codex",
    socketPath,
    sessionId: "thread-1",
    surfaceVersion: "test",
    expiresAt: Date.now() + 60_000,
  };
}

test("an aborted live dispatch asks the surface to cancel and waits for the answer", async (t) => {
  // Destroying the UDS client is a send. The edge releases this delivery's
  // broker fence when `deliverLive` rejects and the first retry is 5s behind
  // it, so the rejection may not arrive before the surface says the turn
  // stopped — otherwise the retry runs beside a live turn.
  const root = mkdtempSync(join(tmpdir(), "hive-live-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);
  const surface = cancellableSurface(socketPath, () => ({ status: 200, body: { cancelled: true, interrupted: true } }));
  await surface.ready;
  t.after(() => surface.server.close());

  const codex = new CodexProvider();
  const controller = new AbortController();
  const dispatch = codex.deliverLive(liveIngress(socketPath), delivery(21), "framed", controller.signal);
  let settled = false;
  void dispatch.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));

  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "the dispatch is still held while the surface interrupts");

  await assert.rejects(() => dispatch, /cancelled at the edge's dispatch bound/);
  assert.deepEqual(surface.cancels, [21], "the surface was asked to cancel this exact delivery");
});

test("a surface that cannot interrupt its turn yields an UNCONFIRMED cancellation", async (t) => {
  // `interrupted: false` is the far side saying the turn may still be running.
  // Filing that as an ordinary deadline would hide the one case where the
  // retry really can collide (R-3).
  const root = mkdtempSync(join(tmpdir(), "hive-live-uncancelled-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);
  const surface = cancellableSurface(socketPath, () => ({ status: 200, body: { cancelled: true, interrupted: false } }));
  await surface.ready;
  t.after(() => surface.server.close());

  const codex = new CodexProvider();
  const controller = new AbortController();
  const dispatch = codex.deliverLive(liveIngress(socketPath), delivery(22), "framed", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();

  const error = await dispatch.then(() => null, (reason: unknown) => reason);
  assert.ok(error instanceof CancellationUnconfirmedError, "an unconfirmed stop is its own failure class");
  assert.equal((error as CancellationUnconfirmedError).deliveryId, 22);
  assert.match((error as CancellationUnconfirmedError).detail, /could not interrupt the accepted turn/);
});

test("a surface that fails the cancel request yields an UNCONFIRMED cancellation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-live-cancel-failed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);
  const surface = cancellableSurface(socketPath, () => ({ status: 500, body: { error: "live_delivery_failed" } }));
  await surface.ready;
  t.after(() => surface.server.close());

  const codex = new CodexProvider();
  const controller = new AbortController();
  const dispatch = codex.deliverLive(liveIngress(socketPath), delivery(23), "framed", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();

  const error = await dispatch.then(() => null, (reason: unknown) => reason);
  assert.ok(error instanceof CancellationUnconfirmedError, "no answer is never a confirmed stop");
  assert.match((error as CancellationUnconfirmedError).detail, /did not answer the cancel request/);
});

/**
 * Every answer a live surface can give to `/cancel`, and what the edge is
 * entitled to conclude from it. The table is checked against
 * `LIVE_CANCEL_OUTCOMES` below, so a fifth answer cannot be added to the reader
 * without a case here that says whether it releases the fence.
 *
 * The load-bearing row is `no_record`. `cancelled: false` is the answer for a
 * registration that has not landed AND for one that already settled, discarding
 * a recorded failed interrupt with it — so it is not evidence of a stop, and
 * reading it as one released the fence beside a turn known to be running.
 */
const LIVE_CANCEL_ANSWERS: ReadonlyArray<{
  outcome: (typeof LIVE_CANCEL_OUTCOMES)[number];
  what: string;
  answers: ReadonlyArray<{ status: number; body: unknown }>;
  confirmed: boolean;
  detail: RegExp;
  asks: number;
}> = [
  {
    outcome: "stopped",
    what: "the surface stopped the turn and the interrupt landed",
    answers: [{ status: 200, body: { cancelled: true, interrupted: true } }],
    confirmed: true,
    detail: /cancelled at the edge's dispatch bound/,
    asks: 1,
  },
  {
    outcome: "stopped",
    what: "the surface stopped a tracked delivery that had accepted no turn",
    answers: [{ status: 200, body: { cancelled: true, interrupted: null } }],
    confirmed: true,
    detail: /cancelled at the edge's dispatch bound/,
    asks: 1,
  },
  {
    outcome: "interrupt_failed",
    what: "the surface could not interrupt the accepted turn",
    answers: [{ status: 200, body: { cancelled: true, interrupted: false } }],
    confirmed: false,
    detail: /could not interrupt the accepted turn/,
    asks: 1,
  },
  {
    outcome: "no_record",
    what: "the surface has no record of the delivery, twice",
    answers: [
      { status: 200, body: { cancelled: false, interrupted: null } },
      { status: 200, body: { cancelled: false, interrupted: null } },
    ],
    confirmed: false,
    detail: /has no record of this delivery/,
    asks: 2,
  },
  {
    outcome: "no_record",
    what: "the first no-record answer raced the arriving /deliver and the re-ask finds the turn",
    answers: [
      { status: 200, body: { cancelled: false, interrupted: null } },
      { status: 200, body: { cancelled: true, interrupted: true } },
    ],
    confirmed: true,
    detail: /cancelled at the edge's dispatch bound/,
    asks: 2,
  },
  {
    outcome: "no_answer",
    what: "the surface never answers the cancel request",
    answers: [{ status: 500, body: { error: "live_delivery_failed" } }],
    confirmed: false,
    detail: /did not answer the cancel request/,
    asks: 1,
  },
];

test("the cancel-answer table covers every outcome the reader can produce", () => {
  assert.deepEqual(
    [...new Set(LIVE_CANCEL_ANSWERS.map((row) => row.outcome))].sort(),
    [...LIVE_CANCEL_OUTCOMES].sort(),
    "a new /cancel outcome needs a row saying whether it releases the delivery fence",
  );
});

for (const [index, row] of LIVE_CANCEL_ANSWERS.entries()) {
  test(`a live cancel where ${row.what} is ${row.confirmed ? "a" : "NOT a"} confirmed stop`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "hive-live-cancel-table-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const socketPath = join(root, "surface.sock");
    prepareSocketPath(socketPath);
    let ask = 0;
    const surface = cancellableSurface(socketPath, () => row.answers[Math.min(ask++, row.answers.length - 1)]!);
    await surface.ready;
    t.after(() => surface.server.close());

    const codex = new CodexProvider();
    const controller = new AbortController();
    const deliveryId = 40 + index;
    const dispatch = codex.deliverLive(liveIngress(socketPath), delivery(deliveryId), "framed", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    const error = await dispatch.then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof Error, "an aborted live dispatch never resolves");
    assert.equal(
      error instanceof CancellationUnconfirmedError,
      !row.confirmed,
      `${row.what}: an unconfirmed stop must be its own failure class, so the release files it as such`,
    );
    assert.match((error as Error).message, row.detail);
    assert.deepEqual(
      surface.cancels,
      Array.from({ length: row.asks }, () => deliveryId),
      `${row.what}: the edge asks the surface exactly ${row.asks} time(s)`,
    );
  });
}

test("dispatch abort kills the provider process group, including SIGTERM-immune descendants", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-pgid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  mkdirSync(profile);
  const marker = join(root, "grandchild.pid");
  const cli = join(root, "cli.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
spawn(process.execPath, ["-e", ${JSON.stringify(`
  process.on("SIGTERM", () => {});
  require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  setInterval(() => {}, 1000);
`)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`, { mode: 0o755 });

  const previous = process.env.HIVE_CLAUDE_COMMAND;
  process.env.HIVE_CLAUDE_COMMAND = cli;
  t.after(() => {
    if (previous === undefined) delete process.env.HIVE_CLAUDE_COMMAND;
    else process.env.HIVE_CLAUDE_COMMAND = previous;
  });

  const claude = new ClaudeProvider({ ingressRoot: join(root, "inbox") });
  const controller = new AbortController();
  const turn = claude.spawn(
    subscription({ provider: "claude", accountProfile: profile, sessionId: null }),
    root,
    "framed",
    controller.signal,
  );

  const started = Date.now();
  while (!existsSync(marker) && Date.now() - started < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(marker), "grandchild published its pid");
  const grandchildPid = Number(readFileSync(marker, "utf8"));
  t.after(() => {
    try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already gone */ }
  });
  assert.equal(processAlive(grandchildPid), true);

  controller.abort();
  await assert.rejects(turn, /exited|deadline/);

  const killDeadline = Date.now() + 8_000;
  while (processAlive(grandchildPid) && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processAlive(grandchildPid), false, "the descendant must die with the group, not outlive the CLI");
});

function processAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== undefined && state !== "Z";
  } catch {
    return false;
  }
}

test("an oversized live receipt is rejected", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-uds-bad-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ receipt: "x".repeat(4_001), outcome: "done", processed: true }));
  });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  t.after(() => server.close());

  const codex = new CodexProvider();
  const ingress: LiveIngress = {
    actor: "ariadne",
    provider: "codex",
    socketPath,
    sessionId: "thread-1",
    surfaceVersion: "test",
    expiresAt: Date.now() + 60_000,
  };
  await assert.rejects(
    () => codex.deliverLive(ingress, delivery(12), "framed"),
    /invalid response/,
  );
});

test("a missing live outcome is rejected instead of parsing the diagnostic receipt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-uds-no-outcome-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ receipt: "completed", processed: true }));
  });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  t.after(() => server.close());

  const codex = new CodexProvider();
  const ingress: LiveIngress = {
    actor: "ariadne",
    provider: "codex",
    socketPath,
    sessionId: "thread-1",
    surfaceVersion: "test",
    expiresAt: Date.now() + 60_000,
  };
  await assert.rejects(
    () => codex.deliverLive(ingress, delivery(13), "framed"),
    /invalid outcome/,
  );
});

test("a structured Desktop account rejection remains a deterministic pre-dispatch error", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-uds-account-reject-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "surface.sock");
  prepareSocketPath(socketPath);
  const server = createServer((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "account_profile_mismatch" }));
  });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  t.after(() => server.close());

  const codex = new CodexProvider();
  const ingress: LiveIngress = {
    actor: "ariadne",
    provider: "codex",
    socketPath,
    sessionId: "thread-1",
    surfaceVersion: "test",
    expiresAt: Date.now() + 60_000,
  };
  await assert.rejects(
    () => codex.deliverLive(ingress, delivery(14), "framed"),
    (error: unknown) => error instanceof ProviderPreDispatchError
      && error.code === "account_profile_mismatch",
  );
});
