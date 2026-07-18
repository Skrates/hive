import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Delivery, Subscription } from "../domain.js";
import type { LiveIngress } from "./live-registry.js";
import { ClaudeProvider, CodexProvider } from "./providers.js";

test("headless providers bound output tails and tolerate a closed stdin pipe", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hive-provider-tail-"));
  const command = join(directory, "large-output.js");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) { console.log('test (Claude Code)'); process.exit(0); }",
    "process.stdin.destroy();",
    "process.stdout.write('x'.repeat(200000));",
  ].join("\n"), { mode: 0o700 });
  await chmod(command, 0o700);
  const previousCommand = process.env.HIVE_CLAUDE_COMMAND;
  process.env.HIVE_CLAUDE_COMMAND = command;
  t.after(async () => {
    if (previousCommand === undefined) delete process.env.HIVE_CLAUDE_COMMAND;
    else process.env.HIVE_CLAUDE_COMMAND = previousCommand;
    await rm(directory, { recursive: true, force: true });
  });
  const subscription: Subscription = {
    actor: "fable",
    provider: "claude",
    providerSurface: "claude-cli",
    providerVersion: "test",
    sessionId: null,
    homeEdge: "linux",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "linux", cwd: directory, worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    leaseTtlMs: 30_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    expiresAt: null,
    updatedAt: new Date().toISOString(),
    bindingMode: "pinned",
    bindingSource: "operator",
	    bindingRevision: 1,
		egressPolicy: "receipt_only",
		egressChannelIds: [],
  };

  const result = await new ClaudeProvider("unused").spawn(
    subscription,
    directory,
    "input".repeat(200_000),
    new AbortController().signal,
  );

  assert.equal(result.processed, true);
  assert.equal(result.sessionId, null);
  assert.equal(result.receipt.length, 4_000);
  assert.match(result.receipt, /^x+$/);
});

test("Codex spawn extracts only a structured thread.started id and uses an exact child env allowlist", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hive-codex-session-"));
  const command = join(directory, "codex");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "console.log('x'.repeat(70000));",
    "console.log('prose says thread_id=prose-codex-id');",
    "console.log(JSON.stringify({type:'result', thread_id:'false-codex-id', result:'thread.started'}));",
    "console.log(JSON.stringify({",
    "  type:'thread.started',",
    "  thread_id:'codex-thread-123',",
    "  args:process.argv.slice(2),",
    "  env:{",
    "    lcAll:process.env.LC_ALL ?? null,",
    "    lcToken:process.env.LC_TOKEN ?? null,",
    "    xdgConfigHome:process.env.XDG_CONFIG_HOME ?? null,",
    "    xdgSecret:process.env.XDG_SECRET ?? null",
    "  }",
    "}));",
  ].join("\n"), { mode: 0o700 });
  await chmod(command, 0o700);
  const restore = preserveEnvironment(t, ["PATH", "LC_ALL", "LC_TOKEN", "XDG_CONFIG_HOME", "XDG_SECRET"]);
  process.env.PATH = `${directory}:${restore.PATH ?? ""}`;
  process.env.LC_ALL = "C";
  process.env.LC_TOKEN = "must-not-cross";
  process.env.XDG_CONFIG_HOME = directory;
  process.env.XDG_SECRET = "must-not-cross";
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await new CodexProvider("unused").spawn(
    providerSubscription("codex", directory),
    directory,
    "untrusted input",
    new AbortController().signal,
  );
  const event = lastJsonLine(result.receipt) as {
    args: string[];
    env: { lcAll: string | null; lcToken: string | null; xdgConfigHome: string | null; xdgSecret: string | null };
  };

  assert.equal(result.sessionId, "codex-thread-123");
  assert.deepEqual(event.args.slice(0, 3), ["exec", "--cd", directory]);
  assert.ok(event.args.includes("--json"));
  assert.deepEqual(event.env, {
    lcAll: "C",
    lcToken: null,
    xdgConfigHome: directory,
    xdgSecret: null,
  });
});

