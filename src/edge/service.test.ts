import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery, DeliveryResultInput, SubscriptionBinding } from "../domain.js";
import { BrokerClient } from "./broker-client.js";
import { LiveIngressRegistry } from "./live-registry.js";
import type { ProviderAdapter } from "./providers.js";
import { completionAcknowledgement } from "./service.js";
import { EdgeService } from "./service.js";
import { EdgeStore } from "./store.js";

test("automatic Slack completion is a fixed bounded receipt without provider prose", () => {
  const acknowledgement = completionAcknowledgement({ actor: "ariadne", id: 42 });
  assert.equal(acknowledgement, "Hive: ariadne completed delivery 42.");
  assert.equal(acknowledgement.includes("provider result"), false);
  assert.ok(acknowledgement.length < 100);

  const hostile = completionAcknowledgement({ actor: "<!channel>".repeat(1_000), id: 43 });
  assert.doesNotMatch(hostile, /[<>!]/);
  assert.ok(hostile.length < 110);
});

function delivery(overrides: Partial<Delivery["subscription"]> = {}): Delivery {
	const subscription: Delivery["subscription"] = {
		actor: "ariadne",
		provider: "codex",
		providerSurface: "desktop-ipc",
		providerVersion: "test",
		sessionId: "thread-1",
		homeEdge: "mac",
		workspace: "hive",
		edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
		wakePolicy: "live_only",
		permissionProfile: "read-only",
		leaseTtlMs: 1_000,
		deliveryTtlMs: 10_000,
		homeGraceMs: 0,
		spawnRateLimit: 1,
		expiresAt: null,
		updatedAt: new Date().toISOString(),
		bindingMode: "auto",
		bindingSource: "edge-discovery",
		bindingRevision: 1,
		egressPolicy: "receipt_only",
		egressChannelIds: [],
		...overrides,
	};
	return {
		id: 1,
		eventId: "Ev-service-1",
		actor: "ariadne",
		status: "claimed",
		reasons: [],
		leaseGeneration: 1,
		claimedBy: "mac",
		attempts: 1,
		coalesceKey: "ariadne:C1:100.1",
		coalescedEventIds: ["Ev-service-1"],
		initialSnapshot: null,
		snapshotTs: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		subscription,
		event: {
			eventId: "Ev-service-1",
			workspaceId: "T1",
			channelId: "C1",
			threadTs: "100.1",
			messageTs: "100.2",
			senderId: "U1",
			senderKind: "user",
			actor: "ariadne",
			text: "WAKE: ariadne | test",
			raw: {},
			receivedAt: new Date().toISOString(),
		},
	};
}

function binding(value: Delivery): SubscriptionBinding {
	return {
		actor: value.actor,
		provider: value.subscription.provider,
		providerSurface: value.subscription.providerSurface,
		providerVersion: value.subscription.providerVersion,
		sessionId: value.subscription.sessionId,
		homeEdge: value.subscription.homeEdge,
		workspace: value.subscription.workspace,
		wakePolicy: value.subscription.wakePolicy,
		permissionProfile: value.subscription.permissionProfile,
		updatedAt: value.subscription.updatedAt,
		bindingMode: value.subscription.bindingMode,
		bindingSource: value.subscription.bindingSource,
		bindingRevision: value.subscription.bindingRevision,
	};
}

