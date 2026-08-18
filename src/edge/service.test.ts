import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATTESTATION_FILENAME } from "./attestation.js";
import type { Delivery, DeliveryResultInput, Reason, ReplaySnapshot, Subscription } from "../domain.js";
import type { BrokerClient } from "./broker-client.js";
import { LiveIngressRegistry, type LiveIngress } from "./live-registry.js";
import {
  CHILD_KILL_GRACE_MS,
  dispatchDeadlineAt,
  LIVE_CANCEL_CONFIRM_MS,
  ProviderPreDispatchError,
  type ProviderAdapter,
  type ProviderDispatch,
} from "./providers.js";
import { headlessAcknowledgement, HeadlessStreamReader } from "./providers.js";
import { CANCEL_CONFIRM_MS, EDGE_TEARDOWN_GRACE_MS, EdgeService, type EdgeTimers } from "./service.js";
import { EdgeStore, type AttestationBinding } from "./store.js";
import { EdgeLivenessWatchdog } from "./watchdog.js";

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

  async resume(_subscription: Subscription, _cwd: string, framed: string): Promise<ProviderDispatch> {
    if (this.behavior.dispatchError) throw this.behavior.dispatchError;
    this.resumes.push(framed);
    return this.behavior.headlessResult ?? { receipt: JSON.stringify({ type: "result", result: "resumed" }), outcome: "resumed", processed: true };
  }

  async spawn(_subscription: Subscription, _cwd: string, framed: string, _signal?: AbortSignal): Promise<ProviderDispatch> {
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
    override async spawn(sub: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
      if (sub.actor === "gnomon") {
        await slowTurn;
        return { receipt: JSON.stringify({ type: "result", result: "slow done" }), outcome: "slow done", processed: true };
      }
      return super.spawn(sub, cwd, framed);
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
    override async spawn(sub: Subscription, cwd: string, framed: string): Promise<ProviderDispatch> {
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

/**
 * Virtual clock for the run loop. Every wait inside `EdgeService` — the empty-poll
 * backoff, the capacity park, the lease heartbeat, the dispatch deadline — goes
 * through the injected timers, so the three-hour bounds under test are exercised
 * deterministically instead of being asserted at a scaled-down stand-in.
 */
class FakeTimers implements EdgeTimers {
  private current = 1_000_000;
  private sequence = 0;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  set(callback: () => void, delayMs: number): unknown {
    const id = (this.sequence += 1);
    this.pending.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Advance the virtual clock, firing due callbacks in time order and draining microtasks between each. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (let guard = 0; guard < 200_000; guard += 1) {
      let next: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.pending.entries()) {
        if (entry[1].at <= target && (next === null || entry[1].at < next[1].at)) next = entry;
      }
      if (next === null) break;
      this.pending.delete(next[0]);
      this.current = next[1].at;
      next[1].callback();
      await flush();
    }
    this.current = target;
    await flush();
  }

  /** Advance in bounded steps until `reached` holds, or give up at `maxMs` of virtual time. */
  async advanceUntil(reached: () => boolean, maxMs: number, stepMs = 30_000): Promise<boolean> {
    await flush();
    for (let elapsed = 0; elapsed < maxMs; elapsed += stepMs) {
      if (reached()) return true;
      await this.advance(stepMs);
    }
    return reached();
  }
}

/** Let every pending microtask and immediate callback settle. */
async function flush(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Wait until `reached` holds, yielding to the event loop between checks.
 *
 * Every dispatch now awaits `readWakeAttestation` before the provider starts, so
 * "the dispatch started" is gated on real filesystem I/O, not on a countable
 * number of microtask turns. `flush(3)` happened to cover one pending read on a
 * warm local disk and did not cover two in CI. Bounded by rounds rather than
 * wall clock so it cannot flake against its own timer.
 */
async function until(reached: () => boolean, rounds = 500): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    if (reached()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return reached();
}

const THREE_HOURS_MS = 3 * 60 * 60_000;

/**
 * A dispatch that never settles on its own — the incident's provider child.
 * `hangsFor` names which actors wedge; everyone else runs the ordinary stub, so
 * a test can prove the loop recovered by watching an unrelated actor complete.
 */
class HangingAdapter extends StubAdapter {
  readonly signals: Array<AbortSignal | undefined> = [];

  /**
   * `stopAfterMs` is how long the provider takes to ACTUALLY stop once the edge
   * aborts it — a live-surface interrupt is 10-15s of real work, a process
   * group takes its SIGTERM grace. `null` models a provider that never stops,
   * which is what the edge's cancellation bound has to survive. Timers are the
   * virtual clock, so these delays cost no wall time.
   */
  constructor(
    private readonly hangsFor: (actor: string) => boolean = () => true,
    private readonly stopAfterMs: number | null = 0,
    private readonly timers?: EdgeTimers,
  ) {
    super();
  }

  override spawn(sub: Subscription, cwd: string, framed: string, signal?: AbortSignal): Promise<ProviderDispatch> {
    if (!this.hangsFor(sub.actor)) return super.spawn(sub, cwd, framed, signal);
    this.signals.push(signal);
    return new Promise<ProviderDispatch>((_resolve, reject) => {
      // Never settles on its own: the whole point. Only the edge's deadline can
      // end it — and then only after this provider has finished stopping.
      if (this.stopAfterMs === null) return;
      const stopAfterMs = this.stopAfterMs;
      const timers = this.timers;
      const stop = (): void => { reject(new Error("provider turn stopped at the edge's abort")); };
      signal?.addEventListener("abort", () => {
        if (stopAfterMs === 0 || timers === undefined) stop();
        else timers.set(stop, stopAfterMs);
      }, { once: true });
    });
  }
}

function hangingDelivery(id: number, actor: string): Delivery {
  return delivery(id, {
    actor,
    coalesceKey: `${actor}:C1:100.${id}`,
    subscription: subscription({ actor, sessionId: null }),
  });
}

test("a dispatch that outlives the wall-clock deadline is aborted, and released only once it has stopped", async () => {
  // The 2026-08-15 wedge in miniature: a provider turn that neither exits nor
  // errors held its slot forever while the lease heartbeat renewed the broker's
  // fence underneath it, so nothing anywhere could reclaim the delivery.
  //
  // This turn takes 8s to actually stop after the abort — the cost of a real
  // interrupt. The fence must be held for those 8s: releasing on the abort
  // itself makes the delivery eligible for retry (5s backoff) while the
  // original turn is still executing.
  const timers = new FakeTimers();
  const broker = new FakeBroker([hangingDelivery(40, "gnomon")]);
  const store = new EdgeStore(":memory:");
  const adapter = new HangingAdapter(() => true, 8_000, timers);
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter], timers);

  const done = edge.processOne();
  let settled = false;
  void done.then(() => { settled = true; });
  assert.ok(await until(() => adapter.signals.length === 1), "the dispatch started");
  assert.equal(adapter.signals[0]?.aborted, false, "and is not aborted before its deadline");
  assert.equal(dispatchDeadlineAt(adapter.signals[0]), 1_000_000 + THREE_HOURS_MS);

  // Just short of the bound, the turn is still running and untouched.
  await timers.advance(THREE_HOURS_MS - 1_000);
  assert.equal(settled, false, "a long turn inside the bound is not killed");
  assert.equal(broker.releases.length, 0);

  await timers.advance(2_000);
  assert.equal(adapter.signals[0]?.aborted, true, "the provider is asked to kill its child");
  assert.equal(settled, false, "the dispatch is still held while the provider stops");
  assert.equal(broker.releases.length, 0, "the fence outlives the abort, not just the send");

  await timers.advance(8_000);
  assert.equal(await done, true);
  assert.equal(broker.releases.length, 1);
  assert.equal(broker.releases[0]?.reason.code, "dispatch_deadline_exceeded");
  assert.equal(broker.finishes.length, 0, "uncertainty releases; it never declares an outcome");
  assert.equal(store.get(40)?.status, "released");
  store.close();
});

test("a provider that never stops releases as an UNCONFIRMED cancellation, once the bound expires", async () => {
  // The other half of the ordering contract: waiting for the stop must itself
  // be bounded, or the fence-hold rebuilds the park this whole change removes.
  // What the bound may not do is call the result clean — the turn may still be
  // running, and the reason has to say so (R-3).
  const timers = new FakeTimers();
  const broker = new FakeBroker([hangingDelivery(41, "gnomon")]);
  const store = new EdgeStore(":memory:");
  const adapter = new HangingAdapter(() => true, null);
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter], timers);

  const done = edge.processOne();
  assert.ok(await until(() => adapter.signals.length === 1), "the dispatch started");
  await timers.advance(THREE_HOURS_MS + 1_000);
  assert.equal(adapter.signals[0]?.aborted, true);
  assert.equal(broker.releases.length, 0, "an unanswering provider still holds the fence inside the bound");

  await timers.advance(CANCEL_CONFIRM_MS);
  assert.equal(await done, true);
  assert.equal(broker.releases.length, 1);
  assert.equal(broker.releases[0]?.reason.code, "dispatch_cancellation_unconfirmed");
  assert.match(broker.releases[0]?.reason.detail ?? "", /could not confirm it stopped/);
  assert.equal(store.get(41)?.status, "released");
  store.close();
});

