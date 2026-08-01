import assert from "node:assert/strict";
import test from "node:test";
import { DispatchCapabilityError } from "./dispatch-capability.js";
import { EdgeHttpServer } from "./http.js";
import { LiveIngressRegistry } from "./live-registry.js";
import type { EdgeService } from "./service.js";

const LOCAL_TOKEN = "local-token-must-not-escape";
const VALID_CAPABILITY = "A".repeat(43);

test("live registration uses local auth and renews only with the exact fence", async () => {
  const live = new LiveIngressRegistry({
    now: () => 1_000,
    createBindingId: () => "binding-1",
  });
  const fixture = await httpFixture({ live });
  try {
    const unauthorized = await post(fixture.url, "/v1/live/register", "wrong-local-secret", registration());
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(unauthorized.body, { error: "unauthorized" });
    assert.equal(unauthorized.text.includes("wrong-local-secret"), false);
    assert.equal(unauthorized.text.includes(LOCAL_TOKEN), false);

    const registered = await post(fixture.url, "/v1/live/register", LOCAL_TOKEN, registration());
    assert.equal(registered.status, 200);
    assert.equal(registered.body.bindingId, "binding-1");
    assert.equal(registered.body.bindingRevision, 1);
    assert.equal(live.get("ariadne", "codex"), null);

    const renewed = await post(fixture.url, "/v1/live/register", LOCAL_TOKEN, {
      ...registration(),
      bindingId: registered.body.bindingId,
      bindingRevision: registered.body.bindingRevision,
    });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.bindingId, "binding-1");
    assert.equal(renewed.body.bindingRevision, 1);
    assert.equal(renewed.body.sessionId, "session-1");
    assert.equal(live.get("ariadne", "codex")?.bindingId, "binding-1");

    const staleSecret = "stale-binding-secret-must-not-escape";
    const stale = await post(fixture.url, "/v1/live/register", LOCAL_TOKEN, {
      ...registration(),
      bindingId: staleSecret,
      bindingRevision: 1,
    });
    assert.equal(stale.status, 400);
    assert.deepEqual(stale.body, { error: "live_binding_stale" });
    assert.equal(stale.text.includes(staleSecret), false);
    assert.equal(stale.text.includes(LOCAL_TOKEN), false);

    const partialFence = await post(fixture.url, "/v1/live/register", LOCAL_TOKEN, {
      ...registration(),
      bindingId: "binding-1",
    });
    assert.equal(partialFence.status, 400);
    assert.deepEqual(partialFence.body, { error: "invalid bindingRevision" });

    const callbackSecret = "callback-secret-must-not-escape";
    const malformedCallback = await post(fixture.url, "/v1/live/register", LOCAL_TOKEN, {
      ...registration(),
      callbackUrl: `http://[${callbackSecret}`,
      bindingId: registered.body.bindingId,
      bindingRevision: registered.body.bindingRevision,
    });
    assert.equal(malformedCallback.status, 400);
    assert.deepEqual(malformedCallback.body, { error: "invalid callbackUrl" });
    assert.equal(malformedCallback.text.includes(callbackSecret), false);
  } finally {
    await fixture.server.stop();
  }
});

test("live ACK uses its Bearer as a dispatch capability and collapses auth failures", async () => {
  const calls: Array<{ deliveryId: number; capability: string; text: string }> = [];
  const fixture = await httpFixture({
    acknowledgeByCapability: async (deliveryId, capability, text) => {
      calls.push({ deliveryId, capability, text });
      if (capability === VALID_CAPABILITY) return;
      const error = new DispatchCapabilityError();
      error.message = `rejected ${capability}`;
      throw error;
    },
  });
  try {
    const acknowledged = await post(fixture.url, "/v1/live/ack", VALID_CAPABILITY, {
      deliveryId: 7,
      text: "Handled.",
    });
    assert.equal(acknowledged.status, 200);
    assert.deepEqual(acknowledged.body, { ok: true });
    assert.deepEqual(calls[0], {
      deliveryId: 7,
      capability: VALID_CAPABILITY,
      text: "Handled.",
    });

    const rejected = await post(fixture.url, "/v1/live/ack", LOCAL_TOKEN, {
      deliveryId: 7,
      text: "Handled.",
    });
    assert.equal(rejected.status, 401);
    assert.deepEqual(rejected.body, { error: "invalid_dispatch_capability" });
    assert.equal(rejected.text.includes(LOCAL_TOKEN), false);
    assert.equal(rejected.text.includes("rejected"), false);
    assert.equal(calls[1]?.capability, LOCAL_TOKEN);

    const missing = await fetch(`${fixture.url}/v1/live/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: 7, text: "Handled." }),
    });
    const missingText = await missing.text();
    assert.equal(missing.status, 401);
    assert.deepEqual(JSON.parse(missingText), { error: "invalid_dispatch_capability" });
    assert.equal(missingText.includes(LOCAL_TOKEN), false);
    assert.equal(calls.length, 2);
  } finally {
    await fixture.server.stop();
  }
});

test("health remains unauthenticated", async () => {
  const fixture = await httpFixture();
  try {
    const response = await fetch(`${fixture.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await fixture.server.stop();
  }
});

test("downstream failures are collapsed without reflecting secrets", async () => {
  const secret = "downstream-secret-must-not-escape";
  const fixture = await httpFixture({
    acknowledgeByCapability: async () => { throw new Error(secret); },
  });
  try {
    const response = await post(fixture.url, "/v1/live/ack", VALID_CAPABILITY, {
      deliveryId: 7,
      text: "Handled.",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "edge_request_failed" });
    assert.equal(response.text.includes(secret), false);
  } finally {
    await fixture.server.stop();
  }
});

function registration(): Record<string, unknown> {
  return {
    actor: "ariadne",
    provider: "codex",
    callbackUrl: "http://127.0.0.1:9001/callback",
    sessionId: "session-1",
    surfaceVersion: "1",
    ttlMs: 30_000,
  };
}

async function httpFixture(overrides: Partial<HttpEdge> = {}): Promise<{
  server: EdgeHttpServer;
  url: string;
}> {
  const edge: HttpEdge = {
    live: new LiveIngressRegistry(),
    acknowledgeByCapability: async () => undefined,
    ...overrides,
  };
  const server = new EdgeHttpServer(edge as unknown as EdgeService, {
    host: "127.0.0.1",
    port: 0,
    localToken: LOCAL_TOKEN,
  });
  const address = await server.start();
  return { server, url: `http://${address.host}:${address.port}` };
}

interface HttpEdge {
  live: LiveIngressRegistry;
  acknowledgeByCapability(deliveryId: number, capability: string, text: string): Promise<void>;
}

async function post(
  url: string,
  path: string,
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}
