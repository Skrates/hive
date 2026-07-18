import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { SubscriptionBinding } from "../domain.js";
import { runClaudeChannel } from "./claude.js";

test("Claude channel renewal is single-flight and transport close reports unavailable last", async () => {
	let close: (() => void) | undefined;
	const fakeMcp = {
		get onclose() {
			return close;
		},
		set onclose(value: (() => void) | undefined) {
			close = value;
		},
		setRequestHandler() {},
		async connect() {},
		async notification() {},
		async close() {},
	} as unknown as McpServer;
	const binding: SubscriptionBinding = {
		actor: "fable",
		provider: "claude",
		providerSurface: "claude-channel",
		providerVersion: "test-v1",
		sessionId: "session-1",
		homeEdge: "fable-linux",
		workspace: "hive",
		wakePolicy: "live_only",
		permissionProfile: "workspace-write",
		updatedAt: new Date().toISOString(),
		bindingMode: "pinned",
		bindingSource: "operator",
		bindingRevision: 3,
	};
	let targetCalls = 0;
	let callbackUrl = "";
	let healthyPresenceCalls = 0;
	const presenceOrder: boolean[] = [];
	let renewalStarted!: () => void;
	const renewalHasStarted = new Promise<void>((resolve) => {
		renewalStarted = resolve;
	});
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/v1/live/target") {
			targetCalls += 1;
			return Response.json(binding);
		}
		if (url.pathname === "/v1/live/register") {
			callbackUrl = (JSON.parse(String(init?.body)) as { callbackUrl: string }).callbackUrl;
			return Response.json({ ok: true });
		}
		if (url.pathname === "/v1/live/presence") {
			const body = JSON.parse(String(init?.body)) as { ownerLoaded: boolean };
			if (body.ownerLoaded) {
				healthyPresenceCalls += 1;
				if (healthyPresenceCalls === 2) {
					renewalStarted();
					await delay(70);
				}
			}
			presenceOrder.push(body.ownerLoaded);
			return Response.json({ ok: true });
		}
		throw new Error(`unexpected edge request ${url.pathname}`);
	};

	const running = runClaudeChannel({
		actor: "fable",
		edgeUrl: "http://edge.invalid",
		localToken: "local-token-that-is-at-least-thirty-two-characters",
		sessionId: "session-1",
		providerSurface: "claude-channel",
		surfaceVersion: "test-v1",
	}, {
		mcp: fakeMcp,
		transport: {} as StdioServerTransport,
		fetch: fetchImpl,
		renewalMs: 25,
		requestTimeoutMs: 200,
	});
	await renewalHasStarted;
	assert.equal(targetCalls, 2);
	assert.ok(callbackUrl);
	close?.();
	await running;

	assert.deepEqual(presenceOrder, [true, true, false]);
	assert.equal(targetCalls, 2, "a stalled renewal must not accumulate overlapping registrations");
	await assert.rejects(fetch(callbackUrl), /fetch failed|ECONNREFUSED/);
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
