import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery, DeliveryResultInput, ReplaySnapshot, Subscription } from "../domain.js";
import type { Clock } from "../time.js";
import { BrokerClient } from "./broker-client.js";
import {
  DispatchCapabilityError,
  DispatchCapabilityRegistry,
  type DispatchCapabilityBinding,
} from "./dispatch-capability.js";
import { LiveIngressRegistry, type LiveIngress } from "./live-registry.js";
import {
  ProviderPreDispatchError,
  type ProviderAdapter,
  type ProviderDispatch,
} from "./providers.js";
import { headlessAcknowledgement, type EdgeTimers } from "./service.js";
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

type PoisonPhase = "accept" | "replay" | "beginDispatch" | "provider" | "finish";

for (const poisonPhase of ["accept", "replay", "beginDispatch", "provider", "finish"] as const) {
  test(`a ${poisonPhase} poison is isolated and the edge processes the next delivery`, async () => {
    const controller = new AbortController();
    const broker = new PoisonBroker([delivery(1), delivery(2, "fable")], poisonPhase, controller);
    const store = new EdgeStore(":memory:");
    const adapter = new PoisonAdapter(poisonPhase);
    const edge = new EdgeService(broker, store, new LiveIngressRegistry(), [adapter]);

    await edge.run(controller.signal);

    assert.deepEqual(broker.claimedIds, [1, 2]);
    assert.deepEqual(broker.claimedActors, ["ariadne", "fable"]);
    const first = broker.finishes.find((entry) => entry.deliveryId === 1);
    assert.equal(first?.result.status, ["provider", "finish"].includes(poisonPhase) ? "ambiguous" : "undeliverable");
    assert.equal(JSON.stringify(first).includes("secret-must-not-escape"), false);
    assert.equal(broker.finishes.at(-1)?.deliveryId, 2);
    assert.equal(broker.finishes.at(-1)?.result.status, "processed");
    assert.equal(store.get(2)?.status, "processed");
    store.close();
  });
}

test("live ACK authority is durably activated before provider ingress, exactly bound, single-use, and secret-negative", async () => {
  const events: string[] = [];
  const broker = new LiveBroker([liveDelivery(1), liveDelivery(2)], events);
  const store = new EdgeStore(":memory:");
  const clock = new MutableClock(1_000);
  const capabilities = new Map<number, string>();
  const registry = new RecordingDispatchCapabilities(store, broker, events, clock);
  const adapter = new LiveAdapter(async (_ingress, value, _framed, capability) => {
    capabilities.set(value.id, capability);
    events.push(`provider:${value.id}`);
    return { receipt: `live:${value.id}`, processed: false };
  });
  const live = liveRegistry(clock);
  const edge = new EdgeService(broker, store, live, [adapter], registry);

  await edge.processOne();
  await edge.processOne();

  const firstCapability = capabilities.get(1)!;
  const secondCapability = capabilities.get(2)!;
  assert.ok(firstCapability);
  assert.ok(secondCapability);
  assert.equal(JSON.stringify(store.delivery(1)).includes(firstCapability), false);
  assert.equal(JSON.stringify(store.delivery(2)).includes(secondCapability), false);
  assert.ok(events.indexOf("mark:1") < events.indexOf("activate:1"));
  assert.ok(events.indexOf("activate:1") < events.indexOf("provider:1"));
  assert.ok(events.indexOf("mark:2") < events.indexOf("activate:2"));
  assert.ok(events.indexOf("activate:2") < events.indexOf("provider:2"));

  await assert.rejects(
    () => edge.acknowledgeByCapability(2, firstCapability, "cross-delivery"),
    uniformCapabilityFailure,
  );
  await assert.rejects(
    () => edge.acknowledgeByCapability(1, "A".repeat(43), "forged"),
    uniformCapabilityFailure,
  );

  await edge.acknowledgeByCapability(1, firstCapability, "Handled one.");
  assert.equal(store.get(1)?.status, "processed");
  assert.deepEqual(broker.replies.at(-1), { deliveryId: 1, text: "Handled one." });
  assert.equal(broker.finishes.at(-1)?.result.status, "processed");
  await assert.rejects(
    () => edge.acknowledgeByCapability(1, firstCapability, "replay"),
    uniformCapabilityFailure,
  );

  // Operator reconciliation can requeue while the actor lease is still alive.
  // The resulting same-generation provider attempt must replace the local
  // coordinate and invalidate authority from the prior attempt.
  const replacementAttempt = { ...liveDelivery(2), attempts: 2 };
  store.receive(replacementAttempt, 1);
  store.setStatus(2, 1, "dispatched", "new-attempt");
  assert.equal(store.delivery(2)?.attempts, 2);
  await assert.rejects(
    () => edge.acknowledgeByCapability(2, secondCapability, "stale provider attempt"),
    uniformCapabilityFailure,
  );

  // A later lease generation likewise replaces the local binding.
  const replacement = { ...liveDelivery(2), leaseGeneration: 2, attempts: 3 };
  store.receive(replacement, 2);
  store.setStatus(2, 2, "dispatched", "new-attempt");
  await assert.rejects(
    () => edge.acknowledgeByCapability(2, secondCapability, "stale generation"),
    uniformCapabilityFailure,
  );

  store.close();
});

