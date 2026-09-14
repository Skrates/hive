import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ProviderSchema, SeatWakeInputSchema } from "../domain.js";
import { prepareSocketPath } from "../local/uds.js";
import { parseAttestationWire } from "./attestation.js";
import { BrokerHttpError, type ReviewActForward } from "./broker-client.js";
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
      // A surface that sent no attestation field is registered as having
      // reported exactly that, never as an omission. Dropping the key here
      // would make `undefined` inside the registry mean two different things —
      // "no prior registration" and "the prior registration said nothing" —
      // and `retainedAttestation` cannot recover a distinction the write
      // already erased: a later report would then be adopted as though it had
      // been captured when the session started. Minting the absence at the
      // ingress is the edge computing it about its own input, which is why
      // `attestationWire` refuses to let a *surface* claim this one.
      const runtimeAttestation = parseAttestationWire(body.attestation)
        ?? { ok: false, absence: "attestation_unreported" } as const;
      const ingress = this.edge.live.register({
        actor,
        provider: parsedProvider.data,
        socketPath,
        sessionId,
        surfaceVersion,
        runtimeAttestation,
      }, ttlMs);
      return json(response, 200, { ...ingress,
        reviewCustody: sessionId === null ? { available: false, reason: "session_not_registered" }
          : this.edge.live.sessionCustody(sessionId),
      });
    }

    if (request.method === "POST" && request.url === "/live/deregister") {
      const body = await readJson(request);
      const actor = requiredString(body.actor, "actor");
      const parsedProvider = ProviderSchema.safeParse(body.provider);
      if (!parsedProvider.success) throw new Error("invalid provider");
      this.edge.live.deregister(actor, parsedProvider.data);
      return json(response, 200, { ok: true });
    }

    // KRA-1097: a seat's explicit wake mint. The edge forwards it to the broker
    // under its machine credential and relays the broker's answer verbatim —
    // including a refusal, so the minting seat learns exactly why nothing was
    // delivered instead of watching its handoff vanish (R-3).
    //
    // The source delivery is resolved HERE, from the edge's own dispatch state,
    // and never read from the request. Filesystem ownership of this socket
    // authenticates the machine; on a multi-actor box the machine is not the
    // seat, so a body that named a delivery id would let any co-tenant mint
    // under a peer's attribution.
    if (request.method === "POST" && request.url === "/wake") {
      const parsed = SeatWakeInputSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        return json(response, 400, {
          error: "invalid_wake",
          detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        });
      }
      const source = this.edge.resolveMintSource(parsed.data.token);
      if (!source) {
        return json(response, 403, {
          error: "unknown_dispatch_token",
          detail: "no dispatch on this edge holds that token — a turn can mint only while it is running",
        });
      }
      try {
        return json(response, 201, await this.edge.broker.mintWake({
          sourceDeliveryId: source.deliveryId,
          generation: source.generation,
          actor: parsed.data.actor,
          text: parsed.data.text,
          threadTs: parsed.data.threadTs,
        }));
      } catch (error) {
        if (error instanceof BrokerHttpError) {
          return json(response, error.status, parseErrorBody(error.responseBody));
        }
        throw error;
      }
    }

    // Design §9.1 / §5.A1: `hive review` reaches the broker through this socket.
    // A read carries no seat identity (the socket is the authentication); a
    // write presents the turn's dispatch token, which the edge turns into the
    // delivery custody the broker fences — exactly the `/wake` shape above, and
    // for the same reason: a body that could name a delivery could name a peer.
    if (request.method === "POST" && request.url === "/review/read") {
      const body = await readJson(request);
      const key = requiredString(body.key, "key");
      return this.relayBroker(response, 200, () => this.edge.broker.reviewRead(key));
    }

    if (request.method === "POST" && request.url === "/review/reconcile") {
      const body = await readJson(request);
      const key = requiredString(body.key, "key");
      return this.relayBroker(response, 202, () => this.edge.broker.reviewReconcile(key));
    }

    if (request.method === "POST" && request.url === "/review/session") {
      const body = await readJson(request);
      const custody = this.edge.live.sessionCustody(requiredString(body.session_id, "session_id"));
      return json(response, custody.available ? 200 : 403, custody);
    }

    if (request.method === "POST" && request.url === "/review/act") {
      const body = await readJson(request);
      const key = requiredString(body.key, "key");
      const token = requiredString(body.token, "token");
      const actId = requiredString(body.act_id, "act_id");
      const expectedRevision = body.expected_revision;
      if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) throw new Error("invalid expected_revision");
      const action = body.action;
      if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("missing action");
      if ("actor" in body || "principal" in body || "custody" in body) throw new Error("invalid custody");
      const source = this.edge.resolveMintSource(token);
      const session = source ? null : this.edge.live.resolveSession(token);
      if (!source && !session) {
        return json(response, 403, {
          error: "unknown_custody_token",
          detail: "no live delivery or attested session on this edge holds that token; custody may have expired or been revoked",
        });
      }
      try {
        const { status, receipt } = await this.edge.broker.reviewAct(key, {
          act_id: actId,
          expected_revision: Number(expectedRevision),
          action: action as ReviewActForward["action"],
          custody: source ? { delivery_id: source.deliveryId, generation: source.generation }
            : { session_id: session!.session_id, actor: session!.actor },
        });
        return json(response, status, receipt);
      } catch (error) {
        if (error instanceof BrokerHttpError) return json(response, error.status, parseErrorBody(error.responseBody));
        throw error;
      }
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

  /** Relay a broker answer verbatim, its refusal envelope included. */
  private async relayBroker(response: ServerResponse, status: number, call: () => Promise<unknown>): Promise<void> {
    try {
      return json(response, status, await call());
    } catch (error) {
      if (error instanceof BrokerHttpError) return json(response, error.status, parseErrorBody(error.responseBody));
      throw error;
    }
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

/**
 * The broker's error body, relayed as-is when it is the JSON envelope every
 * broker error uses. A non-JSON body (a proxy page, a truncated response) is
 * never guessed at — it surfaces as an opaque relay failure with the raw text.
 */
function parseErrorBody(body: string): { error: string; detail?: string } {
  try {
    const value = JSON.parse(body) as { error?: unknown; detail?: unknown };
    if (typeof value.error === "string") {
      return typeof value.detail === "string"
        ? { error: value.error, detail: value.detail }
        : { error: value.error };
    }
  } catch {
    // fall through to the opaque shape below
  }
  return { error: "broker_relay_failed", detail: body.slice(0, 500) };
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
    || message === "invalid expected_revision"
    || message === "invalid custody"
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
