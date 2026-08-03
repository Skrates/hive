#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Delivery } from "../domain.js";
import { prepareSocketPath, udsRequestJson } from "../local/uds.js";
import { CodexAppServerClient } from "./app-server.js";

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
}

const REGISTRATION_TTL_MS = 60_000;
const RENEWAL_INTERVAL_MS = 20_000;

export async function runCodexLive(config: Config): Promise<void> {
  const client = new CodexAppServerClient(config.appServerSocket);
  await client.connect();
  await client.assertLiveThread(config.threadId);

  prepareSocketPath(config.surfaceSocket);
  const http = createServer((request, response) => {
    void handle(request, response, (delivery, framed) => client.deliver(config.threadId, framed, delivery.id))
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
    await udsRequestJson(config.edgeSocket, "POST", "/live/register", {
      actor: config.actor,
      provider: "codex",
      socketPath: config.surfaceSocket,
      sessionId: config.threadId,
      surfaceVersion: config.surfaceVersion,
      ttlMs: REGISTRATION_TTL_MS,
    });
  };
  await register();
  const renewal = setInterval(() => {
    void register().catch((error: unknown) => {
      console.error("Hive Codex live renewal failed", error instanceof Error ? error.message : String(error));
    });
  }, RENEWAL_INTERVAL_MS);
  renewal.unref();
}

class SurfaceError extends Error {
  constructor(readonly code: "not_found" | "live_delivery_invalid" | "live_delivery_failed") {
    super(code);
    this.name = "SurfaceError";
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  deliver: (delivery: Delivery, framed: string) => Promise<string>,
): Promise<void> {
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
  const receipt = await deliver(payload.delivery, payload.framed);
  const encoded = JSON.stringify({ receipt });
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const hiveHome = process.env.HIVE_HOME ?? join(homedir(), ".hive");
  await runCodexLive({
    actor: required("HIVE_ACTOR"),
    threadId: required("HIVE_SESSION_ID"),
    edgeSocket: process.env.HIVE_EDGE_SOCKET ?? join(hiveHome, "edge.sock"),
    surfaceSocket: process.env.HIVE_SURFACE_SOCKET ?? join(hiveHome, `codex-live-${required("HIVE_ACTOR")}.sock`),
    surfaceVersion: process.env.HIVE_PROVIDER_VERSION ?? "unknown",
    ...(process.env.HIVE_CODEX_APP_SERVER_SOCKET
      ? { appServerSocket: process.env.HIVE_CODEX_APP_SERVER_SOCKET }
      : {}),
  });
}
