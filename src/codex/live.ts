#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AutoBindingTarget,
  Delivery,
  LivePresenceInput,
  SubscriptionBinding,
} from "../domain.js";
import { CodexAppServerClient } from "./app-server.js";
import { CodexDesktopIpcClient, type DesktopTurnCompletion } from "./desktop-ipc.js";
import { CodexThreadCatalog, type DiscoveredCodexThread } from "./discovery.js";

export interface CodexLiveConfig {
  actor: string;
  edgeUrl: string;
  localToken: string;
  providerSurface: string;
  providerVersion: string;
  appServerSocket?: string;
  desktopIpcSocket?: string;
  stateDatabase?: string;
  pollMs?: number;
  registrationTtlMs?: number;
	edgeRequestTimeoutMs?: number;
	healthFreshnessMs?: number;
}

interface DesktopClient {
  readonly connected: boolean;
  connect(): Promise<void>;
  follow(conversationId: string, timeoutMs?: number): Promise<void>;
  unfollow(conversationId: string): void;
  isFollowing(conversationId: string): boolean;
	  deliver(conversationId: string, framed: string, deliveryId: number, timeoutMs?: number): Promise<{
    turnId: string;
    mode: "start" | "steer";
  }>;
  waitForTurnCompletion(
    conversationId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<DesktopTurnCompletion>;
  close(): Promise<void>;
}

interface AppServerClient {
  connect(): Promise<void>;
  assertLiveThread(threadId: string): Promise<"active" | "idle">;
	  deliver(threadId: string, framed: string, deliveryId: number, timeoutMs?: number): Promise<{
    turnId: string;
    mode: "start" | "steer";
  }>;
  waitForCompletion(threadId: string, turnId: string, timeoutMs: number): Promise<{
    status: "completed" | "failed" | "interrupted";
    assistantText: string | null;
  }>;
  close(): Promise<void>;
}

interface ThreadCatalog {
  latestPrimaryUserThread(cwd: string): DiscoveredCodexThread | null;
  close(): void;
}

interface Dependencies {
  desktop?: DesktopClient;
  appServer?: AppServerClient;
  catalog?: ThreadCatalog;
  fetch?: typeof fetch;
  now?: () => number;
}

interface BoundSession {
  binding: SubscriptionBinding;
  callbackId: string;
  callbackUrl: string;
  transport: "desktop-ipc" | "app-server";
}

export interface CodexLiveHealth {
  ok: boolean;
  actor: string;
  bindingMode: "auto" | "pinned" | null;
  bindingRevision: number | null;
  sessionId: string | null;
  providerSurface: string | null;
  providerVersion: string | null;
  transport: "desktop-ipc" | "app-server" | null;
  ownerLoaded: boolean;
  registered: boolean;
  reason: string | null;
  updatedAt: string;
}

export class CodexLiveSupervisor {
  private readonly desktop: DesktopClient;
  private readonly appServer: AppServerClient;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private catalog: ThreadCatalog | null;
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private bound: BoundSession | null = null;
	private pendingBound: BoundSession | null = null;
  private syncing = false;
  private activeDeliveries = 0;
  private healthValue: CodexLiveHealth;

