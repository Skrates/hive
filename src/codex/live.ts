#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { dedupeKey, type Delivery } from "../domain.js";
import { prepareSocketPath, udsRequestJson } from "../local/uds.js";
import { CodexAppServerClient } from "./app-server.js";
import { readCodexForegroundBinding, type CodexForegroundBinding } from "./binding.js";
import { CodexDesktopIpcClient } from "./desktop-ipc.js";
import { CodexThreadCatalog } from "./discovery.js";

/**
 * ADR-0003 R-4: the Codex live surface. Connects to the Codex app-server
 * control socket for true mid-turn steering, serves its own owner-only UDS
 * delivery socket, and keeps its liveness registered with the edge control
 * plane. Registration TTL is the heartbeat — no fence, no capability, no
 * local token: every hop is an owner-only Unix socket on one machine.
 */

interface Config {
  actor: string;
  threadId: string;
  edgeSocket: string;
  surfaceSocket: string;
  surfaceVersion: string;
  appServerSocket?: string;
  bindingFile: string;
  /**
   * The Codex installation this surface follows for a foreground attachment
   * (state home of the running Desktop app). ADR-0003 R-5 pins execution to
   * the subscription's account, so this home's `auth.json` must resolve to the
   * same artifact as the pinned profile's — checked per delivery, where that
   * profile is known.
   */
  desktopHome: string;
  desktopIpcSocket: string;
  desktopStateDatabase: string;
}

const REGISTRATION_TTL_MS = 60_000;
const RENEWAL_INTERVAL_MS = 20_000;
const BINDING_POLL_INTERVAL_MS = 1_000;
const MAX_CODEX_LIVE_OUTCOME_CHARS = 30_000;

interface CompletedLiveDelivery {
  receipt: string;
  outcome: string;
  processed: true;
}

type LiveTarget =
  | { kind: "dedicated"; sessionId: string }
  | { kind: "desktop"; sessionId: string; cwd: string; revision: string };

/**
 * Retire obsolete Desktop followers without tearing down a response stream
 * that an accepted delivery still needs. Binding switches mark the old task
 * for retirement; the actual unfollow happens after its final in-flight
 * delivery releases the lease. Re-activating the same task cancels retirement.
 */
export class DesktopFollowerRetirement {
  private readonly inFlight = new Map<string, number>();
  private readonly obsolete = new Set<string>();

  constructor(private readonly unfollow: (sessionId: string) => void) {}

  keep(sessionId: string): void {
    this.obsolete.delete(sessionId);
  }

  retire(sessionId: string): void {
    this.obsolete.add(sessionId);
    this.flush(sessionId);
  }

  async whileInUse<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.inFlight.get(sessionId) ?? 1) - 1;
      if (remaining === 0) this.inFlight.delete(sessionId);
      else this.inFlight.set(sessionId, remaining);
      this.flush(sessionId);
    }
  }

  private flush(sessionId: string): void {
    if (!this.obsolete.has(sessionId) || this.inFlight.has(sessionId)) return;
    this.obsolete.delete(sessionId);
    this.unfollow(sessionId);
  }
}

