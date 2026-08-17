import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Delivery, Provider, Subscription } from "../domain.js";
import { UdsHttpError, udsRequestJson } from "../local/uds.js";
import { clampEffortToXhigh, type WakeEffort } from "./effort.js";
import type { LiveIngress } from "./live-registry.js";

const MAX_CODEX_LIVE_RECEIPT_CHARS = 4_000;
const MAX_CODEX_LIVE_OUTCOME_CHARS = 30_000;

interface ProviderDispatchBase {
  /** Diagnostic tail of the provider's raw output — for the ledger, never for parsing. */
  receipt: string;
}

export type ProviderDispatch = ProviderDispatchBase & (
  | {
    /** The provider run completed and `outcome` carries its final text. */
    processed: true;
    /**
     * The agent's final text, extracted before any diagnostic-receipt
     * truncation. Parsing the receipt instead loses long replies when its
     * terminal JSON line is front-chopped.
     */
    outcome: string;
  }
  | {
    /** Dispatch was accepted, but the provider has not produced an outcome. */
    processed: false;
    outcome?: never;
  }
);

export type ProviderPreDispatchErrorCode =
  | "live_ingress_rejected"
  | "provider_permission_profile_invalid"
  | "account_profile_missing"
  | "account_profile_mismatch";

/** A deterministic rejection that proves no provider turn was started. */
export class ProviderPreDispatchError extends Error {
  constructor(readonly code: ProviderPreDispatchErrorCode) {
    super(code);
    this.name = "ProviderPreDispatchError";
  }
}

