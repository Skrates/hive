import assert from "node:assert/strict";
import test from "node:test";
import type { Clock } from "../time.js";
import {
  DispatchCapabilityError,
  DispatchCapabilityRegistry,
  INVALID_DISPATCH_CAPABILITY,
  type DispatchCapabilityBinding,
  type DispatchCapabilityTokenSource,
} from "./dispatch-capability.js";

const BINDING: DispatchCapabilityBinding = {
  deliveryId: 41,
  generation: 8,
  providerAttempt: 3,
};
const LEASE_KEY = "ariadne";

class FakeClock implements Clock {
  constructor(private currentMs: number) {}

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

function sequentialTokens(): DispatchCapabilityTokenSource {
  let next = 0;
  return () => Buffer.alloc(32, ++next);
}

function harness(startMs = 1_000): {
  clock: FakeClock;
  registry: DispatchCapabilityRegistry;
} {
  const clock = new FakeClock(startMs);
  return {
    clock,
    registry: new DispatchCapabilityRegistry({ clock, tokenSource: sequentialTokens() }),
  };
}

function assertInvalid(operation: () => unknown, secrets: string[] = []): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof DispatchCapabilityError);
    assert.equal(error.code, INVALID_DISPATCH_CAPABILITY);
    assert.equal(error.message, INVALID_DISPATCH_CAPABILITY);
    for (const secret of secrets) assert.equal(error.message.includes(secret), false);
    return true;
  });
}

test("minted bearer is opaque, digest-stored, exactly bound, and consumable once", () => {
  const { registry } = harness();
  const minted = registry.mint(BINDING, 500, LEASE_KEY);

  assert.match(minted.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.expiresAt, 1_500);

  const entries = Reflect.get(registry, "entries") as Map<string, unknown>;
  assert.equal(entries.has(minted.capability), false);
  assert.equal(entries.size, 1);
  assert.match([...entries.keys()][0]!, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify([...entries]).includes(minted.capability), false);

  // The callback may receive the bearer before broker-side dispatched state is
  // durable, but it has no authority until the edge explicitly activates it.
  assertInvalid(() => registry.consume(minted.capability, BINDING));
  registry.activate(minted.capability, BINDING);
  registry.consume(minted.capability, BINDING);
  assertInvalid(
    () => registry.consume(minted.capability, BINDING),
    [minted.capability, String(BINDING.deliveryId)],
  );
});

test("forged and every incorrectly bound bearer fail with the same non-sensitive error", () => {
  const { registry } = harness();
  const { capability } = registry.mint(BINDING, 500, LEASE_KEY);
  const failures: Array<[string, DispatchCapabilityBinding]> = [
    ["A".repeat(43), BINDING],
    [capability, { ...BINDING, deliveryId: BINDING.deliveryId + 1 }],
    [capability, { ...BINDING, generation: BINDING.generation - 1 }],
    [capability, { ...BINDING, providerAttempt: BINDING.providerAttempt + 1 }],
  ];

  for (const [presented, binding] of failures) {
    assertInvalid(
      () => registry.consume(presented, binding),
      [presented, capability, String(binding.deliveryId), String(binding.generation)],
    );
  }

  // A mismatched presentation does not consume the legitimate dispatch's authority.
  registry.activate(capability, BINDING);
  registry.consume(capability, BINDING);
});

test("capability expires exactly at its injected lease horizon and cannot be renewed", () => {
  const { clock, registry } = harness();
  const { capability } = registry.mint(BINDING, 500, LEASE_KEY);

  clock.advance(500);
  assertInvalid(() => registry.consume(capability, BINDING), [capability]);
  assertInvalid(() => registry.renewWithLease(capability, BINDING, 1_000), [capability]);
});

test("lease renewal resets expiry from the injected clock", () => {
  const { clock, registry } = harness();
  const { capability } = registry.mint(BINDING, 100, LEASE_KEY);

  clock.advance(75);
  assert.equal(registry.renewWithLease(capability, BINDING, 200), 1_275);
  registry.activate(capability, BINDING);
  clock.advance(199);
  registry.consume(capability, BINDING);
});

test("activation is exactly bound and cannot revive an expired capability", () => {
  const { clock, registry } = harness();
  const { capability } = registry.mint(BINDING, 100, LEASE_KEY);

  assertInvalid(() => registry.activate(
    capability,
    { ...BINDING, generation: BINDING.generation + 1 },
  ));
  registry.activate(capability, BINDING);
  registry.activate(capability, BINDING);
  clock.advance(100);
  assertInvalid(() => registry.activate(capability, BINDING));
  assertInvalid(() => registry.consume(capability, BINDING));
});

