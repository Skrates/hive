import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { DeliveryResultInputSchema, ReasonSchema, SubscriptionInputSchema } from "../domain.js";
import { BrokerService } from "./service.js";
import { InvalidTransitionError, StaleLeaseError } from "./store.js";

export interface BrokerHttpConfig {
  host: string;
  port: number;
  adminToken: string;
}

export class BrokerHttpServer {
  private server: Server | null = null;

  constructor(
    private readonly broker: BrokerService,
    private readonly config: BrokerHttpConfig,
  ) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("broker HTTP server already started");
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => this.handleError(response, error));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.config.host, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") return { host: this.config.host, port: this.config.port };
    return { host: this.config.host, port: address.port };
  }

  /**
   * Stop accepting connections and resolve once the server is closed. Edges
   * long-poll `GET /v1/deliveries` with a server-side wait of up to 30s, and
   * HTTP keep-alive holds idle sockets open — either would keep `server.close()`
   * pending indefinitely and turn a SIGTERM into a systemd SIGKILL. So we give
   * in-flight requests a short drain window, then force the remainder closed
   * with `closeAllConnections()` (Node ≥18.2) so shutdown always completes.
   */
  async stop(drainMs = 2_000): Promise<void> {
    if (!this.server) return;
    const current = this.server;
    this.server = null;
    const closed = new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
    const forceClose = setTimeout(() => current.closeAllConnections(), Math.max(0, drainMs));
    try {
      await closed;
    } finally {
      clearTimeout(forceClose);
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true });
    }

    if (url.pathname.startsWith("/v1/admin/")) {
      this.requireAdmin(request);
      if (request.method === "POST" && url.pathname === "/v1/admin/edges") {
        const body = await readJson(request);
        const edgeId = requiredString(body.edgeId, "edgeId");
        return json(response, 201, { edgeId, token: this.broker.createEdge(edgeId) });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/v1/admin/subscriptions/")) {
        const actor = decodeURIComponent(url.pathname.slice("/v1/admin/subscriptions/".length));
        const body = await readJson(request);
        const input = SubscriptionInputSchema.parse({ ...body, actor });
        return json(response, 200, this.broker.upsertSubscription(input));
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/v1/admin/subscriptions/")) {
        const actor = decodeURIComponent(url.pathname.slice("/v1/admin/subscriptions/".length));
        return json(response, 200, { actor, deleted: this.broker.deleteSubscription(actor) });
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/deliveries") {
        return json(response, 200, this.broker.store.listDeliveries());
      }
      return json(response, 404, { error: "not_found" });
    }

    const edgeId = this.requireEdge(request);
    if (request.method === "GET" && url.pathname === "/v1/deliveries") {
      const after = integerParam(url.searchParams.get("after"), 0);
      const waitMs = integerParam(url.searchParams.get("wait_ms"), 0);
      const busy = url.searchParams.get("busy");
      const busyActors = busy ? busy.split(",").filter((item) => item.length > 0) : [];
      const delivery = await this.broker.claim(
        edgeId,
        after,
        waitMs,
        busyActors,
        requestAbortSignal(request, response),
        () => connectionStillLive(request, response),
      );
      return delivery ? json(response, 200, delivery) : json(response, 204, null);
    }

    const outcome = /^\/v1\/deliveries\/(\d+)\/outcome$/.exec(url.pathname);
    if (request.method === "POST" && outcome?.[1]) {
      const body = await readJson(request);
      const text = requiredString(body.text, "text");
      return json(response, 200, this.broker.recordOutcome(Number(outcome[1]), text));
    }

    const transition = /^\/v1\/deliveries\/(\d+)\/(accept|dispatch|dispatched|renew|reserve-spawn|release|result|reply)$/.exec(url.pathname);
    if (request.method === "POST" && transition?.[1] && transition[2]) {
      const deliveryId = Number(transition[1]);
      const body = await readJson(request);
      const generation = requiredInteger(body.generation, "generation");
      switch (transition[2]) {
        case "accept": return json(response, 200, this.broker.accept(deliveryId, edgeId, generation));
        case "dispatch": return json(response, 200, this.broker.beginDispatch(deliveryId, edgeId, generation));
        case "dispatched": return json(response, 200, this.broker.markDispatched(deliveryId, edgeId, generation));
        case "renew": return json(response, 200, this.broker.renew(deliveryId, edgeId, generation));
        case "reserve-spawn": return json(response, 200, { reserved: this.broker.reserveSpawn(deliveryId, edgeId, generation) });
        case "release": {
          const reason = ReasonSchema.parse(body.reason);
          return json(response, 200, this.broker.release(deliveryId, edgeId, generation, reason));
        }
        case "result": {
          const result = DeliveryResultInputSchema.parse(body);
          return json(response, 200, this.broker.finish(deliveryId, edgeId, result));
        }
        case "reply": {
          const text = requiredString(body.text, "text");
          return json(response, 200, { ts: await this.broker.reply(deliveryId, edgeId, generation, text) });
        }
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/replay") {
      const channelId = requiredString(url.searchParams.get("channel_id"), "channel_id");
      const threadTs = requiredString(url.searchParams.get("thread_ts"), "thread_ts");
      return json(response, 200, await this.broker.replay(channelId, threadTs));
    }
    return json(response, 404, { error: "not_found" });
  }

  private requireAdmin(request: IncomingMessage): void {
    const token = bearer(request);
    if (!token || !constantTimeEqual(token, this.config.adminToken)) throw new HttpError(401, "unauthorized");
  }

  private requireEdge(request: IncomingMessage): string {
    const edgeId = request.headers["x-hive-edge"];
    const token = bearer(request);
    if (typeof edgeId !== "string" || !token || !this.broker.store.authenticateEdge(edgeId, token)) {
      throw new HttpError(401, "unauthorized");
    }
    return edgeId;
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof HttpError) return json(response, error.status, { error: error.message });
    if (error instanceof StaleLeaseError) return json(response, 409, { error: "stale_lease" });
    if (error instanceof InvalidTransitionError) return json(response, 409, { error: "invalid_transition", detail: error.message });
    if (error instanceof SyntaxError) return json(response, 400, { error: "invalid_json" });
    const message = error instanceof Error ? error.message : String(error);
    return json(response, 400, { error: "bad_request", detail: message });
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > 1_000_000) throw new HttpError(413, "payload_too_large");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `missing_${name}`);
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new HttpError(400, `invalid_${name}`);
  return Number(value);
}

function integerParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new HttpError(400, "invalid_integer_parameter");
  return parsed;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

/**
 * Abort the claim when the edge hangs up. Aborting fetch (including
 * `AbortSignal.timeout`) closes the client first; `socket.close` is not the
 * first event the server sees — `socket.end` makes `writable` false while the
 * socket is still not destroyed. Without those earlier events, a stalled
 * `drainOutbox()` can resume into `claimNext()` and lease work to an edge
 * that will never read it.
 */
function requestAbortSignal(request: IncomingMessage, response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!response.writableEnded) controller.abort();
  };
  if (!connectionStillLive(request, response) && !response.writableEnded) {
    controller.abort();
    return controller.signal;
  }
  const socket = request.socket;
  socket.once("end", abort);
  socket.once("close", abort);
  socket.once("error", abort);
  request.once("aborted", abort);
  request.once("close", abort);
  response.once("close", abort);
  response.once("finish", () => {
    socket.off("end", abort);
    socket.off("close", abort);
    socket.off("error", abort);
    request.off("aborted", abort);
    request.off("close", abort);
    response.off("close", abort);
  });
  return controller.signal;
}

/** The HTTP connection can still carry a claim response to the calling edge. */
function connectionStillLive(request: IncomingMessage, response: ServerResponse): boolean {
  if (response.writableEnded || response.destroyed || request.destroyed) return false;
  const socket = request.socket;
  return Boolean(socket && !socket.destroyed && socket.writable);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