function fakeBroker(
	value: Delivery,
	overrides: {
		replay?: BrokerClient["replay"];
		renew?: BrokerClient["renew"];
		releasePreProvider?: BrokerClient["releasePreProvider"];
		markDispatched?: BrokerClient["markDispatched"];
		finish?: BrokerClient["finish"];
	} = {},
): {
	client: BrokerClient;
	results: DeliveryResultInput[];
	readonly releaseCalls: number;
} {
	let claimed = false;
	const results: DeliveryResultInput[] = [];
	let renewCalls = 0;
	let releaseCalls = 0;
	const client = {
		edgeId: "mac",
		probe: async () => undefined,
		claim: async () => claimed ? null : (claimed = true, value),
		accept: async () => ({ ...value, status: "accepted_local" }),
		replay: async (...args: Parameters<BrokerClient["replay"]>) => {
			if (overrides.replay) return overrides.replay(...args);
			return {
				channelId: "C1",
				threadTs: "100.1",
				fetchedAt: new Date().toISOString(),
				cursor: null,
				messages: [],
			};
		},
		beginDispatch: async () => ({ ...value, status: "dispatching" }),
		markDispatched: async (...args: Parameters<BrokerClient["markDispatched"]>) => {
			if (overrides.markDispatched) return overrides.markDispatched(...args);
			return { ...value, status: "dispatched" };
		},
		renew: async (...args: Parameters<BrokerClient["renew"]>) => {
			renewCalls += 1;
			if (overrides.renew) return overrides.renew(...args);
			return value;
		},
		subscriptionBinding: async () => binding(value),
			finish: async (...args: Parameters<BrokerClient["finish"]>) => {
				if (overrides.finish) return overrides.finish(...args);
				const result = args[1];
			results.push(result);
			return { ...value, status: result.status };
			},
			releasePreProvider: async (...args: Parameters<BrokerClient["releasePreProvider"]>) => {
				releaseCalls += 1;
				if (overrides.releasePreProvider) return overrides.releasePreProvider(...args);
				return { ...value, status: "pending", availableAt: new Date().toISOString() };
			},
		reserveSpawn: async () => true,
		get renewCalls() { return renewCalls; },
	} as unknown as BrokerClient;
	return {
		client,
		results,
		get releaseCalls() { return releaseCalls; },
	};
}

