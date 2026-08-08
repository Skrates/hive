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

export async function runCodexLive(config: Config): Promise<void> {
  const appClient = new CodexAppServerClient(config.appServerSocket);
  const desktopClient = new CodexDesktopIpcClient(config.desktopIpcSocket);
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
  const http = createServer((request, response) => {
    void handle(request, response, () => bindingStatus(config.actor, target), async (delivery, framed) => {
      const acceptedTarget = target;
      if (!acceptedTarget) throw new Error("Codex explicit foreground attachment is unavailable");
      if (acceptedTarget.kind === "desktop") {
        await assertPinnedDesktopAccount(config.desktopHome, delivery.subscription.accountProfile);
      }
      return acceptedTarget.kind === "desktop"
        ? completeDesktopDelivery(desktopClient, acceptedTarget.sessionId, delivery, framed)
        : completeCodexDelivery(appClient, acceptedTarget.sessionId, delivery, framed);
    })
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
          target = await prepareDesktop(binding!);
          if (!wasFollowing) await register();
          return;
        }
        target = binding ? await prepareDesktop(binding) : await prepareDedicated();
        await register();
      } catch (error) {
        // An explicit binding is an authority choice. If it cannot be validated
        // or reached, withdraw liveness instead of silently steering fallback.
        target = null;
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

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  status: () => BindingStatus,
  deliver: (delivery: Delivery, framed: string) => Promise<CompletedLiveDelivery>,
): Promise<void> {
  if (request.method === "GET" && request.url === "/binding") {
    return sendJson(response, 200, status());
  }
  if (request.method !== "POST" || request.url !== "/deliver") throw new SurfaceError("not_found");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SurfaceError("live_delivery_invalid");
  }
  const payload = parseLiveDeliveryPayload(body);
  const result = await deliver(payload.delivery, payload.framed);
  sendJson(response, 200, result);
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
  client: Pick<CodexAppServerClient, "deliver" | "waitForCompletion">,
  threadId: string,
  delivery: Delivery,
  framed: string,
  now: () => number = Date.now,
): Promise<CompletedLiveDelivery> {
  const deadline = turnDeadline(delivery, now);
  const accepted = await client.deliver(
    threadId,
    framed,
    delivery.id,
    remainingBefore(deadline, now),
  );
  const completion = await client.waitForCompletion(
    threadId,
    accepted.turnId,
    remainingBefore(deadline, now),
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
}

export async function completeDesktopDelivery(
  client: Pick<CodexDesktopIpcClient, "deliver" | "waitForDeliveryOutcome">,
  sessionId: string,
  delivery: Delivery,
  framed: string,
  now: () => number = Date.now,
): Promise<CompletedLiveDelivery> {
  const deadline = turnDeadline(delivery, now);
  const accepted = await client.deliver(
    sessionId,
    framed,
    desktopDeliveryKey(delivery),
    remainingBefore(deadline, now),
  );
  const completion = await client.waitForDeliveryOutcome(
    sessionId,
    accepted,
    remainingBefore(deadline, now),
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
}

function boundedLiveOutcome(text: string): string {
  return text.length <= MAX_CODEX_LIVE_OUTCOME_CHARS
    ? text
    : `${text.slice(0, MAX_CODEX_LIVE_OUTCOME_CHARS - 1)}…`;
}

interface LiveDeliveryPayload {
  readonly delivery: Delivery;
  readonly framed: string;
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
  return {
    delivery: value.delivery as unknown as Delivery,
    framed: value.framed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remainingBefore(deadline: number, now: () => number): number {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("Codex live delivery exceeded its absolute deadline");
  return remaining;
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
 */
function turnDeadline(delivery: Delivery, now: () => number): number {
  return now() + delivery.subscription.deliveryTtlMs;
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