test("wrongly bound renewal fails closed without changing the legitimate lease", () => {
  const { clock, registry } = harness();
  const { capability } = registry.mint(BINDING, 100, LEASE_KEY);

  clock.advance(75);
  assertInvalid(() => registry.renewWithLease(
    capability,
    { ...BINDING, providerAttempt: BINDING.providerAttempt + 1 },
    1_000,
  ));
  clock.advance(25);
  assertInvalid(() => registry.consume(capability, BINDING));
});

test("revocation is idempotent and indistinguishable from expiry or replay", () => {
  const { registry } = harness();
  const { capability } = registry.mint(BINDING, 500, LEASE_KEY);

  registry.revoke(capability);
  registry.revoke(capability);
  registry.revoke("not-a-capability");
  assertInvalid(() => registry.consume(capability, BINDING), [capability]);
});

test("mint retries a digest collision without retaining either plaintext bearer", () => {
  const first = Buffer.alloc(32, 1);
  const second = Buffer.alloc(32, 2);
  const outputs = [first, first, second];
  let calls = 0;
  const registry = new DispatchCapabilityRegistry({
    clock: new FakeClock(1_000),
    tokenSource: () => outputs[calls++]!,
  });

  const one = registry.mint(BINDING, 500, LEASE_KEY);
  const two = registry.mint({ ...BINDING, providerAttempt: 4 }, 500, LEASE_KEY);
  assert.notEqual(one.capability, two.capability);
  assert.equal(calls, 3);

  const entries = Reflect.get(registry, "entries") as Map<string, unknown>;
  const serialized = JSON.stringify([...entries]);
  assert.equal(serialized.includes(one.capability), false);
  assert.equal(serialized.includes(two.capability), false);
});

test("lease-scoped renewal extends every outstanding capability for only that actor generation", () => {
  const { clock, registry } = harness();
  const sameScopeOne = BINDING;
  const sameScopeTwo = { ...BINDING, deliveryId: 42, providerAttempt: 4 };
  const otherActor = { ...BINDING, deliveryId: 43, providerAttempt: 5 };
  const otherGeneration = { ...BINDING, deliveryId: 44, generation: 9, providerAttempt: 6 };
  const one = registry.mint(sameScopeOne, 100, LEASE_KEY);
  const two = registry.mint(sameScopeTwo, 100, LEASE_KEY);
  const fable = registry.mint(otherActor, 100, "fable");
  const newerGeneration = registry.mint(otherGeneration, 100, LEASE_KEY);
  for (const [minted, binding] of [
    [one, sameScopeOne],
    [two, sameScopeTwo],
    [fable, otherActor],
    [newerGeneration, otherGeneration],
  ] as const) {
    registry.activate(minted.capability, binding);
  }

  clock.advance(75);
  assert.equal(registry.renewLeaseScope(LEASE_KEY, BINDING.generation, 300), 2);
  clock.advance(25);

  registry.consume(one.capability, sameScopeOne);
  registry.consume(two.capability, sameScopeTwo);
  assertInvalid(() => registry.consume(fable.capability, otherActor));
  assertInvalid(() => registry.consume(newerGeneration.capability, otherGeneration));
});

test("lease-scoped renewal cannot revive expired entries and expiry pruning is observable", () => {
  const { clock, registry } = harness();
  const expiredBinding = BINDING;
  const survivorBinding = { ...BINDING, deliveryId: 42, providerAttempt: 4 };
  const expired = registry.mint(expiredBinding, 100, LEASE_KEY);
  const survivor = registry.mint(survivorBinding, 500, LEASE_KEY);

  clock.advance(100);
  assert.equal(registry.renewLeaseScope(LEASE_KEY, BINDING.generation, 300), 1);
  assertInvalid(() => registry.activate(expired.capability, expiredBinding));
  assert.equal(registry.pruneExpired(), 0);

  const separatelyExpiredBinding = { ...BINDING, deliveryId: 43, providerAttempt: 5 };
  const separatelyExpired = registry.mint(separatelyExpiredBinding, 50, "fable");
  clock.advance(50);
  assert.equal(registry.pruneExpired(), 1);
  assertInvalid(() => registry.activate(separatelyExpired.capability, separatelyExpiredBinding));

  registry.activate(survivor.capability, survivorBinding);
  registry.consume(survivor.capability, survivorBinding);
});
