import { spawn } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Delivery, Provider, Subscription } from "../domain.js";
import { udsRequestJson } from "../local/uds.js";
import type { LiveIngress } from "./live-registry.js";

export interface ProviderDispatch {
  receipt: string;
  /** True when the provider run itself completed and the receipt is the outcome. */
  processed: boolean;
}

export type ProviderPreDispatchErrorCode =
  | "live_ingress_rejected"
  | "provider_permission_profile_invalid"
  | "account_profile_missing";

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
  deliverLive(ingress: LiveIngress, delivery: Delivery, framed: string): Promise<ProviderDispatch>;
  resume(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch>;
  spawn(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch>;
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
    const result = await udsRequestJson<{ receipt?: unknown }>(ingress.socketPath, "POST", "/deliver", {
      delivery,
      framed,
    });
    const receipt = result.receipt;
    if (typeof receipt !== "string" || receipt.length === 0 || receipt.length > 1_000) {
      throw new Error("Codex live ingress invalid response");
    }
    return { receipt, processed: false };
  }

  resume(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      "codex",
      ["exec", "resume", subscription.sessionId, "-", "--json", ...codexPermissionArgs(subscription.permissionProfile)],
      cwd,
      framed,
      { CODEX_HOME: requireAccountProfile(subscription) },
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    return runHeadless(
      "codex",
      ["exec", "--cd", cwd, "--json", ...codexPermissionArgs(subscription.permissionProfile), "-"],
      cwd,
      framed,
      { CODEX_HOME: requireAccountProfile(subscription) },
    );
  }
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

  resume(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--resume", subscription.sessionId, "--output-format", "stream-json", "--verbose", ...claudePermissionArgs(subscription.permissionProfile), framed],
      cwd,
      null,
      { CLAUDE_CONFIG_DIR: requireAccountProfile(subscription) },
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--output-format", "stream-json", "--verbose", ...claudePermissionArgs(subscription.permissionProfile), framed],
      cwd,
      null,
      { CLAUDE_CONFIG_DIR: requireAccountProfile(subscription) },
    );
  }
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
  return { receipt: output.slice(-4_000), processed: true };
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

function claudePermissionArgs(profile: string): string[] {
  switch (profile) {
    case "read-only": return ["--permission-mode", "plan"];
    case "workspace-write": return ["--permission-mode", "acceptEdits"];
    case "danger-full-access": return ["--permission-mode", "bypassPermissions"];
    default: throw new ProviderPreDispatchError("provider_permission_profile_invalid");
  }
}
