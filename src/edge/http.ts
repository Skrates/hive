import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ProviderSchema } from "../domain.js";
import {
  DispatchCapabilityError,
  INVALID_DISPATCH_CAPABILITY,
} from "./dispatch-capability.js";
import { LiveIngressRegistryError, type LiveIngressFence } from "./live-registry.js";
import type { EdgeService } from "./service.js";

export interface EdgeHttpConfig {
  host: string;
  port: number;
  localToken: string;
}

export class EdgeHttpServer {
  private server: Server | null = null;

  constructor(
    private readonly edge: EdgeService,
    private readonly config: EdgeHttpConfig,
  ) {}

  async start(): Promise<{ host: string; port: number }> {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        if (error instanceof DispatchCapabilityError) {
          json(response, 401, { error: INVALID_DISPATCH_CAPABILITY });
          return;
        }
        const code = safeHttpError(error);
        json(response, code === "unauthorized" ? 401 : 400, { error: code });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.config.host, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") return { host: this.config.host, port: this.config.port };
    return { host: this.config.host, port: address.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true });
    if (request.method === "POST" && request.url === "/v1/live/ack") {
      const capability = dispatchCapability(request);
      const body = await readJson(request);
      const deliveryId = Number(body.deliveryId);
      if (!Number.isInteger(deliveryId) || deliveryId < 1) throw new Error("invalid deliveryId");
      const text = requiredString(body.text, "text");
      await this.edge.acknowledgeByCapability(deliveryId, capability, text);
      return json(response, 200, { ok: true });
    }
    this.authorize(request);
    if (request.method === "POST" && request.url === "/v1/live/register") {
      const body = await readJson(request);
      const actor = requiredString(body.actor, "actor");
      const parsedProvider = ProviderSchema.safeParse(body.provider);
      if (!parsedProvider.success) throw new Error("invalid provider");
      const provider = parsedProvider.data;
      const callbackUrl = requiredLocalCallback(body.callbackUrl);
      const surfaceVersion = requiredString(body.surfaceVersion, "surfaceVersion");
      const sessionId = body.sessionId === null || body.sessionId === undefined
        ? null
        : requiredString(body.sessionId, "sessionId");
      const ttlMs = Number(body.ttlMs ?? 30_000);
      if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000) throw new Error("invalid ttlMs");
      const registration = {
        actor,
        provider,
        callbackUrl,
        sessionId,
        surfaceVersion,
      };
      const fence = optionalLiveIngressFence(body);
      const ingress = fence
        ? this.edge.live.renew(registration, fence, ttlMs)
        : this.edge.live.register(registration, ttlMs);
      return json(response, 200, ingress);
    }
    return json(response, 404, { error: "not_found" });
  }

  private authorize(request: IncomingMessage): void {
    if (request.headers.authorization !== `Bearer ${this.config.localToken}`) throw new Error("unauthorized");
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("invalid_json");
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function optionalLiveIngressFence(body: Record<string, unknown>): LiveIngressFence | null {
  if (body.bindingId === undefined && body.bindingRevision === undefined) return null;
  const bindingId = requiredString(body.bindingId, "bindingId");
  if (!Number.isSafeInteger(body.bindingRevision) || Number(body.bindingRevision) < 1) {
    throw new Error("invalid bindingRevision");
  }
  return { bindingId, bindingRevision: Number(body.bindingRevision) };
}

function dispatchCapability(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new DispatchCapabilityError();
  }
  const capability = authorization.slice("Bearer ".length);
  if (capability.length === 0) throw new DispatchCapabilityError();
  return capability;
}

function requiredLocalCallback(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(requiredString(value, "callbackUrl"));
  } catch {
    throw new Error("invalid callbackUrl");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("callbackUrl must be loopback HTTP");
  }
  return parsed.toString();
}

function safeHttpError(error: unknown): string {
  if (error instanceof LiveIngressRegistryError) return error.code;
  const message = error instanceof Error ? error.message : "edge_request_failed";
  if (
    message === "unauthorized"
    || message === "not_found"
    || message === "invalid_json"
    || message === "invalid provider"
    || message === "invalid ttlMs"
    || message === "invalid deliveryId"
    || message === "invalid bindingRevision"
    || message === "invalid callbackUrl"
    || message === "callbackUrl must be loopback HTTP"
    || message.startsWith("missing ")
  ) return message;
  return "edge_request_failed";
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
