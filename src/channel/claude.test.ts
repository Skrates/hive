import assert from "node:assert/strict";
import test from "node:test";
import type { Delivery } from "../domain.js";
import { AckCapabilityStore, LiveBindingRegistrar, parseLiveDeliveryPayload } from "./claude.js";

test("Claude live registration confirms the initial fence and serializes later renewals", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let active = 0;
  let maxActive = 0;
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return Response.json({
      bindingId: "edge-binding",
      bindingRevision: 1,
      expiresAt: 10_000,
    });
  };
  const registrar = new LiveBindingRegistrar(request, "http://edge", "ambient-token", {
    actor: "ariadne",
    provider: "claude",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "session-1",
    surfaceVersion: "test",
    ttlMs: 30_000,
  }, () => 1_000);

  const initial = await registrar.refresh();
  await Promise.all([registrar.refresh(), registrar.refresh()]);

  assert.equal(maxActive, 1);
  assert.deepEqual(
    requests.map(({ bindingId, bindingRevision }) => ({ bindingId, bindingRevision })),
    [
      { bindingId: undefined, bindingRevision: undefined },
      { bindingId: "edge-binding", bindingRevision: 1 },
      { bindingId: "edge-binding", bindingRevision: 1 },
      { bindingId: "edge-binding", bindingRevision: 1 },
    ],
  );
  assert.deepEqual(initial, { bindingId: "edge-binding", bindingRevision: 1, expiresAt: 10_000 });
  assert.deepEqual(registrar.currentFence(), { bindingId: "edge-binding", bindingRevision: 1 });
});

test("Claude live registration retries a lost initial response with identical input", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (requests.length === 1) throw new Error("response lost after edge registration");
    return Response.json({ bindingId: "edge-binding", bindingRevision: 1, expiresAt: 10_000 });
  };
  const registrar = new LiveBindingRegistrar(request, "http://edge", "ambient-token", {
    actor: "ariadne",
    provider: "claude",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "session-1",
    surfaceVersion: "test",
    ttlMs: 30_000,
  }, () => 1_000);

  await registrar.refresh();

  assert.deepEqual(
    requests.map(({ bindingId, bindingRevision }) => ({ bindingId, bindingRevision })),
    [
      { bindingId: undefined, bindingRevision: undefined },
      { bindingId: undefined, bindingRevision: undefined },
      { bindingId: "edge-binding", bindingRevision: 1 },
    ],
  );
  assert.deepEqual(registrar.currentFence(), { bindingId: "edge-binding", bindingRevision: 1 });
});

test("Claude live registration immediately re-establishes after an edge restart", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let edgeBinding: { bindingId: string; bindingRevision: number } | null = null;
  let nextBinding = 1;
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.bindingId !== undefined) {
      if (
        !edgeBinding
        || body.bindingId !== edgeBinding.bindingId
        || body.bindingRevision !== edgeBinding.bindingRevision
      ) {
        return Response.json({ error: "live_binding_unavailable" }, { status: 400 });
      }
      return Response.json({ ...edgeBinding, expiresAt: 10_000 });
    }
    edgeBinding = { bindingId: `edge-binding-${nextBinding++}`, bindingRevision: 1 };
    return Response.json({ ...edgeBinding, expiresAt: 10_000 });
  };
  const registrar = new LiveBindingRegistrar(request, "http://edge", "ambient-token", {
    actor: "ariadne",
    provider: "claude",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "session-1",
    surfaceVersion: "test",
    ttlMs: 30_000,
  }, () => 1_000);

  await registrar.refresh();
  edgeBinding = null;
  const recovered = await registrar.refresh();

  assert.deepEqual(recovered, {
    bindingId: "edge-binding-2",
    bindingRevision: 1,
    expiresAt: 10_000,
  });
  assert.deepEqual(
    requests.map(({ bindingId, bindingRevision }) => ({ bindingId, bindingRevision })),
    [
      { bindingId: undefined, bindingRevision: undefined },
      { bindingId: "edge-binding-1", bindingRevision: 1 },
      { bindingId: "edge-binding-1", bindingRevision: 1 },
      { bindingId: undefined, bindingRevision: undefined },
      { bindingId: "edge-binding-2", bindingRevision: 1 },
    ],
  );
  assert.deepEqual(registrar.currentFence(), { bindingId: "edge-binding-2", bindingRevision: 1 });
});

test("Claude live registration fails a stale renewal with a fixed non-sensitive code", async () => {
  let requestCount = 0;
  const secret = "edge-detail-must-not-escape";
  const request = async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount === 3) {
      return Response.json({ error: "live_binding_stale", detail: secret }, { status: 400 });
    }
    return Response.json({ bindingId: "edge-binding", bindingRevision: 1, expiresAt: 10_000 });
  };
  const registrar = new LiveBindingRegistrar(request, "http://edge", "ambient-token", {
    actor: "ariadne",
    provider: "claude",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "session-1",
    surfaceVersion: "test",
    ttlMs: 30_000,
  }, () => 1_000);
  await registrar.refresh();

  await assert.rejects(registrar.refresh(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "live_binding_stale");
    assert.equal(error.message.includes(secret), false);
    return true;
  });

  assert.equal(requestCount, 3);
  assert.equal(registrar.currentFence(), null);
});

