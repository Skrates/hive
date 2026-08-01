import assert from "node:assert/strict";
import test from "node:test";
import {
  LiveIngressRegistry,
  LiveIngressRegistryError,
  type LiveIngressRegistration,
} from "./live-registry.js";

test("identical pending registration retries return the same edge-issued fence", () => {
  const fixture = registryFixture();

  const registered = fixture.registry.register(registration(), 1_000);

  assert.deepEqual(registered, {
    ...registration(),
    bindingId: "binding-1",
    bindingRevision: 1,
    expiresAt: 2_000,
  });
  assert.equal(fixture.registry.get("ariadne", "codex"), null);
  fixture.advance(250);

  const retried = fixture.registry.register(registration(), 1_000);

  assert.deepEqual(retried, {
    ...registration(),
    bindingId: "binding-1",
    bindingRevision: 1,
    expiresAt: 2_250,
  });
  assert.equal(fixture.issuedIds(), 1);
  assert.equal(fixture.registry.get("ariadne", "codex"), null);

  const confirmed = fixture.registry.renew(registration(), retried, 1_000);
  assert.equal(fixture.registry.get("ariadne", "codex"), confirmed);
});

test("a pending registration cannot be retargeted while preserving its fence", () => {
  const fixture = registryFixture();
  const registered = fixture.registry.register(registration(), 1_000);

  assertRegistryError(
    () => fixture.registry.register(
      { ...registration(), callbackUrl: "http://127.0.0.1:9002/callback" },
      1_000,
    ),
    "live_binding_stale",
  );
  assert.equal(fixture.issuedIds(), 1);
  assert.equal(fixture.registry.get("ariadne", "codex"), null);

  const confirmed = fixture.registry.renew(registration(), registered, 1_000);
  assert.equal(fixture.registry.get("ariadne", "codex"), confirmed);
});

test("an active binding cannot be replaced by registration", () => {
  const fixture = registryFixture();
  const registered = fixture.registry.register(registration(), 1_000);
  const confirmed = fixture.registry.renew(registration(), registered, 1_000);

  assertRegistryError(
    () => fixture.registry.register({ ...registration(), callbackUrl: "http://127.0.0.1:9002/callback" }, 1_000),
    "live_binding_active",
  );
  assert.equal(fixture.registry.get("ariadne", "codex"), confirmed);
  assert.equal(fixture.issuedIds(), 1);
});

test("callers cannot mutate the registry's current binding through a returned entry", () => {
  const fixture = registryFixture();
  const registered = fixture.registry.register(registration(), 1_000);
  const confirmed = fixture.registry.renew(registration(), registered, 1_000);

  assert.throws(() => {
    (registered as { bindingRevision: number }).bindingRevision = 99;
  }, TypeError);
  assert.throws(() => {
    (confirmed as { bindingRevision: number }).bindingRevision = 99;
  }, TypeError);
  assert.equal(fixture.registry.get("ariadne", "codex")?.bindingRevision, 1);
});

test("renewal compare-and-swaps the exact binding coordinate without changing its epoch", () => {
  const fixture = registryFixture();
  const first = fixture.registry.register(registration(), 1_000);
  fixture.advance(250);

  const renewed = fixture.registry.renew(
    registration(),
    { bindingId: first.bindingId, bindingRevision: first.bindingRevision },
    2_000,
  );

  assert.equal(renewed.bindingId, first.bindingId);
  assert.equal(renewed.bindingRevision, 1);
  assert.equal(renewed.expiresAt, 3_250);
  assert.equal(renewed.sessionId, "session-1");
  assert.equal(fixture.issuedIds(), 1);
});

