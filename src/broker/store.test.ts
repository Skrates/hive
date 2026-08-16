import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BrokerStore,
  DISPATCHED_OUTCOME_GRACE_MS,
  InvalidTransitionError,
  LegacyDatabaseError,
  StaleLeaseError,
} from "./store.js";
import { frameWakeInstruction, retryBackoffMs, SubscriptionInputSchema, type SlackEventInput, type SubscriptionInput } from "../domain.js";
import { peekDeliveryTraceparent, rememberDeliveryTraceparent, resetObservabilityForTests } from "../observability.js";
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
    accountProfile: "/home/user/.codex-hive",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 60_000,
    homeGraceMs: 2_000,
    spawnRateLimit: 1,
    maxAttempts: 3,
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

test("broker UUID is canonical, durable across opens, and unique per database", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-broker-uuid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const firstPath = join(directory, "first.sqlite");
  const secondPath = join(directory, "second.sqlite");

  const first = new BrokerStore(firstPath);
  const firstUuid = first.brokerUuid;
  assert.match(firstUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const sameDatabase = new BrokerStore(firstPath);
  assert.equal(sameDatabase.brokerUuid, firstUuid);
  const second = new BrokerStore(secondPath);
  assert.notEqual(second.brokerUuid, firstUuid);

  second.close();
  sameDatabase.close();
  first.close();
});

test("broker UUID migration upgrades an old database and metadata is immutable", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-broker-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "broker.sqlite");
  const old = new Database(path);
  old.exec("CREATE TABLE old_install_marker(value TEXT NOT NULL)");
  old.close();

  const upgraded = new BrokerStore(path);
  const uuid = upgraded.brokerUuid;
  assert.throws(
    () => upgraded.db.prepare("UPDATE broker_metadata SET broker_uuid = ? WHERE singleton = 1").run(uuid.toUpperCase()),
    /broker_metadata_immutable/,
  );
  assert.throws(
    () => upgraded.db.prepare("DELETE FROM broker_metadata WHERE singleton = 1").run(),
    /broker_metadata_immutable/,
  );
  assert.throws(
    () => upgraded.db.prepare(`
      INSERT OR REPLACE INTO broker_metadata(singleton, broker_uuid, created_at)
      VALUES (1, '22222222-2222-4222-8222-222222222222', '2026-08-02T00:00:00.000Z')
    `).run(),
    /broker_metadata_immutable/,
  );
  assert.equal(
    (upgraded.db.prepare("SELECT broker_uuid FROM broker_metadata WHERE singleton = 1").get() as { broker_uuid: string }).broker_uuid,
    uuid,
  );
  upgraded.close();

  const reopened = new BrokerStore(path);
  assert.equal(reopened.brokerUuid, uuid);
  reopened.close();
});

test("pre-existing noncanonical broker metadata fails closed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-broker-corrupt-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "broker.sqlite");
  const corrupt = new Database(path);
  corrupt.exec(`
    CREATE TABLE broker_metadata (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      broker_uuid TEXT NOT NULL UNIQUE CHECK(length(broker_uuid) = 36),
      created_at TEXT NOT NULL
    );
    INSERT INTO broker_metadata(singleton, broker_uuid, created_at)
    VALUES (1, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '2026-08-01T00:00:00.000Z');
  `);
  corrupt.close();
  assert.throws(() => new BrokerStore(path), /invalid_broker_uuid_metadata/);
});

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

