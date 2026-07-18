import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AutoBindingUpdateSchema, LivePresenceInputSchema, ProviderSchema } from "../domain.js";
import { EdgeService } from "./service.js";

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
        const message = error instanceof Error ? error.message : String(error);
        json(response, message === "unauthorized" ? 401 : 400, { error: message });
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
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "GET" && url.pathname === "/health") {
			const readiness = this.edge.readiness();
			return json(response, readiness.ok ? 200 : 503, readiness);
		}
    this.authorize(request);
    if (request.method === "GET" && url.pathname === "/v1/live/target") {
      const actor = requiredString(url.searchParams.get("actor"), "actor");
      const provider = ProviderSchema.parse(url.searchParams.get("provider"));
      return json(response, 200, await this.edge.liveTarget(actor, provider));
    }
    if (request.method === "GET" && url.pathname === "/v1/live/auto-target") {
      const actor = requiredString(url.searchParams.get("actor"), "actor");
      return json(response, 200, await this.edge.autoBindingTarget(actor));
    }
    if (request.method === "PATCH" && url.pathname === "/v1/live/auto-bind") {
      const body = await readJson(request);
      const actor = requiredString(body.actor, "actor");
      const update = AutoBindingUpdateSchema.parse(body);
      return json(response, 200, await this.edge.autoBind(actor, update));
    }
    if (request.method === "POST" && url.pathname === "/v1/live/register") {
      const body = await readJson(request);
      const actor = requiredString(body.actor, "actor");
      const provider = ProviderSchema.parse(body.provider);
      const callbackUrl = requiredLocalCallback(body.callbackUrl);
      const providerSurface = requiredString(body.providerSurface, "providerSurface");
      const surfaceVersion = requiredString(body.surfaceVersion, "surfaceVersion");
      const sessionId = body.sessionId === null || body.sessionId === undefined
        ? null
        : requiredString(body.sessionId, "sessionId");
      const bindingRevision = Number(body.bindingRevision);
      if (!Number.isInteger(bindingRevision) || bindingRevision < 1) throw new Error("invalid bindingRevision");
      const ttlMs = Number(body.ttlMs ?? 30_000);
      if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000) throw new Error("invalid ttlMs");
      return json(response, 200, await this.edge.registerLive({
        actor,
        provider,
        callbackUrl,
        sessionId,
        bindingRevision,
        providerSurface,
        surfaceVersion,
      }, ttlMs));
    }
    if (request.method === "POST" && url.pathname === "/v1/live/presence") {
      const presence = LivePresenceInputSchema.parse(await readJson(request));
      return json(response, 200, await this.edge.reportLivePresence(presence));
    }
    if (request.method === "POST" && url.pathname === "/v1/live/ack") {
      const body = await readJson(request);
      const deliveryId = Number(body.deliveryId);
      if (!Number.isInteger(deliveryId) || deliveryId < 1) throw new Error("invalid deliveryId");
      const text = requiredString(body.text, "text");
      await this.edge.acknowledgeById(deliveryId, text);
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: "not_found" });
  }

  private authorize(request: IncomingMessage): void {
    if (request.headers.authorization !== `Bearer ${this.config.localToken}`) throw new Error("unauthorized");
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += value.length;
		if (length > 1_000_000) throw new Error("payload_too_large");
		chunks.push(value);
	}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function requiredLocalCallback(value: unknown): string {
  const parsed = new URL(requiredString(value, "callbackUrl"));
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("callbackUrl must be loopback HTTP");
  }
  return parsed.toString();
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
