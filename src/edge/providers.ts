import { spawn } from "node:child_process";
import type { Delivery, Provider, Subscription } from "../domain.js";
import type { LiveIngress } from "./live-registry.js";

export interface ProviderDispatch {
  receipt: string;
  processed: boolean;
  sessionId: string | null;
}

export interface ProviderAdapter {
  provider: Provider;
  deliverLive(ingress: LiveIngress, delivery: Delivery, framed: string, signal: AbortSignal): Promise<ProviderDispatch>;
  resume(subscription: Subscription, cwd: string, framed: string, signal: AbortSignal): Promise<ProviderDispatch>;
  spawn(subscription: Subscription, cwd: string, framed: string, signal: AbortSignal): Promise<ProviderDispatch>;
}

export class CodexProvider implements ProviderAdapter {
  readonly provider = "codex" as const;

  constructor(private readonly localToken: string) {}

  async deliverLive(
    ingress: LiveIngress,
    delivery: Delivery,
    framed: string,
    signal: AbortSignal,
  ): Promise<ProviderDispatch> {
    const response = await fetch(ingress.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.localToken}` },
      body: JSON.stringify({ delivery, framed }),
      signal,
    });
    if (!response.ok) throw new Error(`Codex live ingress ${response.status}: ${await response.text()}`);
    const result = await response.json() as { receipt?: unknown; processed?: unknown; sessionId?: unknown };
    if (typeof result.receipt !== "string") throw new Error("Codex live ingress returned an invalid receipt");
    return {
      receipt: result.receipt,
      processed: result.processed === true,
      sessionId: safeSessionId(result.sessionId),
    };
  }

  resume(subscription: Subscription, cwd: string, framed: string, signal: AbortSignal): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      "codex",
      ["exec", ...codexPermissionArgs(subscription.permissionProfile), "resume", subscription.sessionId, "-", "--json"],
      cwd,
      framed,
      signal,
      null,
	  "codex",
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string, signal: AbortSignal): Promise<ProviderDispatch> {
    return runHeadless(
      "codex",
      ["exec", "--cd", cwd, "--json", ...codexPermissionArgs(subscription.permissionProfile), "-"],
      cwd,
      framed,
      signal,
      "codex-spawn",
	  "codex",
    );
  }
}

export class ClaudeProvider implements ProviderAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly localToken: string) {}

  async deliverLive(
    ingress: LiveIngress,
    delivery: Delivery,
    framed: string,
    signal: AbortSignal,
  ): Promise<ProviderDispatch> {
    const response = await fetch(ingress.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.localToken}` },
      body: JSON.stringify({ delivery, framed }),
      signal,
    });
    if (!response.ok) throw new Error(`Claude live ingress ${response.status}: ${await response.text()}`);
    const result = await response.json() as { receipt?: unknown; processed?: unknown; sessionId?: unknown };
    if (typeof result.receipt !== "string") throw new Error("Claude live ingress returned an invalid receipt");
    return {
      receipt: result.receipt,
      processed: result.processed === true,
      sessionId: safeSessionId(result.sessionId),
    };
  }

  async resume(subscription: Subscription, cwd: string, framed: string, signal: AbortSignal): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    const command = process.env.HIVE_CLAUDE_COMMAND ?? "claude";
    await assertClaudeVersion(command, subscription.providerVersion, cwd, signal);
    return runHeadless(
      command,
	  [
		...claudeIsolationArgs(), "-p", "--resume", subscription.sessionId,
		"--output-format", "stream-json", "--verbose",
		...claudePermissionArgs(subscription.permissionProfile),
	  ],
      cwd,
      framed,
      signal,
      null,
	  "claude",
    );
  }

  async spawn(subscription: Subscription, cwd: string, framed: string, signal: AbortSignal): Promise<ProviderDispatch> {
    const command = process.env.HIVE_CLAUDE_COMMAND ?? "claude";
    await assertClaudeVersion(command, subscription.providerVersion, cwd, signal);
    return runHeadless(
      command,
	  [
		...claudeIsolationArgs(), "-p", "--output-format", "stream-json", "--verbose",
		...claudePermissionArgs(subscription.permissionProfile),
	  ],
      cwd,
      framed,
      signal,
      "claude-spawn",
	  "claude",
    );
  }
}

function claudeIsolationArgs(): string[] {
	// Headless delivery must not inherit personal plugins, hooks, or MCP servers from the workstation.
	// No filesystem settings source is trusted; strict MCP mode means no server starts unless Hive adds
	// an explicit immutable --mcp-config in a future authority-bearing contract.
	return ["--setting-sources", "", "--strict-mcp-config"];
}

