import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery, DeliveryResultInput, Reason, ReplaySnapshot, Subscription } from "../domain.js";
import type { BrokerClient } from "./broker-client.js";
import { LiveIngressRegistry, type LiveIngress } from "./live-registry.js";
import {
  ProviderPreDispatchError,
  type ProviderAdapter,
  type ProviderDispatch,
} from "./providers.js";
import { headlessAcknowledgement } from "./providers.js";
import { EdgeService } from "./service.js";
import { EdgeStore } from "./store.js";

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

  async claim(): Promise<Delivery | null> {
    return this.queue.shift() ?? null;
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
  readonly liveDeliveries: number[] = [];
  readonly liveFrames: string[] = [];

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

  async deliverLive(_ingress: LiveIngress, value: Delivery, framed: string): Promise<ProviderDispatch> {
    if (this.behavior.dispatchError) throw this.behavior.dispatchError;
    this.liveDeliveries.push(value.id);
    this.liveFrames.push(framed);
    return this.behavior.liveResult ?? { receipt: `live:${value.id}`, processed: false };
  }

  async resume(_subscription: Subscription, _cwd: string, framed: string): Promise<ProviderDispatch> {
    if (this.behavior.dispatchError) throw this.behavior.dispatchError;
    this.resumes.push(framed);
    return this.behavior.headlessResult ?? { receipt: JSON.stringify({ type: "result", result: "resumed" }), outcome: "resumed", processed: true };
  }

  async spawn(_subscription: Subscription, _cwd: string, framed: string): Promise<ProviderDispatch> {
    if (this.behavior.dispatchError) throw this.behavior.dispatchError;
    this.spawns.push(framed);
    return this.behavior.headlessResult ?? { receipt: JSON.stringify({ type: "result", result: "spawned" }), outcome: "spawned", processed: true };
  }
}

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
  store.receive(delivery(5), 1);
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
  store.receive(delivery(6), 1);
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
  store.receive(delivery(7), 1);
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