test("renewal cannot retarget an existing binding epoch", () => {
  const fixture = registryFixture();
  const first = fixture.registry.register(registration(), 1_000);
  const confirmed = fixture.registry.renew(registration(), first, 1_000);

  for (const changed of [
    { ...registration(), callbackUrl: "http://127.0.0.1:9002/callback" },
    { ...registration(), sessionId: "session-2" },
    { ...registration(), surfaceVersion: "2" },
  ]) {
    assertRegistryError(
      () => fixture.registry.renew(changed, first, 1_000),
      "live_binding_stale",
    );
  }
  assert.equal(fixture.registry.get("ariadne", "codex"), confirmed);
});

test("a stale renewal fails closed without changing the current binding", () => {
  const fixture = registryFixture();
  const first = fixture.registry.register(registration(), 1_000);
  const second = fixture.registry.renew(
    registration(),
    { bindingId: first.bindingId, bindingRevision: first.bindingRevision },
    1_000,
  );

  assertRegistryError(
    () => fixture.registry.renew(
      { ...registration(), callbackUrl: "http://127.0.0.1:9002/callback" },
      { bindingId: first.bindingId, bindingRevision: first.bindingRevision + 1 },
      1_000,
    ),
    "live_binding_stale",
  );
  assertRegistryError(
    () => fixture.registry.renew(
      registration(),
      { bindingId: "not-the-current-binding", bindingRevision: second.bindingRevision },
      1_000,
    ),
    "live_binding_stale",
  );
  assert.equal(fixture.registry.get("ariadne", "codex"), second);
});

test("expired bindings disappear and cannot be renewed", () => {
  const fixture = registryFixture();
  const first = fixture.registry.register(registration(), 1_000);
  fixture.advance(1_000);

  assert.equal(fixture.registry.get("ariadne", "codex"), null);
  assertRegistryError(
    () => fixture.registry.renew(
      registration(),
      { bindingId: first.bindingId, bindingRevision: first.bindingRevision },
      1_000,
    ),
    "live_binding_unavailable",
  );
  assert.equal(fixture.registry.get("ariadne", "codex"), null);
});

test("registration after expiry gets a new id and a strictly greater revision", () => {
  const fixture = registryFixture();
  const first = fixture.registry.register(registration(), 1_000);
  const renewed = fixture.registry.renew(
    registration(),
    { bindingId: first.bindingId, bindingRevision: first.bindingRevision },
    1_000,
  );
  fixture.advance(1_000);

  const replacement = fixture.registry.register(registration(), 1_000);

  assert.equal(replacement.bindingId, "binding-2");
  assert.ok(replacement.bindingRevision > renewed.bindingRevision);
  assert.equal(replacement.bindingRevision, 2);
});

test("registry failures expose only stable non-sensitive codes", () => {
  const fixture = registryFixture();
  const first = fixture.registry.register(registration(), 1_000);

  const secret = "secret-must-not-escape";
  const error = captureError(() => fixture.registry.renew(
    { ...registration(), callbackUrl: `http://127.0.0.1/${secret}` },
    { bindingId: secret, bindingRevision: first.bindingRevision },
    1_000,
  ));
  assert.ok(error instanceof LiveIngressRegistryError);
  assert.equal(error.code, "live_binding_stale");
  assert.equal(error.message.includes(secret), false);
});

function registration(): LiveIngressRegistration {
  return {
    actor: "ariadne",
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/callback",
    sessionId: "session-1",
    surfaceVersion: "1",
  };
}

function registryFixture(): {
  registry: LiveIngressRegistry;
  advance(ms: number): void;
  issuedIds(): number;
} {
  let now = 1_000;
  let issuedIds = 0;
  return {
    registry: new LiveIngressRegistry({
      now: () => now,
      createBindingId: () => `binding-${++issuedIds}`,
    }),
    advance: (ms) => { now += ms; },
    issuedIds: () => issuedIds,
  };
}

function assertRegistryError(
  operation: () => unknown,
  code: LiveIngressRegistryError["code"],
): void {
  const error = captureError(operation);
  assert.ok(error instanceof LiveIngressRegistryError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to throw");
}
