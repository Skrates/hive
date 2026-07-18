import assert from "node:assert/strict";
import test from "node:test";
import { BindingBusyError, BrokerStore, InvalidTransitionError, StaleLeaseError } from "./store.js";
import {
	BindingUpdateSchema,
	SubscriptionInputSchema,
	type SlackEventInput,
	type SubscriptionInput,
} from "../domain.js";
import type { Clock } from "../time.js";

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

function event(overrides: Partial<SlackEventInput> = {}): SlackEventInput {
  return {
    eventId: "Ev1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | test",
    raw: { type: "message" },
    receivedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function subscription(overrides: Partial<SubscriptionInput> = {}): SubscriptionInput {
  return {
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0-alpha.4",
    sessionId: "thread-1",
    homeEdge: "mac",
    workspace: "taxis",
    edgeWorkspaces: [
      { edgeId: "mac", cwd: "/work/taxis", worktree: null },
      { edgeId: "dev", cwd: "/srv/taxis", worktree: null },
    ],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 5_000,
    homeGraceMs: 2_000,
    spawnRateLimit: 1,
    expiresAt: null,
    ...overrides,
  };
}

function fixture(overrides: Partial<SubscriptionInput> = {}) {
  const clock = new FakeClock(new Date("2026-07-12T00:00:00.000Z"));
  const store = new BrokerStore(":memory:", clock);
  const macToken = store.createEdge("mac");
  const devToken = store.createEdge("dev");
  store.upsertSubscription(subscription(overrides));
  return { store, clock, macToken, devToken };
}

test("event ingestion is idempotent and produces one delivery", () => {
  const { store } = fixture();
  assert.deepEqual(store.ingestEvent(event()), { created: true, deliveryId: 1 });
  assert.deepEqual(store.ingestEvent(event()), { created: false, deliveryId: null });
  assert.equal(store.listDeliveries().length, 1);
  store.close();
});

test("provisioning rejects lease timings that cannot be heartbeated safely", () => {
	assert.throws(() => SubscriptionInputSchema.parse(subscription({ leaseTtlMs: 10 })), />=1000/);
	assert.throws(
		() => SubscriptionInputSchema.parse(subscription({ leaseTtlMs: 5_000, deliveryTtlMs: 4_000 })),
		/must be at least leaseTtlMs/,
	);
});

test("binding updates preserve wake, permission, and workspace authority", () => {
	const { store } = fixture();
	const before = store.getSubscription("ariadne")!;
	const updated = store.updateBinding("ariadne", {
		sessionId: "thread-2",
		providerSurface: "app-server-control",
		providerVersion: "0.145.0",
	});
	assert.equal(updated.sessionId, "thread-2");
	assert.equal(updated.providerSurface, "app-server-control");
	assert.equal(updated.providerVersion, "0.145.0");
	assert.equal(updated.wakePolicy, before.wakePolicy);
	assert.equal(updated.permissionProfile, before.permissionProfile);
	assert.deepEqual(updated.edgeWorkspaces, before.edgeWorkspaces);
	assert.equal(updated.homeEdge, before.homeEdge);
	assert.equal(updated.provider, before.provider);
	assert.throws(() => BindingUpdateSchema.parse({ homeEdge: "unmapped" }), /at least one field/);
	store.close();
});

test("home-edge binding exposes permission authority and its exact mapped cwd", () => {
	const { store } = fixture({ permissionProfile: "workspace-write" });
	const binding = store.subscriptionBindingForHomeEdge("ariadne", "mac");
	const target = store.autoBindingTargetForHomeEdge("ariadne", "mac");
	assert.equal(binding?.permissionProfile, "workspace-write");
	assert.equal(target?.permissionProfile, "workspace-write");
	assert.equal(target?.edgeCwd, "/work/taxis");
	assert.equal(store.subscriptionBindingForHomeEdge("ariadne", "dev"), null);
	store.close();
});

test("a pre-dispatch rebind increments its ABA fence, clears presence, and requeues safely", () => {
	const { store } = fixture({ wakePolicy: "live_only" });
	const before = store.getSubscription("ariadne")!;
	store.reportLivePresence("mac", {
		actor: "ariadne",
		provider: "codex",
		providerSurface: before.providerSurface,
		providerVersion: before.providerVersion,
		sessionId: before.sessionId,
		bindingRevision: before.bindingRevision,
		transport: "app-server",
		ownerLoaded: true,
		reason: null,
		ttlMs: 30_000,
	});
	store.ingestEvent(event());
	const claimed = store.claimNext("mac", 0)!;
	store.transition(claimed.id, "mac", claimed.leaseGeneration!, "claimed", "accepted_local");

	const rebound = store.updateBinding("ariadne", { sessionId: "thread-2" });

	assert.equal(rebound.bindingRevision, before.bindingRevision + 1);
	assert.equal(rebound.bindingMode, "pinned");
	assert.equal(rebound.bindingSource, "operator");
	assert.equal(store.getLivePresence("ariadne"), null);
	assert.equal(store.getDelivery(claimed.id).status, "pending");
	assert.throws(
		() => store.transition(claimed.id, "mac", claimed.leaseGeneration!, "accepted_local", "dispatching"),
		StaleLeaseError,
	);
	store.close();
});

test("an in-flight or unresolved ambiguous delivery blocks rebinding until reconciliation", () => {
	const { store, clock } = fixture();
	store.ingestEvent(event());
	const claimed = store.claimNext("mac", 0)!;
	store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
	store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
	assert.throws(() => store.updateBinding("ariadne", { sessionId: "thread-2" }), BindingBusyError);

	clock.advance(1_001);
	assert.throws(() => store.updateBinding("ariadne", { sessionId: "thread-2" }), BindingBusyError);
	assert.equal(store.getDelivery(claimed.id).status, "ambiguous");
	store.reconcile(claimed.id, "processed", "provider transcript confirms the original binding completed");
	const rebound = store.updateBinding("ariadne", { sessionId: "thread-2" });
	assert.equal(rebound.sessionId, "thread-2");
	store.close();
});

test("auto binding is home-edge, exact-cwd, primary-thread, and revision fenced", () => {
	const { store } = fixture();
	const automatic = store.setBindingMode("ariadne", "auto");
	assert.equal(store.autoBindingTargetForHomeEdge("ariadne", "dev"), null);
	assert.throws(() => store.autoBindForHomeEdge("ariadne", "dev", {
		expectedBindingRevision: automatic.bindingRevision,
		sessionId: "thread-2",
		providerSurface: "codex-desktop-ipc",
		providerVersion: "desktop-ipc-v1",
		cwd: "/srv/taxis",
		threadSource: "user",
		parentThreadId: null,
	}), /auto_binding_not_home_edge/);
	assert.throws(() => store.autoBindForHomeEdge("ariadne", "mac", {
		expectedBindingRevision: automatic.bindingRevision,
		sessionId: "thread-2",
		providerSurface: "codex-desktop-ipc",
		providerVersion: "desktop-ipc-v1",
		cwd: "/wrong",
		threadSource: "user",
		parentThreadId: null,
	}), /auto_binding_cwd_mismatch/);
	const rebound = store.autoBindForHomeEdge("ariadne", "mac", {
		expectedBindingRevision: automatic.bindingRevision,
		sessionId: "thread-2",
		providerSurface: "codex-desktop-ipc",
		providerVersion: "desktop-ipc-v1",
		cwd: "/work/taxis",
		threadSource: "user",
		parentThreadId: null,
	});
	assert.equal(rebound.bindingRevision, automatic.bindingRevision + 1);
	assert.equal(rebound.bindingSource, "edge-discovery");
	assert.throws(() => store.autoBindForHomeEdge("ariadne", "mac", {
		expectedBindingRevision: automatic.bindingRevision,
		sessionId: "thread-3",
		providerSurface: "codex-desktop-ipc",
		providerVersion: "desktop-ipc-v1",
		cwd: "/work/taxis",
		threadSource: "user",
		parentThreadId: null,
	}), /auto_binding_stale_revision/);
	const pinned = store.updateBinding("ariadne", { sessionId: "thread-pinned" });
	assert.equal(pinned.bindingMode, "pinned");
	assert.throws(() => store.autoBindForHomeEdge("ariadne", "mac", {
		expectedBindingRevision: pinned.bindingRevision,
		sessionId: "thread-4",
		providerSurface: "codex-desktop-ipc",
		providerVersion: "desktop-ipc-v1",
		cwd: "/work/taxis",
		threadSource: "user",
		parentThreadId: null,
	}), /auto_binding_not_enabled/);
	store.close();
});

test("operator status reports stale edges and attention without exposing Slack bodies", () => {
	const { store, macToken } = fixture({ wakePolicy: "resume", sessionId: null });
	store.ingestEvent(event({ text: "WAKE: ariadne | super secret payload" }));
	let status = store.operatorStatus(60_000);
	assert.equal(status.edges.find((edge) => edge.edgeId === "mac")?.connected, false);
	assert.deepEqual(status.actors[0]?.warnings, ["home_edge_stale", "resume_session_missing"]);
	assert.doesNotMatch(JSON.stringify(status), /super secret payload/);

	assert.equal(store.authenticateEdge("mac", macToken), true);
	status = store.operatorStatus(60_000);
	assert.equal(status.edges.find((edge) => edge.edgeId === "mac")?.connected, true);
	assert.deepEqual(status.actors[0]?.warnings, ["resume_session_missing"]);
	assert.equal(status.deliveryCounts.pending, 1);
	store.close();
});

test("a renewed Claude channel presence is healthy at its exact binding revision", () => {
	const { store, macToken } = fixture({
		provider: "claude",
		providerSurface: "claude-channel",
		providerVersion: "1.0.0",
		wakePolicy: "live_only",
	});
	assert.equal(store.authenticateEdge("mac", macToken), true);
	const current = store.getSubscription("ariadne")!;
	store.reportLivePresence("mac", {
		actor: "ariadne",
		provider: "claude",
		providerSurface: "claude-channel",
		providerVersion: "1.0.0",
		sessionId: "thread-1",
		bindingRevision: current.bindingRevision,
		transport: "claude-channel",
		ownerLoaded: true,
		reason: null,
		ttlMs: 30_000,
	});
	const actor = store.operatorStatus().actors[0]!;
	assert.equal(actor.livePresence?.transport, "claude-channel");
	assert.equal(actor.livePresence?.bindingRevision, current.bindingRevision);
	assert.equal(actor.warnings.includes("live_surface_stale_or_missing"), false);
	store.close();
});

test("operator summaries never expose failing-provider details or unclassified reason content", () => {
	const { store, macToken } = fixture({ wakePolicy: "live_only" });
	assert.equal(store.authenticateEdge("mac", macToken), true);
	store.ingestEvent(event({ text: "WAKE: ariadne | prompt-body-secret" }));
	const claimed = store.claimNext("mac", 0)!;
	store.finish(claimed.id, "mac", claimed.leaseGeneration!, "undeliverable", [
		{
			code: "provider_dispatch_unknown",
			detail: "callback echoed prompt-body-secret and bearer-secret-value",
		},
		{
			code: "bad code containing bearer-secret-value",
			detail: "another provider body",
		},
	]);
	const status = store.operatorStatus();
	const encoded = JSON.stringify(status);
	assert.doesNotMatch(encoded, /prompt-body-secret|bearer-secret-value|another provider body/);
	assert.deepEqual(status.recentDeliveries[0]?.reasons, [
		{ code: "provider_dispatch_unknown" },
		{ code: "unclassified_reason" },
	]);
	assert.deepEqual(store.listDeliveryOperatorSummaries()[0]?.reasons, [
		{ code: "provider_dispatch_unknown" },
		{ code: "unclassified_reason" },
	]);
	store.close();
});

test("operator queries stay bounded and payload-free across a hostile append-only ledger", () => {
	const { store } = fixture();
	store.upsertSubscription(subscription({ actor: "fable", sessionId: "claude-current" }));
	const current = store.getSubscription("ariadne")!;
	const historicalBinding = {
		...current,
		sessionId: null,
		providerSurface: "codex-desktop-ipc",
		providerVersion: "desktop-ipc-v1",
		permissionProfile: "workspace-write" as const,
		bindingRevision: 7,
	};
	const insertEvent = store.db.prepare(`
		INSERT INTO slack_events(
			event_id, workspace_id, channel_id, thread_ts, message_ts, sender_id,
			sender_kind, actor, text, raw_json, received_at
		) VALUES (?, 'T1', 'C1', ?, ?, 'U1', 'user', ?, ?, ?, ?)
	`);
	const insertDelivery = store.db.prepare(`
		INSERT INTO deliveries(
			event_id, actor, status, reasons_json, coalesce_key, initial_snapshot_json,
			subscription_snapshot_json, created_at, updated_at
		) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)
	`);
	const insertDeliveryEvent = store.db.prepare(`
		INSERT INTO delivery_events(delivery_id, event_id, relation) VALUES (?, ?, 'primary')
	`);
	store.db.transaction(() => {
		for (let index = 0; index < 1_200; index += 1) {
			for (const actor of ["ariadne", "fable"]) {
				const eventId = `hostile-${index}-${actor}`;
				const minute = String(Math.floor(index / 60) % 60).padStart(2, "0");
				const second = String(index % 60).padStart(2, "0");
				const timestamp = `2026-07-12T00:${minute}:${second}.000Z`;
				insertEvent.run(
					eventId,
					`thread-${index}`,
					`message-${index}`,
					actor,
					`SECRET Slack body ${index}`,
					"{ deliberately malformed Slack raw JSON",
					timestamp,
				);
				const snapshot = actor === "ariadne" && index === 1_199
					? JSON.stringify(historicalBinding)
					: null;
				const result = insertDelivery.run(
					eventId,
					actor,
					index % 2 === 0 ? "pending" : "processed",
					`${actor}:${index}`,
					"{ deliberately malformed replay snapshot",
					snapshot,
					timestamp,
					timestamp,
				);
				insertDeliveryEvent.run(Number(result.lastInsertRowid), eventId);
			}
		}
	})();

	store.listDeliveries = () => {
		throw new Error("operator query walked the delivery ledger");
	};
	store.getDelivery = () => {
		throw new Error("operator query parsed a Slack payload");
	};

	const status = store.operatorStatus();
	assert.equal(status.deliveryCounts.pending, 1_200);
	assert.equal(status.deliveryCounts.processed, 1_200);
	assert.equal(status.recentDeliveries.length, 20);
	assert.deepEqual(status.recentDeliveries.map((delivery) => delivery.id),
		Array.from({ length: 20 }, (_, offset) => 2_400 - offset));
	const ariadneStatus = status.actors.find((item) => item.subscription.actor === "ariadne")!;
	const fableStatus = status.actors.find((item) => item.subscription.actor === "fable")!;
	assert.equal(ariadneStatus.deliveryCounts.pending, 600);
	assert.equal(fableStatus.deliveryCounts.processed, 600);
	assert.equal(ariadneStatus.latestDelivery?.binding.sessionId, null);
	assert.equal(ariadneStatus.latestDelivery?.binding.revision, 7);
	assert.equal(fableStatus.latestDelivery?.binding.sessionId, "claude-current");
	assert.doesNotMatch(JSON.stringify(status), /SECRET Slack body|malformed Slack raw|malformed replay/);

	const ariadne = store.operatorStatus(60_000, "ariadne");
	assert.equal(ariadne.actors.length, 1);
	assert.equal(ariadne.deliveryCounts.pending, 600);
	assert.equal(ariadne.deliveryCounts.processed, 600);
	assert.equal(ariadne.recentDeliveries.length, 20);
	assert.ok(ariadne.recentDeliveries.every((delivery) => delivery.actor === "ariadne"));

	const filtered = store.listDeliveryOperatorSummaries({
		actor: "ariadne",
		status: "processed",
		limit: 9_999,
	});
	assert.equal(filtered.length, 500);
	assert.ok(filtered.every((delivery) => delivery.actor === "ariadne" && delivery.status === "processed"));
	assert.ok(filtered.every((delivery, index) => index === 0 || filtered[index - 1]!.id > delivery.id));
	assert.equal(filtered[0]?.binding.sessionId, null);
	assert.equal(filtered[0]?.binding.revision, 7);
	store.close();
});

test("a burst in one actor thread coalesces into one pending delivery", () => {
  const { store } = fixture();
  assert.equal(store.ingestEvent(event()).deliveryId, 1);
  assert.equal(store.ingestEvent(event({ eventId: "Ev2", messageTs: "100.3" })).deliveryId, 1);
  assert.equal(store.listDeliveries().length, 1);
  assert.deepEqual(store.getDelivery(1).coalescedEventIds, ["Ev1", "Ev2"]);
  store.close();
});

test("an unmapped or foreign edge skips work without disposing it", () => {
  const { store } = fixture({ wakePolicy: "live_only" });
  store.createEdge("other");
  store.ingestEvent(event());
  assert.equal(store.claimNext("other", 0), null);
  assert.equal(store.claimNext("dev", 0), null);
  assert.equal(store.getDelivery(1).status, "pending");
  assert.equal(store.claimNext("mac", 0)?.claimedBy, "mac");
  store.close();
});

test("pending delivery expires at its configured TTL", () => {
  const { store, clock } = fixture({ wakePolicy: "resume", sessionId: "thread-1", deliveryTtlMs: 100 });
  store.ingestEvent(event());
  clock.advance(101);
  assert.equal(store.claimNext("mac", 0), null);
  const expired = store.getDelivery(1);
  assert.equal(expired.status, "undeliverable");
  assert.equal(expired.reasons[0]?.code, "delivery_ttl_expired");
  store.close();
});

test("bounded maintenance terminalizes stale pending work and alerts without an edge poll", () => {
	const { store, clock } = fixture();
	store.upsertSubscription(subscription({
		actor: "fable",
		deliveryTtlMs: 30_000,
		expiresAt: "2026-07-12T00:00:02.000Z",
	}));
	store.ingestEvent(event({ text: "WAKE: ariadne | ttl secret" }));
	store.ingestEvent(event({
		eventId: "Ev-fable",
		actor: "fable",
		messageTs: "101.1",
		threadTs: "101.0",
		text: "WAKE: fable | authority secret",
	}));
	clock.advance(5_001);

	const swept = store.sweepExpiredDeliveries(10);
	assert.deepEqual(swept, { terminalizedPending: 2, requeuedPreDispatch: 0, ambiguous: 0 });
	assert.equal(store.getDelivery(1).reasons[0]?.code, "delivery_ttl_expired");
	assert.equal(store.getDelivery(2).reasons[0]?.code, "subscription_expired");
	assert.equal(store.operatorStatus().deliveryCounts.undeliverable, 2);
	const firstAlert = store.claimOutbox()!;
	store.completeOutbox(firstAlert.id, firstAlert.claimToken, "sent", { slackTs: "102.1" });
	const secondAlert = store.claimOutbox()!;
	assert.equal(firstAlert.kind, "operator_alert");
	assert.equal(secondAlert.kind, "operator_alert");
	assert.match(firstAlert.text, /No agent was dispatched/);
	assert.match(secondAlert.text, /No agent was dispatched/);
	assert.doesNotMatch(`${firstAlert.text}${secondAlert.text}`, /ttl secret|authority secret/);
	store.close();
});

test("spawn waits for home grace before a foreign mapped edge may claim", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  assert.equal(store.claimNext("dev", 0), null);
  clock.advance(2_001);
  const claimed = store.claimNext("dev", 0);
  assert.equal(claimed?.claimedBy, "dev");
  assert.equal(claimed?.leaseGeneration, 1);
  store.close();
});

test("a reserved foreign-edge spawn is audited but cannot promote the home binding", () => {
	const { store, clock } = fixture({ sessionId: null });
	store.ingestEvent(event());
	clock.advance(2_001);
	const claimed = store.claimNext("dev", 0)!;
	store.transition(claimed.id, "dev", 1, "claimed", "accepted_local");
	store.transition(claimed.id, "dev", 1, "accepted_local", "dispatching");
	assert.equal(store.reserveSpawn(claimed.id, "dev", 1), true);
	store.transition(claimed.id, "dev", 1, "dispatching", "dispatched");

	const finished = store.finish(
		claimed.id,
		"dev",
		1,
		"processed",
		[],
		"foreign spawn receipt",
		"foreign-session-1",
	);

	assert.equal(finished.status, "processed");
	assert.equal(finished.spawnedSessionId, "foreign-session-1");
	assert.equal(finished.spawnedOnEdge, "dev");
	assert.equal(store.getSubscription("ariadne")?.sessionId, null);
	store.close();
});

test("a cursor past a home-grace-skipped delivery still revisits the older id", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  assert.equal(store.claimNext("dev", 0), null);
  clock.advance(2_001);
  const claimed = store.claimNext("dev", 99);
  assert.equal(claimed?.id, 1);
  assert.equal(claimed?.claimedBy, "dev");
  store.close();
});

