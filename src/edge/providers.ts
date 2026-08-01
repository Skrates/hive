import { spawn } from "node:child_process";
import type { Delivery, Provider, Subscription } from "../domain.js";
import type { LiveIngress } from "./live-registry.js";

export interface ProviderDispatch {
  receipt: string;
  processed: boolean;
}

export type ProviderPreDispatchErrorCode =
  | "live_ingress_rejected"
  | "provider_permission_profile_invalid";

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
  deliverLive(
    ingress: LiveIngress,
    delivery: Delivery,
    framed: string,
    ackCapability: string,
  ): Promise<ProviderDispatch>;
  resume(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch>;
  spawn(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch>;
}

export class CodexProvider implements ProviderAdapter {
  readonly provider = "codex" as const;

  constructor(private readonly localToken: string) {}

  preflight(subscription: Subscription): void {
    codexPermissionArgs(subscription.permissionProfile);
  }

  async deliverLive(
    ingress: LiveIngress,
    delivery: Delivery,
    framed: string,
    ackCapability: string,
  ): Promise<ProviderDispatch> {
    const response = await fetch(ingress.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.localToken}` },
      body: JSON.stringify({
        delivery,
        framed,
        ackCapability,
        binding: {
          bindingId: ingress.bindingId,
          bindingRevision: ingress.bindingRevision,
        },
      }),
    });
    assertLiveIngressAccepted(response, "Codex");
    return {
      receipt: await safeLiveReceipt(response, "Codex", ackCapability, this.localToken),
      processed: false,
    };
  }

  resume(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      "codex",
      ["exec", "resume", subscription.sessionId, "-", "--json", ...codexPermissionArgs(subscription.permissionProfile)],
      cwd,
      framed,
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    return runHeadless(
      "codex",
      ["exec", "--cd", cwd, "--json", ...codexPermissionArgs(subscription.permissionProfile), "-"],
      cwd,
      framed,
    );
  }
}

export class ClaudeProvider implements ProviderAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly localToken: string) {}

  preflight(subscription: Subscription): void {
    claudePermissionArgs(subscription.permissionProfile);
  }

  async deliverLive(
    ingress: LiveIngress,
    delivery: Delivery,
    framed: string,
    ackCapability: string,
  ): Promise<ProviderDispatch> {
    const response = await fetch(ingress.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.localToken}` },
      body: JSON.stringify({
        delivery,
        framed,
        ackCapability,
        binding: {
          bindingId: ingress.bindingId,
          bindingRevision: ingress.bindingRevision,
        },
      }),
    });
    assertLiveIngressAccepted(response, "Claude");
    return {
      receipt: await safeLiveReceipt(response, "Claude", ackCapability, this.localToken),
      processed: false,
    };
  }

  resume(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--resume", subscription.sessionId, "--output-format", "stream-json", ...claudePermissionArgs(subscription.permissionProfile), framed],
      cwd,
      null,
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--output-format", "stream-json", ...claudePermissionArgs(subscription.permissionProfile), framed],
      cwd,
      null,
    );
  }
}

function assertLiveIngressAccepted(response: Response, provider: "Codex" | "Claude"): void {
  if (response.ok) return;
  if (response.status >= 400 && response.status < 500) {
    throw new ProviderPreDispatchError("live_ingress_rejected");
  }
  throw new Error(`${provider} live ingress ${response.status}`);
}

async function safeLiveReceipt(
  response: Response,
  provider: "Codex" | "Claude",
  ackCapability: string,
  localToken: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${provider} live ingress invalid response`);
  }
  const receipt = value && typeof value === "object"
    ? (value as { receipt?: unknown }).receipt
    : null;
  if (
    typeof receipt !== "string"
    || receipt.length === 0
    || receipt.length > 1_000
    || receipt.includes(ackCapability)
    || receipt.includes(localToken)
  ) {
    throw new Error(`${provider} live ingress invalid response`);
  }
  return receipt;
}

async function runHeadless(command: string, args: string[], cwd: string, stdin: string | null): Promise<ProviderDispatch> {
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
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

function codexPermissionArgs(profile: string): string[] {
  switch (profile) {
    case "read-only": return ["--sandbox", "read-only"];
    case "workspace-write": return ["--sandbox", "workspace-write"];
    case "danger-full-access": return ["--dangerously-bypass-approvals-and-sandbox"];
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
