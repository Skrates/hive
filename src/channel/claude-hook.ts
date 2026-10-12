#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attestationWire, readWakeAttestation } from "../edge/attestation.js";
import { udsRequestJson } from "../local/uds.js";
import { ingressInboxDirectory, resolveEdgeSocketPath } from "../edge/providers.js";
import { canonicalActor } from "../domain.js";

/**
 * ADR-0003 R-4 steering matrix: Claude Code delivery is next-boundary.
 *
 * This binary runs as a Claude Code Stop/PostToolUse hook. At every session
 * boundary it does two things:
 *
 * 1. Renews the actor's live registration with the edge control socket — the
 *    registration TTL is the session heartbeat. While the heartbeat is fresh
 *    the edge delivers by inbox alone; once it lapses the edge falls back to
 *    a `--resume`/`-p` idle wake.
 * 2. Drains the actor's owner-only ingress inbox and injects any pending wake
 *    envelopes into the session as hook output. Emission happens before the
 *    consumed marker moves, so a crash duplicates rather than loses a
 *    message — duplicates are permitted and self-identifying (R-3).
 *
 * The envelope instructs the agent to report its outcome with `hive reply`,
 * which closes the R-6 loop through the edge control socket.
 */

const REGISTRATION_TTL_MS = 180_000;

/**
 * The heartbeat promises "a future boundary will drain the inbox". A Stop with
 * an empty inbox makes no such promise — the session is ending — so the hook
 * DEREGISTERS instead, and the edge's resume/spawn ladder owns the next wake.
 * A Stop WITH messages blocks the stop (the session continues); any other
 * boundary implies the session is still running: both renew the heartbeat.
 */
export function shouldMaintainHeartbeat(eventName: string, pendingMessages: number): boolean {
  const terminalBoundary = eventName === "Stop" || eventName === "SubagentStop";
  return !terminalBoundary || pendingMessages > 0;
}

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
}

/**
 * ADR-0004: an exact-session attention return. Only the named session may drain it, and only
 * after the edge confirms it is still the current generation of a delivery this edge holds.
 */
export interface AttentionConstraint {
  expectedSessionId: string;
  resolutionCommandId: string;
  generation: number;
  deliveryId: number;
}

export interface InboxMessage {
  file: string;
  framed: string;
  attention: AttentionConstraint | null;
}

export type GuardVerdict = "eligible" | "ineligible" | "unavailable";

export function drainInbox(inboxDirectory: string): InboxMessage[] {
  let names: string[];
  try {
    names = readdirSync(inboxDirectory);
  } catch {
    return [];
  }
  const messages: InboxMessage[] = [];
  for (const name of names.sort()) {
    if (!/^delivery-\d+-attempt-\d+\.json$/.test(name)) continue;
    const path = join(inboxDirectory, name);
    try {
      const payload = JSON.parse(readFileSync(path, "utf8")) as { framed?: unknown; attention?: unknown };
      if (typeof payload.framed === "string" && payload.framed.length > 0) {
        if (payload.attention === undefined) {
          messages.push({ file: path, framed: payload.framed, attention: null });
        } else {
          const constraint = parseConstraint(payload.attention);
          // A constraint the hook cannot read is never treated as unconstrained.
          if (constraint !== null) messages.push({ file: path, framed: payload.framed, attention: constraint });
        }
      }
    } catch {
      // Unreadable inbox entries are left in place for operator inspection.
    }
  }
  return messages;
}

function parseConstraint(value: unknown): AttentionConstraint | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.expectedSessionId !== "string" || record.expectedSessionId.length === 0
    || typeof record.resolutionCommandId !== "string"
    || !Number.isSafeInteger(record.generation) || !Number.isSafeInteger(record.deliveryId)
  ) return null;
  return {
    expectedSessionId: record.expectedSessionId,
    resolutionCommandId: record.resolutionCommandId,
    generation: Number(record.generation),
    deliveryId: Number(record.deliveryId),
  };
}

/**
 * ADR-0004 receiver-side check, immediately before emission. Ordinary envelopes pass through
 * untouched. A constrained one is left in place unless this exact session is the one it
 * names (an unknown session never drains it); then the edge's guard decides: eligible emits,
 * a superseded or terminal generation is quarantined, and an unreachable guard leaves the
 * file for a later boundary — never emitted on the strength of the session match alone.
 */
export async function selectDeliverable(
  messages: InboxMessage[],
  sessionId: string | null,
  guard: (constraint: AttentionConstraint) => Promise<GuardVerdict>,
): Promise<{ emit: InboxMessage[]; quarantine: InboxMessage[] }> {
  const emit: InboxMessage[] = [];
  const quarantine: InboxMessage[] = [];
  for (const message of messages) {
    if (message.attention === null) {
      emit.push(message);
      continue;
    }
    if (sessionId === null || sessionId !== message.attention.expectedSessionId) continue;
    const verdict = await guard(message.attention);
    if (verdict === "eligible") emit.push(message);
    else if (verdict === "ineligible") quarantine.push(message);
  }
  return { emit, quarantine };
}

