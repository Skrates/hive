import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReplaySnapshot, SlackEventInput, SubscriptionInput } from "../domain.js";
import type { Clock } from "../time.js";
import { BrokerService, SlackSendError, type SlackTransport } from "./service.js";
import { BrokerStore, InvalidTransitionError } from "./store.js";

class FakeClock implements Clock {
	constructor(private value = new Date("2026-07-18T00:00:00.000Z")) {}
	now(): Date { return new Date(this.value); }
	advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

function subscription(): SubscriptionInput {
	return {
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
		leaseTtlMs: 30_000,
		deliveryTtlMs: 300_000,
		homeGraceMs: 0,
		spawnRateLimit: 1,
		expiresAt: null,
	};
}

function event(overrides: Partial<SlackEventInput> = {}): SlackEventInput {
	return {
		eventId: "Ev-outbox-1",
		workspaceId: "T1",
		channelId: "C12345678",
		threadTs: "100.1",
		messageTs: "100.2",
		senderId: "U1",
		senderKind: "user",
		actor: "ariadne",
		text: "WAKE: ariadne | test",
		raw: { type: "message" },
		receivedAt: "2026-07-18T00:00:00.000Z",
		...overrides,
	};
}

function preparedStore(clock: Clock = new FakeClock()): { store: BrokerStore; generation: number } {
	const store = new BrokerStore(":memory:", clock);
	store.createEdge("mac");
	store.upsertSubscription(subscription());
	store.ingestEvent(event());
	const claimed = store.claimNext("mac", 0)!;
	return { store, generation: claimed.leaseGeneration! };
}

const replay = async (channelId: string, threadTs: string): Promise<ReplaySnapshot> => ({
	channelId,
	threadTs,
	fetchedAt: new Date().toISOString(),
	cursor: null,
	messages: [],
});

test("unroutable ingress and its diagnostic outbox commit once in one transaction", () => {
	const store = new BrokerStore(":memory:");
	assert.deepEqual(store.ingestEvent(event({ actor: "missing" })), { created: true, deliveryId: null });
	assert.deepEqual(store.ingestEvent(event({ actor: "missing" })), { created: false, deliveryId: null });
	assert.equal(store.listIngressDiagnostics().length, 1);
	assert.deepEqual(store.outboxCounts(), { pending: 1, sending: 0, sent: 0, ambiguous: 0, dead: 0 });
	assert.equal(store.listOutboxOperatorSummaries()[0]?.kind, "ingress_diagnostic");
	store.close();
});

test("a failed diagnostic outbox insert rolls back the Slack event and diagnostic", () => {
	const store = new BrokerStore(":memory:");
	store.db.exec(`
		CREATE TRIGGER fail_diagnostic_outbox BEFORE INSERT ON slack_outbox
		WHEN NEW.kind='ingress_diagnostic' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
	`);
	assert.throws(() => store.ingestEvent(event({ actor: "missing" })), /forced failure/);
	assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM slack_events").get() as { count: number }).count, 0);
	assert.equal(store.listIngressDiagnostics().length, 0);
	assert.equal(store.listOutboxOperatorSummaries().length, 0);
	store.close();
});

test("terminal result is idempotent and atomically selects one allowlisted assistant completion", () => {
	const { store, generation } = preparedStore();
	store.setEgressPolicy("ariadne", { policy: "assistant_text", channelIds: ["C12345678"] });
	const receipt = JSON.stringify({
		type: "item.completed",
		item: { type: "agent_message", text: "WAKE: ariadne\n<@U12345678> & done" },
	});
	const first = store.finish(1, "mac", generation, "processed", [], receipt);
	const repeated = store.finish(1, "mac", generation, "processed", [], receipt);
	assert.equal(first.status, "processed");
	assert.equal(repeated.status, "processed");
	assert.throws(
		() => store.finish(1, "mac", generation, "processed", [], `${receipt}conflict`),
		InvalidTransitionError,
	);
	assert.equal(store.outboxCounts().pending, 1);
	const claim = store.claimOutbox()!;
	assert.equal(store.claimOutbox(), null);
	assert.match(claim.text, /^Hive: ariadne completed delivery 1\.\n\nWAKE:/);
	assert.match(claim.text, /&lt;@U12345678&gt; &amp; done/);
	assert.equal(claim.metadata.outbox_key, "completion:1");
	assert.ok(claim.metadata.outbox_nonce);
	store.close();
});

test("a definitely rejected Slack post retries durably and sends once", async () => {
	const { store, generation } = preparedStore();
	store.finish(1, "mac", generation, "processed", [], null);
	let calls = 0;
	const slack: SlackTransport = {
		replay,
		async reply(): Promise<string> {
			calls += 1;
			if (calls === 1) throw new SlackSendError("definite_retryable", "slack_rate_limited", 0);
			return "101.2";
		},
	};
	const broker = new BrokerService(store, slack);
	assert.equal(await broker.drainOutbox(), 2);
	assert.equal(calls, 2);
	assert.deepEqual(store.outboxCounts(), { pending: 0, sending: 0, sent: 1, ambiguous: 0, dead: 0 });
	assert.equal(store.listOutboxOperatorSummaries()[0]?.attempts, 2);
	store.close();
});

test("restart reconciliation proves an accepted post without sending a duplicate", async () => {
	const clock = new FakeClock();
	const { store, generation } = preparedStore(clock);
	store.finish(1, "mac", generation, "processed", [], null);
	const abandoned = store.claimOutbox()!;
	clock.advance(30_001);
	let sends = 0;
	const slack: SlackTransport = {
		replay,
		async reply(): Promise<string> { sends += 1; return "duplicate"; },
		async findReply(_channel, _thread, metadata): Promise<string | null> {
			assert.equal(metadata.outbox_nonce, abandoned.metadata.outbox_nonce);
			return "101.2";
		},
	};
	const broker = new BrokerService(store, slack);
	assert.equal(await broker.drainOutbox(), 1);
	assert.equal(sends, 0);
	assert.equal(store.outboxCounts().sent, 1);
	store.close();
});

test("a hanging Slack call never blocks the committed delivery and becomes operator-visible", async () => {
	const { store, generation } = preparedStore();
	const slack: SlackTransport = {
		replay,
		reply: () => new Promise<string>(() => undefined),
		findReply: async () => null,
	};
	const broker = new BrokerService(store, slack, 20);
	const started = Date.now();
	const delivery = broker.finish(1, "mac", {
		generation,
		status: "processed",
		reasons: [],
		providerReceipt: null,
	});
	assert.equal(delivery.status, "processed");
	assert.ok(Date.now() - started < 20);
	await broker.drainOutbox();
	assert.equal(store.outboxCounts().ambiguous, 1);
	assert.doesNotMatch(JSON.stringify(store.operatorStatus()), /WAKE: ariadne \| test/);
	store.close();
});

test("operator outbox reconciliation audit persists without entering routine summaries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hive-outbox-audit-"));
	const path = join(directory, "broker.sqlite");
	try {
		const first = new BrokerStore(path);
		first.recordIngressDiagnostic(
			"Ev-diagnostic",
			"C12345678",
			"100.1",
			"malformed_explicit_envelope",
			"fixed diagnostic",
		);
		const claim = first.claimOutbox()!;
		first.completeOutbox(claim.id, claim.claimToken, "ambiguous", {
			errorCode: "slack_outbox_send_uncertain",
		});
		first.reconcileOutboxForOperator(claim.id, {
			disposition: "dead",
			detail: "inspected Slack audit log; external delivery could not be proven",
		});
		first.close();

		const reopened = new BrokerStore(path);
		const audit = reopened.listOutboxReconciliationAudit(claim.id);
		assert.equal(audit[0]?.detail, "inspected Slack audit log; external delivery could not be proven");
		assert.doesNotMatch(JSON.stringify(reopened.operatorStatus()), /inspected Slack audit log/);
		reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("broker maintenance marks expired in-flight work ambiguous without a live edge poller", async () => {
	const clock = new FakeClock();
	const { store, generation } = preparedStore(clock);
	store.transition(1, "mac", generation, "claimed", "accepted_local");
	store.transition(1, "mac", generation, "accepted_local", "dispatching");
	clock.advance(30_001);
	const broker = new BrokerService(store, { replay, async reply() { return "unused"; } });
	broker.startOutbox(60_000);
	assert.equal(store.getDelivery(1).status, "ambiguous");
	await broker.stopOutbox();
	store.close();
});
