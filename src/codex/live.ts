#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Delivery } from "../domain.js";
import { CodexAppServerClient } from "./app-server.js";

interface Config {
  actor: string;
  threadId: string;
  edgeUrl: string;
  localToken: string;
  surfaceVersion: string;
  appServerSocket?: string;
}

interface LiveBindingFence {
  readonly bindingId: string;
  readonly bindingRevision: number;
}

interface LiveBinding extends LiveBindingFence {
  readonly expiresAt: number;
}

interface LiveRegistrationInput {
  readonly actor: string;
  readonly provider: "codex";
  readonly callbackUrl: string;
  readonly sessionId: string;
  readonly surfaceVersion: string;
  readonly ttlMs: number;
}

interface LiveDeliveryPayload {
  readonly delivery: Delivery;
  readonly framed: string;
  readonly ackCapability: string;
}

type SurfaceFetch = (url: string, init: RequestInit) => Promise<Response>;

type SurfaceErrorCode =
  | "not_found"
  | "unauthorized"
  | "live_delivery_invalid"
  | "live_binding_active"
  | "live_binding_unavailable"
  | "live_binding_stale"
  | "live_delivery_failed"
  | "live_registration_failed"
  | "live_registration_invalid";

class LiveSurfaceError extends Error {
  constructor(readonly code: SurfaceErrorCode) {
    super(code);
    this.name = "LiveSurfaceError";
  }
}

export class LiveBindingRegistrar {
  private binding: LiveBinding | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly request: SurfaceFetch,
    private readonly edgeUrl: string,
    private readonly localToken: string,
    private readonly input: LiveRegistrationInput,
    private readonly now: () => number = Date.now,
  ) {}

  refresh(): Promise<LiveBindingFence> {
    const operation = this.tail.then(() => this.performRefresh());
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  currentFence(): LiveBindingFence | null {
    if (!this.binding || this.binding.expiresAt <= this.now()) return null;
    return {
      bindingId: this.binding.bindingId,
      bindingRevision: this.binding.bindingRevision,
    };
  }

  private async performRefresh(): Promise<LiveBinding> {
    const current = this.binding;
    if (current) {
      try {
        return await this.renew(current);
      } catch (error) {
        if (hasSurfaceCode(error, "live_binding_unavailable")) {
          // The edge registry is process-local. If it restarted, discard only
          // the unavailable coordinate and establish a new two-step binding now.
          this.binding = null;
        } else {
          if (hasSurfaceCode(error, "live_binding_stale")) this.binding = null;
          throw error;
        }
      }
    }
    return this.establish();
  }

  private async establish(): Promise<LiveBinding> {
    // A second attempt covers an edge restart between register and confirm.
    // requestBinding retries a transport-lost response with identical input;
    // a lost confirmation remains recoverable from the provisional fence below.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = await this.requestBinding(null);
      this.binding = pending;
      try {
        return await this.renew(pending);
      } catch (error) {
        if (hasSurfaceCode(error, "live_binding_unavailable")) {
          this.binding = null;
          if (attempt === 0) continue;
        }
        if (hasSurfaceCode(error, "live_binding_stale")) this.binding = null;
        throw error;
      }
    }
    throw new LiveSurfaceError("live_registration_failed");
  }

  private async renew(current: LiveBinding): Promise<LiveBinding> {
    const next = await this.requestBinding(current);
    if (
      next.bindingId !== current.bindingId
      || next.bindingRevision !== current.bindingRevision
    ) {
      this.binding = null;
      throw new LiveSurfaceError("live_registration_invalid");
    }
    this.binding = next;
    return next;
  }

  private async requestBinding(current: LiveBindingFence | null): Promise<LiveBinding> {
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: `Bearer ${this.localToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...this.input,
        ...(current ?? {}),
      }),
    };
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.request(`${this.edgeUrl}/v1/live/register`, init);
        break;
      } catch {
        if (attempt === 1) throw new LiveSurfaceError("live_registration_failed");
      }
    }
    if (!response) throw new LiveSurfaceError("live_registration_failed");
    if (!response.ok) {
      throw new LiveSurfaceError(await registrationFailureCode(response));
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new LiveSurfaceError("live_registration_invalid");
    }
    const next = parseRegistrationResponse(value, this.now());
    return next;
  }
}

export async function runCodexLive(config: Config): Promise<void> {
  const client = new CodexAppServerClient(config.appServerSocket);
  await client.connect();
  await client.assertLiveThread(config.threadId);
  let registrar: LiveBindingRegistrar | null = null;
  const http = createServer((request, response) => {
    void handle(
      request,
      response,
      config.localToken,
      () => registrar?.currentFence() ?? null,
      async (delivery, framed) => client.deliver(config.threadId, framed, delivery.id),
    ).catch((error: unknown) => {
      const code = safeSurfaceError(error, "live_delivery_failed");
      const body = JSON.stringify({ error: code });
      response.writeHead(surfaceErrorStatus(code), {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Codex live callback did not bind TCP");
  const callbackUrl = `http://127.0.0.1:${address.port}/deliver`;
  registrar = new LiveBindingRegistrar(fetch, config.edgeUrl, config.localToken, {
    actor: config.actor,
    provider: "codex",
    callbackUrl,
    sessionId: config.threadId,
    surfaceVersion: config.surfaceVersion,
    ttlMs: 30_000,
  });
  await registrar.refresh();
  scheduleRenewal(registrar, "Hive Codex live renewal failed");
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  currentFence: () => LiveBindingFence | null,
  deliver: (
    delivery: Delivery,
    framed: string,
  ) => Promise<string>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/deliver") throw new LiveSurfaceError("not_found");
  if (request.headers.authorization !== `Bearer ${token}`) throw new LiveSurfaceError("unauthorized");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LiveSurfaceError("live_delivery_invalid");
  }
  const payload = parseLiveDeliveryPayload(body, currentFence());
  // The capability is validated at this local boundary but deliberately never
  // enters the framed content or the Codex app-server transcript. Codex has no
  // explicit agent ACK interface yet, so completion must not consume it.
  const receipt = await deliver(payload.delivery, payload.framed);
  const encoded = JSON.stringify({ receipt });
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