test("resume never escalates to a foreign edge", () => {
  const { store, clock } = fixture({ wakePolicy: "resume" });
  store.ingestEvent(event());
  clock.advance(2_001);
  assert.equal(store.claimNext("dev", 0), null);
  assert.equal(store.claimNext("mac", 0)?.claimedBy, "mac");
  store.close();
});

test("delivery transitions require the current fenced lease", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const first = store.claimNext("mac", 0)!;
  store.transition(first.id, "mac", first.leaseGeneration!, "claimed", "accepted_local");
  store.transition(first.id, "mac", first.leaseGeneration!, "accepted_local", "dispatching");

  store.ingestEvent(event({ eventId: "Ev2", messageTs: "101.1" }));
  clock.advance(2_001);
	  store.markAmbiguousForExpiredDispatches();
	  store.reconcile(first.id, "processed", "provider transcript confirms delivery one completed");
	  const second = store.claimNext("dev", 0);
  assert.equal(second?.leaseGeneration, 2);
  assert.throws(
    () => store.transition(first.id, "mac", first.leaseGeneration!, "dispatching", "dispatched"),
    StaleLeaseError,
  );
  store.close();
});

test("expired pre-dispatch claim is safely requeued with a new fence", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const first = store.claimNext("mac", 0)!;
  store.transition(first.id, "mac", 1, "claimed", "accepted_local");
  clock.advance(2_001);
  store.markAmbiguousForExpiredDispatches();
  assert.equal(store.getDelivery(first.id).status, "pending");
  const second = store.claimNext("dev", 0)!;
  assert.equal(second.leaseGeneration, 2);
  assert.equal(second.claimedBy, "dev");
  store.close();
});