test("the teardown clocks are ordered: exit grace > cancellation bound > every far-side stop", () => {
  // Each of these bounds waits for the one below it. A grace that slipped under
  // the stop it waits for is a check that cannot fire for its reason: the exit
  // would kill the edge mid-interrupt and orphan the turn it was stopping.
  assert.ok(EDGE_TEARDOWN_GRACE_MS > CANCEL_CONFIRM_MS, "the supervisor exit outlasts the cancellation bound");
  assert.ok(CANCEL_CONFIRM_MS > LIVE_CANCEL_CONFIRM_MS, "the cancellation bound outlasts a live-surface receipt");
  assert.ok(CANCEL_CONFIRM_MS > CHILD_KILL_GRACE_MS, "and outlasts a headless SIGTERM grace");
  // The live receipt in turn outlasts the far side's own interrupt timeouts:
  // 10s on the Codex app-server, 15s on the Desktop IPC client.
  assert.ok(LIVE_CANCEL_CONFIRM_MS > 15_000, "the receipt outlasts the slowest provider interrupt");
});

test("the edge command's supervisor teardown uses the ordered grace, not the child-kill grace", () => {
  // The watchdog exit path is wired in the CLI, where no unit test reaches the
  // timer. Assert the wiring at the source: a default or a stale constant here
  // is exactly how this bound silently reverted to 5.5s.
  const cli = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
  assert.match(cli, /setTimeout\(\(\) => process\.exit\(code\), EDGE_TEARDOWN_GRACE_MS\)/);
  // Strip comments first: the prose ABOVE that wiring names the old constant,
  // and an absence assertion that matches its own documentation proves nothing.
  const code = cli.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /CHILD_KILL_GRACE_MS \+ 500/);
});