export interface ProviderAdapter {
  provider: Provider;
  preflight?(subscription: Subscription): void;
  /**
   * Live delivery reaches a session that is already running — its effort was
   * fixed at ITS spawn, so the overlay does not apply here by construction.
   */
  deliverLive(ingress: LiveIngress, delivery: Delivery, framed: string): Promise<ProviderDispatch>;
  resume(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch>;
  spawn(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch>;
}

/**
 * ADR-0003 R-5: a wake always executes under the enrolled agent's pinned
 * account profile. A missing profile is a hard pre-dispatch failure — never a
 * fallback to whatever seat the edge process happens to be logged into.
 */
export function requireAccountProfile(subscription: Subscription): string {
  try {
    if (statSync(subscription.accountProfile).isDirectory()) return subscription.accountProfile;
  } catch {
    // fall through to the hard failure below
  }
  throw new ProviderPreDispatchError("account_profile_missing");
}

export class CodexProvider implements ProviderAdapter {
  readonly provider = "codex" as const;

  preflight(subscription: Subscription): void {
    codexPermissionArgs(subscription.permissionProfile);
    requireAccountProfile(subscription);
  }

  async deliverLive(ingress: LiveIngress, delivery: Delivery, framed: string): Promise<ProviderDispatch> {
    let result: { receipt?: unknown; outcome?: unknown; processed?: unknown };
    try {
      result = await udsRequestJson(ingress.socketPath, "POST", "/deliver", { delivery, framed });
    } catch (error) {
      if (error instanceof UdsHttpError && surfaceErrorCode(error.responseBody) === "account_profile_mismatch") {
        throw new ProviderPreDispatchError("account_profile_mismatch");
      }
      throw error;
    }
    const receipt = result.receipt;
    if (typeof receipt !== "string" || receipt.length === 0
      || receipt.length > MAX_CODEX_LIVE_RECEIPT_CHARS) {
      throw new Error("Codex live ingress invalid response");
    }
    if (result.processed !== true) throw new Error("Codex live ingress returned before turn completion");
    const outcome = result.outcome;
    if (typeof outcome !== "string" || outcome.length === 0
      || outcome.length > MAX_CODEX_LIVE_OUTCOME_CHARS) {
      throw new Error("Codex live ingress invalid outcome");
    }
    return { receipt, outcome, processed: true };
  }

  resume(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      "codex",
      ["exec", "resume", subscription.sessionId, "-", "--json", ...codexEffortArgs(effort), ...codexPermissionArgs(subscription.permissionProfile)],
      cwd,
      framed,
      { CODEX_HOME: requireAccountProfile(subscription) },
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    return runHeadless(
      "codex",
      ["exec", "--cd", cwd, "--json", ...codexEffortArgs(effort), ...codexPermissionArgs(subscription.permissionProfile), "-"],
      cwd,
      framed,
      { CODEX_HOME: requireAccountProfile(subscription) },
    );
  }
}

/**
 * Codex has no dedicated effort flag; `-c` overrides the config key for this
 * invocation only. The value is passed unquoted — the child receives the
 * argument verbatim with no shell in between, and Codex's TOML-ish parser
 * treats a bare word as a string. Codex does not validate the value at CLI
 * parse (probed, v0.146.0), so the clamp here is the only guard.
 */
export function codexEffortArgs(effort: WakeEffort | null): string[] {
  if (effort === null) return [];
  return ["-c", `model_reasoning_effort=${clampEffortToXhigh(effort)}`];
}

function surfaceErrorCode(body: string): string | null {
  try {
    const value = JSON.parse(body) as { error?: unknown };
    return typeof value.error === "string" ? value.error : null;
  } catch {
    return null;
  }
}

/**
 * Grok Build (xAI's agentic CLI) keeps everything — auth artifact, config.toml,
 * session state — under `~/.grok/` and exposes no config-dir override env var.
 * Pinning R-5's account profile therefore pins HOME itself: the profile
 * directory IS the child's home, and `~/.grok` resolves inside it. For a seat
 * whose durable state must live on its network volume anyway, home-as-profile
 * is coherent rather than a workaround; the adapter comment is the contract.
 *
 * Unlike Claude's boolean `-p` + positional prompt, Grok's `-p/--single` takes
 * the prompt as its VALUE — the flag must come last with the framed text as
 * its argument, or clap rejects the invocation (live-fire finding, Talos's
 * first wake: delivery 59 burned five attempts on exactly this).
 *
 * Spawn and resume (`-r <sessionId>`) are both verified live with session
 * continuity; live delivery has no ingress surface and terminalizes loudly.
 */
export class GrokProvider implements ProviderAdapter {
  readonly provider = "grok" as const;

  preflight(subscription: Subscription): void {
    grokPermissionArgs(subscription.permissionProfile);
    requireAccountProfile(subscription);
  }

  deliverLive(): Promise<ProviderDispatch> {
    return Promise.reject(new Error("Grok Build has no live-ingress surface; deliveries fall through to spawn"));
  }

  resume(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      process.env.HIVE_GROK_COMMAND ?? "grok",
      ["-r", subscription.sessionId, "--output-format", "streaming-messages-json", ...grokEffortArgs(effort), ...grokPermissionArgs(subscription.permissionProfile), "-p", framed],
      cwd,
      null,
      { HOME: requireAccountProfile(subscription) },
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    return runHeadless(
      process.env.HIVE_GROK_COMMAND ?? "grok",
      ["--output-format", "streaming-messages-json", ...grokEffortArgs(effort), ...grokPermissionArgs(subscription.permissionProfile), "-p", framed],
      cwd,
      null,
      { HOME: requireAccountProfile(subscription) },
    );
  }
}

/**
 * Grok validates at CLI parse against `low|medium|high|xhigh` (grok 1.0.4);
 * an unclamped `max` would burn the whole wake on an argument error — the
 * exact failure class of the `-p`-must-come-last scar above.
 */
export function grokEffortArgs(effort: WakeEffort | null): string[] {
  if (effort === null) return [];
  return ["--reasoning-effort", clampEffortToXhigh(effort)];
}

export interface ClaudeInboxConfig {
  /** Root directory for per-actor ingress inboxes (owner-only). */
  ingressRoot: string;
}

export class ClaudeProvider implements ProviderAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly inbox: ClaudeInboxConfig) {}

  preflight(subscription: Subscription): void {
    claudePermissionArgs(subscription.permissionProfile);
    requireAccountProfile(subscription);
  }

  /**
   * ADR-0003 R-4 steering matrix: Claude Code delivery is next-boundary. The
   * session's Stop/PostToolUse hook keeps the actor's live registration fresh
   * (the registration TTL is the heartbeat), so a live hit here means an
   * active session will see the inbox at its next natural boundary. The
   * envelope lands durably in the actor's owner-only ingress inbox; a lapsed
   * registration falls through to the `--resume`/`-p` idle-wake ladder
   * instead. A double delivery is permitted and self-identifying.
   */
  async deliverLive(_ingress: LiveIngress, delivery: Delivery, framed: string): Promise<ProviderDispatch> {
    const receipt = this.writeInbox(delivery, framed);
    return { receipt, processed: false };
  }