test("expired dispatching lease becomes ambiguous rather than redelivered", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "accepted_local", "dispatching");
  clock.advance(1_001);
  assert.equal(store.markAmbiguousForExpiredDispatches(), 1);
  const delivery = store.getDelivery(claimed.id);
  assert.equal(delivery.status, "ambiguous");
  assert.equal(delivery.reasons[0]?.code, "dispatch_outcome_unknown");
  assert.equal(store.claimNext("dev", 0), null);
  store.close();
});

test("live dispatch awaiting acknowledgement becomes ambiguous when its lease expires", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.transition(claimed.id, "mac", 1, "dispatching", "dispatched");
  clock.advance(1_001);
  assert.equal(store.markAmbiguousForExpiredDispatches(), 1);
  assert.equal(store.getDelivery(claimed.id).status, "ambiguous");
  store.close();
});

test("lease renewal preserves the fence during a long provider dispatch", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "accepted_local", "dispatching");
  clock.advance(800);
  store.renewDeliveryLease(claimed.id, "mac", claimed.leaseGeneration!);
  clock.advance(800);
  assert.equal(store.markAmbiguousForExpiredDispatches(), 0);
  assert.equal(store.getDelivery(claimed.id).status, "dispatching");
  store.close();
});

test("spawn reservations enforce the per-actor minute window", () => {
  const { store } = fixture({ sessionId: null, spawnRateLimit: 1 });
  store.ingestEvent(event());
  const first = store.claimNext("mac", 0)!;
  store.transition(first.id, "mac", 1, "claimed", "accepted_local");
  store.transition(first.id, "mac", 1, "accepted_local", "dispatching");
  assert.equal(store.reserveSpawn(first.id, "mac", 1), true);
  assert.equal(store.reserveSpawn(first.id, "mac", 1), true);
	store.finish(first.id, "mac", 1, "processed", [], "spawn receipt", "spawned-session-1");
	assert.equal(store.getSubscription("ariadne")?.sessionId, "spawned-session-1");
  store.ingestEvent(event({ eventId: "Ev2", messageTs: "101.1", threadTs: "101.0" }));
  const second = store.claimNext("mac", 0)!;
  store.transition(second.id, "mac", 1, "claimed", "accepted_local");
  store.transition(second.id, "mac", 1, "accepted_local", "dispatching");
  assert.equal(store.reserveSpawn(second.id, "mac", 1), false);
  store.close();
});

