import assert from "node:assert/strict";
import test from "node:test";
import { LiveBindingRegistrar, parseLiveDeliveryPayload } from "./live.js";

test("Codex live registration confirms the initial fence and serializes later renewals", async () => {
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
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "thread-1",
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

test("Codex live registration retries an exact renewal after a lost response", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (requests.length === 3) throw new Error("response lost after edge renewal");
    return Response.json({ bindingId: "edge-binding", bindingRevision: 1, expiresAt: 10_000 });
  };
  const registrar = new LiveBindingRegistrar(request, "http://edge", "ambient-token", {
    actor: "ariadne",
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "thread-1",
    surfaceVersion: "test",
    ttlMs: 30_000,
  }, () => 1_000);
  await registrar.refresh();

  await registrar.refresh();

  assert.deepEqual(
    requests.slice(2).map(({ bindingId, bindingRevision }) => ({ bindingId, bindingRevision })),
    [
      { bindingId: "edge-binding", bindingRevision: 1 },
      { bindingId: "edge-binding", bindingRevision: 1 },
    ],
  );
  assert.deepEqual(registrar.currentFence(), { bindingId: "edge-binding", bindingRevision: 1 });
});

test("Codex live registration immediately re-establishes after an edge restart", async () => {
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
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "thread-1",
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

test("Codex live registration fails a stale renewal with a fixed non-sensitive code", async () => {
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
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "thread-1",
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

test("Codex callback validates capability and exact fence without changing framed content", () => {
  const framed = "untrusted Slack frame";
  const parsed = parseLiveDeliveryPayload({
    delivery: { id: 41, leaseGeneration: 7, attempts: 1 },
    framed,
    ackCapability: "dispatch-capability",
    binding: { bindingId: "edge-binding", bindingRevision: 7 },
  }, { bindingId: "edge-binding", bindingRevision: 7 });

  assert.equal(parsed.framed, framed);
  assert.equal(parsed.ackCapability, "dispatch-capability");
  assert.throws(() => parseLiveDeliveryPayload({
    delivery: { id: 41, leaseGeneration: 7, attempts: 1 },
    framed,
    ackCapability: "dispatch-capability",
    binding: { bindingId: "edge-binding", bindingRevision: 6 },
  }, { bindingId: "edge-binding", bindingRevision: 7 }), { message: "live_binding_stale" });
});

test("Codex rejects an expired local binding before callback acceptance", async () => {
  let now = 1_000;
  const registrar = new LiveBindingRegistrar(async () => Response.json({
    bindingId: "edge-binding",
    bindingRevision: 1,
    expiresAt: 2_000,
  }), "http://edge", "ambient-token", {
    actor: "ariadne",
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/deliver",
    sessionId: "thread-1",
    surfaceVersion: "test",
    ttlMs: 30_000,
  }, () => now);
  await registrar.refresh();

  now = 2_000;

  assert.equal(registrar.currentFence(), null);
  assert.throws(() => parseLiveDeliveryPayload({
    delivery: { id: 41, leaseGeneration: 1, attempts: 1 },
    framed: "frame",
    ackCapability: "dispatch-capability",
    binding: { bindingId: "edge-binding", bindingRevision: 1 },
  }, registrar.currentFence()), { message: "live_binding_unavailable" });
});