test("remote callback prose cannot downgrade an already-started provider failure", async () => {
	const value = delivery();
	const { client, results } = fakeBroker(value);
	const live = new LiveIngressRegistry();
	live.register({
		actor: "ariadne",
		provider: "codex",
		callbackUrl: "http://127.0.0.1:1/deliver",
		sessionId: "thread-1",
		bindingRevision: 1,
		providerSurface: "desktop-ipc",
		surfaceVersion: "test",
	}, 30_000);
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { throw new Error("500 body: live_ingress_unavailable live_binding_changed"); },
		resume: async () => { throw new Error("unexpected"); },
		spawn: async () => { throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(client, store, live, [adapter]);
	assert.equal(await edge.processOne(), true);
	assert.equal(results[0]?.status, "ambiguous");
	assert.equal(results[0]?.reasons[0]?.code, "provider_dispatch_unknown");
	store.close();
});

test("a live-owned Desktop surface cannot fall through to headless resume", async () => {
	const value = delivery({
		providerSurface: "codex-desktop-ipc",
		wakePolicy: "resume",
	});
	const releaseReasons: string[] = [];
	const broker = fakeBroker(value, {
		releasePreProvider: async (candidate, reason) => {
			releaseReasons.push(reason);
			return { ...candidate, status: "pending", availableAt: new Date().toISOString() };
		},
	});
	let resumeCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { throw new Error("unexpected"); },
		resume: async () => {
			resumeCalls += 1;
			return { receipt: "wrong owner", processed: true, sessionId: null };
		},
		spawn: async () => { throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, new LiveIngressRegistry(), [adapter]);

	assert.equal(await edge.processOne(), true);
	assert.equal(resumeCalls, 0);
	assert.equal(broker.releaseCalls, 1);
	assert.deepEqual(releaseReasons, ["live_ingress_unavailable"]);
	assert.equal(broker.results.length, 0);
	store.close();
});

test("an explicit headless-exec surface may resume without a live registry owner", async () => {
	const value = delivery({
		providerSurface: "headless-exec",
		wakePolicy: "resume",
	});
	const broker = fakeBroker(value);
	let resumeCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { throw new Error("unexpected"); },
		resume: async () => {
			resumeCalls += 1;
			return { receipt: "headless resume", processed: true, sessionId: null };
		},
		spawn: async () => { throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, new LiveIngressRegistry(), [adapter]);

	assert.equal(await edge.processOne(), true);
	assert.equal(resumeCalls, 1);
	assert.equal(broker.releaseCalls, 0);
	assert.equal(broker.results[0]?.status, "processed");
	store.close();
});

test("an unknown provider surface fails closed before any adapter invocation", async () => {
	const value = delivery({
		providerSurface: "mystery-owner",
		wakePolicy: "resume",
	});
	const releaseReasons: string[] = [];
	const broker = fakeBroker(value, {
		releasePreProvider: async (candidate, reason) => {
			releaseReasons.push(reason);
			return { ...candidate, status: "pending", availableAt: new Date().toISOString() };
		},
	});
	let adapterCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { adapterCalls += 1; throw new Error("unexpected"); },
		resume: async () => { adapterCalls += 1; throw new Error("unexpected"); },
		spawn: async () => { adapterCalls += 1; throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, new LiveIngressRegistry(), [adapter]);

	assert.equal(await edge.processOne(), true);
	assert.equal(adapterCalls, 0);
	assert.deepEqual(releaseReasons, ["provider_surface_unsupported"]);
	store.close();
});

test("a completed spawn without one structured session id becomes operator-visible ambiguous", async () => {
	const value = delivery({
		providerSurface: "codex-cli",
		sessionId: null,
		wakePolicy: "spawn",
	});
	const { client, results } = fakeBroker(value);
	let spawnCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { throw new Error("unexpected"); },
		resume: async () => { throw new Error("unexpected"); },
		spawn: async () => {
			spawnCalls += 1;
			return { receipt: "spawn exited zero", processed: true, sessionId: null };
		},
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(client, store, new LiveIngressRegistry(), [adapter]);

	assert.equal(await edge.processOne(), true);
	assert.equal(spawnCalls, 1);
	assert.equal(results.length, 1);
	assert.equal(results[0]?.status, "ambiguous");
	assert.equal(results[0]?.reasons[0]?.code, "spawn_session_unconfirmed");
	assert.equal(results[0]?.spawnedSessionId, null);
	assert.equal(store.get(value.id)?.status, "ambiguous");
	assert.equal(await edge.processOne(), false);
	assert.equal(spawnCalls, 1);
	store.close();
});

test("post-spawn control failure preserves the reservation-fenced session for recovery", async () => {
	const value = delivery({
		providerSurface: "codex-cli",
		sessionId: null,
		wakePolicy: "spawn",
	});
	const { client, results } = fakeBroker(value, {
		markDispatched: async () => { throw new Error("broker control unavailable"); },
	});
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { throw new Error("unexpected"); },
		resume: async () => { throw new Error("unexpected"); },
		spawn: async () => ({
			receipt: "structured spawn receipt",
			processed: true,
			sessionId: "observed-session-123",
		}),
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(client, store, new LiveIngressRegistry(), [adapter]);

	assert.equal(await edge.processOne(), true);
	assert.equal(results.length, 1);
	assert.equal(results[0]?.status, "ambiguous");
	assert.equal(results[0]?.reasons[0]?.code, "provider_dispatch_unknown");
	assert.equal(results[0]?.spawnedSessionId, "observed-session-123");
	assert.equal(store.get(value.id)?.status, "ambiguous");
	assert.equal(store.get(value.id)?.spawned_session_id, "observed-session-123");
	store.close();
});

test("a running edge retries orphan-session recovery after transient broker control loss", async () => {
	const value = delivery({
		providerSurface: "codex-cli",
		sessionId: null,
		wakePolicy: "spawn",
	});
	const controller = new AbortController();
	let finishCalls = 0;
	const recovered: DeliveryResultInput[] = [];
	const outageStartedAt = Date.now();
	const outageUntil = outageStartedAt + 650;
	const { client } = fakeBroker(value, {
		markDispatched: async () => { throw new Error("mark control unavailable"); },
		finish: async (_delivery, result) => {
			finishCalls += 1;
			if (Date.now() < outageUntil) throw new Error("terminal control unavailable");
			recovered.push(result);
			setTimeout(() => controller.abort(new Error("recovery observed")), 0);
			return { ...value, status: result.status };
		},
	});
	let spawnCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { throw new Error("unexpected"); },
		resume: async () => { throw new Error("unexpected"); },
		spawn: async () => {
			spawnCalls += 1;
			return {
				receipt: "structured spawn receipt",
				processed: true,
				sessionId: "same-process-orphan-session",
			};
		},
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(client, store, new LiveIngressRegistry(), [adapter]);

	await edge.run(controller.signal);

	assert.ok(finishCalls > 2);
	assert.ok(Date.now() - outageStartedAt >= 500);
	assert.equal(spawnCalls, 1);
	assert.equal(recovered[0]?.status, "ambiguous");
	assert.equal(recovered[0]?.spawnedSessionId, "same-process-orphan-session");
	assert.equal(store.get(value.id)?.status, "ambiguous");
	assert.equal(store.get(value.id)?.spawned_session_id, "same-process-orphan-session");
	assert.equal(value.subscription.sessionId, null);
	store.close();
});

test("restart recovery reports a locally observed spawned session without binding it", async () => {
	const value = delivery({
		providerSurface: "codex-cli",
		sessionId: null,
		wakePolicy: "spawn",
	});
	const { client, results } = fakeBroker(value);
	const store = new EdgeStore(":memory:");
	store.receive(value, 1);
	store.setStatus(1, 1, "dispatched", "spawn receipt", "restart-observed-session");
	const edge = new EdgeService(client, store, new LiveIngressRegistry(), []);

	assert.equal(await edge.recoverInterruptedDispatches(), 1);
	assert.equal(results[0]?.status, "ambiguous");
	assert.equal(results[0]?.spawnedSessionId, "restart-observed-session");
	assert.equal(store.get(1)?.spawned_session_id, "restart-observed-session");
	store.close();
});

test("a hung renewal aborts the provider before the lease safety deadline", async () => {
	const value = delivery({ leaseTtlMs: 200, deliveryTtlMs: 2_000 });
	let calls = 0;
	const { client, results } = fakeBroker(value, {
		renew: (...args: Parameters<BrokerClient["renew"]>) => {
			calls += 1;
				if (calls <= 2) return Promise.resolve(value);
			const signal = args[1]!;
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		},
	});
	const live = new LiveIngressRegistry();
	live.register({
		actor: "ariadne",
		provider: "codex",
		callbackUrl: "http://127.0.0.1:1/deliver",
		sessionId: "thread-1",
		bindingRevision: 1,
		providerSurface: "desktop-ipc",
		surfaceVersion: "test",
	}, 30_000);
	let providerAbortedAt = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async (_ingress, _delivery, _framed, signal) => new Promise((_, reject) => {
			signal.addEventListener("abort", () => {
				providerAbortedAt = Date.now();
				reject(signal.reason);
			}, { once: true });
		}),
		resume: async () => { throw new Error("unexpected"); },
		spawn: async () => { throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(client, store, live, [adapter]);
	const startedAt = Date.now();
	assert.equal(await edge.processOne(), true);
	assert.ok(providerAbortedAt > 0);
	assert.ok(providerAbortedAt - startedAt < value.subscription.leaseTtlMs);
	assert.equal(results[0]?.status, "ambiguous");
	assert.equal(results[0]?.reasons[0]?.code, "lease_renewal_failed");
	store.close();
});

test("run shutdown abort reaches Slack replay and releases without invoking a provider", async () => {
	const value = delivery({ deliveryTtlMs: 2_000 });
	let replayStarted!: () => void;
	const started = new Promise<void>((resolve) => { replayStarted = resolve; });
	let replayAborted = false;
	const broker = fakeBroker(value, {
		replay: async (_delivery, signal) => new Promise((_, reject) => {
			replayStarted();
			const abort = () => {
				replayAborted = true;
				reject(signal?.reason);
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		}),
	});
	let providerCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { providerCalls += 1; throw new Error("unexpected"); },
		resume: async () => { providerCalls += 1; throw new Error("unexpected"); },
		spawn: async () => { providerCalls += 1; throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, new LiveIngressRegistry(), [adapter]);
	const controller = new AbortController();
	const running = edge.run(controller.signal);
	await started;
	const abortedAt = Date.now();
	controller.abort(new Error("test shutdown"));
	await running;
	assert.equal(replayAborted, true);
	assert.equal(providerCalls, 0);
	assert.equal(broker.releaseCalls, 1);
	assert.equal(store.get(value.id)?.status, "received");
	assert.ok(Date.now() - abortedAt < 250);
	store.close();
});

test("an initial renewal failure cleans up and releases before provider dispatch", async () => {
	const value = delivery({ deliveryTtlMs: 5_000 });
	const broker = fakeBroker(value, {
		renew: async () => { throw new TypeError("fetch failed"); },
	});
	const live = new LiveIngressRegistry();
	live.register({
		actor: "ariadne",
		provider: "codex",
		callbackUrl: "http://127.0.0.1:1/deliver",
		sessionId: "thread-1",
		bindingRevision: 1,
		providerSurface: "desktop-ipc",
		surfaceVersion: "test",
	}, 30_000);
	let providerCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { providerCalls += 1; throw new Error("unexpected"); },
		resume: async () => { providerCalls += 1; throw new Error("unexpected"); },
		spawn: async () => { providerCalls += 1; throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, live, [adapter]);
	const startedAt = Date.now();
	assert.equal(await edge.processOne(), true);
	assert.ok(Date.now() - startedAt < 250);
	assert.equal(providerCalls, 0);
	assert.equal(broker.releaseCalls, 1);
	assert.equal(store.get(value.id)?.status, "received");
	store.close();
});

test("pre-provider release retries transient failures with the same fence until confirmed", async () => {
	const value = delivery({ deliveryTtlMs: 2_000 });
	const releaseFences: Array<string> = [];
	let releaseAttempts = 0;
	const broker = fakeBroker(value, {
		releasePreProvider: async (candidate, reason, signal) => {
			releaseAttempts += 1;
			releaseFences.push(`${candidate.id}:${candidate.leaseGeneration}:${reason}`);
			assert.equal(signal?.aborted, false);
			if (releaseAttempts < 3) throw new TypeError("fetch failed");
			return { ...candidate, status: "pending", availableAt: new Date().toISOString() };
		},
	});
	let providerCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { providerCalls += 1; throw new Error("unexpected"); },
		resume: async () => { providerCalls += 1; throw new Error("unexpected"); },
		spawn: async () => { providerCalls += 1; throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, new LiveIngressRegistry(), [adapter]);
	assert.equal(await edge.processOne(), true);
	assert.equal(providerCalls, 0);
	assert.equal(broker.releaseCalls, 3);
	assert.deepEqual(releaseFences, [
		"1:1:live_ingress_unavailable",
		"1:1:live_ingress_unavailable",
		"1:1:live_ingress_unavailable",
	]);
	assert.equal(store.get(value.id)?.status, "received");
	store.close();
});

test("pre-provider release stops retrying when the broker confirms a stale fence", async () => {
	const value = delivery({ deliveryTtlMs: 2_000 });
	let releaseAttempts = 0;
	const broker = fakeBroker(value, {
		releasePreProvider: async () => {
			releaseAttempts += 1;
			if (releaseAttempts === 1) throw new TypeError("fetch failed");
			throw new Error('broker 409: {"error":"stale_lease"}');
		},
	});
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { throw new Error("unexpected"); },
		resume: async () => { throw new Error("unexpected"); },
		spawn: async () => { throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, new LiveIngressRegistry(), [adapter]);
	assert.equal(await edge.processOne(), true);
	assert.equal(broker.releaseCalls, 2);
	assert.equal(store.get(value.id)?.status, "received");
	store.close();
});

test("pre-provider release is bounded by the absolute delivery deadline", async () => {
	const value = delivery({ deliveryTtlMs: 150 });
	const broker = fakeBroker(value, {
		releasePreProvider: async () => new Promise(() => undefined),
	});
	let providerCalls = 0;
	const adapter: ProviderAdapter = {
		provider: "codex",
		deliverLive: async () => { providerCalls += 1; throw new Error("unexpected"); },
		resume: async () => { providerCalls += 1; throw new Error("unexpected"); },
		spawn: async () => { providerCalls += 1; throw new Error("unexpected"); },
	};
	const store = new EdgeStore(":memory:");
	const edge = new EdgeService(broker.client, store, new LiveIngressRegistry(), [adapter]);
	const startedAt = Date.now();
	assert.equal(await edge.processOne(), true);
	const elapsed = Date.now() - startedAt;
	assert.ok(elapsed >= 75);
	assert.ok(elapsed < 500);
	assert.equal(providerCalls, 0);
	assert.equal(broker.releaseCalls, 1);
	assert.equal(store.get(value.id)?.status, "received");
	store.close();
});