test("an unreserved spawned session result cannot bind or complete", () => {
	const { store } = fixture({ sessionId: null });
	store.ingestEvent(event());
	const claimed = store.claimNext("mac", 0)!;
	store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
	store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
	store.transition(claimed.id, "mac", 1, "dispatching", "dispatched");

	assert.throws(
		() => store.finish(claimed.id, "mac", 1, "processed", [], "receipt", "unreserved-session"),
		/spawn reservation/,
	);
	assert.equal(store.getSubscription("ariadne")?.sessionId, null);
	assert.equal(store.getDelivery(claimed.id).status, "dispatched");
	assert.equal(store.getDelivery(claimed.id).spawnedSessionId, null);
	store.finish(claimed.id, "mac", 1, "ambiguous", [{
		code: "spawn_session_unconfirmed",
		detail: "provider contacted without a durable spawn reservation",
	}]);
	store.close();
});

test("a reserved spawn needs one session id and the exact claimed authority tuple", () => {
	const { store } = fixture({ sessionId: null });
	store.ingestEvent(event());
	const claimed = store.claimNext("mac", 0)!;
	store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
	store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
	assert.equal(store.reserveSpawn(claimed.id, "mac", 1), true);
	store.transition(claimed.id, "mac", 1, "dispatching", "dispatched");
	assert.throws(
		() => store.finish(claimed.id, "mac", 1, "processed", [], "receipt"),
		/unambiguous session id/,
	);

	store.db.prepare("UPDATE subscriptions SET provider_version='hostile-change' WHERE actor='ariadne'").run();
	assert.throws(
		() => store.finish(claimed.id, "mac", 1, "processed", [], "receipt", "spawned-session-1"),
		/authority changed/,
	);
	assert.equal(store.getSubscription("ariadne")?.sessionId, null);
	assert.equal(store.getDelivery(claimed.id).status, "dispatched");
	store.finish(claimed.id, "mac", 1, "ambiguous", [{
		code: "spawn_session_unconfirmed",
		detail: "spawn authority could not be proven",
	}]);
	store.ingestEvent(event({ eventId: "Ev2", messageTs: "101.1", threadTs: "101.0" }));
	assert.equal(store.claimNext("mac", 0), null);
	assert.equal(store.operatorStatus().deliveryCounts.ambiguous, 1);
	const ambiguous = store.operatorStatus().recentDeliveries.find((delivery) => delivery.status === "ambiguous");
	assert.equal(ambiguous?.reasons[0]?.code, "spawn_session_unconfirmed");
	store.close();
});