async function assertClaudeVersion(
	command: string,
	expected: string,
	cwd: string,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) throw abortError(signal);
	const useProcessGroup = process.platform !== "win32";
	const child = spawn(command, ["--version"], {
		cwd,
		env: sanitizedChildEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		detached: useProcessGroup,
	});
	const stdout = new TailBuffer(8 * 1024);
	const stderr = new TailBuffer(8 * 1024);
	child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
	let terminationReason: Error | null = null;
	let hardKillTimer: NodeJS.Timeout | null = null;
	const killTree = (signalName: NodeJS.Signals) => {
		if (useProcessGroup && child.pid !== undefined) {
			try {
				process.kill(-child.pid, signalName);
				return;
			} catch {
				child.kill(signalName);
				return;
			}
		}
		child.kill(signalName);
	};
	const terminate = (reason: Error) => {
		if (terminationReason !== null) return;
		terminationReason = reason;
		killTree("SIGTERM");
		hardKillTimer = setTimeout(() => killTree("SIGKILL"), 250);
	};
	const abort = () => terminate(abortError(signal));
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const timeout = setTimeout(() => terminate(new Error("claude_version_probe_timeout")), 5_000);
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		if (terminationReason !== null) throw terminationReason;
		if (code !== 0) throw new Error(`Claude CLI version probe exited ${code}`);
	} finally {
		clearTimeout(timeout);
		if (hardKillTimer) clearTimeout(hardKillTimer);
		signal.removeEventListener("abort", abort);
	}
	const output = `${stdout.text()}${stderr.text()}`.trim();
	if (output !== expected && output !== `${expected} (Claude Code)`) {
		throw new Error(`Claude CLI version mismatch: expected ${expected}`);
	}
}