test("with every dispatch slot hung, a newly published delivery is still claimed once the bound elapses", async () => {
  // The acceptance criterion: four hung dispatches used to park the run loop on
  // `Promise.race(this.inFlight)` permanently, and the fifth delivery was never
  // claimed. Bounding the park alone does NOT fix this — the loop would re-park
  // forever — so this test is the honest joint check of the deadline and the park.
  const timers = new FakeTimers();
  const queue = [
    hangingDelivery(50, "alpha"),
    hangingDelivery(51, "beta"),
    hangingDelivery(52, "gamma"),
    hangingDelivery(53, "delta"),
  ];
  const broker = new FakeBroker(queue);
  const store = new EdgeStore(":memory:");
  const wedged = new Set(["alpha", "beta", "gamma", "delta"]);
  const adapter = new HangingAdapter((actor) => wedged.has(actor));
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter], timers);

  const controller = new AbortController();
  const run = edge.run(controller.signal);
  assert.ok(await until(() => adapter.signals.length === 4), "all four slots are occupied by hung turns");
  assert.equal(edge.saturated(), true);

  // A fresh delivery arrives for a fifth actor while the edge is wedged.
  queue.push(delivery(54, {
    actor: "epsilon",
    coalesceKey: "epsilon:C1:100.54",
    subscription: subscription({ actor: "epsilon", sessionId: null }),
  }));
  await timers.advance(CAPACITY_PARK_PROBE_MS);
  assert.ok(!broker.finishes.some((f) => f.deliveryId === 54), "still wedged before the bound");

  const claimed = await timers.advanceUntil(
    () => broker.finishes.some((f) => f.deliveryId === 54 && f.result.status === "processed"),
    THREE_HOURS_MS + 10 * 60_000,
  );
  assert.ok(claimed, "the fifth delivery is claimed and processed once the hung slots time out");
  assert.equal(broker.releases.filter((r) => r.reason.code === "dispatch_deadline_exceeded").length, 4);
  controller.abort();
  await timers.advanceUntil(() => false, 60_000);
  await run;
  store.close();
});