test("Codex resume places its sandbox option before the resume subcommand", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hive-codex-resume-"));
	const command = join(directory, "codex");
	await writeFile(command, [
		"#!/usr/bin/env node",
		"console.log(JSON.stringify({args:process.argv.slice(2)}));",
	].join("\n"), { mode: 0o700 });
	await chmod(command, 0o700);
	const restore = preserveEnvironment(t, ["PATH"]);
	process.env.PATH = `${directory}:${restore.PATH ?? ""}`;
	t.after(() => rm(directory, { recursive: true, force: true }));
	const subscription = {
		...providerSubscription("codex", directory, "existing-session"),
		permissionProfile: "workspace-write" as const,
	};

	const result = await new CodexProvider("unused").resume(
		subscription,
		directory,
		"untrusted input",
		new AbortController().signal,
	);
	const event = lastJsonLine(result.receipt) as { args: string[] };

	assert.deepEqual(event.args, [
		"exec",
		"--sandbox",
		"workspace-write",
		"resume",
		"existing-session",
		"-",
		"--json",
	]);
	assert.equal(result.sessionId, null);
});

test("Claude spawn accepts only system/init session_id while resume returns no discovered session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hive-claude-session-"));
  const command = join(directory, "claude-fake.js");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) { console.log('test (Claude Code)'); process.exit(0); }",
    "console.log('prose says session_id=prose-claude-id');",
    "console.log(JSON.stringify({type:'assistant', session_id:'false-assistant-id'}));",
    "console.log(JSON.stringify({type:'system', subtype:'init', session_id:'claude-session-456', args:process.argv.slice(2), disableAutoupdater:process.env.DISABLE_AUTOUPDATER ?? null}));",
  ].join("\n"), { mode: 0o700 });
  await chmod(command, 0o700);
  preserveEnvironment(t, ["HIVE_CLAUDE_COMMAND"]);
  process.env.HIVE_CLAUDE_COMMAND = command;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new ClaudeProvider("unused");

  const spawned = await provider.spawn(
    providerSubscription("claude", directory),
    directory,
    "untrusted input",
    new AbortController().signal,
  );
  const resumed = await provider.resume(
    providerSubscription("claude", directory, "existing-session"),
    directory,
    "untrusted input",
    new AbortController().signal,
  );
	const spawnedEvent = lastJsonLine(spawned.receipt) as { args: string[]; disableAutoupdater: string | null };
	const resumedEvent = lastJsonLine(resumed.receipt) as { args: string[] };

	assert.equal(spawned.sessionId, "claude-session-456");
	assert.deepEqual(spawnedEvent.args, [
		"--setting-sources", "", "--strict-mcp-config",
		"-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan",
	]);
	assert.deepEqual(resumedEvent.args, [
		"--setting-sources", "", "--strict-mcp-config",
		"-p", "--resume", "existing-session", "--output-format", "stream-json", "--verbose",
		"--permission-mode", "plan",
	]);
	assert.equal(spawnedEvent.disableAutoupdater, "1");
  assert.equal(resumed.sessionId, null);
});

test("Claude dispatch refuses a runtime that no longer matches its authority fence", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hive-claude-version-"));
	const command = join(directory, "claude-fake.js");
	const sentinel = join(directory, "delivery-started");
	await writeFile(command, [
		"#!/usr/bin/env node",
		"const {writeFileSync}=require('node:fs');",
		"if (process.argv.includes('--version')) { console.log('2.1.999 (Claude Code)'); process.exit(0); }",
		`writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');`,
	].join("\n"), { mode: 0o700 });
	await chmod(command, 0o700);
	preserveEnvironment(t, ["HIVE_CLAUDE_COMMAND"]);
	process.env.HIVE_CLAUDE_COMMAND = command;
	t.after(() => rm(directory, { recursive: true, force: true }));

	await assert.rejects(
		() => new ClaudeProvider("unused").spawn(
			providerSubscription("claude", directory),
			directory,
			"must not run",
			new AbortController().signal,
		),
		/Claude CLI version mismatch: expected test/,
	);
	await assert.rejects(() => access(sentinel), (error: unknown) =>
		(error as NodeJS.ErrnoException).code === "ENOENT");
});

