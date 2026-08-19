import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Delivery, Provider, Subscription } from "../domain.js";
import { UdsHttpError, udsRequestJson } from "../local/uds.js";
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

/**
 * The edge asked a provider to stop an in-flight turn and got no confirmation
 * that it stopped. The delivery is still released — holding a fence on an
 * unanswering peer forever is the wedge this whole change removes — but the
 * disposition names the uncertainty instead of reporting a clean teardown, so a
 * retry landing beside a still-running turn is explained rather than mysterious
 * (ADR-0003 R-3).
 */
export class CancellationUnconfirmedError extends Error {
  constructor(readonly deliveryId: number, readonly detail: string) {
    super(`cancellation of delivery ${deliveryId} was not confirmed: ${detail}`);
    this.name = "CancellationUnconfirmedError";
  }
}

/**
 * Every dispatch carries the edge's wall-clock deadline as an abort signal. An
 * adapter that owns a child process MUST kill it on abort: the edge frees the
 * dispatch slot the moment the deadline fires, so a child that outlives the
 * signal is an orphan holding a provider session nobody is waiting for.
 */
export interface ProviderAdapter {
  provider: Provider;
  preflight?(subscription: Subscription): void;
  deliverLive(ingress: LiveIngress, delivery: Delivery, framed: string, signal?: AbortSignal): Promise<ProviderDispatch>;
  resume(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch>;
  spawn(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch>;
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

  async deliverLive(ingress: LiveIngress, delivery: Delivery, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    let result: { receipt?: unknown; outcome?: unknown; processed?: unknown };
    const deadlineAt = dispatchDeadlineAt(signal);
    // The dispatch abort must NOT simply tear this request down. Destroying the
    // socket tells the surface to stop but says nothing about whether it did,
    // and the edge releases the delivery's fence on that send — the interrupt
    // takes 10-15s, the first retry is eligible after 5s. So the abort asks for
    // cancellation over a second request and waits for the surface's answer;
    // that answer is the receipt. The transport controller is the hard bound on
    // the wait, so an unanswering surface still cannot park this dispatch.
    const transport = new AbortController();
    let cancellation: Promise<LiveCancellation> | null = null;
    // Read through a function: the assignment happens in the abort listener, so
    // control-flow narrowing at the catch would otherwise call it unreachable.
    const pendingCancellation = (): Promise<LiveCancellation> | null => cancellation;
    let transportTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      cancellation = requestLiveCancel(ingress.socketPath, delivery.id);
      transportTimer = setTimeout(() => transport.abort(), LIVE_CANCEL_CONFIRM_MS);
      transportTimer.unref();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      result = await udsRequestJson(
        ingress.socketPath,
        "POST",
        "/deliver",
        deadlineAt === undefined ? { delivery, framed } : { delivery, framed, deadlineAt },
        transport.signal,
      );
    } catch (error) {
      const pending = pendingCancellation();
      if (pending !== null) {
        let outcome = await pending;
        if (outcome.outcome === "no_record") {
          // The cancel raced the still-arriving /deliver: a no-record answer
          // given before the delivery request settled proves nothing. Now that
          // /deliver HAS settled, one re-ask is the last word — the
          // registration either landed (and is stopped, upgrading this to a
          // confirmed cancellation) or the surface still has no record, which
          // is not a stop. Only this member is re-asked: a surface that never
          // answered would spend the cancel bound a second time.
          outcome = await requestLiveCancel(ingress.socketPath, delivery.id);
        }
        if (!cancelConfirmed(outcome)) throw new CancellationUnconfirmedError(delivery.id, outcome.detail);
        throw new Error(`Codex live turn for delivery ${delivery.id} was cancelled at the edge's dispatch bound`);
      }
      if (error instanceof UdsHttpError && surfaceErrorCode(error.responseBody) === "account_profile_mismatch") {
        throw new ProviderPreDispatchError("account_profile_mismatch");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (transportTimer !== null) clearTimeout(transportTimer);
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

  resume(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      "codex",
      ["exec", "resume", subscription.sessionId, "-", "--json", ...codexPermissionArgs(subscription.permissionProfile)],
      cwd,
      framed,
      { CODEX_HOME: requireAccountProfile(subscription) },
      signal,
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    return runHeadless(
      "codex",
      ["exec", "--cd", cwd, "--json", ...codexPermissionArgs(subscription.permissionProfile), "-"],
      cwd,
      framed,
      { CODEX_HOME: requireAccountProfile(subscription) },
      signal,
    );
  }
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

  resume(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    return runHeadless(
      process.env.HIVE_GROK_COMMAND ?? "grok",
      ["-r", subscription.sessionId, "--output-format", "streaming-messages-json", ...grokPermissionArgs(subscription.permissionProfile), "-p", framed],
      cwd,
      null,
      { HOME: requireAccountProfile(subscription) },
      signal,
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    return runHeadless(
      process.env.HIVE_GROK_COMMAND ?? "grok",
      ["--output-format", "streaming-messages-json", ...grokPermissionArgs(subscription.permissionProfile), "-p", framed],
      cwd,
      null,
      { HOME: requireAccountProfile(subscription) },
      signal,
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

  resume(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    if (!subscription.sessionId) throw new Error("resume target missing");
    const profile = requireAccountProfile(subscription);
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--resume", subscription.sessionId, "--output-format", "stream-json", "--verbose", ...claudePermissionArgs(subscription.permissionProfile), ...claudePromptSlotArgs(profile), framed],
      cwd,
      null,
      { CLAUDE_CONFIG_DIR: profile },
      signal,
    );
  }

  spawn(subscription: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    const profile = requireAccountProfile(subscription);
    return runHeadless(
      process.env.HIVE_CLAUDE_COMMAND ?? "claude",
      ["-p", "--output-format", "stream-json", "--verbose", ...claudePermissionArgs(subscription.permissionProfile), ...claudePromptSlotArgs(profile), framed],
      cwd,
      null,
      { CLAUDE_CONFIG_DIR: profile },
      signal,
    );
  }
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

/** Diagnostic tail retained from a provider's stdout — the ledger receipt, never a parse source. */
const RECEIPT_TAIL_CHARS = 4_000;
/** Diagnostic tail retained from a provider's stderr — quoted in the non-zero-exit error. */
const STDERR_TAIL_CHARS = 2_000;
/**
 * A single JSONL line longer than this is dropped rather than buffered. The
 * agent-text lines this reader is looking for are bounded by the model's own
 * output; an unbounded line is a tool-result dump, and holding one hostage is
 * how a stream reader reintroduces the very growth it exists to bound.
 */
const MAX_STREAM_LINE_CHARS = 1_000_000;
/** Grace between SIGTERM and SIGKILL when the edge's dispatch deadline aborts a turn. */
export const CHILD_KILL_GRACE_MS = 5_000;
/**
 * Longest the edge waits for a live surface to confirm that an aborted turn
 * stopped. Must exceed the far side's own interrupt timeouts — 10s on the Codex
 * app-server, 15s on the Desktop IPC client — or the receipt would time out
 * while the interrupt it reports on is still legitimately running.
 */
export const LIVE_CANCEL_CONFIRM_MS = 20_000;

/**
 * What one `/cancel` exchange established. Exactly one of four states, because
 * the two that a `confirmed`/`sawDelivery` boolean pair used to fold together —
 * "the surface has no record" and "the surface never answered" — need different
 * handling: only the first is worth re-asking, and only the first is bounded by
 * an answer that already arrived.
 *
 * `stopped` is the only member that permits releasing the delivery's fence as a
 * clean cancellation; every other member is an UNconfirmed stop, because this
 * result is the edge's only evidence that a released delivery is safe to retry.
 */
export const LIVE_CANCEL_OUTCOMES = ["stopped", "interrupt_failed", "no_record", "no_answer"] as const;
type LiveCancelOutcome = (typeof LIVE_CANCEL_OUTCOMES)[number];

interface LiveCancellation {
  outcome: LiveCancelOutcome;
  detail: string;
}

/** A cancellation is confirmed only when the surface said the turn stopped. */
function cancelConfirmed(cancellation: LiveCancellation): boolean {
  return cancellation.outcome === "stopped";
}

/**
 * Ask a live surface to stop one delivery and report what it answered. Every
 * failure mode — an unreachable socket, a timeout, a surface that could not
 * interrupt its accepted turn, a surface with no record of the delivery — is an
 * UNconfirmed cancellation, never a silent success.
 */
async function requestLiveCancel(socketPath: string, deliveryId: number): Promise<LiveCancellation> {
  try {
    const result = await udsRequestJson<{ cancelled?: unknown; interrupted?: unknown }>(
      socketPath,
      "POST",
      "/cancel",
      { deliveryId },
      AbortSignal.timeout(LIVE_CANCEL_CONFIRM_MS),
    );
    if (result.interrupted === false) {
      return { outcome: "interrupt_failed", detail: "the live surface could not interrupt the accepted turn" };
    }
    if (result.cancelled !== true) {
      // No record of the delivery — and that answer is produced by two states
      // the surface cannot tell apart: a registration that has not landed yet,
      // and one that already settled. The settle is the dangerous one: the
      // tracked operation's teardown deletes its entry and discards whatever it
      // recorded about its interrupt, so a turn whose interrupt is KNOWN to
      // have failed answers exactly like one that never existed. The edge does
      // not read that as a stop (R-3).
      return {
        outcome: "no_record",
        detail: "the live surface has no record of this delivery and cannot say whether its turn stopped",
      };
    }
    return { outcome: "stopped", detail: "the live surface confirmed the turn stopped" };
  } catch (error) {
    return {
      outcome: "no_answer",
      detail: `the live surface did not answer the cancel request: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const dispatchDeadlines = new WeakMap<AbortSignal, number>();

/** Stamp the edge's wall-clock dispatch deadline onto the abort signal it hands adapters. */
export function stampDispatchDeadline(signal: AbortSignal, deadlineAt: number): void {
  dispatchDeadlines.set(signal, deadlineAt);
}

/** Absolute epoch-ms the edge will wait; undefined when the signal was not stamped. */
export function dispatchDeadlineAt(signal: AbortSignal | undefined): number | undefined {
  return signal === undefined ? undefined : dispatchDeadlines.get(signal);
}

/**
 * Signal every process in the headless turn's group. `child.kill()` only hits
 * the CLI PID; a descendant that outlives the CLI keeps writing the workspace
 * after the edge has already released the delivery and may start a retry.
 */
/** True while any process in the group (or the CLI itself) still exists. */
function processGroupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Poll until the group is gone, bounded — the SIGKILL timer armed by the abort
 * path is the enforcer. Returns whether the group was observed gone: `false`
 * means the bound elapsed with it still alive, and the caller must keep
 * treating the PID as the group's live identifier.
 */
async function waitForProcessGroupExit(pid: number | undefined, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processGroupAlive(pid)) {
    console.error("hive edge provider process group survived the kill grace", pid);
    return false;
  }
  return true;
}

export function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The group (or CLI) is already gone.
    }
  }
}

/**
 * Incremental reader over a headless provider's JSONL stdout.
 *
 * The 2026-08-15 cx53 edge reached a 15.1G RSS on a process that idles in the
 * tens of MB: `runHeadless` accumulated every chunk of every child's stdout for
 * the whole turn and then kept the last 4 000 characters. A 77-minute Claude
 * turn under `--output-format stream-json --verbose` echoes every tool result
 * into that stream, so the buffer grew without any bound but the turn's length.
 *
 * This reader keeps O(1) state instead: the bounded receipt tail, the current
 * partial line, and the three extraction candidates. It is also the ONLY
 * extraction path — {@link headlessAcknowledgement} runs the same reader over a
 * complete string, so the streaming and whole-string shapes cannot drift.
 */
export class HeadlessStreamReader {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private pendingOverflowed = false;
  private tail = "";
  private resultText: string | null = null;
  private agentMessageText: string | null = null;
  private lastAssistantText: string | null = null;
  /** Lines dropped for exceeding {@link MAX_STREAM_LINE_CHARS} — surfaced, never silent (R-3). */
  droppedLines = 0;

  constructor(private readonly tailChars: number) {}

  push(chunk: Buffer): void {
    this.write(this.decoder.write(chunk));
  }

  write(text: string): void {
    if (text.length === 0) return;
    this.tail = (this.tail + text).slice(-this.tailChars);
    let rest = text;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) break;
      this.appendPending(rest.slice(0, newline));
      this.consumeLine();
      rest = rest.slice(newline + 1);
    }
    this.appendPending(rest);
  }

  /** Flush the decoder and the trailing partial line. Idempotent. */
  finish(): void {
    this.write(this.decoder.end());
    this.consumeLine();
  }

  receipt(): string {
    return this.tail;
  }

  /**
   * Characters currently retained. This is the bound the class exists to hold:
   * it must stay within the receipt tail plus one in-progress line no matter
   * how much stream has passed through, which is exactly what the old
   * accumulate-everything reader could not promise.
   */
  retainedChars(): number {
    return this.tail.length + this.pending.length;
  }

  outcome(): string {
    const best = this.resultText ?? this.agentMessageText ?? this.lastAssistantText
      ?? "Headless provider turn completed successfully.";
    return best.length <= 2_500 ? best : `${best.slice(0, 2_497)}…`;
  }

  private appendPending(text: string): void {
    if (text.length === 0) return;
    if (this.pendingOverflowed) return;
    if (this.pending.length + text.length > MAX_STREAM_LINE_CHARS) {
      this.pending = "";
      this.pendingOverflowed = true;
      return;
    }
    this.pending += text;
  }

  private consumeLine(): void {
    const line = this.pending;
    const overflowed = this.pendingOverflowed;
    this.pending = "";
    this.pendingOverflowed = false;
    if (overflowed) {
      this.droppedLines += 1;
      return;
    }
    if (line.length === 0) return;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "result" && typeof value.result === "string" && value.result.length > 0) {
        this.resultText = value.result;
      }
      const item = value.item as Record<string, unknown> | undefined;
      if (value.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        this.agentMessageText = item.text;
      }
      if (value.type === "assistant") {
        const text = assistantMessageText(value.message);
        if (text) this.lastAssistantText = text;
      }
    } catch {
      // Provider outputs are JSONL on supported surfaces; non-JSON diagnostics are ignored.
    }
  }
}

async function runHeadless(
  command: string,
  args: string[],
  cwd: string,
  stdin: string | null,
  profileEnv: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProviderDispatch> {
  if (signal?.aborted) throw new Error(`${command} dispatch deadline elapsed before the turn was spawned`);
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: composeChildEnv(profileEnv),
    // Own process group so deadline teardown can signal the CLI *and* every
    // tool/shell descendant it spawned. Without this, SIGTERM on the CLI PID
    // leaves orphans writing the workspace after the edge has released.
    detached: true,
  });
  if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
  const stdout = new HeadlessStreamReader(RECEIPT_TAIL_CHARS);
  const stderr = new HeadlessStreamReader(STDERR_TAIL_CHARS);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  // The edge frees this dispatch's slot the moment its deadline fires, so the
  // whole process group must not outlive the signal: SIGTERM first, SIGKILL
  // after a grace. The SIGKILL stays armed if the CLI exits first — a
  // descendant that ignored SIGTERM is why the grace exists.
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = (): void => {
    const pid = child.pid;
    console.error("hive edge provider turn aborted at the dispatch deadline", command, pid ?? "no-pid");
    signalProcessGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => signalProcessGroup(pid, "SIGKILL"), CHILD_KILL_GRACE_MS);
    killTimer.unref();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (killTimer !== null && !signal?.aborted) clearTimeout(killTimer);
  }
  if (signal?.aborted) {
    // `close` settles when the CLI's stdio ends; a descendant with its own
    // stdio can outlive both the CLI and SIGTERM. The edge releases the
    // delivery's fence on this return, so the whole group must be dead first —
    // otherwise the retry races a survivor still writing the workspace.
    const groupExited = await waitForProcessGroupExit(child.pid, CHILD_KILL_GRACE_MS + 1_000);
    // A pending SIGKILL addresses the group by numeric PGID, and that number is
    // free for reuse the moment the group is gone. Once the exit is observed the
    // timer can only reach a stranger, so disarm it; it stays armed only while
    // the original group may still exist.
    if (groupExited && killTimer !== null) clearTimeout(killTimer);
  }
  stdout.finish();
  stderr.finish();
  if (stdout.droppedLines > 0) {
    console.error("hive edge provider stream dropped overlong lines", command, stdout.droppedLines);
  }
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr.receipt()}`);
  return { receipt: stdout.receipt(), outcome: stdout.outcome(), processed: true };
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
  const reader = new HeadlessStreamReader(RECEIPT_TAIL_CHARS);
  reader.write(output);
  reader.finish();
  return reader.outcome();
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
