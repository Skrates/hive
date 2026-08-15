import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ProviderSchema } from "../domain.js";
import { prepareSocketPath } from "../local/uds.js";
import { parseAttestationWire } from "./attestation.js";
import { LiveIngressRegistryError } from "./live-registry.js";
import type { EdgeService } from "./service.js";

export interface EdgeControlConfig {
  /** Owner-only Unix domain socket path for the local control plane. */
  socketPath: string;
}

/**
 * ADR-0003 R-4: the edge's machine-local control plane. Serves over an
 * owner-only Unix domain socket — filesystem ownership is the authentication,
 * so there is no local token and no capability ceremony.
 *
 * Surface: live-registration renewal (the hook/daemon heartbeat) and outcome
 * relay (`hive reply` lands here and the edge forwards it to the broker under
 * its machine credential).
 */
export class EdgeControlServer {
  private server: Server | null = null;

  constructor(
    private readonly edge: EdgeService,
    private readonly config: EdgeControlConfig,
  ) {}

  async start(): Promise<{ socketPath: string }> {
    if (this.server) throw new Error("edge control server already started");
    prepareSocketPath(this.config.socketPath);
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        const code = safeControlError(error);
        json(response, code === "not_found" ? 404 : 400, { error: code });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen({ path: this.config.socketPath }, () => resolve());
    });
    return { socketPath: this.config.socketPath };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true });

    if (request.method === "POST" && request.url === "/live/register") {
      const body = await readJson(request);
      const actor = requiredString(body.actor, "actor");
      const parsedProvider = ProviderSchema.safeParse(body.provider);
      if (!parsedProvider.success) throw new Error("invalid provider");
      const socketPath = requiredString(body.socketPath, "socketPath");
      const surfaceVersion = requiredString(body.surfaceVersion, "surfaceVersion");
      const sessionId = body.sessionId === null || body.sessionId === undefined
        ? null
        : requiredString(body.sessionId, "sessionId");
      const ttlMs = Number(body.ttlMs ?? 30_000);
      if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 600_000) throw new Error("invalid ttlMs");
      const runtimeAttestation = parseAttestationWire(body.attestation);
      const ingress = this.edge.live.register({
        actor,
        provider: parsedProvider.data,
        socketPath,
        sessionId,
        surfaceVersion,
        ...(runtimeAttestation !== undefined ? { runtimeAttestation } : {}),
      }, ttlMs);
      return json(response, 200, ingress);
    }

    if (request.method === "POST" && request.url === "/live/deregister") {
      const body = await readJson(request);
      const actor = requiredString(body.actor, "actor");
      const parsedProvider = ProviderSchema.safeParse(body.provider);
      if (!parsedProvider.success) throw new Error("invalid provider");
      this.edge.live.deregister(actor, parsedProvider.data);
      return json(response, 200, { ok: true });
    }

    if (request.method === "POST" && request.url === "/outcome") {
      const body = await readJson(request);
      const deliveryId = Number(body.deliveryId);
      if (!Number.isInteger(deliveryId) || deliveryId < 1) throw new Error("invalid deliveryId");
      const text = requiredString(body.text, "text");
      await this.edge.broker.outcome(deliveryId, text);
      return json(response, 200, { ok: true });
    }

    return json(response, 404, { error: "not_found" });
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

function safeControlError(error: unknown): string {
  if (error instanceof LiveIngressRegistryError) return error.code;
  const message = error instanceof Error ? error.message : "edge_request_failed";
  if (
    message === "not_found"
    || message === "invalid_json"
    || message === "invalid provider"
    || message === "invalid ttlMs"
    || message === "invalid deliveryId"
    || message === "invalid attestation"
    || message.startsWith("missing ")
  ) return message;
  return "edge_request_failed";
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