test("Claude version probing hard-kills a SIGTERM-ignoring process at the delivery deadline", {
	skip: process.platform === "win32",
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hive-claude-version-deadline-"));
	const command = join(directory, "claude-fake.js");
	const ready = join(directory, "version-ready");
	const survivor = join(directory, "version-survived");
	await writeFile(command, [
		"#!/usr/bin/env node",
		"const {writeFileSync}=require('node:fs');",
		"if (process.argv.includes('--version')) {",
		"  process.on('SIGTERM',()=>{});",
		`  writeFileSync(${JSON.stringify(ready)}, 'ready');`,
		`  setTimeout(()=>writeFileSync(${JSON.stringify(survivor)}, 'escaped'), 800);`,
		"  setInterval(()=>{}, 1000);",
		"}",
	].join("\n"), { mode: 0o700 });
	await chmod(command, 0o700);
	preserveEnvironment(t, ["HIVE_CLAUDE_COMMAND"]);
	process.env.HIVE_CLAUDE_COMMAND = command;
	t.after(() => rm(directory, { recursive: true, force: true }));
	const controller = new AbortController();
	const pending = new ClaudeProvider("unused").spawn(
		providerSubscription("claude", directory),
		directory,
		"must not run",
		controller.signal,
	);
	await waitForFile(ready);
	const abortedAt = Date.now();
	controller.abort(new Error("version_probe_deadline"));
	await assert.rejects(() => pending, /version_probe_deadline/);
	assert.ok(Date.now() - abortedAt < 1_000);
	await new Promise((resolve) => setTimeout(resolve, 900));
	await assert.rejects(() => access(survivor), (error: unknown) =>
		(error as NodeJS.ErrnoException).code === "ENOENT");
});

test("Claude keeps the structured final answer when later stdout exceeds the raw receipt tail", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hive-claude-completion-"));
	const command = join(directory, "claude-fake.js");
	const finalText = `Fable live.${"x".repeat(10_000)}`;
	await writeFile(command, [
		"#!/usr/bin/env node",
		"if (process.argv.includes('--version')) { console.log('test (Claude Code)'); process.exit(0); }",
		"console.log(JSON.stringify({type:'system', subtype:'init', session_id:'claude-session-final'}));",
		"console.log(JSON.stringify({type:'result', subtype:'error', is_error:true, result:'not final'}));",
		`console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, result:${JSON.stringify(finalText)}}));`,
		"console.log('noise'.repeat(20_000));",
	].join("\n"), { mode: 0o700 });
	await chmod(command, 0o700);
	preserveEnvironment(t, ["HIVE_CLAUDE_COMMAND"]);
	process.env.HIVE_CLAUDE_COMMAND = command;
	t.after(() => rm(directory, { recursive: true, force: true }));

	const result = await new ClaudeProvider("unused").spawn(
		providerSubscription("claude", directory),
		directory,
		"read-only probe",
		new AbortController().signal,
	);
	const receipt = JSON.parse(result.receipt) as {
		type: string;
		subtype: string;
		is_error: boolean;
		result: string;
	};

	assert.equal(result.sessionId, "claude-session-final");
	assert.deepEqual(receipt, {
		type: "result",
		subtype: "success",
		is_error: false,
		result: finalText,
	});
});

test("structured-looking prose and conflicting trusted IDs cannot create a session binding", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hive-false-session-"));
  const command = join(directory, "codex");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "console.log('thread.started { thread_id: fake-prose-id }');",
    "console.log(JSON.stringify({type:'result', thread_id:'fake-result-id'}));",
    "console.log(JSON.stringify({type:'thread.started', thread_id:'first-trusted-id'}));",
    "console.log(JSON.stringify({type:'thread.started', thread_id:'second-trusted-id'}));",
  ].join("\n"), { mode: 0o700 });
  await chmod(command, 0o700);
  const restore = preserveEnvironment(t, ["PATH"]);
  process.env.PATH = `${directory}:${restore.PATH ?? ""}`;
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await new CodexProvider("unused").spawn(
    providerSubscription("codex", directory),
    directory,
    "input",
    new AbortController().signal,
  );

  assert.equal(result.sessionId, null);
});