test("a requeued spawn reservation cannot poison a later bound resume attempt", () => {
	const { store } = fixture({ sessionId: null });
	store.ingestEvent(event());
	const spawned = store.claimNext("mac", 0)!;
	store.transition(spawned.id, "mac", 1, "claimed", "accepted_local");
	store.transition(spawned.id, "mac", 1, "accepted_local", "dispatching");
	assert.equal(store.reserveSpawn(spawned.id, "mac", 1), true);
	store.transition(spawned.id, "mac", 1, "dispatching", "dispatched");
	store.finish(spawned.id, "mac", 1, "ambiguous", [{
		code: "provider_dispatch_unknown",
		detail: "post-spawn control failed",
	}], null, "observed-orphan-session");
	assert.equal(store.getDelivery(spawned.id).spawnedSessionId, "observed-orphan-session");
	assert.equal(store.getSubscription("ariadne")?.sessionId, null);

	store.reconcile(spawned.id, "requeue", "operator recovered and selected the resumable session");
	assert.equal(
		Number((store.db.prepare("SELECT COUNT(*) AS count FROM spawn_reservations").get() as { count: number }).count),
		0,
	);
	store.updateBinding("ariadne", { sessionId: "operator-bound-session" });
	const resumed = store.claimNext("mac", 0)!;
	assert.ok((resumed.leaseGeneration ?? 0) > 1);
	assert.equal(resumed.subscription.sessionId, "operator-bound-session");
	const generation = resumed.leaseGeneration!;
	store.transition(resumed.id, "mac", generation, "claimed", "accepted_local");
	store.transition(resumed.id, "mac", generation, "accepted_local", "dispatching");
	store.transition(resumed.id, "mac", generation, "dispatching", "dispatched");
	const finished = store.finish(resumed.id, "mac", generation, "processed", [], "resume receipt");
	assert.equal(finished.status, "processed");
	assert.equal(finished.spawnedSessionId, null);
	assert.equal(store.getSubscription("ariadne")?.sessionId, "operator-bound-session");
	store.close();
});

