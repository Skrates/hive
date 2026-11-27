import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import { prepareSocketPath } from "../local/uds.js";
import type { LiveIngress } from "./live-registry.js";
import { delimiter, dirname } from "node:path";
import { antigravitySandboxAvailable, headlessDispatchResult, ingressInboxDirectory, ClaudeProvider, claudePromptSlotArgs, CODEX_NETWORK_DOMAINS, codexPermissionArgs, codexSpawnArgs, codexResumeTurn, codexSpawnTurn, CodexProvider, composeChildEnv, GeminiProvider, GrokProvider, grokPermissionArgs, prependPathEntry, ProviderPreDispatchError, requireAccountProfile, resolveEdgeSocketPath } from "./providers.js";
import { drainInbox } from "../channel/claude-hook.js";

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
    turnSlots: 1,
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
    leaseSlot: 1,
    claimedBy: "mac",
    attempts: 2,
    nextAttemptAt: null,
    coalesceKey: "ariadne:C1:100.1",
    coalescedEventIds: [],
    coalescedMessages: [],
    continuationTarget: null,
    requiredEdgeProtocol: 0,
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
  const env = composeChildEnv({ CLAUDE_CONFIG_DIR: "/profiles/ariadne" }, { deliveryId: 512, token: "turn-token", effort: null });
  assert.ok(env.PATH, "composed env carries a PATH");
  assert.ok(env.PATH!.startsWith(`${runtimeDir}${delimiter}`) || env.PATH === runtimeDir, "PATH starts with the runtime dir");
  // The pinned profile env is preserved alongside the PATH fix.
  assert.equal(env.CLAUDE_CONFIG_DIR, "/profiles/ariadne");
  // The runtime dir appears exactly once even if it was already on the inherited PATH.
  assert.equal(env.PATH!.split(delimiter).filter((part) => part === runtimeDir).length, 1);
});

test("a headless child carries its delivery id, and never the actor's live-ingress identity", (t) => {
  // An edge started from a seat's own shell inherits that seat's HIVE_ACTOR.
  const previous = process.env.HIVE_ACTOR;
  process.env.HIVE_ACTOR = "gnomon";
  t.after(() => {
    if (previous === undefined) delete process.env.HIVE_ACTOR;
    else process.env.HIVE_ACTOR = previous;
  });
  const env = composeChildEnv({ CLAUDE_CONFIG_DIR: "/profiles/gnomon" }, { deliveryId: 512, token: "turn-token", effort: null });

  // KRA-1097: `hive wake` reads this to name the minting seat's delivery, so a
  // completing seat can address a peer without re-typing an id it was handed.
  assert.equal(env.HIVE_DELIVERY_ID, "512");
  // The turn's mint capability. Without it `hive wake` has nothing to present,
  // and with it the child never has to name a delivery id — which on a
  // multi-actor edge is the difference between minting as itself and minting
  // as a co-tenant.
  assert.equal(env.HIVE_DELIVERY_TOKEN, "turn-token");
  // The owner-local socket rides along so a Grok child whose HOME is the
  // account profile still dials the edge, not `<profile>/.hive/edge.sock`.
  assert.equal(env.HIVE_EDGE_SOCKET, resolveEdgeSocketPath());

  // HIVE_ACTOR must NOT ride along, even when the edge inherited one. The Claude
  // session hook registers whatever actor it finds in the environment as that
  // actor's LIVE ingress; letting it through would point the actor's live
  // registration at a process that exits moments later, sending the next wake to
  // an inbox no session drains.
  assert.equal(env.HIVE_ACTOR, undefined);
  // The pinned profile still decides which seat the turn runs as (R-5).
  assert.equal(env.CLAUDE_CONFIG_DIR, "/profiles/gnomon");
});

