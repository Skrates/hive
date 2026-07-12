import assert from "node:assert/strict";
import test from "node:test";
import { BrokerStore, InvalidTransitionError, StaleLeaseError } from "./store.js";
import type { SlackEventInput, SubscriptionInput } from "../domain.js";
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
  const second = store.claimNext("dev", 0);
  assert.equal(second?.leaseGeneration, 2);
  assert.throws(
    () => store.transition(first.id, "mac", first.leaseGeneration!, "dispatching", "dispatched"),
    StaleLeaseError,
  );
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
  store.finish(first.id, "mac", 1, "processed", []);
  store.ingestEvent(event({ eventId: "Ev2", messageTs: "101.1", threadTs: "101.0" }));
  const second = store.claimNext("mac", 0)!;
  store.transition(second.id, "mac", 1, "claimed", "accepted_local");
  store.transition(second.id, "mac", 1, "accepted_local", "dispatching");
  assert.equal(store.reserveSpawn(second.id, "mac", 1), false);
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