test("a live adapter can acknowledge synchronously after the single durable dispatch mark", async () => {
  const events: string[] = [];
  const broker = new LiveBroker([liveDelivery(20)], events);
  const store = new EdgeStore(":memory:");
  const clock = new MutableClock(1_000);
  const registry = new RecordingDispatchCapabilities(store, broker, events, clock);
  let edge!: EdgeService;
  const adapter = new LiveAdapter(async (_ingress, value, _framed, capability) => {
    events.push(`provider:${value.id}`);
    await edge.acknowledgeByCapability(value.id, capability, "synchronous ACK");
    return { receipt: "live:20", processed: false };
  });
  edge = new EdgeService(broker, store, liveRegistry(clock), [adapter], registry);

  await edge.processOne();

  assert.equal(broker.markCount, 1);
  assert.equal(store.get(20)?.status, "processed");
  assert.deepEqual(broker.replies, [{ deliveryId: 20, text: "synchronous ACK" }]);
  assert.equal(broker.finishes.length, 1);
  assert.equal(broker.finishes[0]?.result.status, "processed");
  assert.ok(events.indexOf("mark:20") < events.indexOf("activate:20"));
  assert.ok(events.indexOf("activate:20") < events.indexOf("provider:20"));
  store.close();
});

test("a live ACK capability expires with the injected lease clock", async () => {
  const broker = new LiveBroker([liveDelivery(3)], []);
  const store = new EdgeStore(":memory:");
  const clock = new MutableClock(1_000);
  const registry = new DispatchCapabilityRegistry({
    clock,
    tokenSource: () => Buffer.alloc(32, 7),
  });
  let capability = "";
  const adapter = new LiveAdapter(async (_ingress, _value, _framed, presented) => {
    capability = presented;
    return { receipt: "live:3", processed: false };
  });
  const edge = new EdgeService(broker, store, liveRegistry(clock), [adapter], registry);

  await edge.processOne();
  clock.advance(liveDelivery(3).subscription.leaseTtlMs);

  await assert.rejects(
    () => edge.acknowledgeByCapability(3, capability, "expired"),
    uniformCapabilityFailure,
  );
  assert.equal(store.get(3)?.status, "dispatched");
  assert.equal(broker.replies.length, 0);
  store.close();
});

test("a same-actor claim extends outstanding ACK authority for its shared lease generation", async () => {
  const broker = new LiveBroker([liveDelivery(5), liveDelivery(6)], []);
  const store = new EdgeStore(":memory:");
  const clock = new MutableClock(1_000);
  const registry = new DispatchCapabilityRegistry({
    clock,
    tokenSource: sequentialCapabilityTokens(),
  });
  const capabilities = new Map<number, string>();
  const adapter = new LiveAdapter(async (_ingress, value, _framed, capability) => {
    capabilities.set(value.id, capability);
    return { receipt: `live:${value.id}`, processed: false };
  });
  const edge = new EdgeService(broker, store, liveRegistry(clock), [adapter], registry);

  await edge.processOne();
  clock.advance(29_000);
  await edge.processOne();
  clock.advance(2_000);

  await edge.acknowledgeByCapability(5, capabilities.get(5)!, "renewed with actor lease");
  assert.equal(store.get(5)?.status, "processed");
  store.close();
});

