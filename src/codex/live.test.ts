import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery, SubscriptionBinding } from "../domain.js";
import { CodexLiveSupervisor } from "./live.js";

function delivery(createdAt: string, deliveryTtlMs: number): Delivery {
	return {
		id: 1,
		eventId: "Ev-live-deadline",
		actor: "ariadne",
		status: "dispatching",
		reasons: [],
		leaseGeneration: 1,
		claimedBy: "mac",
		attempts: 1,
		coalesceKey: "ariadne:C1:100.1",
		coalescedEventIds: ["Ev-live-deadline"],
		initialSnapshot: null,
		snapshotTs: null,
		createdAt,
		updatedAt: createdAt,
		subscription: {
			actor: "ariadne",
			provider: "codex",
			providerSurface: "desktop-ipc",
			providerVersion: "test-v1",
			sessionId: "thread-1",
			homeEdge: "mac",
			workspace: "hive",
			edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
			wakePolicy: "live_only",
			permissionProfile: "read-only",
			leaseTtlMs: 1_000,
			deliveryTtlMs,
			homeGraceMs: 0,
			spawnRateLimit: 1,
			expiresAt: null,
			updatedAt: createdAt,
			bindingMode: "pinned",
			bindingSource: "operator",
			bindingRevision: 1,
			egressPolicy: "receipt_only",
			egressChannelIds: [],
		},
		event: {
			eventId: "Ev-live-deadline",
			workspaceId: "T1",
			channelId: "C1",
			threadTs: "100.1",
			messageTs: "100.2",
			senderId: "U1",
			senderKind: "user",
			actor: "ariadne",
			text: "WAKE: ariadne | deadline",
			raw: {},
			receivedAt: createdAt,
		},
	};
}

test("Desktop acceptance and completion share one absolute delivery deadline", async (t) => {
	const binding: SubscriptionBinding = {
		actor: "ariadne",
		provider: "codex",
		providerSurface: "desktop-ipc",
		providerVersion: "test-v1",
		sessionId: "thread-1",
		homeEdge: "mac",
		workspace: "hive",
		wakePolicy: "live_only",
		permissionProfile: "workspace-write",
		updatedAt: new Date().toISOString(),
		bindingMode: "pinned",
		bindingSource: "operator",
		bindingRevision: 1,
	};
	let callbackUrl = "";
	let completionBudget = Number.POSITIVE_INFINITY;
	const desktop = {
		connected: true,
		connect: async () => undefined,
		follow: async () => undefined,
		unfollow: () => undefined,
		isFollowing: () => true,
		async deliver(_conversationId: string, _framed: string, _deliveryId: number, timeoutMs?: number) {
			assert.ok((timeoutMs ?? 0) <= 250);
			await delay(160);
			return { turnId: "turn-1", mode: "start" as const };
		},
		async waitForTurnCompletion(_conversationId: string, _turnId: string, timeoutMs: number) {
			completionBudget = timeoutMs;
			await delay(160);
			return { turnId: "turn-1", status: "completed" as const, assistantText: "late result" };
		},
		close: async () => undefined,
	};
	const appServer = {
		connect: async () => undefined,
		assertLiveThread: async () => "idle" as const,
		deliver: async () => ({ turnId: "unused", mode: "start" as const }),
		waitForCompletion: async () => ({ status: "completed" as const, assistantText: "unused" }),
		close: async () => undefined,
	};
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/live/target") return Response.json(binding);
		if (url.pathname === "/v1/live/register") {
			const body = JSON.parse(String(init?.body)) as { callbackUrl: string };
			callbackUrl = body.callbackUrl;
			return Response.json({ ok: true });
		}
		if (url.pathname === "/v1/live/presence") return Response.json({ ok: true });
		throw new Error(`unexpected edge request ${url.pathname}`);
	};
	const supervisor = new CodexLiveSupervisor({
		actor: "ariadne",
		edgeUrl: "http://edge.invalid",
		localToken: "local-token-that-is-at-least-thirty-two-characters",
		providerSurface: "desktop-ipc",
		providerVersion: "test-v1",
		pollMs: 60_000,
	}, { desktop, appServer, fetch: fetchImpl });
	await supervisor.start();
	t.after(() => supervisor.stop());
	assert.ok(callbackUrl);

	const createdAt = Date.now();
	const ttlMs = 250;
	const response = await fetch(callbackUrl, {
		method: "POST",
		headers: {
			authorization: "Bearer local-token-that-is-at-least-thirty-two-characters",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			delivery: delivery(new Date(createdAt).toISOString(), ttlMs),
			framed: "untrusted frame",
		}),
	});
	const settledAt = Date.now();
	assert.equal(response.status, 400);
	assert.match(await response.text(), /completion_timeout/);
	assert.ok(completionBudget < 130, `completion budget should be recomputed, got ${completionBudget}`);
	assert.ok(settledAt <= createdAt + ttlMs + 60, `callback exceeded absolute deadline by ${settledAt - createdAt - ttlMs}ms`);
});