test("composeChildEnv exports the owner-local edge socket, not the child's pinned home", (t) => {
  const previousSocket = process.env.HIVE_EDGE_SOCKET;
  const previousHome = process.env.HIVE_HOME;
  delete process.env.HIVE_EDGE_SOCKET;
  delete process.env.HIVE_HOME;
  t.after(() => {
    if (previousSocket === undefined) delete process.env.HIVE_EDGE_SOCKET;
    else process.env.HIVE_EDGE_SOCKET = previousSocket;
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
  });

  const env = composeChildEnv({ HOME: "/profiles/grok-seat" }, { deliveryId: 7, token: "turn-token", effort: null });
  assert.equal(env.HOME, "/profiles/grok-seat");
  assert.equal(env.HIVE_EDGE_SOCKET, join(homedir(), ".hive", "edge.sock"));
  assert.notEqual(env.HIVE_EDGE_SOCKET, join("/profiles/grok-seat", ".hive", "edge.sock"));

  process.env.HIVE_EDGE_SOCKET = "/run/hive/edge.sock";
  const pinned = composeChildEnv({ HOME: "/profiles/grok-seat" }, { deliveryId: 7, token: "turn-token", effort: null });
  assert.equal(pinned.HIVE_EDGE_SOCKET, "/run/hive/edge.sock");
});