async function runHeadless(
  command: string,
  args: string[],
  cwd: string,
  stdin: string | null,
  signal: AbortSignal,
  sessionFormat: "codex-spawn" | "claude-spawn" | null,
	completionFormat: "codex" | "claude",
): Promise<ProviderDispatch> {
  if (signal.aborted) throw abortError(signal);
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: sanitizedChildEnv(),
    detached: useProcessGroup,
  });
  const stdout = new TailBuffer(64 * 1024);
  const stderr = new TailBuffer(64 * 1024);
  const sessionExtractor = new JsonLineSessionExtractor(sessionFormat);
  const completionExtractor = new JsonLineCompletionExtractor(completionFormat);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.append(chunk);
    sessionExtractor.append(chunk);
    completionExtractor.append(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  let terminationDone: Promise<void> | null = null;
  const killTree = (signalName: NodeJS.Signals) => {
    if (useProcessGroup && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signalName);
        return;
      } catch {
        child.kill(signalName);
        return;
      }
    }
    child.kill(signalName);
  };
  const terminate = () => {
    if (terminationDone) return;
    killTree("SIGTERM");
    terminationDone = new Promise((resolve) => {
      setTimeout(() => {
        killTree("SIGKILL");
        resolve();
      }, 1_000);
    });
  };
  signal.addEventListener("abort", terminate, { once: true });
  const codePromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  child.stdin.end(stdin ?? undefined);
  try {
    const code = await codePromise;
    if (signal.aborted) {
      terminate();
      await terminationDone;
      throw abortError(signal);
    }
    if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr.text().slice(-2_000)}`);
    sessionExtractor.finish();
    completionExtractor.finish();
    return {
      receipt: completionExtractor.receipt ?? stdout.text().slice(-4_000),
      processed: true,
      sessionId: sessionExtractor.sessionId,
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) terminate();
    if (terminationDone) await terminationDone;
    throw error;
  } finally {
    signal.removeEventListener("abort", terminate);
  }
}

class JsonLineCompletionExtractor {
  private partial = Buffer.alloc(0);
  private discardingLine = false;
  private candidate: string | null = null;

	constructor(private readonly format: "codex" | "claude") {}

  get receipt(): string | null {
    if (this.candidate === null) return null;
    return this.format === "claude"
      ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: this.candidate })
      : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: this.candidate } });
  }

  append(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendFragment(chunk.subarray(offset));
        return;
      }
      this.appendFragment(chunk.subarray(offset, newline));
      if (!this.discardingLine) this.processLine(this.partial);
      this.partial = Buffer.alloc(0);
      this.discardingLine = false;
      offset = newline + 1;
    }
  }

  finish(): void {
    if (!this.discardingLine && this.partial.length > 0) this.processLine(this.partial);
    this.partial = Buffer.alloc(0);
  }

  private appendFragment(fragment: Buffer): void {
    if (this.discardingLine || fragment.length === 0) return;
    if (this.partial.length + fragment.length > 256 * 1024) {
      this.partial = Buffer.alloc(0);
      this.discardingLine = true;
      return;
    }
    this.partial = Buffer.concat([this.partial, fragment]);
  }

  private processLine(line: Buffer): void {
    const text = line.at(-1) === 0x0d ? line.subarray(0, -1).toString("utf8") : line.toString("utf8");
    let value: unknown;
    try { value = JSON.parse(text); } catch { return; }
    if (!isRecord(value)) return;
    let result: string | null = null;
    if (this.format === "claude"
      && value.type === "result"
      && value.subtype === "success"
      && value.is_error === false
      && typeof value.result === "string") {
      result = value.result;
    } else if (this.format === "codex"
		&& (value.type === "item.completed" || value.type === "item_completed")
      && isRecord(value.item)
      && (value.item.type === "agent_message" || value.item.type === "agentMessage")
      && typeof value.item.text === "string") {
      result = value.item.text;
    }
    // This normalized receipt stays below the broker's 128 KiB protocol bound even for strings
    // that JSON must escape one code unit at a time. Slack applies its tighter byte cap later.
    if (result !== null) this.candidate = result.slice(0, 16_000);
  }
}

class JsonLineSessionExtractor {
  private partial = Buffer.alloc(0);
  private discardingLine = false;
  private candidate: string | null = null;
  private conflicted = false;

  constructor(private readonly format: "codex-spawn" | "claude-spawn" | null) {}

  get sessionId(): string | null {
    return this.conflicted ? null : this.candidate;
  }

  append(chunk: Buffer): void {
    if (this.format === null) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendFragment(chunk.subarray(offset));
        return;
      }
      this.appendFragment(chunk.subarray(offset, newline));
      if (!this.discardingLine) this.processLine(this.partial);
      this.partial = Buffer.alloc(0);
      this.discardingLine = false;
      offset = newline + 1;
    }
  }

  finish(): void {
    if (this.format !== null && !this.discardingLine && this.partial.length > 0) {
      this.processLine(this.partial);
    }
    this.partial = Buffer.alloc(0);
  }

  private appendFragment(fragment: Buffer): void {
    if (this.discardingLine || fragment.length === 0) return;
    if (this.partial.length + fragment.length > 64 * 1024) {
      this.partial = Buffer.alloc(0);
      this.discardingLine = true;
      return;
    }
    this.partial = Buffer.concat([this.partial, fragment]);
  }

  private processLine(line: Buffer): void {
    const text = line.at(-1) === 0x0d ? line.subarray(0, -1).toString("utf8") : line.toString("utf8");
    let value: unknown;
    try { value = JSON.parse(text); } catch { return; }
    if (!isRecord(value)) return;
    const id = this.format === "codex-spawn"
      && value.type === "thread.started"
      ? safeSessionId(value.thread_id)
      : this.format === "claude-spawn"
        && value.type === "system"
        && value.subtype === "init"
        ? safeSessionId(value.session_id)
        : null;
    if (id === null) return;
    if (this.candidate !== null && this.candidate !== id) {
      this.conflicted = true;
      this.candidate = null;
      return;
    }
    if (!this.conflicted) this.candidate = id;
  }
}

class TailBuffer {
  private value = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.length >= this.maxBytes) {
      this.value = Buffer.from(chunk.subarray(chunk.length - this.maxBytes));
      return;
    }
    const combined = Buffer.concat([this.value, chunk]);
    this.value = combined.length <= this.maxBytes
      ? combined
      : Buffer.from(combined.subarray(combined.length - this.maxBytes));
  }

  text(): string { return this.value.toString("utf8"); }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("delivery_deadline_exceeded");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSessionId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    ? value
    : null;
}

function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const exact = new Set([
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "TERM",
    "COLORTERM",
    "CODEX_HOME",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_DIRS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_DIRS",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
  ]);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => exact.has(name))),
    DISABLE_AUTOUPDATER: "1",
  };
}

function codexPermissionArgs(profile: string): string[] {
  switch (profile) {
    case "read-only": return ["--sandbox", "read-only"];
    case "workspace-write": return ["--sandbox", "workspace-write"];
    case "danger-full-access": return ["--dangerously-bypass-approvals-and-sandbox"];
    default: throw new Error(`unsupported Codex permission profile: ${profile}`);
  }
}

function claudePermissionArgs(profile: string): string[] {
  switch (profile) {
    case "read-only": return ["--permission-mode", "plan"];
    case "workspace-write": return ["--permission-mode", "acceptEdits"];
    case "danger-full-access": return ["--permission-mode", "bypassPermissions"];
    default: throw new Error(`unsupported Claude permission profile: ${profile}`);
  }
}
