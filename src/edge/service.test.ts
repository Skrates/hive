import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATTESTATION_FILENAME } from "./attestation.js";
import type { Delivery, DeliveryResultInput, Reason, ReplaySnapshot, Subscription } from "../domain.js";
import type { WakeEffort } from "./effort.js";
import type { BrokerClient } from "./broker-client.js";
import { LiveIngressRegistry, type LiveIngress } from "./live-registry.js";
import {
  ProviderPreDispatchError,
  type ProviderAdapter,
  type ProviderDispatch,
} from "./providers.js";
import { headlessAcknowledgement } from "./providers.js";
import { EdgeService } from "./service.js";
import { EdgeStore, type AttestationBinding } from "./store.js";

/** These tests exercise generation/attempt fencing, not attestation binding. */
const unbound: AttestationBinding = { attestationId: null, doctrineCommit: null, absence: "no_attestation_file" };


test("Codex JSONL receipt yields the final agent message", () => {
  const receipt = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Handled and recorded." } }),
  ].join("\n");
  assert.equal(headlessAcknowledgement(receipt), "Handled and recorded.");
});

test("Claude stream JSON receipt yields the result", () => {
  const receipt = JSON.stringify({ type: "result", subtype: "success", result: "Done from Claude." });
  assert.equal(headlessAcknowledgement(receipt), "Done from Claude.");
});

test("a hook-disturbed Claude run falls back to the last assistant message, not the placeholder", () => {
  // A hook_non_blocking_error left the terminal result line unusable (no string
  // `result`), so the clean-run source is absent. The final assistant turn is
  // still the real outcome and must surface instead of the empty-summary placeholder.
  const receipt = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fixed the PATH and pushed the branch." }] } }),
    JSON.stringify({ type: "result", subtype: "error_during_execution", result: null }),
  ].join("\n");
  assert.equal(headlessAcknowledgement(receipt), "Fixed the PATH and pushed the branch.");
});