  writeInbox(delivery: Delivery, framed: string): string {
    const directory = join(this.inbox.ingressRoot, delivery.actor);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, `delivery-${delivery.id}-attempt-${delivery.attempts}.json`);
    const temporaryPath = `${finalPath}.tmp`;
    const payload = JSON.stringify({
      deliveryId: delivery.id,
      attempt: delivery.attempts,
      dedupe: `${delivery.event.messageTs}:${delivery.id}`,
      framed,
      writtenAt: new Date().toISOString(),
    });
    writeFileSync(temporaryPath, payload, { mode: 0o600 });
    const descriptor = openSync(temporaryPath, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, finalPath);
    return `claude-inbox:${finalPath}`;
  }

  resume(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    const profile = requireAccountProfile(subscription);
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--resume", subscription.sessionId, "--output-format", "stream-json", "--verbose", ...claudeEffortArgs(effort), ...claudePermissionArgs(subscription.permissionProfile), ...claudePromptSlotArgs(profile), framed],
      cwd,
      null,
      { CLAUDE_CONFIG_DIR: profile },
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    const profile = requireAccountProfile(subscription);
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--output-format", "stream-json", "--verbose", ...claudeEffortArgs(effort), ...claudePermissionArgs(subscription.permissionProfile), ...claudePromptSlotArgs(profile), framed],
      cwd,
      null,
      { CLAUDE_CONFIG_DIR: profile },
    );
  }
}

/**
 * Claude's `--effort` accepts the wake grammar verbatim (it IS the wake
 * grammar — the widest vocabulary of the three providers), and the flag
 * outranks the profile's `settings.json` effortLevel for this session only.
 */
export function claudeEffortArgs(effort: WakeEffort | null): string[] {
  if (effort === null) return [];
  return ["--effort", effort];
}

/**
 * Role-aware system-prompt delivery (weave-doctrine seats `system_prompt_slot`):
 * when the seat's profile carries a rendered `system-prompt-append.md`, the
 * doctrine rides the literal system-prompt slot — appended, never replacing the
 * default prompt (the seats' own ruling: all of wholesale replacement's token
 * savings sit exactly where its silent-degradation risk lives), with the
 * per-machine dynamic sections moved to the first user message for prompt-cache
 * reuse. File presence is the whole switch so rollout stays a doctrine-render
 * decision, attested by install.py — never edge configuration.
 */
export function claudePromptSlotArgs(accountProfile: string): string[] {
  const appendFile = join(accountProfile, "system-prompt-append.md");
  if (!existsSync(appendFile)) return [];
  return ["--append-system-prompt-file", appendFile, "--exclude-dynamic-system-prompt-sections"];
}

/**
 * Prepend `entry` to a PATH-style value, removing any pre-existing occurrence so
 * the entry wins without duplicating. An empty/undefined base yields the entry
 * alone.
 */
export function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const existing = (pathValue ?? "").split(delimiter).filter((part) => part.length > 0 && part !== entry);
  return [entry, ...existing].join(delimiter);
}

/**
 * The edge process is launched from an absolute node path (systemd ExecStart /
 * launchd), so a spawned provider child can inherit a PATH with no JS runtime on
 * it. The `hive` and `hive-claude-hook` CLIs are `#!/usr/bin/env node` scripts:
 * without node on PATH they exit 127 and a seat improvises a shim mid-wake.
 * Guarantee the running runtime's directory is first on the child's PATH.
 */
export function composeChildEnv(profileEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...profileEnv,
    PATH: prependPathEntry(process.env.PATH, dirname(process.execPath)),
  };
}

