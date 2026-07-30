import assert from "node:assert/strict";
import test from "node:test";
import type { BrokerOperatorStatus, DeliveryStatus } from "../domain.js";
import { formatOperatorDeliveries, formatOperatorStatus } from "./format.js";

const emptyCounts = (): Record<DeliveryStatus, number> => ({
	pending: 0,
	claimed: 0,
	accepted_local: 0,
	dispatching: 0,
	dispatched: 0,
	processed: 0,
	undeliverable: 0,
	ambiguous: 0,
	dead_letter: 0,
});

test("operator status makes binding, authority, and attention visible", () => {
	const counts = emptyCounts();
	counts.ambiguous = 1;
		const status: BrokerOperatorStatus = {
			generatedAt: "2026-07-18T00:01:00.000Z",
			staleAfterMs: 60_000,
			slack: { ready: true, socket: "connected", bot: "ready", updatedAt: "2026-07-18T00:00:59.000Z" },
		edges: [{
			edgeId: "mac",
			enabled: true,
			createdAt: "2026-07-18T00:00:00.000Z",
			lastSeenAt: "2026-07-18T00:00:55.000Z",
			connected: true,
		}],
		actors: [{
			subscription: {
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
				updatedAt: "2026-07-18T00:00:00.000Z",
				bindingMode: "pinned",
				bindingSource: "operator",
				bindingRevision: 1,
				egressPolicy: "receipt_only",
				egressChannelIds: [],
				listenChannelIds: ["C00000001"],
			},
			livePresence: null,
			lease: null,
			deliveryCounts: counts,
			latestDelivery: {
				id: 9,
				eventId: "Ev9",
				actor: "ariadne",
				status: "ambiguous",
				reasons: [{ code: "dispatch_outcome_unknown" }],
				leaseGeneration: 2,
				claimedBy: "mac",
					attempts: 2,
					binding: { sessionId: "thread-1", revision: 1, providerSurface: "app-server", providerVersion: "0.144.0", permissionProfile: "workspace-write" },
				channelId: "C1",
				threadTs: "100.1",
				messageTs: "100.2",
				createdAt: "2026-07-18T00:00:30.000Z",
				updatedAt: "2026-07-18T00:00:40.000Z",
			},
			warnings: ["ambiguous_delivery_requires_reconciliation"],
		}],
		deliveryCounts: counts,
		outboxCounts: { pending: 0, sending: 0, sent: 0, ambiguous: 0, dead: 0 },
		recentOutbox: [],
		recentDeliveries: [],
		recentIngressDiagnostics: [{
			id: 4,
			channelId: "C1",
			threadTs: "100.1",
			reason: "malformed_explicit_envelope",
			createdAt: "2026-07-18T00:00:30.000Z",
		}],
	};
	const rendered = formatOperatorStatus(status);
	assert.match(rendered, /READY\s+mac · seen 5s ago/);
	assert.match(rendered, /ATTENTION\s+ariadne · codex\/app-server 0\.144\.0/);
	assert.match(rendered, /permission workspace-write/);
	assert.match(rendered, /listen C00000001/);
	assert.match(rendered, /ambiguous_delivery_requires_reconciliation/);
	assert.match(rendered, /ambiguous=1/);
	assert.match(rendered, /malformed_explicit_envelope · channel C1 · thread 100\.1/);
});

test("delivery rendering shows operational metadata but not message bodies", () => {
	const rendered = formatOperatorDeliveries([{
		id: 2,
		eventId: "Ev2",
		actor: "fable",
		status: "processed",
		reasons: [],
		leaseGeneration: 1,
		claimedBy: "linux",
			attempts: 1,
			binding: { sessionId: "thread-f", revision: 2, providerSurface: "claude-cli", providerVersion: "test", permissionProfile: "read-only" },
		channelId: "C1",
		threadTs: "100.1",
		messageTs: "100.2",
		createdAt: "2026-07-18T00:00:00.000Z",
		updatedAt: "2026-07-18T00:00:01.000Z",
	}]);
		assert.equal(rendered, "  #2 processed     fable · attempts 1 · session thread-f rev 2\n");
});