test("a clean Claude result still wins over earlier assistant turns", () => {
  const receipt = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "Final answer." }),
  ].join("\n");
  assert.equal(headlessAcknowledgement(receipt), "Final answer.");
});

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "1.0.0",
    sessionId: "thread-1",
    homeEdge: "mac",
    workspace: "taxis",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/taxis", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/profiles/ariadne",
    leaseTtlMs: 30_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 0,
    spawnRateLimit: 10,
    maxAttempts: 5,
    expiresAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function delivery(id: number, overrides: Partial<Delivery> = {}): Delivery {
  return {
    id,
    eventId: `Ev${id}`,
    actor: "ariadne",
    status: "claimed",
    reasons: [],
    leaseGeneration: 1,
    claimedBy: "mac",
    attempts: 1,
    nextAttemptAt: null,
    coalesceKey: `ariadne:C1:100.1`,
    coalescedEventIds: [`Ev${id}`],
    coalescedMessages: [],
    initialSnapshot: null,
    snapshotTs: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    subscription: subscription(),
    event: {
      eventId: `Ev${id}`,
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100.1",
      messageTs: `100.${id}`,
      senderId: "U1",
      senderKind: "user",
      actor: "ariadne",
      text: "WAKE: ariadne | do the thing",
      raw: {},
      receivedAt: "2026-08-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

interface FinishRecord { deliveryId: number; result: DeliveryResultInput }
interface ReleaseRecord { deliveryId: number; reason: Reason }

class FakeBroker {
  readonly edgeId = "mac";
  readonly finishes: FinishRecord[] = [];
  readonly releases: ReleaseRecord[] = [];
  readonly replies: Array<{ deliveryId: number; text: string }> = [];
  readonly outcomes: Array<{ deliveryId: number; text: string }> = [];
  markCount = 0;

  constructor(private readonly queue: Delivery[]) {}

  async claim(_after?: number, _waitMs?: number, busyActors: readonly string[] = []): Promise<Delivery | null> {
    // Mirrors the broker: deliveries for actors the edge declared busy are skipped.
    const index = this.queue.findIndex((item) => !busyActors.includes(item.actor));
    if (index === -1) return null;
    return this.queue.splice(index, 1)[0] ?? null;
  }

  async accept(value: Delivery): Promise<Delivery> { return { ...value, status: "accepted_local" }; }
  async beginDispatch(value: Delivery): Promise<Delivery> { return { ...value, status: "dispatching" }; }
  async markDispatched(value: Delivery): Promise<Delivery> {
    this.markCount += 1;
    return { ...value, status: "dispatched" };
  }
  async renew(value: Delivery): Promise<Delivery> { return value; }
  async reserveSpawn(): Promise<boolean> { return true; }
  async finish(value: Delivery, result: DeliveryResultInput): Promise<Delivery> {
    this.finishes.push({ deliveryId: value.id, result });
    return { ...value, status: result.status };
  }
  async release(value: Delivery, reason: Reason): Promise<Delivery> {
    this.releases.push({ deliveryId: value.id, reason });
    return { ...value, status: "pending" };
  }
  async outcome(deliveryId: number, text: string): Promise<Delivery> {
    this.outcomes.push({ deliveryId, text });
    return delivery(deliveryId, { status: "processed" });
  }
  async reply(value: Delivery, text: string): Promise<string> {
    this.replies.push({ deliveryId: value.id, text });
    return "ts";
  }
  async replay(): Promise<ReplaySnapshot> {
    return { channelId: "C1", threadTs: "100.1", fetchedAt: "2026-08-01T00:00:00.000Z", cursor: null, messages: [] };
  }
}

function asBrokerClient(fake: FakeBroker): BrokerClient {
  return fake as unknown as BrokerClient;
}

class StubAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly spawns: string[] = [];
  readonly resumes: string[] = [];
  readonly efforts: (WakeEffort | null)[] = [];
  readonly liveDeliveries: number[] = [];
  readonly liveFrames: string[] = [];
  readonly liveSockets: string[] = [];

  constructor(
    private readonly behavior: {
      preflightError?: ProviderPreDispatchError;
      dispatchError?: Error;
      liveResult?: ProviderDispatch;
      headlessResult?: ProviderDispatch;
    } = {},
  ) {}

  preflight(): void {
    if (this.behavior.preflightError) throw this.behavior.preflightError;
  }

  async deliverLive(ingress: LiveIngress, value: Delivery, framed: string): Promise<ProviderDispatch> {
    if (this.behavior.dispatchError) throw this.behavior.dispatchError;
    this.liveDeliveries.push(value.id);
    this.liveFrames.push(framed);
    this.liveSockets.push(ingress.socketPath);
    return this.behavior.liveResult ?? { receipt: `live:${value.id}`, processed: false };
  }

  async resume(_subscription: Subscription, _cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    if (this.behavior.dispatchError) throw this.behavior.dispatchError;
    this.resumes.push(framed);
    this.efforts.push(effort);
    return this.behavior.headlessResult ?? { receipt: JSON.stringify({ type: "result", result: "resumed" }), outcome: "resumed", processed: true };
  }

  async spawn(_subscription: Subscription, _cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
    if (this.behavior.dispatchError) throw this.behavior.dispatchError;
    this.spawns.push(framed);
    this.efforts.push(effort);
    return this.behavior.headlessResult ?? { receipt: JSON.stringify({ type: "result", result: "spawned" }), outcome: "spawned", processed: true };
  }
}

test("a wake carrying an Effort line reaches the adapter with that tier; a plain wake reaches it with null", async () => {
  const broker = new FakeBroker([
    delivery(1, { event: { ...delivery(1).event, text: "WAKE: ariadne\n\nEffort: xhigh\ndo the thing" } }),
    delivery(2),
  ]);
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(await edge.processOne(), true);
  // The overlay is per-delivery: it binds the one invocation it rode in on and
  // leaves the next wake at the profile default.
  assert.deepEqual(adapter.efforts, ["xhigh", null]);
});

test("a headless resume dispatch completes, posts its outcome, and finishes processed", async () => {
  const broker = new FakeBroker([delivery(1)]);
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(adapter.resumes.length, 1);
  // The envelope is imperative and self-identifying. A headless provider's
  // final response is the outcome, so it must not race the edge by calling the
  // live-session outcome command itself.
  assert.match(adapter.resumes[0]!, /^Message from U1 /);
  assert.match(adapter.resumes[0]!, /dedupe 100\.1:1/);
  assert.match(adapter.resumes[0]!, /attempt 1/);
  assert.match(adapter.resumes[0]!, /Hive will relay that final response/);
  assert.match(adapter.resumes[0]!, /do not run hive reply/);
  assert.doesNotMatch(adapter.resumes[0]!, /hive reply 1/);
  assert.doesNotMatch(adapter.resumes[0]!, /untrusted/i);
  assert.equal(broker.markCount, 1);
  // The outcome rides INSIDE the terminal transition (one durable broker
  // commit), never as a separate inline Slack post.
  assert.deepEqual(broker.replies, []);
  assert.equal(broker.finishes[0]?.result.status, "processed");
  assert.equal(broker.finishes[0]?.result.outcome, "resumed");
  assert.equal(store.get(1)?.status, "processed");
  store.close();
});

test("a completion-tracked Codex live injection commits its final response as the outcome", async () => {
  const broker = new FakeBroker([delivery(2, { subscription: subscription({ wakePolicy: "live_only" }) })]);
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter({
    liveResult: {
      receipt: JSON.stringify({ type: "hive.live.completed", surface: "desktop", turnId: "turn-2" }),
      outcome: "live completed",
      processed: true,
    },
  });
  const live = new LiveIngressRegistry();
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/x.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    // Required: a registration names its attestation or names its absence.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" },
  }, 60_000);
  const edge = new EdgeService(asBrokerClient(broker), store, live, [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.deepEqual(adapter.liveDeliveries, [2]);
  assert.doesNotMatch(adapter.liveFrames[0]!, /hive reply 2/);
  assert.match(adapter.liveFrames[0]!, /Hive will relay that final response/);
  assert.equal(broker.markCount, 1);
  assert.deepEqual(broker.replies, []);
  assert.equal(broker.finishes[0]?.result.status, "processed");
  assert.equal(broker.finishes[0]?.result.outcome, "live completed");
  assert.equal(store.get(2)?.status, "processed");
  store.close();
});

test("a deterministic pre-dispatch failure finishes undeliverable, never released", async () => {
  const broker = new FakeBroker([delivery(3)]);
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter({ preflightError: new ProviderPreDispatchError("account_profile_missing") });
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(broker.releases.length, 0);
  assert.equal(broker.finishes[0]?.result.status, "undeliverable");
  assert.equal(broker.finishes[0]?.result.reasons[0]?.code, "account_profile_missing");
  store.close();
});

test("a live Desktop account rejection terminalizes without an uncertainty retry", async () => {
  const broker = new FakeBroker([delivery(30, { subscription: subscription({ wakePolicy: "live_only" }) })]);
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter({
    dispatchError: new ProviderPreDispatchError("account_profile_mismatch"),
  });
  const live = new LiveIngressRegistry();
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/x.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    // Required: a registration names its attestation or names its absence.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" },
  }, 60_000);
  const edge = new EdgeService(asBrokerClient(broker), store, live, [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(broker.releases.length, 0);
  assert.equal(broker.finishes[0]?.result.status, "undeliverable");
  assert.equal(broker.finishes[0]?.result.reasons[0]?.code, "account_profile_mismatch");
  assert.deepEqual(adapter.liveDeliveries, []);
  store.close();
});

test("provider uncertainty releases the delivery for redelivery instead of declaring an outcome", async () => {
  const broker = new FakeBroker([delivery(4)]);
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter({ dispatchError: new Error("socket hangup mid-dispatch") });
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(broker.finishes.length, 0);
  assert.equal(broker.releases.length, 1);
  assert.equal(broker.releases[0]?.reason.code, "provider_dispatch_unknown");
  assert.equal(store.get(4)?.status, "released");
  store.close();
});

test("an edge restart releases interrupted dispatches back to the broker", async () => {
  const broker = new FakeBroker([]);
  const store = new EdgeStore(":memory:");
  store.receive(delivery(5), 1, unbound);
  store.setStatus(5, 1, "dispatching");
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [new StubAdapter()]);

  assert.equal(await edge.recoverInterruptedDispatches(), 1);
  assert.equal(broker.releases[0]?.deliveryId, 5);
  assert.equal(broker.releases[0]?.reason.code, "edge_restarted_during_dispatch");
  assert.equal(store.get(5)?.status, "released");
  store.close();
});

test("a duplicate claim of an already-processed delivery is recognized and skipped", async () => {
  const store = new EdgeStore(":memory:");
  store.receive(delivery(6), 1, unbound);
  store.setStatus(6, 1, "processed", "done");
  const broker = new FakeBroker([delivery(6)]);
  const adapter = new StubAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(adapter.spawns.length + adapter.resumes.length + adapter.liveDeliveries.length, 0);
  assert.equal(broker.finishes.length, 0);
  store.close();
});

test("a redelivered higher attempt is dispatched again (duplicates tolerated by design)", async () => {
  const store = new EdgeStore(":memory:");
  store.receive(delivery(7), 1, unbound);
  store.setStatus(7, 1, "released");
  const redelivered = delivery(7, { attempts: 2, leaseGeneration: 2 });
  const broker = new FakeBroker([redelivered]);
  const adapter = new StubAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(adapter.resumes.length, 1);
  assert.match(adapter.resumes[0]!, /attempt 2/);
  assert.equal(broker.finishes[0]?.result.status, "processed");
  store.close();
});

test("a slow turn for one actor does not starve a co-tenant actor's delivery (multi-actor edge, 2026-08-11)", async () => {
  // The cx53 incident: the run() loop awaited each provider turn before
  // claiming again, so gnomon's 80-minute headless turn left theoros's
  // delivery `pending` at the broker for hours. run() must claim and
  // dispatch concurrently across actors.
  let releaseSlowTurn!: () => void;
  const slowTurn = new Promise<void>((resolve) => { releaseSlowTurn = resolve; });
  class SlowForGnomonAdapter extends StubAdapter {
    override async spawn(sub: Subscription, cwd: string, framed: string, effort: WakeEffort | null): Promise<ProviderDispatch> {
      if (sub.actor === "gnomon") {
        await slowTurn;
        return { receipt: JSON.stringify({ type: "result", result: "slow done" }), outcome: "slow done", processed: true };
      }
      return super.spawn(sub, cwd, framed, effort);
    }
  }
  const broker = new FakeBroker([
    delivery(1, { actor: "gnomon", coalesceKey: "gnomon:C1:100.1", subscription: subscription({ actor: "gnomon", sessionId: null }) }),
    delivery(2, { actor: "theoros", coalesceKey: "theoros:C1:100.2", subscription: subscription({ actor: "theoros", sessionId: null }) }),
  ]);
  const store = new EdgeStore(":memory:");
  const adapter = new SlowForGnomonAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  const controller = new AbortController();
  const run = edge.run(controller.signal);
  // The theoros delivery must complete while the gnomon turn is still hanging.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !broker.finishes.some((f) => f.deliveryId === 2)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    broker.finishes.some((f) => f.deliveryId === 2 && f.result.status === "processed"),
    "theoros delivery processed while gnomon turn still in flight",
  );
  assert.ok(!broker.finishes.some((f) => f.deliveryId === 1), "gnomon turn genuinely still hanging");
  // Release the slow turn; it must also reach a disposition.
  releaseSlowTurn();
  const slowDeadline = Date.now() + 2_000;
  while (Date.now() < slowDeadline && !broker.finishes.some((f) => f.deliveryId === 1)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(broker.finishes.some((f) => f.deliveryId === 1 && f.result.status === "processed"));
  controller.abort();
  await run;
});


test("two deliveries for the SAME actor never run concurrently — the edge declares busy actors on claim", async () => {
  // The 2026-08-11 regression-of-the-regression: naive concurrent dispatch let
  // the same actor run twice at once, because a same-edge claim on a live
  // lease shares the generation. The edge must declare busy actors and the
  // broker must skip them.
  let releaseFirstTurn!: () => void;
  const firstTurn = new Promise<void>((resolve) => { releaseFirstTurn = resolve; });
  let inFlightSameActor = 0;
  let maxInFlightSameActor = 0;
  class CountingAdapter extends StubAdapter {
    override async spawn(sub: Subscription, cwd: string, framed: string, _effort: WakeEffort | null): Promise<ProviderDispatch> {
      inFlightSameActor += 1;
      maxInFlightSameActor = Math.max(maxInFlightSameActor, inFlightSameActor);
      try {
        await firstTurn;
        return { receipt: JSON.stringify({ type: "result", result: "done" }), outcome: "done", processed: true };
      } finally {
        inFlightSameActor -= 1;
      }
    }
  }
  const broker = new FakeBroker([
    delivery(1, { actor: "gnomon", coalesceKey: "gnomon:C1:100.1", subscription: subscription({ actor: "gnomon", sessionId: null }) }),
    delivery(2, { actor: "gnomon", coalesceKey: "gnomon:C1:100.2", subscription: subscription({ actor: "gnomon", sessionId: null }) }),
  ]);
  const store = new EdgeStore(":memory:");
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [new CountingAdapter()]);

  const controller = new AbortController();
  const run = edge.run(controller.signal);
  // Give the loop time to (wrongly) claim the second gnomon delivery if it can.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(maxInFlightSameActor, 1, "second gnomon delivery must wait for the first turn");
  releaseFirstTurn();
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && broker.finishes.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.finishes.filter((f) => f.result.status === "processed").length, 2);
  assert.equal(maxInFlightSameActor, 1);
  controller.abort();
  await run;
});