test("a hostile local edge is bounded, single-flight, and makes supervisor health fail closed", async (t) => {
	let active = 0;
	let maxActive = 0;
	let aborted = 0;
	const fetchImpl: typeof fetch = async (_input, init) => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		return await new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const onAbort = () => {
				aborted += 1;
				active -= 1;
				reject(new Error("aborted"));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	};
	const supervisor = new CodexLiveSupervisor({
		actor: "ariadne",
		edgeUrl: "http://edge.invalid",
		localToken: "local-token-that-is-at-least-thirty-two-characters",
		providerSurface: "desktop-ipc",
		providerVersion: "test-v1",
		pollMs: 20,
		edgeRequestTimeoutMs: 30,
		healthFreshnessMs: 50,
	}, { fetch: fetchImpl });
	const address = await supervisor.start();
	t.after(() => supervisor.stop());
	assert.equal(supervisor.health.ok, false);
	assert.equal(supervisor.health.reason, "live_supervisor_unavailable");
	assert.equal(aborted, 1);

	await delay(90);
	assert.equal(maxActive, 1);
	assert.ok(aborted >= 2);
	const response = await fetch(`http://${address.host}:${address.port}/health`);
	assert.equal(response.status, 503);
	assert.equal((await response.json() as { ok: boolean }).ok, false);
});

test("a delivery callback arriving during registration is accepted only by its pending binding fence", async (t) => {
	const binding: SubscriptionBinding = {
		actor: "ariadne",
		provider: "codex",
		providerSurface: "desktop-ipc",
		providerVersion: "test-v1",
		sessionId: "thread-1",
		homeEdge: "mac",
		workspace: "hive",
		wakePolicy: "live_only",
		permissionProfile: "workspace-write",
		updatedAt: new Date().toISOString(),
		bindingMode: "pinned",
		bindingSource: "operator",
		bindingRevision: 1,
	};
	let callbackStatus = 0;
	let delivered = 0;
	const desktop = {
		connected: true,
		connect: async () => undefined,
		follow: async () => undefined,
		unfollow: () => undefined,
		isFollowing: () => true,
		async deliver() {
			delivered += 1;
			return { turnId: "turn-race", mode: "start" as const };
		},
		async waitForTurnCompletion() {
			return { turnId: "turn-race", status: "completed" as const, assistantText: "race handled" };
		},
		close: async () => undefined,
	};
	const appServer = {
		connect: async () => undefined,
		assertLiveThread: async () => "idle" as const,
		deliver: async () => ({ turnId: "unused", mode: "start" as const }),
		waitForCompletion: async () => ({ status: "completed" as const, assistantText: "unused" }),
		close: async () => undefined,
	};
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/live/target") return Response.json(binding);
		if (url.pathname === "/v1/live/register") {
			const body = JSON.parse(String(init?.body)) as { callbackUrl: string };
			const response = await fetch(body.callbackUrl, {
				method: "POST",
				headers: {
					authorization: "Bearer local-token-that-is-at-least-thirty-two-characters",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					delivery: { ...delivery(new Date().toISOString(), 5_000), remainingTtlMs: 5_000 },
					framed: "untrusted frame",
				}),
			});
			callbackStatus = response.status;
			return Response.json({ ok: true });
		}
		if (url.pathname === "/v1/live/presence") return Response.json({ ok: true });
		throw new Error(`unexpected edge request ${url.pathname}`);
	};
	const supervisor = new CodexLiveSupervisor({
		actor: "ariadne",
		edgeUrl: "http://edge.invalid",
		localToken: "local-token-that-is-at-least-thirty-two-characters",
		providerSurface: "desktop-ipc",
		providerVersion: "test-v1",
		pollMs: 60_000,
	}, { desktop, appServer, fetch: fetchImpl });
	await supervisor.start();
	t.after(() => supervisor.stop());
	assert.equal(callbackStatus, 200);
	assert.equal(delivered, 1);
	assert.equal(supervisor.health.registered, true);
});