test("live callbacks expose a session only through the explicit camel-case response field", async (t) => {
  const responses = [
    { receipt: "codex-live", processed: true, session_id: "implicit-snake-id" },
    { receipt: "claude-live", processed: true, sessionId: "live-session-789" },
  ];
  const server = createServer((request, response) => {
    request.resume();
    const body = JSON.stringify(responses.shift());
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test callback did not bind TCP");
  const callbackUrl = `http://127.0.0.1:${address.port}/deliver`;
  const ingress = (provider: "codex" | "claude"): LiveIngress => ({
    actor: provider === "codex" ? "ariadne" : "fable",
    provider,
    callbackUrl,
    sessionId: "existing-session",
    bindingRevision: 1,
    providerSurface: `${provider}-live`,
    surfaceVersion: "test",
    expiresAt: Date.now() + 30_000,
  });

  const codex = await new CodexProvider("token").deliverLive(
    ingress("codex"),
    {} as Delivery,
    "framed",
    new AbortController().signal,
  );
  const claude = await new ClaudeProvider("token").deliverLive(
    ingress("claude"),
    {} as Delivery,
    "framed",
    new AbortController().signal,
  );

  assert.equal(codex.sessionId, null);
  assert.equal(claude.sessionId, "live-session-789");
});

test("deadline termination kills the provider process group before descendants can mutate", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hive-provider-tree-"));
  const command = join(directory, "hostile-provider.cjs");
  const sentinel = join(directory, "grandchild-survived");
  const parentReady = join(directory, "parent-ready");
  const grandchildReady = join(directory, "grandchild-ready");
  const grandchild = [
    "const {writeFileSync}=require('node:fs');",
    "process.on('SIGTERM',()=>{});",
    `writeFileSync(${JSON.stringify(grandchildReady)},'ready');`,
    `setTimeout(()=>writeFileSync(${JSON.stringify(sentinel)},'escaped'),1600);`,
    "setInterval(()=>{},1000);",
  ].join("");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) { console.log('test (Claude Code)'); process.exit(0); }",
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    `spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});`,
    `writeFileSync(${JSON.stringify(parentReady)},'ready');`,
    "setInterval(()=>{},1000);",
  ].join("\n"), { mode: 0o700 });
  await chmod(command, 0o700);
  preserveEnvironment(t, ["HIVE_CLAUDE_COMMAND"]);
  process.env.HIVE_CLAUDE_COMMAND = command;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const pending = new ClaudeProvider("unused").spawn(
    providerSubscription("claude", directory),
    directory,
    "input",
    controller.signal,
  );
  await Promise.all([waitForFile(parentReady), waitForFile(grandchildReady)]);
  controller.abort(new Error("test_deadline"));

  await assert.rejects(
    () => pending,
    /test_deadline/,
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(() => access(sentinel), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

function providerSubscription(
  provider: "codex" | "claude",
  cwd: string,
  sessionId: string | null = null,
): Subscription {
  return {
    actor: provider === "codex" ? "ariadne" : "fable",
    provider,
    providerSurface: `${provider}-cli`,
    providerVersion: "test",
    sessionId,
    homeEdge: "test",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "test", cwd, worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    leaseTtlMs: 30_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    expiresAt: null,
    updatedAt: new Date().toISOString(),
    bindingMode: "pinned",
    bindingSource: "operator",
    bindingRevision: 1,
    egressPolicy: "receipt_only",
    egressChannelIds: [],
  };
}

function preserveEnvironment(t: test.TestContext, names: string[]): Record<string, string | undefined> {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return saved;
}

function lastJsonLine(receipt: string): unknown {
  const line = receipt.trim().split("\n").at(-1);
  if (!line) throw new Error("provider receipt had no JSON line");
  return JSON.parse(line) as unknown;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}