test("every claimed delivery is bound to the attestation of the profile it runs under", async () => {
  // AC (KRA-1077): a wake outcome must be traceable to the exact seat
  // attestation that produced it. The binding is written at claim time and
  // sits in the same row as the provider receipt.
  const profile = mkdtempSync(join(tmpdir(), "weave-seat-"));
  writeFileSync(join(profile, ATTESTATION_FILENAME), JSON.stringify({
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + "a".repeat(64),
    actor: "ariadne",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: "9".repeat(40) },
  }));

  const broker = new FakeBroker([delivery(1, { subscription: subscription({ accountProfile: profile }) })]);
  const store = new EdgeStore(":memory:");
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [new StubAdapter()]);

  assert.equal(await edge.processOne(), true);
  const row = store.get(1)!;
  assert.equal(row.status, "processed");
  assert.equal(row.attestation_id, "sha256:" + "a".repeat(64));
  assert.equal(row.doctrine_commit, "9".repeat(40));
  assert.equal(row.attestation_absence, null);
  assert.ok(row.provider_receipt, "the receipt and the attestation share one row — that IS the trace");
  store.close();
});

test("a live surface that omitted its attestation binds as unreported, not the profile's", async () => {
  // Pre-upgrade hive-codex-live registers without the attestation field. The
  // profile on disk may attest a home the foreground turn never used
  // (Desktop split-state), so the row must say "unreported", never substitute.
  const profile = mkdtempSync(join(tmpdir(), "weave-live-"));
  writeFileSync(join(profile, ATTESTATION_FILENAME), JSON.stringify({
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + "c".repeat(64),
    actor: "ariadne",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: "9".repeat(40) },
  }));
  const broker = new FakeBroker([delivery(1, { subscription: subscription({ accountProfile: profile }) })]);
  const store = new EdgeStore(":memory:");
  const live = new LiveIngressRegistry();
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/x.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    // Required: a registration names its attestation or names its absence.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" },
  }, 60_000);
  const edge = new EdgeService(asBrokerClient(broker), store, live, [new StubAdapter({ liveResult: { processed: true, receipt: "live", outcome: "done" } })]);

  assert.equal(await edge.processOne(), true);
  const row = store.get(1)!;
  assert.equal(row.attestation_id, null);
  assert.equal(row.attestation_absence, "attestation_unreported");
  store.close();
});