/** One capacity park plus a margin — long enough to prove the loop re-parked rather than progressed. */
const CAPACITY_PARK_PROBE_MS = 90_000;

test("abortActiveDispatches tears down in-flight turns before a watchdog exit would kill the process", async () => {
  // One to three headless turns can be running while the loop is still
  // considered unsaturated. process.exit() used to skip their abort
  // controllers, leaving detached process groups behind the restart.
  const timers = new FakeTimers();
  const broker = new FakeBroker([
    hangingDelivery(70, "gnomon"),
    hangingDelivery(71, "theoros"),
  ]);
  const store = new EdgeStore(":memory:");
  const adapter = new HangingAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter], timers);

  const controller = new AbortController();
  const run = edge.run(controller.signal);
  assert.ok(await until(() => adapter.signals.length === 2), "both dispatches started");
  assert.equal(adapter.signals.every((signal) => signal?.aborted === false), true);

  edge.abortActiveDispatches();
  assert.equal(adapter.signals.every((signal) => signal?.aborted === true), true);

  const released = await timers.advanceUntil(
    () => broker.releases.length === 2,
    60_000,
  );
  assert.ok(released, "aborted dispatches reach a release disposition");
  // A watchdog/shutdown abort is the edge's own cancellation, not a deadline:
  // the thread notice must not claim the provider exceeded 180 minutes.
  assert.equal(broker.releases.every((item) => item.reason.code === "dispatch_cancelled_by_edge"), true);

  controller.abort();
  await timers.advanceUntil(() => false, 60_000);
  await run;
  store.close();
});

test("a healthy long dispatch keeps the loop polling, so the watchdog reads healthy throughout", async () => {
  // The regression guard on the watchdog: one slow turn with slots still free
  // must never look like a wedge. The loop keeps claiming, so `lastPollAt`
  // keeps advancing even though the turn never ends.
  const timers = new FakeTimers();
  const broker = new FakeBroker([hangingDelivery(60, "gnomon")]);
  const store = new EdgeStore(":memory:");
  const adapter = new HangingAdapter();
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [adapter], timers);

  const exits: number[] = [];
  const watchdog = new EdgeLivenessWatchdog({
    lastPollAt: () => edge.lastPollAt(),
    saturated: () => edge.saturated(),
    exit: (code) => { exits.push(code); },
    now: () => timers.now(),
    log: () => {},
  }, 300_000);

  const controller = new AbortController();
  const run = edge.run(controller.signal);
  assert.ok(await until(() => adapter.signals.length === 1), "the slow turn is running");

  for (let cycle = 0; cycle < 4; cycle += 1) {
    await timers.advance(300_000);
    assert.equal(watchdog.check(), "healthy");
  }
  assert.deepEqual(exits, [], "a slow turn is never mistaken for a deaf edge");
  assert.ok(edge.lastPollAt()! > 1_000_000, "the loop went on polling under the slow turn");

  controller.abort();
  await timers.advanceUntil(() => false, THREE_HOURS_MS + 60_000);
  await run;
  store.close();
});

