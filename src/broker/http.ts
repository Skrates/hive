import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
	AttachmentUpdateSchema,
	BindingUpdateSchema,
	ChannelListenerUpdateSchema,
		AutoBindingUpdateSchema,
		DeliveryResultInputSchema,
		DeliveryStatusSchema,
		EgressPolicyUpdateSchema,
		LivePresenceInputSchema,
		OutboxReconciliationSchema,
		SlackOutboxStateSchema,
	SubscriptionInputSchema,
} from "../domain.js";
import { BrokerService } from "./service.js";
import {
	BindingBusyError,
	InvalidTransitionError,
	ReconciliationError,
	StaleLeaseError,
} from "./store.js";

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

  async stop(): Promise<void> {
    if (!this.server) return;
    const current = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
	  const readiness = this.broker.readiness();
	  return json(response, readiness.ready ? 200 : 503, readiness);
    }

    if (url.pathname.startsWith("/v1/admin/")) {
      this.requireAdmin(request);
			if (request.method === "GET" && url.pathname === "/v1/admin/status") {
				const staleAfterMs = Math.min(
					Math.max(integerParam(url.searchParams.get("stale_after_ms"), 60_000), 1_000),
					3_600_000,
				);
				const actor = optionalString(url.searchParams.get("actor"));
				return json(response, 200, this.broker.operatorStatus(staleAfterMs, actor));
			}
				if (request.method === "GET" && url.pathname === "/v1/admin/deliveries") {
				const actor = optionalString(url.searchParams.get("actor"));
				const rawStatus = optionalString(url.searchParams.get("status"));
				const status = rawStatus === undefined ? undefined : DeliveryStatusSchema.parse(rawStatus);
				const limit = Math.min(integerParam(url.searchParams.get("limit"), 50), 500);
				return json(response, 200, this.broker.operatorDeliveries({
					...(actor ? { actor } : {}),
					...(status ? { status } : {}),
					limit,
				}));
			}
      if (request.method === "POST" && url.pathname === "/v1/admin/edges") {
        const body = await readJson(request);
        const edgeId = requiredString(body.edgeId, "edgeId");
        return json(response, 201, { edgeId, token: this.broker.createEdge(edgeId) });
      }
      const subscriptionAdmin = /^\/v1\/admin\/subscriptions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PUT" && subscriptionAdmin?.[1]) {
        const actor = decodeURIComponent(subscriptionAdmin[1]);
        const body = await readJson(request);
        const input = SubscriptionInputSchema.parse({ ...body, actor });
        return json(response, 200, this.broker.upsertSubscription(input));
      }
			const binding = /^\/v1\/admin\/subscriptions\/([^/]+)\/binding$/.exec(url.pathname);
			if (request.method === "PATCH" && binding?.[1]) {
				const actor = decodeURIComponent(binding[1]);
				const update = BindingUpdateSchema.parse(await readJson(request));
				return json(response, 200, this.broker.updateBinding(actor, update));
			}
			const attachment = /^\/v1\/admin\/subscriptions\/([^/]+)\/attachment$/.exec(url.pathname);
			if (request.method === "PUT" && attachment?.[1]) {
				const actor = decodeURIComponent(attachment[1]);
				const update = AttachmentUpdateSchema.parse(await readJson(request));
				return json(response, 200, this.broker.attach(actor, update));
			}
			const listener = /^\/v1\/admin\/subscriptions\/([^/]+)\/listener$/.exec(url.pathname);
			if (request.method === "PATCH" && listener?.[1]) {
				const actor = decodeURIComponent(listener[1]);
				const update = ChannelListenerUpdateSchema.parse(await readJson(request));
				return json(response, 200, this.broker.setChannelListener(actor, update));
			}
				const bindingMode = /^\/v1\/admin\/subscriptions\/([^/]+)\/binding-mode$/.exec(url.pathname);
			if (request.method === "PATCH" && bindingMode?.[1]) {
				const actor = decodeURIComponent(bindingMode[1]);
				const body = await readJson(request);
				if (body.mode !== "auto" && body.mode !== "pinned") throw new HttpError(400, "invalid_binding_mode");
					return json(response, 200, this.broker.setBindingMode(actor, body.mode));
				}
				if (request.method === "GET" && url.pathname === "/v1/admin/outbox") {
					const rawState = optionalString(url.searchParams.get("state"));
					const state = rawState === undefined ? undefined : SlackOutboxStateSchema.parse(rawState);
					const limit = Math.min(integerParam(url.searchParams.get("limit"), 50), 500);
					return json(response, 200, this.broker.operatorOutbox({
						...(state ? { state } : {}),
						limit,
					}));
				}
				const egress = /^\/v1\/admin\/subscriptions\/([^/]+)\/egress$/.exec(url.pathname);
				if (request.method === "PATCH" && egress?.[1]) {
					const actor = decodeURIComponent(egress[1]);
					const update = EgressPolicyUpdateSchema.parse(await readJson(request));
					return json(response, 200, this.broker.setEgressPolicy(actor, update));
				}
	      const reconcile = /^\/v1\/admin\/deliveries\/(\d+)\/reconcile$/.exec(url.pathname);
      if (request.method === "POST" && reconcile?.[1]) {
        const body = await readJson(request);
        const disposition = body.disposition;
        if (disposition !== "processed" && disposition !== "requeue") throw new HttpError(400, "invalid_disposition");
        const detail = requiredString(body.detail, "detail");
				return json(
					response,
					200,
					this.broker.operatorReconcile(Number(reconcile[1]), disposition, detail),
				);
	      }
				const reconcileOutbox = /^\/v1\/admin\/outbox\/(\d+)\/reconcile$/.exec(url.pathname);
				if (request.method === "POST" && reconcileOutbox?.[1]) {
					const input = OutboxReconciliationSchema.parse(await readJson(request));
					return json(
						response,
						200,
						this.broker.operatorReconcileOutbox(Number(reconcileOutbox[1]), input),
					);
				}
				const outboxAudit = /^\/v1\/admin\/outbox\/(\d+)\/audit$/.exec(url.pathname);
				if (request.method === "GET" && outboxAudit?.[1]) {
					return json(response, 200, this.broker.operatorOutboxAudit(Number(outboxAudit[1])));
				}
      return json(response, 404, { error: "not_found" });
    }

    const edgeId = this.requireEdge(request);
		if (request.method === "GET" && url.pathname === "/v1/edge/health") {
			return json(response, 200, { ok: true });
		}
		const subscription = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
		if (request.method === "GET" && subscription?.[1]) {
			const actor = decodeURIComponent(subscription[1]);
			const binding = this.broker.subscriptionBindingForEdge(actor, edgeId);
			if (!binding) throw new HttpError(404, "subscription_not_found");
			return json(response, 200, binding);
		}
		const autoBinding = /^\/v1\/subscriptions\/([^/]+)\/auto-binding$/.exec(url.pathname);
		if (request.method === "GET" && autoBinding?.[1]) {
			const actor = decodeURIComponent(autoBinding[1]);
			const target = this.broker.autoBindingTargetForEdge(actor, edgeId);
			if (!target) throw new HttpError(404, "subscription_not_found");
			return json(response, 200, target);
		}
		if (request.method === "PATCH" && autoBinding?.[1]) {
			const actor = decodeURIComponent(autoBinding[1]);
			const update = AutoBindingUpdateSchema.parse(await readJson(request));
			return json(response, 200, this.broker.autoBindForEdge(actor, edgeId, update));
		}
		if (request.method === "POST" && url.pathname === "/v1/live-presence") {
			const presence = LivePresenceInputSchema.parse(await readJson(request));
			return json(response, 200, this.broker.reportLivePresence(edgeId, presence));
		}
    if (request.method === "GET" && url.pathname === "/v1/deliveries") {
      const after = integerParam(url.searchParams.get("after"), 0);
      const waitMs = integerParam(url.searchParams.get("wait_ms"), 0);
      const delivery = await this.broker.claim(edgeId, after, waitMs);
      return delivery ? json(response, 200, delivery) : json(response, 204, null);
    }

    const replay = /^\/v1\/deliveries\/(\d+)\/replay$/.exec(url.pathname);
    if (request.method === "GET" && replay?.[1]) {
      const generation = requiredInteger(Number(url.searchParams.get("generation")), "generation");
      return json(response, 200, await this.broker.replay(Number(replay[1]), edgeId, generation));
    }

	    const transition = /^\/v1\/deliveries\/(\d+)\/(accept|dispatch|dispatched|renew|release-pre-provider|reserve-spawn|result|reply)$/.exec(url.pathname);
    if (request.method === "POST" && transition?.[1] && transition[2]) {
      const deliveryId = Number(transition[1]);
      const body = await readJson(request);
      const generation = requiredInteger(body.generation, "generation");
      switch (transition[2]) {
        case "accept": return json(response, 200, this.broker.accept(deliveryId, edgeId, generation));
        case "dispatch": return json(response, 200, this.broker.beginDispatch(deliveryId, edgeId, generation));
        case "dispatched": return json(response, 200, this.broker.markDispatched(deliveryId, edgeId, generation));
	        case "renew": return json(response, 200, this.broker.renew(deliveryId, edgeId, generation));
			case "release-pre-provider": {
				const reason = requiredString(body.reason, "reason");
				if (!PRE_PROVIDER_RELEASE_REASONS.has(reason)) throw new HttpError(400, "invalid_pre_provider_reason");
				return json(response, 200, this.broker.releasePreProvider(deliveryId, edgeId, generation, {
					code: reason,
					detail: preProviderReleaseDetail(reason),
				}));
			}
        case "reserve-spawn": return json(response, 200, { reserved: this.broker.reserveSpawn(deliveryId, edgeId, generation) });
        case "result": {
          const result = DeliveryResultInputSchema.parse(body);
          return json(response, 200, this.broker.finish(deliveryId, edgeId, result));
        }
        case "reply": {
          const text = requiredString(body.text, "text");
	          return json(response, 200, { ts: this.broker.reply(deliveryId, edgeId, generation, text) });
        }
      }
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
		if (error instanceof BindingBusyError) {
			return json(response, 409, { error: "binding_busy", detail: error.message });
		}
    if (error instanceof InvalidTransitionError) return json(response, 409, { error: "invalid_transition", detail: error.message });
    if (error instanceof ReconciliationError) return json(response, 409, { error: "invalid_reconciliation", detail: error.message });
    if (error instanceof SyntaxError) return json(response, 400, { error: "invalid_json" });
    const message = error instanceof Error ? error.message : String(error);
    return json(response, 400, { error: "bad_request", detail: message });
  }
}

const PRE_PROVIDER_RELEASE_REASONS = new Set([
	"slack_replay_unavailable",
	"slack_replay_limit_exceeded",
	"slack_replay_timeout",
	"pre_provider_control_failed",
	"live_binding_changed",
	"provider_adapter_missing",
	"provider_surface_unsupported",
	"live_ingress_unavailable",
	"workspace_not_mapped",
	"resume_target_missing",
	"spawn_rate_limited",
	"subscription_expired",
]);

function preProviderReleaseDetail(reason: string): string {
	if (reason.startsWith("slack_replay")) return "Slack replay could not be assembled safely before provider invocation";
	if (reason === "subscription_expired") return "subscription authority expired before provider dispatch";
	return "dispatch preparation failed before any provider invocation";
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

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
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