test("a consumed capability stays consumed and ACK failure is promptly fenced ambiguous", async () => {
  const broker = new AckFailureBroker([liveDelivery(7)], []);
  const store = new EdgeStore(":memory:");
  const clock = new MutableClock(1_000);
  let capability = "";
  const adapter = new LiveAdapter(async (_ingress, _value, _framed, presented) => {
    capability = presented;
    return { receipt: "live:7", processed: false };
  });
  const edge = new EdgeService(broker, store, liveRegistry(clock), [adapter]);

  await edge.processOne();
  await assert.rejects(
    () => edge.acknowledgeByCapability(7, capability, "uncertain ACK"),
    /simulated Slack acknowledgement failure/,
  );

  assert.equal(broker.finishes.at(-1)?.result.status, "ambiguous");
  assert.equal(broker.finishes.at(-1)?.result.reasons[0]?.code, "provider_acknowledgement_unknown");
  assert.equal(store.get(7)?.status, "ambiguous");
  await assert.rejects(
    () => edge.acknowledgeByCapability(7, capability, "bearer must stay consumed"),
    uniformCapabilityFailure,
  );
  store.close();
});

for (const fixture of [
  {
    name: "live callback 4xx rejection",
    error: new ProviderPreDispatchError("live_ingress_rejected"),
    expectedStatus: "undeliverable" as const,
    expectedReason: "live_ingress_rejected",
  },
  {
    name: "live callback 5xx uncertainty",
    error: new Error("Codex live ingress 503"),
    expectedStatus: "ambiguous" as const,
    expectedReason: "provider_dispatch_unknown",
  },
] as const) {
  test(`${fixture.name} receives the correct durable disposition`, async () => {
    const value = liveDelivery(fixture.expectedStatus === "undeliverable" ? 8 : 9);
    const broker = new LiveBroker([value], []);
    const store = new EdgeStore(":memory:");
    const clock = new MutableClock(1_000);
    const adapter = new LiveAdapter(async () => { throw fixture.error; });
    const edge = new EdgeService(broker, store, liveRegistry(clock), [adapter]);

    await edge.processOne();

    assert.equal(broker.finishes.at(-1)?.result.status, fixture.expectedStatus);
    assert.equal(broker.finishes.at(-1)?.result.reasons[0]?.code, fixture.expectedReason);
    assert.equal(store.get(value.id)?.status, fixture.expectedStatus);
    store.close();
  });
}

test("an invalid permission profile is rejected before provider invocation or spawn reservation", async () => {
  const value = {
    ...delivery(10),
    subscription: {
      ...delivery(10).subscription,
      sessionId: null,
      wakePolicy: "spawn" as const,
      permissionProfile: "invalid-profile",
    },
  };
  const broker = new LiveBroker([value], []);
  const store = new EdgeStore(":memory:");
  const adapter = new InvalidPermissionAdapter();
  const edge = new EdgeService(broker, store, new LiveIngressRegistry(), [adapter]);

  await edge.processOne();

  assert.equal(adapter.invocations, 0);
  assert.equal(broker.spawnReservations, 0);
  assert.equal(broker.markCount, 0);
  assert.equal(broker.finishes.at(-1)?.result.status, "undeliverable");
  assert.equal(broker.finishes.at(-1)?.result.reasons[0]?.code, "provider_permission_profile_invalid");
  assert.equal(store.get(10)?.status, "undeliverable");
  store.close();
});