test("a broker poll that throws leaves the last-poll stamp standing, so the wedge window keeps running", async () => {
  // `lastPollAt` is evidence of REACHING the broker. A loop spinning on claim
  // errors is exactly as deaf as one that never returns; stamping on the
  // attempt would make the watchdog a check that cannot fail for its reason.
  const timers = new FakeTimers();
  const store = new EdgeStore(":memory:");
  class FailingBroker extends FakeBroker {
    override async claim(): Promise<Delivery | null> {
      throw new Error("connect ECONNREFUSED");
    }
  }
  const broker = new FailingBroker([]);
  const edge = new EdgeService(asBrokerClient(broker), store, new LiveIngressRegistry(), [new StubAdapter()], timers);

  assert.equal(edge.lastPollAt(), null);
  const controller = new AbortController();
  const run = edge.run(controller.signal);
  await timers.advance(600_000);
  assert.equal(edge.lastPollAt(), null, "a throwing poll never counts as reaching the broker");

  controller.abort();
  await timers.advanceUntil(() => false, 60_000);
  await run;
  store.close();
});

test("the headless stream reader stays bounded across a stream far larger than its buffer", async () => {
  // The 15.1G RSS: `runHeadless` kept every chunk of every child's stdout for
  // the whole turn and then used the last 4 000 characters. A 77-minute Claude
  // turn under `--verbose` echoes every tool result into that stream.
  const reader = new HeadlessStreamReader(4_000);
  reader.write(`${JSON.stringify({ type: "result", subtype: "success", result: "the answer" })}\n`);
  const noise = `${JSON.stringify({ type: "user", message: "x".repeat(50_000) })}\n`;
  let peakRetained = 0;
  for (let line = 0; line < 400; line += 1) {
    reader.write(noise);
    peakRetained = Math.max(peakRetained, reader.retainedChars());
  }
  reader.finish();

  assert.ok(noise.length * 400 > 20_000_000, "the probe stream really is large");
  assert.ok(peakRetained <= 4_000 + noise.length, `retained ${peakRetained} characters`);
  // Bounded memory must not cost the extraction: the answer arrived in the very
  // first line, tens of megabytes before the end of the stream.
  assert.equal(reader.outcome(), "the answer");
  assert.equal(reader.receipt().length, 4_000);
});

test("the stream reader parses lines split across chunk boundaries, including mid-codepoint", async () => {
  // A chunked stream splits wherever the pipe does, not where JSON does. The
  // old whole-buffer reader never had to care; this one does.
  const reader = new HeadlessStreamReader(4_000);
  const line = `${JSON.stringify({ type: "result", subtype: "success", result: "héllo — ✅" })}\n`;
  const bytes = Buffer.from(line, "utf8");
  for (let index = 0; index < bytes.length; index += 3) {
    reader.push(bytes.subarray(index, index + 3));
  }
  reader.finish();
  assert.equal(reader.outcome(), "héllo — ✅");
});

test("an unbounded single line is dropped and counted rather than buffered", async () => {
  // A line with no newline in sight is the one shape that could reintroduce the
  // growth this reader exists to bound. It is dropped loudly, and the surrounding
  // stream still parses.
  const reader = new HeadlessStreamReader(4_000);
  reader.write("{\"type\":\"user\",\"text\":\"");
  for (let chunk = 0; chunk < 30; chunk += 1) reader.write("y".repeat(100_000));
  reader.write("\"}\n");
  assert.ok(reader.retainedChars() <= 4_000 + 1_000_000, `retained ${reader.retainedChars()} characters`);
  reader.write(`${JSON.stringify({ type: "result", subtype: "success", result: "still parsing" })}\n`);
  reader.finish();
  assert.equal(reader.droppedLines, 1);
  assert.equal(reader.outcome(), "still parsing");
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
