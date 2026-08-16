import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import { prepareSocketPath } from "../local/uds.js";
import type { LiveIngress } from "./live-registry.js";
import { delimiter, dirname } from "node:path";
import { ClaudeProvider, claudePromptSlotArgs, codexPermissionArgs, CodexProvider, composeChildEnv, GrokProvider, grokPermissionArgs, HeadlessProviderExitError, prependPathEntry, ProviderPreDispatchError, requireAccountProfile } from "./providers.js";

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
    // Required: a registration names its attestation or names its absence.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" },
    expiresAt: Date.now() + 60_000,
  };
  const result = await codex.deliverLive(ingress, delivery(11), "framed body");
  assert.match(result.receipt, /hive\.live\.completed/);
  assert.equal(result.outcome, longOutcome);
  assert.equal(result.processed, true);
  const payload = seen[0] as { delivery: { id: number }; framed: string };
  assert.equal(payload.delivery.id, 11);
  assert.equal(payload.framed, "framed body");
});

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
    // Required: a registration names its attestation or names its absence.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" },
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
    // Required: a registration names its attestation or names its absence.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" },
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
    // Required: a registration names its attestation or names its absence.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" },
    expiresAt: Date.now() + 60_000,
  };
  await assert.rejects(
    () => codex.deliverLive(ingress, delivery(14), "framed"),
    (error: unknown) => error instanceof ProviderPreDispatchError
      && error.code === "account_profile_mismatch",
  );
});

test("a nonzero headless exit throws metadata only — never provider stderr", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-headless-exit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "failing-provider");
  const secret = "SECRET_STDERR WAKE: talos | xoxb-not-a-real-token prompt text";
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${secret}' >&2\nexit 7\n`, { mode: 0o755 });
  chmodSync(script, 0o755);

  const previous = process.env.HIVE_GROK_COMMAND;
  t.after(() => {
    if (previous === undefined) delete process.env.HIVE_GROK_COMMAND;
    else process.env.HIVE_GROK_COMMAND = previous;
  });
  process.env.HIVE_GROK_COMMAND = script;

  const grok = new GrokProvider();
  const error = await grok.spawn(
    subscription({ provider: "grok", accountProfile: directory }),
    directory,
    "framed wake must not appear on the error",
  ).then(
    () => {
      throw new Error("expected spawn to reject");
    },
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof HeadlessProviderExitError);
  assert.equal(error.exitCode, 7);
  assert.ok(error.stderrBytes > 0);
  assert.match(error.message, /exited 7/);
  assert.match(error.message, /stderr_bytes=/);
  assert.doesNotMatch(error.message, /SECRET_STDERR/);
  assert.doesNotMatch(error.message, /xoxb-/);
  assert.doesNotMatch(error.message, /framed wake/);
  assert.doesNotMatch(error.stack ?? "", /SECRET_STDERR/);
  assert.doesNotMatch(JSON.stringify(error), /SECRET_STDERR/);
});