test("Claude callback payload requires the exact live binding fence", () => {
  const payload = {
    delivery: { id: 41, leaseGeneration: 7, attempts: 1 },
    framed: "untrusted Slack frame",
    ackCapability: "dispatch-capability",
    binding: { bindingId: "edge-binding", bindingRevision: 7 },
  };

  assert.equal(
    parseLiveDeliveryPayload(payload, { bindingId: "edge-binding", bindingRevision: 7 }).ackCapability,
    "dispatch-capability",
  );
  const secret = "secret-stale-binding";
  const error = captureError(() => parseLiveDeliveryPayload(
    { ...payload, binding: { bindingId: secret, bindingRevision: 7 } },
    { bindingId: "edge-binding", bindingRevision: 7 },
  ));
  assert.ok(error instanceof Error);
  assert.equal(error.message, "live_binding_stale");
  assert.equal(error.message.includes(secret), false);
});

test("Claude ACK uses the retained dispatch capability as Bearer authority", async () => {
  const store = new AckCapabilityStore();
  store.retain(delivery(41, 7, 1), "dispatch-capability");
  let authorization: string | null = null;
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    authorization = new Headers(init.headers).get("authorization");
    return Response.json({ ok: true });
  };

  const coordinate = { deliveryId: 41, generation: 7, providerAttempt: 1 };
  await store.acknowledge(request, "http://edge", coordinate, "handled");

  assert.equal(authorization, "Bearer dispatch-capability");
  await assert.rejects(
    store.acknowledge(request, "http://edge", coordinate, "duplicate"),
    { message: "unknown_hive_delivery" },
  );
});

test("Claude ACK authority follows actor-lease renewal and expires fail-closed", async () => {
  let now = 1_000;
  const store = new AckCapabilityStore(() => now);
  store.retain(delivery(41, 7, 1, 100), "capability-41");
  now = 1_090;
  store.retain(delivery(42, 7, 1, 100), "capability-42");

  const authorizations: Array<string | null> = [];
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    authorizations.push(new Headers(init.headers).get("authorization"));
    return Response.json({ ok: true });
  };
  now = 1_101;
  await store.acknowledge(
    request,
    "http://edge",
    { deliveryId: 41, generation: 7, providerAttempt: 1 },
    "handled after actor lease extension",
  );
  assert.deepEqual(authorizations, ["Bearer capability-41"]);

  now = 1_190;
  await assert.rejects(
    store.acknowledge(
      request,
      "http://edge",
      { deliveryId: 42, generation: 7, providerAttempt: 1 },
      "expired",
    ),
    { message: "unknown_hive_delivery" },
  );
  assert.equal(authorizations.length, 1);
});

test("Claude ACK authority drops lower generations and requires the exact coordinate", async () => {
  const store = new AckCapabilityStore(() => 1_000);
  const secret = "stale-capability-must-not-escape";
  store.retain(delivery(41, 7, 1), secret);
  store.retain(delivery(42, 8, 1), "current-capability");
  let requestCount = 0;
  const request = async (): Promise<Response> => {
    requestCount += 1;
    return Response.json({ ok: true });
  };

  for (const coordinate of [
    { deliveryId: 41, generation: 7, providerAttempt: 1 },
    { deliveryId: 42, generation: 8, providerAttempt: 2 },
  ]) {
    await assert.rejects(
      store.acknowledge(request, "http://edge", coordinate, "must fail"),
      { message: "unknown_hive_delivery" },
    );
  }
  const error = captureError(() => store.retain(delivery(43, 7, 1), "another-stale-capability"));
  assert.ok(error instanceof Error);
  assert.equal(error.message, "live_delivery_stale");
  assert.equal(error.message.includes(secret), false);
  assert.equal(requestCount, 0);
});

test("Claude rejects a delayed lower provider attempt before model notification", () => {
  const store = new AckCapabilityStore(() => 1_000);
  let notifications = 0;
  const notify = (value: Delivery, capability: string): void => {
    // The live callback retains authority before invoking mcp.notification.
    // A stale retain therefore has to throw before this counter can advance.
    store.retain(value, capability);
    notifications += 1;
  };

  notify(delivery(41, 7, 2), "current-attempt-capability");
  const error = captureError(() => notify(delivery(41, 7, 1), "delayed-stale-capability"));

  assert.ok(error instanceof Error);
  assert.equal(error.message, "live_delivery_stale");
  assert.equal(notifications, 1);
});

function delivery(
  id: number,
  generation: number,
  providerAttempt: number,
  leaseTtlMs = 30_000,
): Delivery {
  return {
    id,
    actor: "ariadne",
    leaseGeneration: generation,
    attempts: providerAttempt,
    subscription: { leaseTtlMs },
  } as unknown as Delivery;
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to throw");
}