async function runHeadless(
  command: string,
  args: string[],
  cwd: string,
  stdin: string | null,
  profileEnv: Record<string, string>,
): Promise<ProviderDispatch> {
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: composeChildEnv(profileEnv),
  });
  if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`);
  const output = Buffer.concat(stdout).toString("utf8");
  return { receipt: output.slice(-4_000), outcome: headlessAcknowledgement(output), processed: true };
}

/**
 * Extract the agent's final text from a full headless output stream. Three
 * wire shapes in precedence order: the terminal `result` line (Claude
 * stream-json and Grok streaming-messages-json share it), Codex's
 * `item.completed`/`agent_message`, and the last `assistant` message as the
 * fallback when a disturbed run emits no usable `result`. Runs on the FULL
 * stream — never on a truncated receipt.
 */
export function headlessAcknowledgement(output: string): string {
  let resultText: string | null = null;
  let agentMessageText: string | null = null;
  let lastAssistantText: string | null = null;
  for (const line of output.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "result" && typeof value.result === "string" && value.result.length > 0) {
        resultText = value.result;
      }
      const item = value.item as Record<string, unknown> | undefined;
      if (value.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        agentMessageText = item.text;
      }
      if (value.type === "assistant") {
        const text = assistantMessageText(value.message);
        if (text) lastAssistantText = text;
      }
    } catch {
      // Provider outputs are JSONL on supported surfaces; non-JSON diagnostics are ignored.
    }
  }
  const best = resultText ?? agentMessageText ?? lastAssistantText ?? "Headless provider turn completed successfully.";
  return best.length <= 2_500 ? best : `${best.slice(0, 2_497)}…`;
}

/** Concatenate the text blocks of an `assistant` wire message (Claude/Grok shape). */
function assistantMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Codex exposes `--sandbox` on `codex exec`, but not on the nested
 * `codex exec resume` command. Config overrides are accepted by both shapes.
 *
 * A sandboxed agent still needs one machine-local capability: the owner-only
 * edge socket used by `hive reply`. Permission profiles let us grant that
 * exact AF_UNIX path without opening ordinary outbound network access. The
 * otherwise-unreachable `.invalid` allow entry makes the domain policy an
 * allowlist rather than Codex's full-network default when network support is
 * enabled for Unix-socket proxying.
 *
 * The pinned CODEX_HOME must use permission profiles rather than the legacy
 * `sandbox_mode` setting; Codex intentionally does not compose the two models.
 */
export function codexPermissionArgs(
  profile: string,
  edgeSocketPath = process.env.HIVE_EDGE_SOCKET ?? join(homedir(), ".hive", "edge.sock"),
): string[] {
  switch (profile) {
    case "read-only": return codexSocketPermissionProfile("hive-read-only", ":read-only", edgeSocketPath);
    case "workspace-write": return codexSocketPermissionProfile("hive-workspace", ":workspace", edgeSocketPath);
    case "danger-full-access": return ["--dangerously-bypass-approvals-and-sandbox"];
    default: throw new ProviderPreDispatchError("provider_permission_profile_invalid");
  }
}

function codexSocketPermissionProfile(name: string, parent: ":read-only" | ":workspace", edgeSocketPath: string): string[] {
  const socketKey = JSON.stringify(edgeSocketPath);
  return [
    "-c", "features.network_proxy=true",
    "-c", `permissions.${name}.extends=${JSON.stringify(parent)}`,
    "-c", `permissions.${name}.network.enabled=true`,
    "-c", `permissions.${name}.network.domains={"hive.invalid"="allow"}`,
    "-c", `permissions.${name}.network.unix_sockets={${socketKey}="allow"}`,
    "-c", `default_permissions=${JSON.stringify(name)}`,
  ];
}

/**
 * The shipping CLI carries `--permission-mode` with Claude-compatible
 * vocabulary (the public docs lag the binary — verified live on the seat pod,
 * 2026-08-08), so all three Hive profiles map directly.
 */
export function grokPermissionArgs(profile: string): string[] {
  switch (profile) {
    case "read-only": return ["--permission-mode", "plan"];
    case "workspace-write": return ["--permission-mode", "acceptEdits"];
    case "danger-full-access": return ["--permission-mode", "bypassPermissions"];
    default: throw new ProviderPreDispatchError("provider_permission_profile_invalid");
  }
}

function claudePermissionArgs(profile: string): string[] {
  switch (profile) {
    case "read-only": return ["--permission-mode", "plan"];
    case "workspace-write": return ["--permission-mode", "acceptEdits"];
    case "danger-full-access": return ["--permission-mode", "bypassPermissions"];
    default: throw new ProviderPreDispatchError("provider_permission_profile_invalid");
  }
}
