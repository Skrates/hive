#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attestationWire, readWakeAttestation } from "../edge/attestation.js";
import { udsRequestJson } from "../local/uds.js";

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
}

interface InboxMessage {
  file: string;
  framed: string;
}

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
      const payload = JSON.parse(readFileSync(path, "utf8")) as { framed?: unknown };
      if (typeof payload.framed === "string" && payload.framed.length > 0) {
        messages.push({ file: path, framed: payload.framed });
      }
    } catch {
      // Unreadable inbox entries are left in place for operator inspection.
    }
  }
  return messages;
}

export function consumeInboxFiles(inboxDirectory: string, messages: InboxMessage[]): void {
  if (messages.length === 0) return;
  const consumedDirectory = join(inboxDirectory, ".consumed");
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
  const edgeSocket = process.env.HIVE_EDGE_SOCKET ?? join(hiveHome, "edge.sock");
  const ingressRoot = process.env.HIVE_INGRESS_DIR ?? join(hiveHome, "ingress");
  const inboxDirectory = join(ingressRoot, actor);

  let input: HookInput = {};
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.length > 0) input = JSON.parse(raw) as HookInput;
  } catch {
    // A malformed hook payload still gets a heartbeat and an inbox check.
  }

  const eventName = input.hook_event_name ?? "Stop";
  const messages = drainInbox(inboxDirectory);

  try {
    if (shouldMaintainHeartbeat(eventName, messages.length)) {
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      const attestation = configDir ? attestationWire(await readWakeAttestation(configDir)) : undefined;
      await udsRequestJson(edgeSocket, "POST", "/live/register", {
        actor,
        provider: "claude",
        socketPath: inboxDirectory,
        sessionId: input.session_id ?? null,
        surfaceVersion: "claude-hook",
        ttlMs: REGISTRATION_TTL_MS,
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

  const output = hookOutput(eventName, messages.map((message) => message.framed));
  if (output !== null) process.stdout.write(output);
  consumeInboxFiles(inboxDirectory, messages);
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === `file://${entry}`;
})();

if (invokedDirectly) {
  await main();
}