test("a profile replaced between claim and provider start is re-read at start", async () => {
  // The last cell of {live, headless} × {claim, provider-start}: an installer
  // can replace the profile in the window between the claim-time capture and
  // the child actually spawning. The row must name what the turn ran under.
  const profile = mkdtempSync(join(tmpdir(), "weave-swap-"));
  const attestation = (id: string) => JSON.stringify({
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + id.repeat(64),
    actor: "ariadne",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: "9".repeat(40) },
  });
  writeFileSync(join(profile, ATTESTATION_FILENAME), attestation("a"));

  class SwappingBroker extends FakeBroker {
    override async accept(value: Delivery): Promise<Delivery> {
      writeFileSync(join(profile, ATTESTATION_FILENAME), attestation("b"));
      return super.accept(value);
    }
  }
  const broker = new SwappingBroker([delivery(1, { subscription: subscription({ accountProfile: profile }) })]);
  const store = new EdgeStore(":memory:");
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [new StubAdapter()]);

  assert.equal(await edge.processOne(), true);
  const row = store.get(1)!;
  assert.equal(row.status, "processed");
  assert.equal(row.attestation_id, "sha256:" + "b".repeat(64));
  store.close();
});

test("a seat with no attestation still wakes, and the delivery says why it is unbound", async () => {
  // Attestation is evidence, not authority: D1 ruled the surface before any
  // enforcement, so an unattested profile must never turn a wake into an outage.
  const broker = new FakeBroker([delivery(1, {
    subscription: subscription({ accountProfile: mkdtempSync(join(tmpdir(), "weave-bare-")) }),
  })]);
  const store = new EdgeStore(":memory:");
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [new StubAdapter()]);

  assert.equal(await edge.processOne(), true);
  const row = store.get(1)!;
  assert.equal(row.status, "processed");
  assert.equal(row.attestation_id, null);
  assert.equal(row.attestation_absence, "no_attestation_file");
  store.close();
});