export function quarantineInboxFiles(inboxDirectory: string, messages: InboxMessage[]): void {
  moveInboxFiles(join(inboxDirectory, ".quarantine"), messages);
}

/**
 * ADR-0004: announce this session to its own per-session file, so the agent inside it can
 * bind an attention source by exact session (`hive attention bind --session-file`). One file
 * per session — never a global "latest session" another session could consume. Returns the
 * path when this boundary created it, so the hook can tell the session once.
 */
export function announceSession(hiveHome: string, actor: string, sessionId: string, cwd: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) return null;
  const directory = join(hiveHome, "attention", "sessions", canonicalActor(actor));
  const path = join(directory, `${sessionId}.json`);
  if (existsSync(path)) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    schema: "hive-attention-session/v1",
    actor: canonicalActor(actor),
    provider: "claude",
    session_id: sessionId,
    cwd,
    announced_at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

export function consumeInboxFiles(inboxDirectory: string, messages: InboxMessage[]): void {
  moveInboxFiles(join(inboxDirectory, ".consumed"), messages);
}

function moveInboxFiles(consumedDirectory: string, messages: InboxMessage[]): void {
  if (messages.length === 0) return;
  mkdirSync(consumedDirectory, { recursive: true, mode: 0o700 });
  for (const message of messages) {
    try {
      renameSync(message.file, join(consumedDirectory, `${Date.now()}-${message.file.split("/").pop()}`));
    } catch {
      // A failed move redelivers at the next boundary; duplicates are accepted.
    }
  }
}

export function hookOutput(eventName: string, framedMessages: string[]): string | null {
  if (framedMessages.length === 0) return null;
  const combined = framedMessages.join("\n\n---\n\n");
  if (eventName === "Stop" || eventName === "SubagentStop") {
    return JSON.stringify({ decision: "block", reason: combined });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: combined,
    },
  });
}

async function main(): Promise<void> {
  const actor = process.env.HIVE_ACTOR;
  if (!actor) return;
  const hiveHome = process.env.HIVE_HOME ?? join(homedir(), ".hive");
  const edgeSocket = resolveEdgeSocketPath();
  const ingressRoot = process.env.HIVE_INGRESS_DIR ?? join(hiveHome, "ingress");
  // Canonical on purpose: the delivery writer derives the same path from the
  // delivery's (canonical) actor, and the live registration below advertises it.
  const inboxDirectory = ingressInboxDirectory(ingressRoot, actor);

  let input: HookInput = {};
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.length > 0) input = JSON.parse(raw) as HookInput;
  } catch {
    // A malformed hook payload still gets a heartbeat and an inbox check.
  }

  const eventName = input.hook_event_name ?? "Stop";
  const sessionId = input.session_id ?? null;
  const cwd = input.cwd ?? process.cwd();
  const { emit: messages, quarantine } = await selectDeliverable(drainInbox(inboxDirectory), sessionId, async (constraint) => {
    try {
      const verdict = await udsRequestJson<{ eligible?: unknown }>(edgeSocket, "POST", "/attention/read", {
        op: "return_guard",
        resolution_command_id: constraint.resolutionCommandId,
        generation: constraint.generation,
        delivery_id: constraint.deliveryId,
      });
      return verdict.eligible === true ? "eligible" : "ineligible";
    } catch {
      return "unavailable";
    }
  });

  try {
    if (shouldMaintainHeartbeat(eventName, messages.length)) {
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      const attestation = configDir ? attestationWire(await readWakeAttestation(configDir)) : undefined;
      await udsRequestJson(edgeSocket, "POST", "/live/register", {
        actor,
        provider: "claude",
        socketPath: inboxDirectory,
        sessionId,
        surfaceVersion: "claude-hook",
        ttlMs: REGISTRATION_TTL_MS,
        // ADR-0004: the observed cwd, and the promise that this receiver enforces the
        // exact-session check on constrained envelopes (selectDeliverable above).
        cwd,
        attentionProtocol: 1,
        // The hook is a new process each boundary; the edge freezes the first
        // snapshot for this sessionId so a mid-session reinstall cannot
        // reattribute the still-running turn.
        ...(attestation ? { attestation } : {}),
      });
    } else {
      await udsRequestJson(edgeSocket, "POST", "/live/deregister", {
        actor,
        provider: "claude",
      });
    }
  } catch {
    // The edge being down never blocks the session; resume-wake covers delivery.
  }

  const framed = messages.map((message) => message.framed);
  const terminal = eventName === "Stop" || eventName === "SubagentStop";
  if (!terminal && sessionId !== null) {
    const announced = announceSession(hiveHome, actor, sessionId, cwd);
    if (announced !== null) {
      framed.push(`Hive attention: this session's binding file is ${announced} — \`hive attention bind --session-file ${announced} …\` enrolls it as an exact-session attention source.`);
    }
  }
  const output = hookOutput(eventName, framed);
  if (output !== null) process.stdout.write(output);
  consumeInboxFiles(inboxDirectory, messages);
  quarantineInboxFiles(inboxDirectory, quarantine);
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === `file://${entry}`;
})();

if (invokedDirectly) {
  await main();
}