test("pending delivery expires at its configured TTL with a thread-visible notice", () => {
  const { store, clock } = fixture({ wakePolicy: "resume", sessionId: "thread-1", deliveryTtlMs: 100 });
  store.ingestEvent(event());
  clock.advance(101);
  assert.equal(store.claimNext("mac", 0), null);
  const expired = store.getDelivery(1);
  assert.equal(expired.status, "undeliverable");
  assert.equal(expired.reasons[0]?.code, "delivery_ttl_expired");
  const notices = store.listUnsentOutbox();
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /undeliverable/);
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

test("claim cursor cannot hide older work skipped during home grace", () => {
  const { store, clock } = fixture();
  store.upsertSubscription(subscription({
    actor: "fable",
    homeEdge: "dev",
    sessionId: "thread-2",
  }));

  assert.equal(store.ingestEvent(event()).deliveryId, 1);
  assert.equal(store.ingestEvent(event({
    eventId: "Ev2",
    actor: "fable",
    threadTs: "101.1",
    messageTs: "101.2",
    text: "WAKE: fable | test",
  })).deliveryId, 2);

  const newer = store.claimNext("dev", 0);
  assert.equal(newer?.id, 2);
  assert.equal(store.getDelivery(1).status, "pending");

  clock.advance(2_001);
  const older = store.claimNext("dev", newer!.id);
  assert.equal(older?.id, 1);
  assert.equal(older?.claimedBy, "dev");
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

test("an expired lease requeues the delivery for redelivery behind backoff (ADR-0003 R-3)", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "accepted_local", "dispatching");
  clock.advance(1_001);
  assert.equal(store.requeueExpiredLeases(), 1);
  const requeued = store.getDelivery(claimed.id);
  assert.equal(requeued.status, "pending");
  assert.notEqual(requeued.nextAttemptAt, null);
  // Backoff holds the delivery out of claim until its retry horizon passes.
  assert.equal(store.claimNext("mac", 0), null);
  clock.advance(retryBackoffMs(1) + 1);
  const reclaimed = store.claimNext("mac", 0)!;
  assert.equal(reclaimed.leaseGeneration, 2);
  assert.equal(reclaimed.attempts, 2);
  // The retry is visible in the thread.
  assert.ok(store.listUnsentOutbox().some((entry) => /retrying delivery/.test(entry.text)));
  store.close();
});

test("a dispatched delivery waits out the outcome grace, then is redelivered, not quarantined", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.transition(claimed.id, "mac", 1, "dispatching", "dispatched");
  // Inside the grace the delivery stays open for the agent's outcome report —
  // an expired lease alone must NOT requeue a durably dispatched wake.
  clock.advance(1_001);
  assert.equal(store.requeueExpiredLeases(), 0);
  assert.equal(store.getDelivery(claimed.id).status, "dispatched");
  // An outcome arriving during the grace closes the loop without redelivery.
  // (Separate delivery below proves the requeue side.)
  clock.advance(DISPATCHED_OUTCOME_GRACE_MS + 1);
  assert.equal(store.requeueExpiredLeases(), 1);
  assert.equal(store.getDelivery(claimed.id).status, "pending");
  store.close();
});

test("an outcome report during the dispatched grace closes the delivery without redelivery", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.transition(claimed.id, "mac", 1, "dispatching", "dispatched");
  clock.advance(1_001);
  store.recordOutcome(claimed.id, "done");
  clock.advance(DISPATCHED_OUTCOME_GRACE_MS + 1);
  assert.equal(store.requeueExpiredLeases(), 0);
  assert.equal(store.getDelivery(claimed.id).status, "processed");
  store.close();
});

test("attempt exhaustion terminalizes as failed with a thread-visible notice", () => {
  const { store, clock } = fixture({ maxAttempts: 2 });
  store.ingestEvent(event());
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claimed = store.claimNext("mac", 0)!;
    assert.equal(claimed.attempts, attempt);
    store.transition(claimed.id, "mac", claimed.leaseGeneration!, "claimed", "accepted_local");
    store.transition(claimed.id, "mac", claimed.leaseGeneration!, "accepted_local", "dispatching");
    clock.advance(1_001);
    store.requeueExpiredLeases();
    clock.advance(retryBackoffMs(attempt) + 1);
  }
  const terminal = store.getDelivery(1);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.reasons[0]?.code, "lease_expired");
  assert.ok(store.listUnsentOutbox().some((entry) => /failed after 2 attempt/.test(entry.text)));
  // A sixth attempt is impossible: nothing is claimable and the status is terminal.
  clock.advance(60 * 60_000);
  assert.equal(store.claimNext("mac", 0), null);
  store.close();
});

test("release requeues with backoff and exhausts into failed", () => {
  const { store, clock } = fixture({ maxAttempts: 1 });
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  const released = store.release(claimed.id, "mac", claimed.leaseGeneration!, {
    code: "provider_dispatch_unknown",
    detail: "test uncertainty",
  });
  assert.equal(released.status, "failed");
  assert.ok(store.listUnsentOutbox().some((entry) => /failed after 1 attempt/.test(entry.text)));
  clock.advance(1);
  assert.equal(store.claimNext("mac", 0), null);
  store.close();
});