export async function runCodexLive(config: Config): Promise<void> {
  const appClient = new CodexAppServerClient(config.appServerSocket);
  const desktopClient = new CodexDesktopIpcClient(config.desktopIpcSocket);
  const desktopRetirement = new DesktopFollowerRetirement((sessionId) => {
    try {
      desktopClient.unfollow(sessionId);
    } catch (error) {
      // Follower retirement is cleanup after the routing handoff. A local IPC
      // write race must not replace an already-completed provider outcome with
      // uncertainty; the disconnected client has already dropped its state.
      console.error("Hive Codex Desktop unfollow failed", error instanceof Error ? error.message : String(error));
    }
  });
  let target: LiveTarget | null = null;
  let refreshPromise: Promise<void> | null = null;

  const prepareDedicated = async (): Promise<LiveTarget> => {
    await appClient.connect();
    await appClient.assertLiveThread(config.threadId);
    return { kind: "dedicated", sessionId: config.threadId };
  };
  const prepareDesktop = async (binding: CodexForegroundBinding): Promise<LiveTarget> => {
    if (binding.actor !== config.actor) throw new Error("Codex attachment actor does not match this live surface");
    const catalog = new CodexThreadCatalog(config.desktopStateDatabase);
    try {
      if (!catalog.primaryUserThread(binding.sessionId, binding.cwd)) {
        throw new Error("Codex attachment target is no longer an active primary user task at the exact cwd");
      }
    } finally {
      catalog.close();
    }
    await desktopClient.connect();
    await desktopClient.follow(binding.sessionId);
    desktopRetirement.keep(binding.sessionId);
    return { kind: "desktop", sessionId: binding.sessionId, cwd: binding.cwd, revision: binding.revision };
  };
  const readTarget = async (): Promise<LiveTarget> => {
    const binding = await readCodexForegroundBinding(config.bindingFile);
    return binding ? prepareDesktop(binding) : prepareDedicated();
  };
  try {
    target = await readTarget();
  } catch (error) {
    // Keep the owner-only status surface available so the attaching CLI can
    // observe failure. The edge registration remains withdrawn.
    console.error("Hive Codex attachment unavailable", error instanceof Error ? error.message : String(error));
  }

  prepareSocketPath(config.surfaceSocket);
  const cancellations = new LiveDeliveryCancellations();
  const http = createServer((request, response) => {
    void handleCodexLiveRequest(request, response, () => bindingStatus(config.actor, target), async (delivery, framed, bound) => {
      const acceptedTarget = target;
      if (!acceptedTarget) throw new Error("Codex explicit foreground attachment is unavailable");
      if (acceptedTarget.kind === "dedicated") {
        return completeCodexDelivery(appClient, acceptedTarget.sessionId, delivery, framed, Date.now, bound);
      }
      // Acquire the follower lease before the first await. A binding switch
      // may happen while account validation or the provider turn is running;
      // the old stream stays followed until this exact delivery settles.
      return desktopRetirement.whileInUse(acceptedTarget.sessionId, async () => {
        await assertPinnedDesktopAccount(config.desktopHome, delivery.subscription.accountProfile);
        return completeDesktopDelivery(desktopClient, acceptedTarget.sessionId, delivery, framed, Date.now, bound);
      });
    }, cancellations)
      .catch((error: unknown) => {
        const code = error instanceof SurfaceError ? error.code : "live_delivery_failed";
        const body = JSON.stringify({ error: code });
        response.writeHead(code === "not_found" ? 404 : code === "live_delivery_failed" ? 500 : 400, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        response.end(body);
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen({ path: config.surfaceSocket }, () => resolve());
  });

  const register = async (): Promise<void> => {
    const current = target;
    if (!current) {
      await udsRequestJson(config.edgeSocket, "POST", "/live/deregister", {
        actor: config.actor,
        provider: "codex",
      });
      return;
    }
    await udsRequestJson(config.edgeSocket, "POST", "/live/register", {
      actor: config.actor,
      provider: "codex",
      socketPath: config.surfaceSocket,
      sessionId: current.sessionId,
      surfaceVersion: config.surfaceVersion,
      ttlMs: REGISTRATION_TTL_MS,
    });
  };
  await register();
  const retireReplacedDesktop = (previous: LiveTarget | null, next: LiveTarget | null): void => {
    if (previous?.kind !== "desktop") return;
    if (next?.kind === "desktop" && next.sessionId === previous.sessionId) return;
    desktopRetirement.retire(previous.sessionId);
  };
  const transitionTarget = async (next: LiveTarget): Promise<void> => {
    const previous = target;
    target = next;
    try {
      await register();
    } catch (error) {
      target = null;
      retireReplacedDesktop(previous, null);
      if (previous?.kind !== "desktop" || next.kind !== "desktop"
        || previous.sessionId !== next.sessionId) retireReplacedDesktop(next, null);
      throw error;
    }
    retireReplacedDesktop(previous, next);
  };
  const refresh = async (): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      let binding: CodexForegroundBinding | null;
      try {
        binding = await readCodexForegroundBinding(config.bindingFile);
        const key = binding ? binding.revision : "dedicated";
        const currentKey = target?.kind === "desktop" ? target.revision : target?.kind ?? "unavailable";
        if (key === currentKey) {
          if (target?.kind !== "desktop") return;
          // An unchanged revision is not proof the task is still routable: it
          // can be archived, or moved out of its exact cwd, under a follower
          // that stays connected. Re-run the same validation a fresh
          // attachment would face — a rejection lands in the catch below and
          // withdraws liveness instead of routing wakes into a dead task.
          const wasFollowing = desktopClient.isFollowing(target.sessionId);
          const refreshed = await prepareDesktop(binding!);
          if (wasFollowing) target = refreshed;
          else await transitionTarget(refreshed);
          return;
        }
        await transitionTarget(binding ? await prepareDesktop(binding) : await prepareDedicated());
      } catch (error) {
        // An explicit binding is an authority choice. If it cannot be validated
        // or reached, withdraw liveness instead of silently steering fallback.
        const previous = target;
        target = null;
        retireReplacedDesktop(previous, null);
        await register().catch(() => {});
        console.error("Hive Codex attachment unavailable", error instanceof Error ? error.message : String(error));
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };
  const bindingPoll = setInterval(() => void refresh(), BINDING_POLL_INTERVAL_MS);
  bindingPoll.unref();
  const renewal = setInterval(() => {
    void register().catch((error: unknown) => {
      console.error("Hive Codex live renewal failed", error instanceof Error ? error.message : String(error));
    });
  }, RENEWAL_INTERVAL_MS);
  renewal.unref();
}

class SurfaceError extends Error {
  constructor(readonly code: "not_found" | "live_delivery_invalid" | "live_delivery_failed" | "account_profile_mismatch") {
    super(code);
    this.name = "SurfaceError";
  }
}

export interface LiveDeliveryBound {
  signal: AbortSignal;
  deadlineAt?: number;
  /**
   * Reports whether the provider confirmed the interrupt of an accepted turn.
   * `true` means the far side acknowledged; `false` means the interrupt itself
   * failed and the turn may still be running. Never called when no turn was
   * accepted — nothing was left to stop.
   */
  onInterrupt?: (confirmed: boolean) => void;
}

/** The `/cancel` answer: what this surface knows about the turn it was asked to stop. */
export interface LiveCancelResult {
  /** A delivery was in flight here and has now left the provider path. */
  cancelled: boolean;
  /**
   * `true` — the provider acknowledged the interrupt; `null` — no turn had been
   * accepted, so there was nothing to interrupt; `false` — the interrupt failed
   * and the turn may still be executing.
   */
  interrupted: boolean | null;
}

/**
 * In-flight live deliveries, keyed by delivery id, so the edge can ask this
 * surface to stop an accepted turn and be told *when it actually stopped*.
 *
 * Destroying the UDS client is only a send. The edge used to release the
 * delivery's broker fence on that send, while an app-server/Desktop interrupt
 * takes 10-15s and the first retry is eligible after 5s — so the retry could
 * start against the same session while the original turn was still executing.
 * The `/cancel` response is the receipt that closes that window.
 */
export class LiveDeliveryCancellations {
  private readonly inFlight = new Map<number, {
    controller: AbortController;
    stopped: Promise<void>;
    interrupted: () => boolean | null;
  }>();

  /** Run one delivery under a registration the `/cancel` route can reach. */
  async track<T>(
    deliveryId: number,
    clientSignal: AbortSignal,
    operation: (bound: LiveDeliveryBound) => Promise<T>,
    deadlineAt?: number,
  ): Promise<T> {
    const controller = new AbortController();
    const onClientAbort = (): void => controller.abort();
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
    let interrupted: boolean | null = null;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const entry = { controller, stopped, interrupted: () => interrupted };
    // A broker retry reuses the delivery id. The superseded attempt is aborted
    // (one delivery, one live attempt), and the delete below is entry-guarded
    // so the old attempt's settle can never deregister this one.
    this.inFlight.get(deliveryId)?.controller.abort();
    this.inFlight.set(deliveryId, entry);
    try {
      return await operation({
        signal: controller.signal,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        onInterrupt: (confirmed) => { interrupted = confirmed; },
      });
    } finally {
      clientSignal.removeEventListener("abort", onClientAbort);
      if (this.inFlight.get(deliveryId) === entry) this.inFlight.delete(deliveryId);
      // Ordered after the delete: a `/cancel` waiter that wakes here must never
      // observe this delivery as still in flight.
      release();
    }
  }

  /**
   * Stop the named delivery and answer only once its provider path has settled.
   *
   * A delivery this surface has no entry for is answered `cancelled: false`,
   * which is NOT a report that it stopped: the registration may not have landed
   * yet, or it may have settled and taken its interrupt result with it. The
   * edge reads that answer as an unconfirmed stop, so the honest thing here is
   * to say only what the map knows.
   */
  async cancel(deliveryId: number): Promise<LiveCancelResult> {
    const entry = this.inFlight.get(deliveryId);
    if (!entry) return { cancelled: false, interrupted: null };
    entry.controller.abort();
    await entry.stopped;
    return { cancelled: true, interrupted: entry.interrupted() };
  }
}

/**
 * HTTP entry for the Codex live surface. Exported so the disconnect/deadline
 * wiring can be tested without standing up the full attachment supervisor.
 */
export async function handleCodexLiveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  status: () => BindingStatus,
  deliver: (delivery: Delivery, framed: string, bound: LiveDeliveryBound) => Promise<CompletedLiveDelivery>,
  cancellations: LiveDeliveryCancellations,
): Promise<void> {
  if (request.method === "GET" && request.url === "/binding") {
    return sendJson(response, 200, status());
  }
  if (request.method !== "POST" || (request.url !== "/deliver" && request.url !== "/cancel")) {
    throw new SurfaceError("not_found");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SurfaceError("live_delivery_invalid");
  }
  if (request.url === "/cancel") {
    return sendJson(response, 200, await cancellations.cancel(parseLiveCancelPayload(body)));
  }
  const payload = parseLiveDeliveryPayload(body);
  const result = await cancellations.track(
    payload.delivery.id,
    clientDisconnectSignal(request, response),
    (bound) => deliver(payload.delivery, payload.framed, bound),
    payload.deadlineAt,
  );
  sendJson(response, 200, result);
}

/**
 * Abort the in-flight provider wait when the edge hangs up. Aborting the UDS
 * client only closes this HTTP request; without this signal, complete*Delivery
 * would keep waiting on the subscription TTL (24h in the shipped Codex
 * subscription) after the edge had already released and retried the delivery.
 */
export function clientDisconnectSignal(request: IncomingMessage, response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const socket = request.socket;
  const onClose = (): void => {
    if (!response.writableEnded) controller.abort();
  };
  if (socket.destroyed && !response.writableEnded) {
    controller.abort();
    return controller.signal;
  }
  socket.once("close", onClose);
  response.once("finish", () => socket.off("close", onClose));
  return controller.signal;
}

export type BindingStatus =
  | { actor: string; mode: "unavailable" }
  | { actor: string; mode: "dedicated" }
  | { actor: string; mode: "desktop"; cwd: string; revision: string };

function bindingStatus(actor: string, target: LiveTarget | null): BindingStatus {
  if (!target) return { actor, mode: "unavailable" };
  if (target.kind === "dedicated") return { actor, mode: "dedicated" };
  return { actor, mode: "desktop", cwd: target.cwd, revision: target.revision };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

/**
 * A live Codex turn is complete only when the exact turn accepted for this
 * Hive delivery reaches a terminal state. The final assistant text is the
 * actor's outcome. It travels separately from the bounded diagnostic receipt
 * so the edge can commit delivery completion and the durable Slack outbox post
 * together without parsing receipt text.
 */
export async function completeCodexDelivery(
  client: Pick<CodexAppServerClient, "deliver" | "waitForCompletion" | "interrupt">,
  threadId: string,
  delivery: Delivery,
  framed: string,
  now: () => number = Date.now,
  bound: Omit<LiveDeliveryBound, "signal"> & { signal?: AbortSignal } = {},
): Promise<CompletedLiveDelivery> {
  const deadline = turnDeadline(delivery, now, bound.deadlineAt);
  throwIfAborted(bound.signal);
  let acceptedTurnId: string | undefined;
  try {
    const accepted = await client.deliver(
      threadId,
      framed,
      delivery.id,
      remainingBefore(deadline, now),
    );
    acceptedTurnId = accepted.turnId;
    throwIfAborted(bound.signal);
    const completion = await client.waitForCompletion(
      threadId,
      accepted.turnId,
      remainingBefore(deadline, now),
      bound.signal,
    );
    if (completion.status !== "completed") {
      throw new Error(`Codex app-server turn ${accepted.turnId} ${completion.status}`);
    }
    const text = boundedLiveOutcome(
      completion.assistantText?.trim()
        || `Codex ${accepted.mode} turn ${accepted.turnId} completed without a textual final message.`,
    );
    return {
      receipt: JSON.stringify({
        type: "hive.live.completed",
        surface: "app-server",
        turnId: accepted.turnId,
        mode: accepted.mode,
        deliveryId: delivery.id,
        status: completion.status,
      }),
      outcome: text,
      processed: true,
    };
  } catch (error) {
    if (acceptedTurnId !== undefined) {
      await interruptAcceptedTurn(client, threadId, acceptedTurnId, bound.onInterrupt);
    }
    throw error;
  }
}

export async function completeDesktopDelivery(
  client: Pick<CodexDesktopIpcClient, "deliver" | "waitForDeliveryOutcome" | "interrupt">,
  sessionId: string,
  delivery: Delivery,
  framed: string,
  now: () => number = Date.now,
  bound: Omit<LiveDeliveryBound, "signal"> & { signal?: AbortSignal } = {},
): Promise<CompletedLiveDelivery> {
  const deadline = turnDeadline(delivery, now, bound.deadlineAt);
  throwIfAborted(bound.signal);
  let acceptedTurnId: string | undefined;
  try {
    const accepted = await client.deliver(
      sessionId,
      framed,
      desktopDeliveryKey(delivery),
      remainingBefore(deadline, now),
    );
    acceptedTurnId = accepted.turnId;
    throwIfAborted(bound.signal);
    const completion = await client.waitForDeliveryOutcome(
      sessionId,
      accepted,
      remainingBefore(deadline, now),
      bound.signal,
    );
    if (completion.status !== "completed") {
      throw new Error(`Codex Desktop turn ${accepted.turnId} ${completion.status}`);
    }
    const text = boundedLiveOutcome(
      completion.assistantText?.trim()
        || `Codex Desktop ${accepted.mode} turn ${accepted.turnId} completed without a textual final message.`,
    );
    return {
      receipt: JSON.stringify({
        type: "hive.live.completed",
        surface: "desktop",
        turnId: accepted.turnId,
        mode: accepted.mode,
        deliveryId: delivery.id,
        status: completion.status,
      }),
      outcome: text,
      processed: true,
    };
  } catch (error) {
    if (acceptedTurnId !== undefined) {
      await interruptAcceptedTurn(client, sessionId, acceptedTurnId, bound.onInterrupt);
    }
    throw error;
  }
}

/**
 * Interrupting is the only thing that stops an accepted turn, so a failed
 * interrupt is not a logging matter: the edge is about to release this
 * delivery's fence and retry it. `report` carries that fact back to the
 * `/cancel` answer; the throw is still swallowed so a failed interrupt cannot
 * replace the diagnosis of the error that triggered the cancellation.
 */
async function interruptAcceptedTurn(
  client: { interrupt(targetId: string, turnId: string): Promise<void> },
  targetId: string,
  turnId: string,
  report?: (confirmed: boolean) => void,
): Promise<void> {
  try {
    await client.interrupt(targetId, turnId);
    report?.(true);
  } catch (error) {
    report?.(false);
    console.error(
      "Hive Codex accepted-turn interrupt failed",
      turnId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function boundedLiveOutcome(text: string): string {
  return text.length <= MAX_CODEX_LIVE_OUTCOME_CHARS
    ? text
    : `${text.slice(0, MAX_CODEX_LIVE_OUTCOME_CHARS - 1)}…`;
}

interface LiveDeliveryPayload {
  readonly delivery: Delivery;
  readonly framed: string;
  readonly deadlineAt?: number;
}

export function parseLiveDeliveryPayload(value: unknown): LiveDeliveryPayload {
  if (!isRecord(value) || !isRecord(value.delivery)) {
    throw new SurfaceError("live_delivery_invalid");
  }
  const deliveryId = value.delivery.id;
  if (
    !Number.isSafeInteger(deliveryId)
    || Number(deliveryId) < 1
    || !Number.isSafeInteger(value.delivery.attempts)
    || Number(value.delivery.attempts) < 1
    || typeof value.framed !== "string"
  ) {
    throw new SurfaceError("live_delivery_invalid");
  }
  let deadlineAt: number | undefined;
  if (value.deadlineAt !== undefined) {
    if (typeof value.deadlineAt !== "number" || !Number.isFinite(value.deadlineAt)) {
      throw new SurfaceError("live_delivery_invalid");
    }
    deadlineAt = value.deadlineAt;
  }
  return {
    delivery: value.delivery as unknown as Delivery,
    framed: value.framed,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  };
}

export function parseLiveCancelPayload(value: unknown): number {
  if (!isRecord(value) || !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) < 1) {
    throw new SurfaceError("live_delivery_invalid");
  }
  return Number(value.deliveryId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remainingBefore(deadline: number, now: () => number): number {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("Codex live delivery exceeded its absolute deadline");
  return remaining;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Codex live delivery aborted");
}

/**
 * The execution budget for a live turn starts at the claim, not at delivery
 * creation. `deliveryTtlMs` is the broker's *pre-claim* window — it decides
 * whether a pending delivery may still be handed to an edge. Anchoring the turn
 * deadline at `createdAt` would give a delivery claimed late in that window
 * (after backoff, say) almost no time to run: the turn would time out as
 * uncertainty while still executing, and the released delivery would then
 * expire on its next claim — losing the outcome and skipping retry exhaustion.
 * The live surface is only reached after the claim, so the budget starts here.
 *
 * When the edge also sends `deadlineAt` (its dispatch wall-clock), this turn
 * cannot outlive that bound. The shipped Codex subscription TTL is 24 hours;
 * the edge releases at three. Without the min, aborting the UDS client would
 * leave this handler waiting for another 21 hours while a retry starts.
 */
function turnDeadline(delivery: Delivery, now: () => number, deadlineAt?: number): number {
  const subscriptionDeadline = now() + delivery.subscription.deliveryTtlMs;
  return deadlineAt === undefined ? subscriptionDeadline : Math.min(subscriptionDeadline, deadlineAt);
}

/**
 * The Desktop idempotency coordinate. Recovery searches a followed foreground
 * task's entire history, and that task outlives any single broker ledger: a
 * recreated or restored ledger reissues low delivery ids, so the bare integer
 * could match an unrelated earlier wake and hand back its answer. The full
 * dedupe coordinate — workspace, channel, Slack message ts, delivery id —
 * cannot collide.
 */
export function desktopDeliveryKey(delivery: Delivery): string {
  return `hive-delivery-${delivery.event.workspaceId}-${delivery.event.channelId}-${dedupeKey(delivery)}`;
}

/**
 * ADR-0003 R-5: a wake executes under the subscription's pinned account
 * profile, never whatever seat the edge happens to be logged into. The
 * foreground Desktop installation has its own state home
 * (`HIVE_CODEX_DESKTOP_HOME`), while the Hive profile may be a separate
 * directory. Account identity is the resolved `auth.json` artifact shared by
 * those two homes; comparing the directories themselves would reject a valid
 * split-state profile. A mismatch is a hard pre-dispatch failure before any
 * turn is injected, with no fallback.
 */
export async function assertPinnedDesktopAccount(
  desktopHome: string,
  accountProfile: string,
): Promise<void> {
  let desktopAuth: string;
  let pinnedAuth: string;
  try {
    [desktopAuth, pinnedAuth] = await Promise.all([
      realpath(join(desktopHome, "auth.json")),
      realpath(join(accountProfile, "auth.json")),
    ]);
  } catch (error) {
    throw new SurfaceError("account_profile_mismatch");
  }
  if (desktopAuth !== pinnedAuth) {
    throw new SurfaceError("account_profile_mismatch");
  }
  const auth = await stat(desktopAuth).catch(() => {
    throw new SurfaceError("account_profile_mismatch");
  });
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !auth.isFile() || auth.uid !== currentUid || (auth.mode & 0o077) !== 0) {
    throw new SurfaceError("account_profile_mismatch");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const hiveHome = process.env.HIVE_HOME ?? join(homedir(), ".hive");
  const desktopHome = process.env.HIVE_CODEX_DESKTOP_HOME ?? join(homedir(), ".codex");
  const actor = required("HIVE_ACTOR");
  await runCodexLive({
    actor,
    threadId: required("HIVE_SESSION_ID"),
    edgeSocket: process.env.HIVE_EDGE_SOCKET ?? join(hiveHome, "edge.sock"),
    surfaceSocket: process.env.HIVE_SURFACE_SOCKET ?? join(hiveHome, `codex-live-${actor}.sock`),
    surfaceVersion: process.env.HIVE_PROVIDER_VERSION ?? "unknown",
    bindingFile: process.env.HIVE_CODEX_BINDING_FILE ?? join(hiveHome, "codex-bindings", `${actor}.json`),
    desktopHome,
    desktopIpcSocket: process.env.HIVE_CODEX_DESKTOP_IPC_SOCKET ?? join(desktopHome, "ipc", "ipc.sock"),
    desktopStateDatabase: process.env.HIVE_CODEX_DESKTOP_STATE_DB ?? join(desktopHome, "state_5.sqlite"),
    ...(process.env.HIVE_CODEX_APP_SERVER_SOCKET
      ? { appServerSocket: process.env.HIVE_CODEX_APP_SERVER_SOCKET }
      : {}),
  });
}