test("an invalid permission profile is a deterministic pre-dispatch failure", () => {
  const codex = new CodexProvider();
  assert.throws(
    () => codex.preflight(subscription({ permissionProfile: "yolo" })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "provider_permission_profile_invalid",
  );
});

test("Grok and Claude share all three Hive permission profiles; unknowns fail pre-dispatch", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-provider-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const grok = new GrokProvider();
  const claude = new ClaudeProvider({ ingressRoot: directory });
  const profiles = ["read-only", "workspace-write", "danger-full-access"] as const;

  assert.deepEqual(grokPermissionArgs("read-only"), ["--permission-mode", "plan"]);
  assert.deepEqual(grokPermissionArgs("workspace-write"), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(grokPermissionArgs("danger-full-access"), ["--permission-mode", "bypassPermissions"]);
  for (const permissionProfile of profiles) {
    const profileSubscription = subscription({ permissionProfile, accountProfile: directory });
    assert.doesNotThrow(() => grok.preflight({ ...profileSubscription, provider: "grok" }));
    assert.doesNotThrow(() => claude.preflight({ ...profileSubscription, provider: "claude" }));
  }

  assert.throws(
    () => grok.preflight(subscription({ provider: "grok", permissionProfile: "yolo", accountProfile: directory })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "provider_permission_profile_invalid",
  );
  assert.throws(
    () => claude.preflight(subscription({ provider: "claude", permissionProfile: "yolo", accountProfile: directory })),
    (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "provider_permission_profile_invalid",
  );
});

test("Gemini requires the dedicated Unix user's home and rejects unsupported routes and permissions", async t => {
  const other = mkdtempSync(join(tmpdir(), "hive-gemini-profile-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const gemini = new GeminiProvider(() => true);
  const seat = subscription({ provider: "gemini", permissionProfile: "workspace-write", accountProfile: userInfo().homedir });
  gemini.preflight(seat);
  for (const [override, code] of [
    [{ accountProfile: join(other, "missing") }, "account_profile_missing"],
    [{ accountProfile: other }, "account_profile_user_mismatch"],
    [{ permissionProfile: "read-only" }, "provider_permission_profile_invalid"],
    [{ permissionProfile: "yolo" }, "provider_permission_profile_invalid"],
  ] as const) {
    assert.throws(() => gemini.preflight({ ...seat, ...override }),
      (error: unknown) => error instanceof ProviderPreDispatchError && error.code === code);
  }
  await assert.rejects(gemini.deliverLive(), /no Hive live-ingress/);
  await assert.rejects(gemini.resume({ ...seat, sessionId: null }, other, "framed",
    { deliveryId: 1, token: "test", effort: null }), /resume target missing/);
});

test("Gemini maps spawn and exact resume to agy and records the complete reply and conversation ID", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "hive-gemini-turn-"));
  const command = join(cwd, "fake-agy.cjs");
  const previous = process.env.HIVE_GEMINI_COMMAND;
  process.env.HIVE_GEMINI_COMMAND = command;
  t.after(() => {
    if (previous === undefined) delete process.env.HIVE_GEMINI_COMMAND;
    else process.env.HIVE_GEMINI_COMMAND = previous;
    rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync("invocation", JSON.stringify({args: process.argv.slice(2), home: process.env.HOME, id: process.env.HIVE_DELIVERY_ID}));
process.stdout.write(fs.readFileSync("stream"));
if (fs.existsSync("exit-code")) process.exitCode = Number(fs.readFileSync("exit-code", "utf8"));
`, { mode: 0o700 });

  const gemini = new GeminiProvider(() => true);
  const home = userInfo().homedir;
  const seat = subscription({ provider: "gemini", permissionProfile: "workspace-write", accountProfile: home, sessionId: "requested-id" });
  const context = { deliveryId: 42, token: "test", effort: null };
  const outcome = "final reply\n".repeat(800);
  const terminal = (sessionId: string, status = "SUCCESS") => JSON.stringify({
    event: "result", result: { status, conversation_id: sessionId, response: outcome },
  });
  const stream = join(cwd, "stream");
  writeFileSync(stream, JSON.stringify({ event: "step_update", step_update: { text_delta: "partial" } })
    + "\n" + terminal("spawned-id") + "\n");
  const framed = "Wake instruction\nwith more than one line";
  const invoked = () => JSON.parse(readFileSync(join(cwd, "invocation"), "utf8"));
  const spawned = await gemini.spawn(seat, cwd, framed, context);
  assert.deepEqual(spawned, { processed: true, outcome, receipt: JSON.stringify({ conversation_id: "spawned-id" }) });
  assert.deepEqual(invoked(), { args: ["--output-format", "stream-json", "--mode", "auto", "--sandbox", "-p", framed], home, id: "42" });

  writeFileSync(stream, terminal("requested-id"));
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"] as const) {
    const resumed = await gemini.resume(seat, cwd, framed, { ...context, effort });
    assert.deepEqual(resumed, { processed: true, outcome, receipt: JSON.stringify({ conversation_id: "requested-id" }) });
    assert.deepEqual(invoked().args, ["--output-format", "stream-json", "--mode", "auto", "--sandbox",
      "--conversation", "requested-id", "--effort", effort === "ultra" ? "max" : effort, "-p", framed]);
  }
  await gemini.spawn({ ...seat, permissionProfile: "danger-full-access" }, cwd, framed, context);
  assert.deepEqual(invoked().args, ["--output-format", "stream-json", "--dangerously-skip-permissions", "-p", framed]);
  writeFileSync(stream, terminal("different-id"));
  await assert.rejects(gemini.resume(seat, cwd, framed, context), /different conversation/);
  writeFileSync(join(cwd, "exit-code"), "7");
  writeFileSync(stream, terminal("requested-id"));
  await assert.rejects(gemini.resume(seat, cwd, framed, context), /exited 7/);
  rmSync(join(cwd, "exit-code"));
  for (const invalid of [terminal("requested-id", "ERROR"), terminal(""), '{"event":"init"}']) {
    writeFileSync(stream, invalid);
    await assert.rejects(gemini.spawn(seat, cwd, framed, context), /successful turn result/);
  }
});

test("Gemini refuses a sandboxed turn before invoking agy when the Antigravity sandbox is unavailable", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "hive-gemini-nosandbox-"));
  const command = join(cwd, "fake-agy.cjs");
  const invoked = join(cwd, "invoked");
  const previous = process.env.HIVE_GEMINI_COMMAND;
  process.env.HIVE_GEMINI_COMMAND = command;
  t.after(() => {
    if (previous === undefined) delete process.env.HIVE_GEMINI_COMMAND;
    else process.env.HIVE_GEMINI_COMMAND = previous;
    rmSync(cwd, { recursive: true, force: true });
  });
  // agy >= 1.4.4 ignores --sandbox without one and still reports success; the stand-in does the same.
  writeFileSync(command, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "");
process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", conversation_id: "c", response: "ran" } }));
`, { mode: 0o700 });

  let probes = 0;
  const gemini = new GeminiProvider(() => { probes += 1; return false; });
  const seat = subscription({ provider: "gemini", permissionProfile: "workspace-write", accountProfile: userInfo().homedir, sessionId: "c" });
  const context = { deliveryId: 7, token: "test", effort: null };
  const unavailable = (error: unknown) => error instanceof ProviderPreDispatchError && error.code === "provider_sandbox_unavailable";
  assert.throws(() => gemini.preflight(seat), unavailable);
  await assert.rejects(async () => gemini.spawn(seat, cwd, "framed", context), unavailable);
  await assert.rejects(async () => gemini.resume(seat, cwd, "framed", context), unavailable);
  assert.equal(existsSync(invoked), false);
  assert.equal(probes, 3);

  // danger-full-access claims no sandbox: it neither probes nor refuses.
  const full = { ...seat, permissionProfile: "danger-full-access" };
  gemini.preflight(full);
  await gemini.spawn(full, cwd, "framed", context);
  assert.equal(existsSync(invoked), true);
  assert.equal(probes, 3);
});

test("the Antigravity sandbox probe creates the sandbox's namespaces unprivileged and fails closed", t => {
  const dir = mkdtempSync(join(tmpdir(), "hive-unshare-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const argv = join(dir, "argv");
  const fakeUnshare = (exitCode: number) => {
    const path = join(dir, `unshare-${exitCode}.cjs`);
    writeFileSync(path, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));
process.exit(${exitCode});
`, { mode: 0o700 });
    return path;
  };
  assert.equal(antigravitySandboxAvailable("linux", fakeUnshare(0)), true);
  assert.deepEqual(JSON.parse(readFileSync(argv, "utf8")),
    ["--user", "--map-root-user", "--mount", "--pid", "--net", "--fork", "--", "true"]);
  // Ubuntu 24.04's AppArmor restriction makes unshare exit 1: "write failed /proc/self/uid_map".
  assert.equal(antigravitySandboxAvailable("linux", fakeUnshare(1)), false);
  assert.equal(antigravitySandboxAvailable("linux", join(dir, "no-such-unshare")), false);
  assert.equal(antigravitySandboxAvailable("win32", fakeUnshare(0)), false);
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
    async () => grok.resume(subscription({ provider: "grok", sessionId: null }), "/tmp", "framed", { deliveryId: 512, token: "turn-token", effort: null }),
    /resume target missing/,
  );
});

test("Codex permission arguments grant only the Hive edge socket on spawn and resume", () => {
  const socketPath = "/tmp/hive edge.sock";
  assert.deepEqual(codexPermissionArgs("read-only", socketPath), [
    "-c", "features.network_proxy=true",
    "-c", 'permissions.hive-read-only.extends=":read-only"',
    "-c", "permissions.hive-read-only.network.enabled=true",
    "-c", `permissions.hive-read-only.network.domains=${CODEX_NETWORK_DOMAINS}`,
    "-c", 'permissions.hive-read-only.network.unix_sockets={"/tmp/hive edge.sock"="allow"}',
    "-c", 'default_permissions="hive-read-only"',
  ]);
  assert.deepEqual(codexPermissionArgs("workspace-write", socketPath), [
    "-c", "features.network_proxy=true",
    "-c", 'permissions.hive-workspace.extends=":workspace"',
    "-c", "permissions.hive-workspace.network.enabled=true",
    "-c", `permissions.hive-workspace.network.domains=${CODEX_NETWORK_DOMAINS}`,
    "-c", 'permissions.hive-workspace.network.unix_sockets={"/tmp/hive edge.sock"="allow"}',
    "-c", 'default_permissions="hive-workspace"',
  ]);
  assert.deepEqual(codexPermissionArgs("danger-full-access"), ["--dangerously-bypass-approvals-and-sandbox"]);
});

test("Codex socket grant and child env share resolveEdgeSocketPath, including HIVE_HOME", (t) => {
  const previousSocket = process.env.HIVE_EDGE_SOCKET;
  const previousHome = process.env.HIVE_HOME;
  delete process.env.HIVE_EDGE_SOCKET;
  process.env.HIVE_HOME = "/var/lib/hive";
  t.after(() => {
    if (previousSocket === undefined) delete process.env.HIVE_EDGE_SOCKET;
    else process.env.HIVE_EDGE_SOCKET = previousSocket;
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
  });

  const expected = resolveEdgeSocketPath();
  assert.equal(expected, join("/var/lib/hive", "edge.sock"));
  assert.notEqual(expected, join(homedir(), ".hive", "edge.sock"));
  assert.equal(composeChildEnv({}, { deliveryId: 1, token: "turn-token", effort: null }).HIVE_EDGE_SOCKET, expected);

  const grant = codexPermissionArgs("read-only").find((arg) => arg.includes("unix_sockets="));
  assert.ok(grant?.includes(JSON.stringify(expected)), grant);
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

test("the writer and the hook agree on one inbox address, whatever case HIVE_ACTOR carries", async (t) => {
  // hive#41 park blocker 2: the live registry keys on the canonical actor, so a
  // surface exporting HIVE_ACTOR=Ariadne IS found by the delivery's lowercase
  // actor — and must then drain the directory the writer wrote to, not a
  // sibling spelled the way the env var was. One derivation on both sides.
  const root = mkdtempSync(join(tmpdir(), "hive-inbox-case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claude = new ClaudeProvider({ ingressRoot: root });
  await claude.deliverLive({} as LiveIngress, delivery(11), "Message from U1: case test");

  const hookSide = ingressInboxDirectory(root, "Ariadne");
  assert.equal(hookSide, ingressInboxDirectory(root, "ariadne"));
  assert.equal(hookSide, join(root, "ariadne"));
  const drained = drainInbox(hookSide);
  assert.equal(drained.length, 1, "the hook drains exactly the envelope the writer landed");
  assert.match(drained[0]!.file, /delivery-11-attempt-2\.json$/);
  assert.equal(drained[0]!.framed, "Message from U1: case test");
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
    cwd: null,
    attentionProtocol: 0,
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
    cwd: null,
    attentionProtocol: 0,
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
    cwd: null,
    attentionProtocol: 0,
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
    cwd: null,
    attentionProtocol: 0,
    expiresAt: Date.now() + 60_000,
  };
  await assert.rejects(
    () => codex.deliverLive(ingress, delivery(14), "framed"),
    (error: unknown) => error instanceof ProviderPreDispatchError
      && error.code === "account_profile_mismatch",
  );
});

test("codex spawn skips the git-repo check: the edge's cwd is a root of checkouts, not a checkout", () => {
  const socketPath = "/tmp/hive-edge.sock";
  const args = codexSpawnArgs("/home/hive/work-ariadne", "workspace-write", null, null, socketPath);
  assert.deepEqual(args.slice(0, 5), ["exec", "--cd", "/home/hive/work-ariadne", "--skip-git-repo-check", "--json"]);
  assert.deepEqual(args.slice(5, -1), codexPermissionArgs("workspace-write", socketPath));
  assert.equal(args.at(-1), "-");
});

test("KRA-1414: a codex spawn's effort override is clamped by the pinned CODEX_HOME's model", () => {
  const socketPath = "/tmp/hive-edge.sock";
  const home = mkdtempSync(join(tmpdir(), "hive-codex-home-"));
  try {
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n');
    // gpt-5.5's ladder stops at xhigh; ultra would be rejected at provider start.
    assert.ok(codexSpawnArgs("/w", "workspace-write", "ultra", home, socketPath)
      .includes("model_reasoning_effort=xhigh"));
    // The same request against a model that speaks the whole grammar is verbatim.
    writeFileSync(join(home, "config.toml"), 'model = "gpt-6-astra"\n');
    assert.ok(codexSpawnArgs("/w", "workspace-write", "ultra", home, socketPath)
      .includes("model_reasoning_effort=ultra"));
    // No overlay: the invocation is byte-identical to the pre-overlay one.
    assert.deepEqual(
      codexSpawnArgs("/w", "workspace-write", null, home, socketPath),
      codexSpawnArgs("/w", "workspace-write", null, null, socketPath),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("KRA-1414: both codex turn routes clamp against the same pinned home the child runs under", () => {
  const socketPath = "/tmp/hive-edge.sock";
  const home = mkdtempSync(join(tmpdir(), "hive-codex-home-"));
  try {
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n');
    const pinned = subscription({ accountProfile: home, sessionId: "thread-1" });
    const routes = [
      ["resume", (effort: "ultra" | null) => codexResumeTurn(pinned, effort)],
      ["spawn", (effort: "ultra" | null) => codexSpawnTurn(pinned, "/work/taxis", effort, socketPath)],
    ] as const;
    // The clamp is armed on BOTH routes, from the home the turn actually runs
    // under — a route that derived its argv without it would silently degrade
    // every overlay to the unknown-model floor.
    for (const [name, turnOf] of routes) {
      const turn = turnOf("ultra");
      assert.equal(turn.codexHome, home, name);
      assert.ok(turn.args.includes("model_reasoning_effort=xhigh"), name);
    }
    // Same request, a model that speaks the whole grammar: verbatim on both.
    writeFileSync(join(home, "config.toml"), 'model = "gpt-6-astra"\n');
    for (const [name, turnOf] of routes) {
      assert.ok(turnOf("ultra").args.includes("model_reasoning_effort=ultra"), name);
    }
    // The routes are still the two different invocations they always were.
    assert.deepEqual(codexResumeTurn(pinned, null).args.slice(0, 5), ["exec", "resume", "thread-1", "-", "--json"]);
    assert.deepEqual(codexSpawnTurn(pinned, "/work/taxis", null, socketPath).args.slice(0, 5),
      ["exec", "--cd", "/work/taxis", "--skip-git-repo-check", "--json"]);
    // R-5: a missing pinned profile is a hard pre-dispatch failure on either route.
    const unpinned = subscription({ accountProfile: "/nonexistent/profile" });
    const missingProfile = (error: unknown) =>
      error instanceof ProviderPreDispatchError && error.code === "account_profile_missing";
    assert.throws(() => codexResumeTurn(unpinned, "ultra"), missingProfile);
    assert.throws(() => codexSpawnTurn(unpinned, "/work/taxis", "ultra", socketPath), missingProfile);
    // A resume with no session is refused before the profile is even read.
    assert.throws(
      () => codexResumeTurn(subscription({ accountProfile: home, sessionId: null }), null),
      (error: unknown) => error instanceof Error && error.message === "resume target missing",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codex seats may reach GitHub and the hive socket, nothing else", () => {
  const domains = codexPermissionArgs("workspace-write", "/tmp/hive-edge.sock").find((arg) => arg.includes("network.domains="));
  assert.ok(domains);
  for (const host of ["hive.invalid", "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com"]) {
    assert.ok(domains.includes(`"${host}"="allow"`), host);
  }
  assert.ok(!domains.includes("deny"));
});


test("runtime errors survive receipt truncation, but recovered command failures remain successful", () => {
  const runtime = { type: "item.completed", item: { type: "error", message: "runtime unavailable" } };
  const done = { type: "item.completed", item: { type: "agent_message", text: "Blocked before claiming." } };
  const stream = [JSON.stringify(runtime), JSON.stringify({ type: "diagnostic", text: "x".repeat(5000) }),
    JSON.stringify(done), JSON.stringify({ type: "turn.completed" })].join("\n");
  const failed = headlessDispatchResult(stream);
  assert.equal(failed.processed, false);
  assert.equal(failed.receipt.includes("runtime unavailable"), false);
  assert.equal(failed.outcome, "Blocked before claiming.");
  assert.equal(headlessDispatchResult([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 1 } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Recovered and done." } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n")).processed, true);
});

test("Claude error results cannot become successful completions", () => {
  for (const failure of [
    { subtype: "success", is_error: true },
    { subtype: "error_during_execution", result: null },
  ]) {
    const parsed = headlessDispatchResult([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Runtime failed." }] } }),
      JSON.stringify({ type: "result", ...failure }),
    ].join("\n"));
    assert.equal(parsed.processed, false);
    assert.equal(parsed.outcome, "Runtime failed.");
  }
  assert.equal(headlessDispatchResult(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "Done.",
  })).processed, true);
});

test("completed Codex turns recover item errors but not startup or fatal errors", () => {
  const itemError = { type: "item.completed", item: { type: "error", message: "runtime unavailable" } };
  const started = { type: "turn.started" };
  const answer = { type: "item.completed", item: { type: "agent_message", text: "Done through another tool." } };
  const completed = { type: "turn.completed" };
  const cases: [string, unknown[], boolean][] = [
    ["recovered item error", [started, itemError, answer, completed], true],
    ["startup failure", [itemError, started, answer, completed], false],
    ["item error without completion", [started, itemError, answer], false],
    ["fatal turn", [started, { type: "turn.failed" }, answer, completed], false],
    ["fatal stream", [started, { type: "error" }, answer, completed], false],
  ];
  for (const [name, events, processed] of cases) {
    const result = headlessDispatchResult(events.map(value => JSON.stringify(value)).join("\n"));
    assert.equal(result.processed, processed, name);
    assert.equal(result.outcome, answer.item.text, name);
  }
});

test("a zero-exit Codex child emitting delivery 2593's stream is a failed attempt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-preclaim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stream = readFileSync("test/fixtures/codex-preclaim-runtime-error.jsonl", "utf8");
  writeFileSync(join(root, "codex"), "#!/bin/sh\ncat <<'STREAM'\n" + stream + "STREAM\n", { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = root + delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  const result = await new CodexProvider().spawn(subscription({ accountProfile: root }), root, "wake", {
    deliveryId: 2593, token: "test-only", effort: null,
  });
  assert.equal(result.processed, false);
  if (result.processed) assert.fail("runtime error was treated as success");
  assert.equal(result.failure?.code, "provider_runtime_failed");
  assert.match(result.outcome ?? "", /Blocked before claiming/);
});

test("a nonzero Claude exit retains a structured failure and rejects a success record", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "hive-claude-exit-"));
  const previousPath = process.env.PATH;
  process.env.PATH = cwd + delimiter + previousPath;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(join(cwd, "claude"), "#!/bin/sh\ncat stream\nexit 7\n", { mode: 0o700 });
  const provider = new ClaudeProvider({ ingressRoot: cwd });
  const seat = subscription({ provider: "claude", accountProfile: cwd });
  const run = () => provider.spawn(seat, cwd, "wake", { deliveryId: 42, token: "test", effort: null });
  const stream = join(cwd, "stream");
  writeFileSync(stream, JSON.stringify({ type: "result", is_error: true, result: "tool failed" }));
  const failure = await run();
  assert.equal(failure.processed, false);
  assert.equal(failure.outcome, "tool failed");
  writeFileSync(stream, JSON.stringify({ type: "result", subtype: "success", result: "done" }));
  await assert.rejects(run(), /exited 7/);
});