test("auto mode reasserts edge-discovery authority when the session is already current", async (t) => {
	const operatorBinding: SubscriptionBinding = {
		actor: "ariadne",
		provider: "codex",
		providerSurface: "desktop-ipc",
		providerVersion: "test-v1",
		sessionId: "thread-1",
		homeEdge: "mac",
		workspace: "hive",
		wakePolicy: "live_only",
		permissionProfile: "workspace-write",
		updatedAt: new Date().toISOString(),
		bindingMode: "auto",
		bindingSource: "operator",
		bindingRevision: 4,
	};
	const discoveredBinding: SubscriptionBinding = {
		...operatorBinding,
		bindingSource: "edge-discovery",
		bindingRevision: 5,
	};
	let autoBindRequests = 0;
	const desktop = {
		connected: true,
		connect: async () => undefined,
		follow: async () => undefined,
		unfollow: () => undefined,
		isFollowing: () => true,
		deliver: async () => ({ turnId: "unused", mode: "start" as const }),
		waitForTurnCompletion: async () => ({
			turnId: "unused",
			status: "completed" as const,
			assistantText: "unused",
		}),
		close: async () => undefined,
	};
	const appServer = {
		connect: async () => undefined,
		assertLiveThread: async () => "idle" as const,
		deliver: async () => ({ turnId: "unused", mode: "start" as const }),
		waitForCompletion: async () => ({ status: "completed" as const, assistantText: "unused" }),
		close: async () => undefined,
	};
	const catalog = {
		latestPrimaryUserThread: () => ({
			sessionId: "thread-1",
			cwd: "/work/hive",
			updatedAtMs: Date.now(),
			threadSource: "user" as const,
			parentThreadId: null,
		}),
		close: () => undefined,
	};
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/live/target") return Response.json(operatorBinding);
		if (url.pathname === "/v1/live/auto-target") {
			return Response.json({
				actor: "ariadne",
				edgeId: "mac",
				edgeCwd: "/work/hive",
				bindingRevision: 4,
			});
		}
		if (url.pathname === "/v1/live/auto-bind") {
			autoBindRequests += 1;
			const body = JSON.parse(String(init?.body)) as { expectedBindingRevision: number; sessionId: string };
			assert.deepEqual(body, {
				actor: "ariadne",
				expectedBindingRevision: 4,
				sessionId: "thread-1",
				providerSurface: "desktop-ipc",
				providerVersion: "test-v1",
				cwd: "/work/hive",
				threadSource: "user",
				parentThreadId: null,
			});
			return Response.json(discoveredBinding);
		}
		if (url.pathname === "/v1/live/register" || url.pathname === "/v1/live/presence") {
			return Response.json({ ok: true });
		}
		throw new Error(`unexpected edge request ${url.pathname}`);
	};
	const supervisor = new CodexLiveSupervisor({
		actor: "ariadne",
		edgeUrl: "http://edge.invalid",
		localToken: "local-token-that-is-at-least-thirty-two-characters",
		providerSurface: "desktop-ipc",
		providerVersion: "test-v1",
		pollMs: 60_000,
	}, { desktop, appServer, catalog, fetch: fetchImpl });
	await supervisor.start();
	t.after(() => supervisor.stop());

	assert.equal(autoBindRequests, 1);
	assert.equal(supervisor.health.bindingRevision, 5);
	assert.equal(supervisor.health.ok, true);
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