test("a reinstall under a live session records the ambiguity instead of guessing an id", async () => {
  // The profile on disk can change while the session stays registered. The
  // surface re-reads it at every boundary, so the edge cannot tell a reinstall
  // under a still-running process from a crash-and-resume of the same session
  // under new artifacts. It names the ambiguity — and still dispatches.
  const live = new LiveIngressRegistry();
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/x.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    runtimeAttestation: {
      ok: true,
      attestation: {
        attestationId: "sha256:" + "a".repeat(64),
        doctrineCommit: "1".repeat(40),
        actor: "ariadne",
      },
    },
  }, 60_000);
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/x.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    runtimeAttestation: {
      ok: true,
      attestation: {
        attestationId: "sha256:" + "b".repeat(64),
        doctrineCommit: "2".repeat(40),
        actor: "ariadne",
      },
    },
  }, 60_000);

  const broker = new FakeBroker([delivery(1, {
    subscription: subscription({ wakePolicy: "live_only" }),
  })]);
  const store = new EdgeStore(":memory:");
  const edge = new EdgeService(asBrokerClient(broker), store, live, [new StubAdapter({
    liveResult: { receipt: "live:1", outcome: "ok", processed: true },
  })]);

  assert.equal(await edge.processOne(), true);
  const ambiguous = store.get(1)!;
  assert.equal(ambiguous.status, "processed", "an unattributable turn still wakes");
  assert.equal(ambiguous.attestation_id, null);
  assert.equal(ambiguous.attestation_absence, "attestation_ambiguous");
  store.close();
});