test("an in-flight lease renewal is drained before live dispatch completes", async () => {
  const events: string[] = [];
  const value = liveDelivery(4);
  const renew = deferred<Delivery>();
  const provider = deferred<ProviderDispatch>();
  const broker = new LiveBroker(
    [value],
    events,
    (renewed, renewal) => renewal === 1 ? Promise.resolve(renewed) : renew.promise,
  );
  const store = new EdgeStore(":memory:");
  const clock = new MutableClock(1_000);
  const timers = new ManualTimers();
  const registry = new RecordingDispatchCapabilities(store, broker, events, clock);
  const adapter = new LiveAdapter(async () => provider.promise);
  const edge = new EdgeService(
    broker,
    store,
    liveRegistry(clock),
    [adapter],
    registry,
    timers,
  );

  const processing = edge.processOne();
  await eventually(() => assert.equal(timers.pending, 1));
  await eventually(() => assert.equal(broker.marked, true));
  assert.equal(events.includes("activate:4"), true);
  timers.fire();
  await eventually(() => assert.equal(broker.renewals, 2));
  let completed = false;
  void processing.then(() => { completed = true; });
  provider.resolve({ receipt: "live:4", processed: false });
  await Promise.resolve();
  assert.equal(completed, false);

  renew.resolve(value);
  await processing;
  assert.ok(events.indexOf("renew:4:1") < events.indexOf("mark:4"));
  assert.ok(events.indexOf("mark:4") < events.indexOf("activate:4"));
  assert.ok(events.indexOf("activate:4") < events.indexOf("renew:4:2"));
  assert.ok(events.indexOf("renew:4:2") < events.lastIndexOf("scope:ariadne:1"));
  store.close();
});

class PoisonBroker extends BrokerClient {
  readonly claimedIds: number[] = [];
  readonly claimedActors: string[] = [];
  readonly finishes: Array<{ deliveryId: number; result: DeliveryResultInput }> = [];
  private finishPoisoned = false;

  constructor(
    private readonly queue: Delivery[],
    private readonly poisonPhase: PoisonPhase,
    private readonly controller: AbortController,
  ) {
    super("http://broker.invalid", "mac", "test-token");
  }

  override async claim(): Promise<Delivery | null> {
    const next = this.queue.shift() ?? null;
    if (next) {
      this.claimedIds.push(next.id);
      this.claimedActors.push(next.actor);
    }
    return next;
  }

  override async accept(value: Delivery): Promise<Delivery> {
    if (value.id === 1 && this.poisonPhase === "accept") throw new Error("poison payload: secret-must-not-escape");
    return { ...value, status: "accepted_local" };
  }

  override async replay(value: Delivery): Promise<ReplaySnapshot> {
    if (value.id === 1 && this.poisonPhase === "replay") throw new Error("poison replay: secret-must-not-escape");
    return {
      channelId: value.event.channelId,
      threadTs: value.event.threadTs,
      fetchedAt: "2026-08-01T00:00:00.000Z",
      cursor: null,
      messages: [],
    };
  }

  override async beginDispatch(value: Delivery): Promise<Delivery> {
    if (value.id === 1 && this.poisonPhase === "beginDispatch") throw new Error("poison transition: secret-must-not-escape");
    return { ...value, status: "dispatching" };
  }

  override async renew(value: Delivery): Promise<Delivery> {
    return value;
  }

  override async markDispatched(value: Delivery): Promise<Delivery> {
    return { ...value, status: "dispatched" };
  }

  override async reply(): Promise<string> {
    return "200.1";
  }

  override async finish(value: Delivery, result: DeliveryResultInput): Promise<Delivery> {
    if (
      value.id === 1
      && this.poisonPhase === "finish"
      && result.status === "processed"
      && !this.finishPoisoned
    ) {
      this.finishPoisoned = true;
      throw new Error("poison finish: secret-must-not-escape");
    }
    this.finishes.push({ deliveryId: value.id, result });
    if (value.id === 2 && result.status === "processed") this.controller.abort();
    return { ...value, status: result.status, reasons: result.reasons };
  }
}

class PoisonAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  private invocation = 0;

  constructor(private readonly poisonPhase: PoisonPhase) {}

  async deliverLive(_ingress: LiveIngress, _delivery: Delivery, _framed: string): Promise<ProviderDispatch> {
    throw new Error("unexpected live dispatch");
  }

  async resume(_subscription: Subscription, _cwd: string, _framed: string): Promise<ProviderDispatch> {
    this.invocation += 1;
    if (this.invocation === 1 && this.poisonPhase === "provider") {
      throw new Error("provider poison: secret-must-not-escape");
    }
    return { receipt: `receipt-${this.invocation}`, processed: true };
  }

  async spawn(_subscription: Subscription, _cwd: string, _framed: string): Promise<ProviderDispatch> {
    throw new Error("unexpected spawn dispatch");
  }
}

class LiveBroker extends BrokerClient {
  readonly replies: Array<{ deliveryId: number; text: string }> = [];
  readonly finishes: Array<{ deliveryId: number; result: DeliveryResultInput }> = [];
  renewals = 0;
  marked = false;
  markCount = 0;
  spawnReservations = 0;

  constructor(
    private readonly queue: Delivery[],
    private readonly events: string[],
    private readonly renewHook?: (value: Delivery, renewal: number) => Promise<Delivery>,
  ) {
    super("http://broker.invalid", "mac", "test-token");
  }

  override async claim(): Promise<Delivery | null> {
    return this.queue.shift() ?? null;
  }

  override async accept(value: Delivery): Promise<Delivery> {
    return { ...value, status: "accepted_local" };
  }

  override async replay(value: Delivery): Promise<ReplaySnapshot> {
    return {
      channelId: value.event.channelId,
      threadTs: value.event.threadTs,
      fetchedAt: "2026-08-01T00:00:00.000Z",
      cursor: null,
      messages: [],
    };
  }

  override async beginDispatch(value: Delivery): Promise<Delivery> {
    return { ...value, status: "dispatching" };
  }

  override async renew(value: Delivery): Promise<Delivery> {
    this.renewals += 1;
    this.events.push(`renew:${value.id}:${this.renewals}`);
    return this.renewHook ? this.renewHook(value, this.renewals) : value;
  }

  override async reserveSpawn(): Promise<boolean> {
    this.spawnReservations += 1;
    return true;
  }

  override async markDispatched(value: Delivery): Promise<Delivery> {
    this.marked = true;
    this.markCount += 1;
    this.events.push(`mark:${value.id}`);
    return { ...value, status: "dispatched" };
  }

  override async reply(value: Delivery, text: string): Promise<string> {
    this.replies.push({ deliveryId: value.id, text });
    return "200.1";
  }

  override async finish(value: Delivery, result: DeliveryResultInput): Promise<Delivery> {
    this.finishes.push({ deliveryId: value.id, result });
    return { ...value, status: result.status, reasons: result.reasons };
  }
}

class AckFailureBroker extends LiveBroker {
  override async reply(value: Delivery, text: string): Promise<string> {
    this.replies.push({ deliveryId: value.id, text });
    throw new Error("simulated Slack acknowledgement failure");
  }
}

class LiveAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;

  constructor(
    private readonly liveDispatch: (
      ingress: LiveIngress,
      delivery: Delivery,
      framed: string,
      capability: string,
    ) => Promise<ProviderDispatch>,
  ) {}

  deliverLive(
    ingress: LiveIngress,
    value: Delivery,
    framed: string,
    capability: string,
  ): Promise<ProviderDispatch> {
    return this.liveDispatch(ingress, value, framed, capability);
  }

  async resume(): Promise<ProviderDispatch> {
    throw new Error("unexpected resume dispatch");
  }

  async spawn(): Promise<ProviderDispatch> {
    throw new Error("unexpected spawn dispatch");
  }
}

class InvalidPermissionAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  invocations = 0;

  preflight(): void {
    throw new ProviderPreDispatchError("provider_permission_profile_invalid");
  }

  async deliverLive(): Promise<ProviderDispatch> {
    this.invocations += 1;
    throw new Error("unexpected live dispatch");
  }

  async resume(): Promise<ProviderDispatch> {
    this.invocations += 1;
    throw new Error("unexpected resume dispatch");
  }

  async spawn(): Promise<ProviderDispatch> {
    this.invocations += 1;
    throw new Error("unexpected spawn dispatch");
  }
}

class MutableClock implements Clock {
  constructor(private currentMs: number) {}

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  value(): number {
    return this.currentMs;
  }
}

class RecordingDispatchCapabilities extends DispatchCapabilityRegistry {
  constructor(
    private readonly store: EdgeStore,
    private readonly broker: LiveBroker,
    private readonly events: string[],
    clock: Clock,
  ) {
    super({ clock, tokenSource: sequentialCapabilityTokens() });
  }

  override activate(capability: string, binding: DispatchCapabilityBinding): void {
    assert.equal(this.broker.marked, true);
    assert.equal(this.store.get(binding.deliveryId)?.status, "dispatched");
    this.events.push(`activate:${binding.deliveryId}`);
    super.activate(capability, binding);
  }

  override renewLeaseScope(leaseKey: string, generation: number, ttlMs: number): number {
    this.events.push(`scope:${leaseKey}:${generation}`);
    return super.renewLeaseScope(leaseKey, generation, ttlMs);
  }
}

class ManualTimers implements EdgeTimers {
  private callbacks: Array<() => void> = [];
  private nextHandle = 1;

  get pending(): number {
    return this.callbacks.length;
  }

  set(callback: () => void): unknown {
    this.callbacks.push(callback);
    return this.nextHandle++;
  }

  clear(_handle: unknown): void {
    this.callbacks = [];
  }

  fire(): void {
    const callback = this.callbacks.shift();
    assert.ok(callback, "expected a scheduled heartbeat");
    callback();
  }
}

function liveRegistry(clock: MutableClock): LiveIngressRegistry {
  const live = new LiveIngressRegistry({
    now: () => clock.value(),
    createBindingId: () => "binding-1",
  });
  const registration = {
    actor: "ariadne",
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "thread-1",
    surfaceVersion: "test",
  } as const;
  const pending = live.register(registration, 120_000);
  live.renew(registration, pending, 120_000);
  return live;
}

function liveDelivery(id: number): Delivery {
  return {
    ...delivery(id),
    subscription: {
      ...delivery(id).subscription,
      providerSurface: "codex-app-server",
      wakePolicy: "live_only",
      leaseTtlMs: 30_000,
    },
  };
}

function sequentialCapabilityTokens(): () => Uint8Array {
  let next = 0;
  return () => Buffer.alloc(32, ++next);
}

function uniformCapabilityFailure(error: unknown): boolean {
  assert.ok(error instanceof DispatchCapabilityError);
  assert.equal(error.message, "invalid_dispatch_capability");
  return true;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

function delivery(id: number, actor = "ariadne"): Delivery {
  return {
    id,
    eventId: `Ev${id}`,
    actor,
    status: "claimed",
    reasons: [],
    leaseGeneration: 1,
    claimedBy: "mac",
    attempts: 1,
    coalesceKey: `${actor}:C1:${id}`,
    coalescedEventIds: [`Ev${id}`],
    initialSnapshot: null,
    snapshotTs: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    subscription: {
      actor,
      provider: "codex",
      providerSurface: "headless-exec",
      providerVersion: "test",
      sessionId: "thread-1",
      homeEdge: "mac",
      workspace: "hive",
      edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
      wakePolicy: "resume",
      permissionProfile: "read-only",
      leaseTtlMs: 30_000,
      deliveryTtlMs: 300_000,
      homeGraceMs: 30_000,
      spawnRateLimit: 1,
      expiresAt: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    event: {
      eventId: `Ev${id}`,
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100.1",
      messageTs: `100.${id}`,
      senderId: "U1",
      senderKind: "user",
      actor,
      text: `WAKE: ${actor} | test`,
      raw: { type: "message" },
      receivedAt: "2026-08-01T00:00:00.000Z",
    },
  };
}