  constructor(
    private readonly config: CodexLiveConfig,
    dependencies: Dependencies = {},
  ) {
    this.desktop = dependencies.desktop ?? new CodexDesktopIpcClient(config.desktopIpcSocket);
    this.appServer = dependencies.appServer ?? new CodexAppServerClient(config.appServerSocket);
    this.catalog = dependencies.catalog ?? null;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.healthValue = {
      ok: false,
      actor: config.actor,
      bindingMode: null,
      bindingRevision: null,
      sessionId: null,
      providerSurface: null,
      providerVersion: null,
      transport: null,
      ownerLoaded: false,
      registered: false,
      reason: "starting",
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  get health(): CodexLiveHealth {
		const health = { ...this.healthValue };
		const updatedAt = new Date(health.updatedAt).getTime();
		const freshnessMs = this.config.healthFreshnessMs
			?? Math.max((this.config.pollMs ?? 5_000) * 3, this.config.registrationTtlMs ?? 30_000);
		if (health.ok && (!Number.isFinite(updatedAt) || this.now() - updatedAt > freshnessMs)) {
			return {
				...health,
				ok: false,
				ownerLoaded: false,
				registered: false,
				reason: "live_supervisor_stale",
			};
		}
		return health;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("Codex live supervisor already started");
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        json(response, errorMessage(error) === "unauthorized" ? 401 : 400, { error: errorMessage(error) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Codex live callback did not bind TCP");
    const pollMs = this.config.pollMs ?? 5_000;
    await this.sync(address.port);
    this.timer = setInterval(() => void this.sync(address.port), pollMs);
    this.timer.unref();
    return { host: "127.0.0.1", port: address.port };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.bound?.transport === "desktop-ipc") this.desktop.unfollow(this.bound.binding.sessionId ?? "");
    this.bound = null;
	this.pendingBound = null;
    this.catalog?.close();
    this.catalog = null;
    await Promise.allSettled([this.desktop.close(), this.appServer.close()]);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async sync(port?: number): Promise<void> {
    if (this.syncing) return;
    const address = this.server?.address();
    const callbackPort = port ?? (address && typeof address !== "string" ? address.port : null);
    if (callbackPort === null) throw new Error("Codex live callback is not listening");
    this.syncing = true;
    let target: SubscriptionBinding | null = null;
    try {
      target = await this.edgeGet<SubscriptionBinding>(
        `/v1/live/target?actor=${encodeURIComponent(this.config.actor)}&provider=codex`,
      );
      if (target.bindingMode === "auto") target = await this.convergeAutoBinding(target);
      await this.ensureBound(target, callbackPort);
      this.setHealth(target, {
        ok: true,
        transport: this.bound!.transport,
        ownerLoaded: true,
        registered: true,
        reason: null,
      });
      await this.reportPresence(target, this.bound!.transport, true, null);
    } catch (error) {
      const reason = operatorReason(error);
      if (target) {
        this.setHealth(target, {
          ok: false,
          transport: this.bound?.transport ?? null,
          ownerLoaded: false,
          registered: false,
          reason,
        });
        await this.reportPresence(target, this.bound?.transport ?? "desktop-ipc", false, reason).catch(() => undefined);
      } else {
        this.healthValue = { ...this.healthValue, ok: false, ownerLoaded: false, registered: false,
          reason, updatedAt: new Date(this.now()).toISOString() };
      }
    } finally {
      this.syncing = false;
    }
  }

  private async convergeAutoBinding(binding: SubscriptionBinding): Promise<SubscriptionBinding> {
    const target = await this.edgeGet<AutoBindingTarget>(
      `/v1/live/auto-target?actor=${encodeURIComponent(this.config.actor)}`,
    );
    const candidate = this.threadCatalog().latestPrimaryUserThread(target.edgeCwd);
    if (!candidate) throw new Error("auto_no_matching_primary_thread");
    if (candidate.sessionId === binding.sessionId
      && binding.providerSurface === this.config.providerSurface
      && binding.providerVersion === this.config.providerVersion
      && binding.bindingSource === "edge-discovery") return binding;

    await this.desktop.connect();
    await this.desktop.follow(candidate.sessionId, 8_000);
    return this.edgeRequest<SubscriptionBinding>("/v1/live/auto-bind", {
      method: "PATCH",
      body: JSON.stringify({
        actor: this.config.actor,
        expectedBindingRevision: target.bindingRevision,
        sessionId: candidate.sessionId,
        providerSurface: this.config.providerSurface,
        providerVersion: this.config.providerVersion,
        cwd: candidate.cwd,
        threadSource: candidate.threadSource,
        parentThreadId: candidate.parentThreadId,
      }),
    });
  }

  private async ensureBound(binding: SubscriptionBinding, port: number): Promise<void> {
    if (!binding.sessionId) throw new Error("session_unbound");
    if (binding.providerSurface !== this.config.providerSurface
      || binding.providerVersion !== this.config.providerVersion) {
      throw new Error("configured_surface_mismatch");
    }
    if (this.bound && sameBinding(this.bound.binding, binding)) {
      if (this.bound.transport === "desktop-ipc" && this.desktop.isFollowing(binding.sessionId)) {
        await this.register(this.bound);
        return;
      }
      if (this.bound.transport === "app-server") {
        await this.appServer.assertLiveThread(binding.sessionId);
        await this.register(this.bound);
        return;
      }
    }
    if (this.activeDeliveries > 0) throw new Error("binding_changed_during_delivery");
    if (this.bound?.transport === "desktop-ipc" && this.bound.binding.sessionId) {
      this.desktop.unfollow(this.bound.binding.sessionId);
    }
    const callbackId = randomUUID();
    const callbackUrl = `http://127.0.0.1:${port}/deliver/${callbackId}`;
    let transport: BoundSession["transport"];
    const requiredTransport = surfaceTransport(binding.providerSurface);
    if (requiredTransport === "desktop-ipc") {
      await this.desktop.connect();
      await this.desktop.follow(binding.sessionId, 8_000);
      transport = "desktop-ipc";
    } else if (requiredTransport === "app-server") {
      await this.appServer.connect();
      await this.appServer.assertLiveThread(binding.sessionId);
      transport = "app-server";
    } else {
      throw new Error("unsupported_provider_surface");
    }
    const bound = { binding, callbackId, callbackUrl, transport };
	this.pendingBound = bound;
	try {
	  await this.register(bound);
	  this.bound = bound;
	} finally {
	  if (this.pendingBound?.callbackId === bound.callbackId) this.pendingBound = null;
	}
  }

  private async register(bound: BoundSession): Promise<void> {
    await this.edgeRequest("/v1/live/register", {
      method: "POST",
      body: JSON.stringify({
        actor: bound.binding.actor,
        provider: "codex",
        callbackUrl: bound.callbackUrl,
        sessionId: bound.binding.sessionId,
        bindingRevision: bound.binding.bindingRevision,
        providerSurface: bound.binding.providerSurface,
        surfaceVersion: bound.binding.providerVersion,
        ttlMs: this.config.registrationTtlMs ?? 30_000,
      }),
    });
  }

  private async reportPresence(
    binding: SubscriptionBinding,
    transport: LivePresenceInput["transport"],
    ownerLoaded: boolean,
    reason: string | null,
  ): Promise<void> {
    await this.edgeRequest("/v1/live/presence", {
      method: "POST",
      body: JSON.stringify({
        actor: binding.actor,
        provider: binding.provider,
        providerSurface: binding.providerSurface,
        providerVersion: binding.providerVersion,
        sessionId: binding.sessionId,
        bindingRevision: binding.bindingRevision,
        transport,
        ownerLoaded,
        reason,
        ttlMs: this.config.registrationTtlMs ?? 30_000,
      } satisfies LivePresenceInput),
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "GET" && url.pathname === "/health") {
			const health = this.health;
			return json(response, health.ok ? 200 : 503, health);
		}
    if (request.headers.authorization !== `Bearer ${this.config.localToken}`) throw new Error("unauthorized");
    const match = /^\/deliver\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match?.[1]) throw new Error("not_found");
	const bound = this.bound?.callbackId === match[1]
	  ? this.bound
	  : this.pendingBound?.callbackId === match[1]
		? this.pendingBound
		: null;
	if (!bound) throw new Error("stale_callback");
    const body = await readJson(request) as { delivery?: Delivery; framed?: unknown };
    if (!body.delivery || typeof body.framed !== "string") throw new Error("invalid_delivery");
    assertDeliveryBinding(body.delivery, bound.binding);
    this.activeDeliveries += 1;
    try {
      const receipt = await this.deliverAndWait(bound, body.delivery, body.framed);
      return json(response, 200, { receipt, processed: true });
    } finally {
      this.activeDeliveries -= 1;
    }
  }

	  private async deliverAndWait(bound: BoundSession, delivery: Delivery, framed: string): Promise<string> {
		const remainingMs = delivery.remainingTtlMs
		  ?? (new Date(delivery.createdAt).getTime() + delivery.subscription.deliveryTtlMs - this.now());
		const deadline = this.now() + remainingMs;
	    let completion: { status: "completed" | "failed" | "interrupted"; assistantText: string | null };
	    let turnId: string;
	    let mode: "start" | "steer";
	    if (bound.transport === "desktop-ipc") {
		const accepted = await beforeAbsoluteDeadline(
			this.desktop.deliver(
				bound.binding.sessionId!,
				framed,
				delivery.id,
				remainingBefore(deadline, this.now),
			),
			deadline,
			this.now,
		);
	      turnId = accepted.turnId;
	      mode = accepted.mode;
	      completion = await beforeAbsoluteDeadline(
			this.desktop.waitForTurnCompletion(
				bound.binding.sessionId!,
				turnId,
				remainingBefore(deadline, this.now),
			),
			deadline,
			this.now,
		);
	    } else {
	      const accepted = await beforeAbsoluteDeadline(
			this.appServer.deliver(
				bound.binding.sessionId!,
				framed,
				delivery.id,
				remainingBefore(deadline, this.now),
			),
			deadline,
			this.now,
		);
	      turnId = accepted.turnId;
	      mode = accepted.mode;
	      completion = await beforeAbsoluteDeadline(
			this.appServer.waitForCompletion(
				bound.binding.sessionId!,
				turnId,
				remainingBefore(deadline, this.now),
			),
			deadline,
			this.now,
		);
    }
    if (completion.status !== "completed") throw new Error(`codex_turn_${completion.status}`);
    const result = completion.assistantText?.trim()
      || `Codex ${bound.transport} turn ${turnId} completed without a textual final message.`;
    return JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: result },
      transport: bound.transport,
      mode,
      turnId,
    });
  }

  private threadCatalog(): ThreadCatalog {
    if (!this.catalog) this.catalog = new CodexThreadCatalog(this.config.stateDatabase);
    return this.catalog;
  }

  private edgeGet<T>(path: string): Promise<T> {
    return this.edgeRequest(path, { method: "GET" });
  }

  private async edgeRequest<T>(path: string, init: RequestInit): Promise<T> {
		const timeoutMs = Math.max(25, this.config.edgeRequestTimeoutMs ?? 5_000);
		const controller = new AbortController();
		const externalSignal = init.signal;
		const forwardAbort = () => controller.abort(externalSignal?.reason);
		if (externalSignal?.aborted) forwardAbort();
		else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
		let timer: NodeJS.Timeout | null = null;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort(new Error("edge_request_timeout"));
					reject(new Error("edge_request_timeout"));
				}, timeoutMs);
			});
			const response = await Promise.race([
				this.fetchImpl(`${this.config.edgeUrl}${path}`, {
					...init,
					signal: controller.signal,
					headers: {
						authorization: `Bearer ${this.config.localToken}`,
						...(init.body ? { "content-type": "application/json" } : {}),
					},
				}),
				timeout,
			]);
			if (!response.ok) throw new Error(`edge_${response.status}:${await response.text()}`);
			return await response.json() as T;
		} catch (error) {
			if (controller.signal.aborted && !externalSignal?.aborted) throw new Error("edge_request_timeout");
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			externalSignal?.removeEventListener("abort", forwardAbort);
		}
  }

  private setHealth(
    binding: SubscriptionBinding,
    state: Pick<CodexLiveHealth, "ok" | "transport" | "ownerLoaded" | "registered" | "reason">,
  ): void {
    this.healthValue = {
      ...state,
      actor: binding.actor,
      bindingMode: binding.bindingMode,
      bindingRevision: binding.bindingRevision,
      sessionId: binding.sessionId,
      providerSurface: binding.providerSurface,
      providerVersion: binding.providerVersion,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
}

export async function runCodexLive(config: CodexLiveConfig): Promise<CodexLiveSupervisor> {
  const supervisor = new CodexLiveSupervisor(config);
  await supervisor.start();
  return supervisor;
}

function sameBinding(left: SubscriptionBinding, right: SubscriptionBinding): boolean {
  return left.actor === right.actor
    && left.provider === right.provider
    && left.sessionId === right.sessionId
    && left.providerSurface === right.providerSurface
    && left.providerVersion === right.providerVersion
    && left.bindingRevision === right.bindingRevision;
}

function surfaceTransport(surface: string): BoundSession["transport"] | null {
  if (surface === "codex-desktop-ipc" || surface === "desktop-ipc") return "desktop-ipc";
  if (surface === "codex-app-server" || surface === "app-server" || surface === "app-server-control") {
    return "app-server";
  }
  return null;
}

function assertDeliveryBinding(delivery: Delivery, binding: SubscriptionBinding): void {
  const subscription = delivery.subscription;
  if (delivery.actor !== binding.actor
    || subscription.provider !== binding.provider
    || subscription.sessionId !== binding.sessionId
    || subscription.providerSurface !== binding.providerSurface
    || subscription.providerVersion !== binding.providerVersion
    || subscription.bindingRevision !== binding.bindingRevision) {
    throw new Error("delivery_binding_mismatch");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > 1_000_000) throw new Error("payload_too_large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function operatorReason(error: unknown): string {
  const detail = errorMessage(error);
  const known = [
    "auto_no_matching_primary_thread",
    "auto_binding_stale_revision",
    "configured_surface_mismatch",
    "no_owner_loaded",
    "no_owner_loaded",
    "session_unbound",
    "completion_timeout",
    "revision_mismatch",
    "socket_missing",
  ].find((code) => detail.includes(code));
  return known ?? "live_supervisor_unavailable";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingBefore(deadline: number, now: () => number): number {
	const remaining = deadline - now();
	if (remaining <= 0) throw new Error("completion_timeout");
	return remaining;
}

async function beforeAbsoluteDeadline<T>(
	value: Promise<T>,
	deadline: number,
	now: () => number,
): Promise<T> {
	const remaining = remainingBefore(deadline, now);
	let timer: NodeJS.Timeout | null = null;
	try {
		return await Promise.race([
			value,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("completion_timeout")), remaining);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const supervisor = await runCodexLive({
    actor: required("HIVE_ACTOR"),
    edgeUrl: process.env.HIVE_EDGE_URL ?? "http://127.0.0.1:8791",
    localToken: required("HIVE_EDGE_LOCAL_TOKEN"),
    providerSurface: process.env.HIVE_PROVIDER_SURFACE ?? "codex-desktop-ipc",
    providerVersion: process.env.HIVE_PROVIDER_VERSION ?? "desktop-ipc-v1",
    ...(process.env.HIVE_CODEX_APP_SERVER_SOCKET
      ? { appServerSocket: process.env.HIVE_CODEX_APP_SERVER_SOCKET }
      : {}),
    ...(process.env.HIVE_CODEX_DESKTOP_IPC_SOCKET
      ? { desktopIpcSocket: process.env.HIVE_CODEX_DESKTOP_IPC_SOCKET }
      : {}),
    ...(process.env.HIVE_CODEX_STATE_DB ? { stateDatabase: process.env.HIVE_CODEX_STATE_DB } : {}),
  });
  const stop = async () => {
    await supervisor.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