test("a live Desktop delivery binds to the surface's runtime home, not the pinned profile", async () => {
  // Split-state: HIVE_CODEX_DESKTOP_HOME ≠ accountProfile. Injection uses
  // Desktop; only that home's attestation names the artifacts the turn used.
  const pinned = mkdtempSync(join(tmpdir(), "weave-pinned-"));
  writeFileSync(join(pinned, ATTESTATION_FILENAME), JSON.stringify({
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + "c".repeat(64),
    actor: "ariadne",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: "1".repeat(40) },
  }));

  const live = new LiveIngressRegistry();
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/x.sock",
    sessionId: "desktop-task",
    surfaceVersion: "test",
    runtimeAttestation: {
      ok: true,
      attestation: {
        attestationId: "sha256:" + "d".repeat(64),
        doctrineCommit: "2".repeat(40),
        actor: "ariadne",
      },
    },
  }, 60_000);

  const broker = new FakeBroker([delivery(1, {
    subscription: subscription({ accountProfile: pinned, wakePolicy: "live_only" }),
  })]);
  const store = new EdgeStore(":memory:");
  const edge = new EdgeService(asBrokerClient(broker), store, live, [new StubAdapter({
    liveResult: { receipt: "live:1", outcome: "ok", processed: true },
  })]);

  assert.equal(await edge.processOne(), true);
  const row = store.get(1)!;
  assert.equal(row.attestation_id, "sha256:" + "d".repeat(64));
  assert.equal(row.doctrine_commit, "2".repeat(40));
  store.close();
});