export function parseLiveDeliveryPayload(value: unknown, current: LiveBindingFence | null): LiveDeliveryPayload {
  if (!current) throw new LiveSurfaceError("live_binding_unavailable");
  if (!isRecord(value) || !isRecord(value.delivery) || !isRecord(value.binding)) {
    throw new LiveSurfaceError("live_delivery_invalid");
  }
  const deliveryId = value.delivery.id;
  if (
    !Number.isSafeInteger(deliveryId)
    || Number(deliveryId) < 1
    || !Number.isSafeInteger(value.delivery.leaseGeneration)
    || Number(value.delivery.leaseGeneration) < 1
    || !Number.isSafeInteger(value.delivery.attempts)
    || Number(value.delivery.attempts) < 1
    || typeof value.framed !== "string"
    || typeof value.ackCapability !== "string"
    || value.ackCapability.length === 0
    || typeof value.binding.bindingId !== "string"
    || !Number.isSafeInteger(value.binding.bindingRevision)
  ) {
    throw new LiveSurfaceError("live_delivery_invalid");
  }
  if (
    value.binding.bindingId !== current.bindingId
    || value.binding.bindingRevision !== current.bindingRevision
  ) {
    throw new LiveSurfaceError("live_binding_stale");
  }
  return {
    delivery: value.delivery as unknown as Delivery,
    framed: value.framed,
    ackCapability: value.ackCapability,
  };
}

function parseRegistrationResponse(value: unknown, now: number): LiveBinding {
  if (
    !isRecord(value)
    || typeof value.bindingId !== "string"
    || value.bindingId.length === 0
    || !Number.isSafeInteger(value.bindingRevision)
    || Number(value.bindingRevision) < 1
    || !Number.isSafeInteger(value.expiresAt)
    || Number(value.expiresAt) <= now
  ) {
    throw new LiveSurfaceError("live_registration_invalid");
  }
  return Object.freeze({
    bindingId: value.bindingId,
    bindingRevision: Number(value.bindingRevision),
    expiresAt: Number(value.expiresAt),
  });
}

async function registrationFailureCode(response: Response): Promise<SurfaceErrorCode> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return "live_registration_failed";
  }
  if (!isRecord(value)) return "live_registration_failed";
  const code = value.error;
  if (
    code === "live_binding_active"
    || code === "live_binding_unavailable"
    || code === "live_binding_stale"
  ) return code;
  return "live_registration_failed";
}

function hasSurfaceCode(error: unknown, code: SurfaceErrorCode): boolean {
  return error instanceof LiveSurfaceError && error.code === code;
}

function scheduleRenewal(registrar: LiveBindingRegistrar, label: string): void {
  const schedule = () => {
    const timer = setTimeout(() => {
      void registrar.refresh()
        .catch((error: unknown) => console.error(label, safeSurfaceError(error, "live_registration_failed")))
        .finally(schedule);
    }, 10_000);
    timer.unref();
  };
  schedule();
}

function safeSurfaceError(error: unknown, fallback: SurfaceErrorCode): SurfaceErrorCode {
  return error instanceof LiveSurfaceError ? error.code : fallback;
}

function surfaceErrorStatus(code: SurfaceErrorCode): number {
  if (code === "not_found") return 404;
  if (code === "unauthorized") return 401;
  if (code === "live_binding_stale" || code === "live_binding_unavailable") return 409;
  if (code === "live_delivery_failed") return 500;
  return 400;
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
  await runCodexLive({
    actor: required("HIVE_ACTOR"),
    threadId: required("HIVE_SESSION_ID"),
    edgeUrl: process.env.HIVE_EDGE_URL ?? "http://127.0.0.1:8791",
    localToken: required("HIVE_EDGE_LOCAL_TOKEN"),
    surfaceVersion: process.env.HIVE_PROVIDER_VERSION ?? "unknown",
    ...(process.env.HIVE_CODEX_APP_SERVER_SOCKET
      ? { appServerSocket: process.env.HIVE_CODEX_APP_SERVER_SOCKET }
      : {}),
  });
}