test("ambiguous delivery requires explicit processed or requeue reconciliation", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "accepted_local", "dispatching");
  clock.advance(1_001);
  store.markAmbiguousForExpiredDispatches();
  assert.equal(store.reconcile(claimed.id, "requeue", "provider transcript showed no injection").status, "pending");
  const reclaimed = store.claimNext("mac", 0)!;
  assert.equal(reclaimed.leaseGeneration, 2);
  store.transition(reclaimed.id, "mac", 2, "claimed", "accepted_local");
  store.transition(reclaimed.id, "mac", 2, "accepted_local", "dispatching");
  clock.advance(1_001);
  store.markAmbiguousForExpiredDispatches();
  const processed = store.reconcile(reclaimed.id, "processed", "provider transcript contained the wake");
  assert.equal(processed.status, "processed");
  assert.equal(processed.reasons[0]?.code, "operator_reconciled_processed");
  store.close();
});

test("operator requeue invalidates a live lease before same-edge reclaim", () => {
	const { store } = fixture();
	store.ingestEvent(event());
	const first = store.claimNext("mac", 0)!;
	const firstGeneration = first.leaseGeneration!;
	store.transition(first.id, "mac", firstGeneration, "claimed", "accepted_local");
	store.transition(first.id, "mac", firstGeneration, "accepted_local", "dispatching");
	store.finish(first.id, "mac", firstGeneration, "ambiguous", [{
		code: "provider_dispatch_unknown",
		detail: "operator must reconcile while the lease is still live",
	}]);

	store.reconcile(first.id, "requeue", "provider transcript proves the wake was not accepted");
	assert.throws(
		() => store.transition(first.id, "mac", firstGeneration, "claimed", "accepted_local"),
		StaleLeaseError,
	);
	const reclaimed = store.claimNext("mac", 0)!;
	const nextGeneration = reclaimed.leaseGeneration!;
	assert.ok(nextGeneration > firstGeneration);
	assert.throws(
		() => store.transition(first.id, "mac", firstGeneration, "claimed", "accepted_local"),
		StaleLeaseError,
	);
	assert.throws(
		() => store.finish(first.id, "mac", firstGeneration, "ambiguous", [{
			code: "provider_dispatch_unknown",
			detail: "delayed attempt-one result",
		}]),
		StaleLeaseError,
	);
	store.transition(first.id, "mac", nextGeneration, "claimed", "accepted_local");
	store.finish(first.id, "mac", nextGeneration, "undeliverable", [{
		code: "provider_unavailable",
		detail: "test cleanup",
	}]);
	store.close();
});

test("a cursor past an operator-requeued delivery still claims the older id", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const first = store.claimNext("mac", 0)!;
  store.transition(first.id, "mac", 1, "claimed", "accepted_local");
  store.transition(first.id, "mac", 1, "accepted_local", "dispatching");
  clock.advance(1_001);
  store.markAmbiguousForExpiredDispatches();
  store.reconcile(first.id, "requeue", "provider did not accept the wake");

  const reclaimed = store.claimNext("mac", first.id + 10);

  assert.equal(reclaimed?.id, first.id);
  assert.equal(reclaimed?.leaseGeneration, 2);
  store.close();
});

test("terminal and out-of-order transitions fail closed", () => {
  const { store } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  assert.throws(
    () => store.transition(claimed.id, "mac", claimed.leaseGeneration!, "accepted_local", "dispatching"),
    InvalidTransitionError,
  );
  store.finish(claimed.id, "mac", claimed.leaseGeneration!, "undeliverable", [
    { code: "provider_unavailable", detail: "test" },
  ]);
  assert.throws(
    () => store.finish(claimed.id, "mac", claimed.leaseGeneration!, "processed", []),
    InvalidTransitionError,
  );
  store.close();
});