test("a wake run from another seat's profile records the mismatch on the delivery", async () => {
  // The 2026-08-15 misbound-seat scar, now leaving evidence at wake time
  // rather than needing git forensics afterwards.
  const profile = mkdtempSync(join(tmpdir(), "weave-wrong-"));
  writeFileSync(join(profile, ATTESTATION_FILENAME), JSON.stringify({
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + "b".repeat(64),
    actor: "gnomon",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: "9".repeat(40) },
  }));

  const broker = new FakeBroker([delivery(1, { subscription: subscription({ accountProfile: profile }) })]);
  const store = new EdgeStore(":memory:");
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [new StubAdapter()]);

  assert.equal(await edge.processOne(), true);
  const row = store.get(1)!;
  assert.equal(row.attestation_absence, "attestation_actor_mismatch");
  assert.equal(row.attestation_id, "sha256:" + "b".repeat(64));
  store.close();
});

class MutatingAcceptBroker extends FakeBroker {
  constructor(queue: Delivery[], private readonly mutate: () => void) {
    super(queue);
  }

  override async accept(value: Delivery): Promise<Delivery> {
    this.mutate();
    return super.accept(value);
  }
}

test("dispatch keeps the live route captured at claim when the registry is replaced mid-accept", async () => {
  // accept/replay/beginDispatch are awaited after the binding is written.
  // A replacement there must not re-select: the receipt belongs to the
  // surface whose attestation is already on the row.
  const live = new LiveIngressRegistry();
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/claimed.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    runtimeAttestation: {
      ok: true,
      attestation: {
        attestationId: "sha256:" + "a".repeat(64),
        doctrineCommit: "1".repeat(40),
        actor: "ariadne",
      },
    },
  }, 60_000);

  const broker = new MutatingAcceptBroker(
    [delivery(1, { subscription: subscription({ wakePolicy: "live_only" }) })],
    () => {
      live.deregister("ariadne", "codex");
      live.register({
        actor: "ariadne",
        provider: "codex",
        socketPath: "/tmp/replacement.sock",
        sessionId: "thread-2",
        surfaceVersion: "test",
        runtimeAttestation: {
          ok: true,
          attestation: {
            attestationId: "sha256:" + "b".repeat(64),
            doctrineCommit: "2".repeat(40),
            actor: "ariadne",
          },
        },
      }, 60_000);
    },
  );
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter({
    liveResult: { receipt: "live:1", outcome: "ok", processed: true },
  });
  const edge = new EdgeService(asBrokerClient(broker), store, live, [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.deepEqual(adapter.liveSockets, ["/tmp/claimed.sock"]);
  assert.equal(adapter.spawns.length + adapter.resumes.length, 0);
  assert.equal(store.get(1)!.attestation_id, "sha256:" + "a".repeat(64));
  store.close();
});

