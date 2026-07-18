import assert from "node:assert/strict";
import test from "node:test";
import { BrokerHttpServer } from "../broker/http.js";
import { BrokerService, type SlackTransport } from "../broker/service.js";
import { BrokerStore } from "../broker/store.js";
import type { ReplaySnapshot } from "../domain.js";
import { OperatorClient } from "./client.js";
import { OperatorDashboardServer } from "./dashboard.js";

const silentSlack: SlackTransport = {
	replay: async (channelId: string, threadTs: string): Promise<ReplaySnapshot> => ({
		channelId,
		threadTs,
		fetchedAt: new Date().toISOString(),
		cursor: null,
		messages: [],
	}),
	reply: async () => "reply-1",
};

test("loopback dashboard keeps admin authority server-side and protects binding mutations", async (t) => {
	const adminToken = "dashboard-admin-token-that-is-more-than-thirty-two-characters";
	const store = new BrokerStore(":memory:");
	store.createEdge("mac");
	store.upsertSubscription({
		actor: "ariadne",
		provider: "codex",
		providerSurface: "app-server",
		providerVersion: "0.144.0",
		sessionId: "thread-1",
		homeEdge: "mac",
		workspace: "hive",
		edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
		wakePolicy: "resume",
		permissionProfile: "workspace-write",
		leaseTtlMs: 30_000,
		deliveryTtlMs: 300_000,
		homeGraceMs: 30_000,
		spawnRateLimit: 1,
		expiresAt: null,
	});
	const broker = new BrokerHttpServer(new BrokerService(store, silentSlack), {
		host: "127.0.0.1",
		port: 0,
		adminToken,
	});
	const brokerAddress = await broker.start();
	const operator = new OperatorClient(
		`http://${brokerAddress.host}:${brokerAddress.port}`,
		adminToken,
	);
	const dashboard = new OperatorDashboardServer(operator, { port: 0 });
	const address = await dashboard.start();
	t.after(async () => {
		await dashboard.stop();
		await broker.stop();
		store.close();
	});

	const pageResponse = await fetch(address.url);
	assert.equal(pageResponse.status, 200);
	assert.match(pageResponse.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
	const page = await pageResponse.text();
	assert.match(page, /Hive operator/);
	assert.doesNotMatch(page, new RegExp(adminToken));
	assert.doesNotMatch(page, /localStorage|sessionStorage/);
	const csrf = /const csrf="([^"]+)"/.exec(page)?.[1];
	assert.ok(csrf);

	const rejected = await fetch(`${address.url}/api/bind`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ actor: "ariadne", sessionId: "thread-2" }),
	});
	assert.equal(rejected.status, 403);
	assert.equal(store.getSubscription("ariadne")?.sessionId, "thread-1");

	const accepted = await fetch(`${address.url}/api/bind`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-hive-csrf": csrf,
			origin: address.url,
		},
		body: JSON.stringify({
			actor: "ariadne",
			sessionId: "thread-2",
			providerSurface: "app-server-control",
		}),
	});
	assert.equal(accepted.status, 200);
	const rebound = store.getSubscription("ariadne")!;
	assert.equal(rebound.sessionId, "thread-2");
	assert.equal(rebound.providerSurface, "app-server-control");
	assert.equal(rebound.permissionProfile, "workspace-write");
	assert.equal(rebound.wakePolicy, "resume");
	assert.equal(rebound.homeEdge, "mac");

	const statusResponse = await fetch(`${address.url}/api/status`);
	assert.equal(statusResponse.status, 200);
	const status = await statusResponse.json() as { actors: Array<{ subscription: { sessionId: string | null } }> };
	assert.equal(status.actors[0]?.subscription.sessionId, "thread-2");
});