test("attempt exhaustion forgets the stored delivery traceparent", () => {
  resetObservabilityForTests();
  const { store } = fixture({ maxAttempts: 1 });
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  rememberDeliveryTraceparent(claimed.id, parent);
  const released = store.release(claimed.id, "mac", claimed.leaseGeneration!, {
    code: "provider_dispatch_unknown",
    detail: "test uncertainty",
  });
  assert.equal(released.status, "failed");
  assert.equal(peekDeliveryTraceparent(claimed.id), undefined);
  store.close();
});

test("a retry requeue keeps the stored delivery traceparent", () => {
  resetObservabilityForTests();
  const { store, clock } = fixture({ maxAttempts: 3 });
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", claimed.leaseGeneration!, "claimed", "accepted_local");
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  rememberDeliveryTraceparent(claimed.id, parent);
  clock.advance(1_001);
  assert.equal(store.requeueExpiredLeases(), 1);
  assert.equal(store.getDelivery(claimed.id).status, "pending");
  assert.equal(peekDeliveryTraceparent(claimed.id), parent);
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
  assert.equal(store.requeueExpiredLeases(), 0);
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

test("an agent outcome report closes the loop without a lease fence (ADR-0003 R-6)", () => {
  const { store, clock } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.transition(claimed.id, "mac", 1, "dispatching", "dispatched");
  // The lease expires — the agent is still working. Its report must still land.
  clock.advance(60_000);
  const reported = store.recordOutcome(claimed.id, "done: merged the fix");
  assert.equal(reported.status, "processed");
  const outbox = store.listUnsentOutbox();
  assert.ok(outbox.some((entry) => /done: merged the fix/.test(entry.text)));
  // The outcome post is self-identifying via the dedupe key.
  assert.ok(outbox.some((entry) => new RegExp(`dedupe 100\\.2:${claimed.id}`).test(entry.text)));

  // A duplicate outcome on a terminal delivery still posts and keeps recorded truth.
  const duplicate = store.recordOutcome(claimed.id, "done: merged the fix");
  assert.equal(duplicate.status, "processed");
  store.close();
});

test("outbox rows drain once, back off after failure, and survive to retry", () => {
  const { store, clock } = fixture();
  store.enqueueThreadNotice("C1", "100.1", "⛔ dropped sender notice");
  const unsent = store.listUnsentOutbox();
  assert.equal(unsent.length, 1);
  store.markOutboxAttempt(unsent[0]!.outboxId);
  // A failed row backs off — it must not immediately reoccupy the page.
  assert.equal(store.listUnsentOutbox().length, 0);
  clock.advance(retryBackoffMs(1) + 1);
  assert.equal(store.listUnsentOutbox().length, 1);
  store.markOutboxSent(unsent[0]!.outboxId);
  clock.advance(retryBackoffMs(2) + 1);
  assert.equal(store.listUnsentOutbox().length, 0);
  store.close();
});

test("a poisoned outbox row cannot starve later rows and is finally abandoned", () => {
  const { store, clock } = fixture();
  store.enqueueThreadNotice("C-archived", "100.1", "poisoned row");
  store.enqueueThreadNotice("C-healthy", "100.2", "healthy row");
  // The poisoned row fails forever; the healthy row must still surface.
  const first = store.listUnsentOutbox();
  assert.equal(first.length, 2);
  store.markOutboxAttempt(first[0]!.outboxId);
  const during = store.listUnsentOutbox();
  assert.deepEqual(during.map((entry) => entry.channelId), ["C-healthy"]);
  // Exhaust the poisoned row's attempts entirely: it leaves the page for good.
  for (let i = 0; i < 60; i += 1) {
    clock.advance(11 * 60_000);
    for (const entry of store.listUnsentOutbox()) {
      if (entry.channelId === "C-archived") store.markOutboxAttempt(entry.outboxId);
    }
  }
  clock.advance(11 * 60_000);
  assert.ok(store.listUnsentOutbox().every((entry) => entry.channelId !== "C-archived"));
  store.close();
});

test("a pre-v0.5 broker database is refused loudly, never migrated in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-legacy-"));
  const path = join(dir, "broker.sqlite");
  const legacy = new Database(path);
  legacy.exec("CREATE TABLE deliveries (delivery_id INTEGER PRIMARY KEY, status TEXT)");
  legacy.close();
  assert.throws(() => new BrokerStore(path), LegacyDatabaseError);
  rmSync(dir, { recursive: true, force: true });
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

test("a coalesced second instruction is delivered imperatively, not demoted to data", () => {
  const { store } = fixture();
  store.ingestEvent(event());
  const second = store.ingestEvent(event({
    eventId: "Ev2",
    messageTs: "100.3",
    text: "WAKE: ariadne | also do the second thing",
  }));
  assert.equal(second.deliveryId, 1);
  const claimed = store.claimNext("mac", 0)!;
  assert.equal(claimed.coalescedMessages.length, 1);
  assert.equal(claimed.coalescedMessages[0]!.text, "WAKE: ariadne | also do the second thing");
  const framed = frameWakeInstruction(claimed, null);
  // Both trusted instructions ride in the imperative section.
  assert.match(framed, /Additional message from U1 in the same thread/);
  assert.match(framed, /also do the second thing/);
  assert.match(framed, /Act on these messages/);
  // And neither is exiled to the data-only replay block.
  assert.doesNotMatch(framed, /<thread_replay/);
  store.close();
});

test("a relative accountProfile is rejected at the schema boundary (R-5)", () => {
  assert.throws(() => SubscriptionInputSchema.parse({
    ...subscription(),
    accountProfile: "profiles/claude-1",
  }));
  assert.doesNotThrow(() => SubscriptionInputSchema.parse(subscription()));
});

test("`everyone` is rejected as a subscription actor name at the schema boundary (KRA-926)", () => {
  // `everyone` is the broadcast keyword; a real seat must never carry it as a name,
  // in any casing, so a subscription can neither shadow nor be shadowed by broadcast.
  assert.throws(() => SubscriptionInputSchema.parse({ ...subscription(), actor: "everyone" }));
  assert.throws(() => SubscriptionInputSchema.parse({ ...subscription(), actor: "Everyone" }));
  assert.doesNotThrow(() => SubscriptionInputSchema.parse(subscription()));
});

test("liveActors enumerates only unexpired subscriptions, in stable order (KRA-926)", () => {
  const store = new BrokerStore(":memory:", new FakeClock(new Date("2026-07-12T00:00:00.950Z")));
  store.createEdge("mac");
  store.createEdge("dev");
  store.upsertSubscription(subscription({ actor: "gnomon", expiresAt: null }));
  store.upsertSubscription(subscription({ actor: "ariadne", expiresAt: "2026-07-12T00:00:01.000Z" })); // future — live
  store.upsertSubscription(subscription({ actor: "fable", expiresAt: "2026-07-12T00:00:00.9Z" })); // 50ms past — lapsed
  // fable is excluded (instant comparison, matching hasActiveSubscription); the rest
  // come back sorted, so the broadcast target set is deterministic.
  assert.deepEqual(store.liveActors(), ["ariadne", "gnomon"]);
  store.close();
});

test("hasActiveSubscription orders expiry by instant, not by ISO string (fractional-precision boundary)", () => {
  // A NULL expiry is always live, an already-past expiry never is.
  {
    const store = new BrokerStore(":memory:", new FakeClock(new Date("2026-07-12T00:00:00.950Z")));
    store.createEdge("mac");
    store.createEdge("dev");
    store.upsertSubscription(subscription({ expiresAt: null }));
    assert.equal(store.hasActiveSubscription(), true);
    store.close();
  }

  // The trap: `expires_at` is a z.string().datetime() whose fractional precision
  // can vary, so a lexical `expires_at > ?` SQL compare orders wrongly near a
  // boundary. Here now = ...00.950Z and the only subscription expired at ...00.9Z
  // (i.e. .900s — 50ms in the PAST). By instant it is expired, so the broker has
  // no live subscription. But lexically "…00.9Z" > "…00.950Z" (the 'Z' terminator
  // outranks the digit '5'), so a string compare would wrongly report it live and
  // arm the deafness watchdog against a broker that legitimately expects silence.
  {
    const store = new BrokerStore(":memory:", new FakeClock(new Date("2026-07-12T00:00:00.950Z")));
    store.createEdge("mac");
    store.createEdge("dev");
    store.upsertSubscription(subscription({ expiresAt: "2026-07-12T00:00:00.9Z" }));
    assert.equal(
      store.hasActiveSubscription(),
      false,
      "an expiry 50ms in the past is not live, however its ISO string happens to sort",
    );
    store.close();
  }

  // A genuinely future expiry is live.
  {
    const store = new BrokerStore(":memory:", new FakeClock(new Date("2026-07-12T00:00:00.950Z")));
    store.createEdge("mac");
    store.createEdge("dev");
    store.upsertSubscription(subscription({ expiresAt: "2026-07-12T00:00:01.000Z" }));
    assert.equal(store.hasActiveSubscription(), true);
    store.close();
  }
});

test("delete-subscription retires an actor: unaddressable, unbound, and idempotent", () => {
  const { store } = fixture(); // ariadne, spawn policy, home edge mac
  store.ingestEvent(event()); // delivery 1 for ariadne in thread 100.1
  // Drive the delivery to a spawn reservation so every actor-scoped table has a row
  // to prove the FK-ordered cascade, not just the subscription row, is removed.
  const claimed = store.claimNext("mac", 0)!;
  const generation = claimed.leaseGeneration!;
  store.transition(1, "mac", generation, "claimed", "accepted_local");
  store.transition(1, "mac", generation, "accepted_local", "dispatching");
  assert.equal(store.reserveSpawn(1, "mac", generation), true);
  store.finish(1, "mac", generation, "processed", [], "completed before retirement");

  const rowsFor = (table: string) =>
    Number((store.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE actor = 'ariadne'`).get() as { count: number }).count);
  const deliveryEventRows = () =>
    Number((store.db.prepare("SELECT count(*) AS count FROM delivery_events").get() as { count: number }).count);

  // Addressable and bound before retirement, with a row in every dependent table.
  assert.notEqual(store.getSubscription("ariadne"), null);
  assert.deepEqual(store.actorsBoundToThread("C1", "100.1"), ["ariadne"]);
  for (const table of ["deliveries", "slack_events", "spawn_reservations", "spawn_windows", "actor_leases"]) {
    assert.equal(rowsFor(table), 1, `${table} should have an ariadne row before delete`);
  }
  assert.equal(deliveryEventRows(), 1);

  assert.equal(store.deleteSubscription("ariadne"), true);

  // Unaddressable (no subscription to dispatch against) and unbound (no delivery
  // joins it to any thread); every dependent row is gone — the FK cascade held.
  assert.equal(store.getSubscription("ariadne"), null);
  assert.deepEqual(store.actorsBoundToThread("C1", "100.1"), []);
  assert.equal(store.listDeliveries().length, 0);
  for (const table of ["deliveries", "slack_events", "spawn_reservations", "spawn_windows", "actor_leases"]) {
    assert.equal(rowsFor(table), 0, `${table} should be empty after delete`);
  }
  assert.equal(deliveryEventRows(), 0);
  // The already-committed outcome is deliberately not erased with the actor's
  // addressability state; durable outbox posts still close the Slack loop.
  assert.equal(store.listUnsentOutbox().length, 1);
  assert.equal(store.listUnsentOutbox()[0]?.deliveryId, 1);

  // Idempotent: retiring an already-absent actor is a no-op, not an error.
  assert.equal(store.deleteSubscription("ariadne"), false);
  store.close();
});

test("delete-subscription refuses to erase an in-flight provider coordinate", () => {
  const { store } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  const generation = claimed.leaseGeneration!;
  store.transition(1, "mac", generation, "claimed", "accepted_local");
  store.transition(1, "mac", generation, "accepted_local", "dispatching");

  assert.throws(
    () => store.deleteSubscription("ariadne"),
    (error: unknown) =>
      error instanceof InvalidTransitionError
      && error.message === "cannot retire ariadne: delivery 1 is dispatching",
  );
  assert.notEqual(store.getSubscription("ariadne"), null);
  assert.equal(store.getDelivery(1).status, "dispatching");
  assert.deepEqual(store.actorsBoundToThread("C1", "100.1"), ["ariadne"]);
  store.close();
});

test("lifecycle reactions ride the outbox: eyes on dispatched, check on outcome, x on failure", () => {
  const { store } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.markDispatched(claimed.id, "mac", 1);
  store.finish(claimed.id, "mac", 1, "processed", [], "done: shipped it");

  const outbox = store.listUnsentOutbox();
  const dispatched = outbox.find((entry) => /delivered to ariadne/.test(entry.text))!;
  assert.equal(dispatched.reaction, "eyes");
  assert.deepEqual(dispatched.reactionTargets, ["100.2"]);
  const outcome = outbox.find((entry) => /done: shipped it/.test(entry.text))!;
  assert.equal(outcome.reaction, "white_check_mark");
  assert.deepEqual(outcome.reactionTargets, ["100.2"]);
  // The reaction targets the wake message, never the thread root.
  assert.ok(outbox.every((entry) => !entry.reactionTargets.includes("100.1")));
  store.close();
});

test("a coalesced delivery stamps every wake message it absorbed, not only the primary", () => {
  const { store } = fixture();
  store.ingestEvent(event());
  // Two more wakes land in the same thread while the delivery is still pending.
  store.ingestEvent(event({ eventId: "Ev2", messageTs: "100.3", text: "WAKE: ariadne | again" }));
  store.ingestEvent(event({ eventId: "Ev3", messageTs: "100.4", text: "WAKE: ariadne | and again" }));
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.transition(claimed.id, "mac", 1, "accepted_local", "dispatching");
  store.markDispatched(claimed.id, "mac", 1);
  store.recordOutcome(claimed.id, "done: all three answered");

  const outbox = store.listUnsentOutbox();
  const dispatched = outbox.find((entry) => /delivered to ariadne/.test(entry.text))!;
  assert.deepEqual(dispatched.reactionTargets, ["100.2", "100.3", "100.4"]);
  const outcome = outbox.find((entry) => /all three answered/.test(entry.text))!;
  assert.deepEqual(outcome.reactionTargets, ["100.2", "100.3", "100.4"]);
  store.close();
});

test("a terminal failure stamps x on the wake message", () => {
  const { store } = fixture();
  store.ingestEvent(event());
  const claimed = store.claimNext("mac", 0)!;
  store.transition(claimed.id, "mac", 1, "claimed", "accepted_local");
  store.finish(claimed.id, "mac", 1, "undeliverable", [{ code: "workspace_not_mapped", detail: "no mapping" }]);
  const failure = store.listUnsentOutbox().find((entry) => /undeliverable/.test(entry.text))!;
  assert.equal(failure.reaction, "x");
  assert.deepEqual(failure.reactionTargets, ["100.2"]);
  store.close();
});

test("thread notices carry no reaction and pre-reaction databases migrate in place", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-outbox-reaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "broker.sqlite");
  const first = new BrokerStore(path);
  first.enqueueThreadNotice("C1", "100.1", "plain notice");
  assert.equal(first.listUnsentOutbox()[0]!.reaction, null);
  assert.deepEqual(first.listUnsentOutbox()[0]!.reactionTargets, []);
  first.close();
  // A database carrying the abandoned single-timestamp column loses it in place.
  const raw = new Database(path);
  raw.exec("ALTER TABLE outbox ADD COLUMN reaction_target_ts TEXT");
  raw.close();
  // Re-opening runs the ensure-column step: no-op for current columns, drop for the stale one.
  const second = new BrokerStore(path);
  assert.equal(second.listUnsentOutbox()[0]!.reaction, null);
  const columns = (second.db.pragma("table_info(outbox)") as { name: string }[]).map((c) => c.name);
  assert.ok(!columns.includes("reaction_target_ts"));
  assert.ok(columns.includes("reaction_targets_json"));
  second.close();
});

test("claimNext skips actors the claiming edge declared busy", () => {
  const { store } = fixture();
  store.ingestEvent(event());
  // The edge is mid-turn for this actor: its declaration must hide the delivery.
  assert.equal(store.claimNext("mac", 0, ["ariadne"]), null);
  assert.equal(store.getDelivery(1).status, "pending");
  // Once the turn ends the same claim succeeds.
  assert.equal(store.claimNext("mac", 0, [])?.claimedBy, "mac");
  store.close();
});