test("a live route that expires after claim still dispatches to that surface, not headless", async () => {
  const live = new LiveIngressRegistry();
  live.register({
    actor: "ariadne",
    provider: "codex",
    socketPath: "/tmp/claimed.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    runtimeAttestation: {
      ok: true,
      attestation: {
        attestationId: "sha256:" + "a".repeat(64),
        doctrineCommit: "1".repeat(40),
        actor: "ariadne",
      },
    },
  }, 60_000);

  const broker = new MutatingAcceptBroker(
    [delivery(1)],
    () => { live.deregister("ariadne", "codex"); },
  );
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter({
    liveResult: { receipt: "live:1", outcome: "ok", processed: true },
  });
  const edge = new EdgeService(asBrokerClient(broker), store, live, [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.deepEqual(adapter.liveSockets, ["/tmp/claimed.sock"]);
  assert.equal(adapter.spawns.length + adapter.resumes.length, 0);
  assert.equal(store.get(1)!.attestation_id, "sha256:" + "a".repeat(64));
  store.close();
});

test("a live surface that appears after claim does not steal a headless dispatch", async () => {
  const pinned = mkdtempSync(join(tmpdir(), "weave-pinned-late-"));
  writeFileSync(join(pinned, ATTESTATION_FILENAME), JSON.stringify({
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + "c".repeat(64),
    actor: "ariadne",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: "3".repeat(40) },
  }));

  const live = new LiveIngressRegistry();
  const broker = new MutatingAcceptBroker(
    [delivery(1, { subscription: subscription({ accountProfile: pinned }) })],
    () => {
      live.register({
        actor: "ariadne",
        provider: "codex",
        socketPath: "/tmp/late.sock",
        sessionId: "desktop-task",
        surfaceVersion: "test",
        runtimeAttestation: {
          ok: true,
          attestation: {
            attestationId: "sha256:" + "d".repeat(64),
            doctrineCommit: "4".repeat(40),
            actor: "ariadne",
          },
        },
      }, 60_000);
    },
  );
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, live, [adapter]);

  assert.equal(await edge.processOne(), true);
  assert.equal(adapter.liveDeliveries.length, 0);
  assert.equal(adapter.resumes.length, 1);
  assert.equal(store.get(1)!.attestation_id, "sha256:" + "c".repeat(64));
  store.close();
});

class ResubscribingBroker extends FakeBroker {
  constructor(queue: Delivery[], private readonly upserted: Subscription) {
    super(queue);
  }

  // The broker rebuilds every transition's delivery by joining the live
  // `subscriptions` row, so an admin upsert shows up on the NEXT transition.
  override async accept(value: Delivery): Promise<Delivery> {
    return { ...await super.accept(value), subscription: this.upserted };
  }

  override async beginDispatch(value: Delivery): Promise<Delivery> {
    return { ...await super.beginDispatch(value), subscription: this.upserted };
  }
}

test("a subscription upsert between claim and dispatch neither re-routes nor re-binds the turn", async () => {
  // One snapshot governs the turn. Straddling two would file the receipt under
  // a profile the provider never loaded (account-profile change) or hand the
  // turn to an adapter the claim never selected (provider change) — both from
  // an ordinary `hive subscribe` re-run landing mid-turn.
  const record = (id: string, commit: string) => JSON.stringify({
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + id.repeat(64),
    actor: "ariadne",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: commit.repeat(40) },
  });
  const claimed = mkdtempSync(join(tmpdir(), "weave-claimed-sub-"));
  writeFileSync(join(claimed, ATTESTATION_FILENAME), record("a", "1"));
  const upserted = mkdtempSync(join(tmpdir(), "weave-upserted-sub-"));
  writeFileSync(join(upserted, ATTESTATION_FILENAME), record("b", "2"));

  const broker = new ResubscribingBroker(
    [delivery(1, { subscription: subscription({ accountProfile: claimed }) })],
    subscription({ provider: "claude", accountProfile: upserted }),
  );
  const store = new EdgeStore(":memory:");
  const adapter = new StubAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter]);

  assert.equal(await edge.processOne(), true);
  // Routing: the claimed provider's adapter ran. Under the upserted snapshot
  // there is no `claude` adapter, so the turn would have died pre-dispatch.
  assert.equal(adapter.resumes.length, 1);
  assert.deepEqual(broker.finishes.map((item) => item.result.status), ["processed"]);
  // Binding: the row names the profile the provider actually ran under.
  const row = store.get(1)!;
  assert.equal(row.attestation_id, "sha256:" + "a".repeat(64));
  assert.equal(row.doctrine_commit, "1".repeat(40));
  assert.equal(row.attestation_absence, null);
  store.close();
});
