import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import type { Delivery, Provider } from "../domain.js";
import type { LiveIngress } from "./live-registry.js";
import {
  ClaudeProvider,
  CodexProvider,
  ProviderPreDispatchError,
  type ProviderAdapter,
} from "./providers.js";

const LOCAL_TOKEN = "local-token-must-not-escape";
const ACK_CAPABILITY = "ack-capability-must-not-escape";
const FRAMED = "explicitly untrusted framed Slack material";

const PROVIDERS: ReadonlyArray<{
  name: string;
  provider: Provider;
  create(): ProviderAdapter;
}> = [
  { name: "Codex", provider: "codex", create: () => new CodexProvider(LOCAL_TOKEN) },
  { name: "Claude", provider: "claude", create: () => new ClaudeProvider(LOCAL_TOKEN) },
];

for (const fixture of PROVIDERS) {
  test(`${fixture.name} live dispatch carries scoped ACK authority and exact binding fence`, async () => {
    let requestBody: unknown = null;
    let authorization: string | undefined;
    const callback = await startLoopback(async (request, response) => {
      authorization = request.headers.authorization;
      requestBody = await readJson(request);
      json(response, 200, {
        receipt: `${fixture.provider}-accepted`,
        // A callback may include unrelated reflected fields. The provider adapter
        // admits only the receipt into its result.
        ackCapability: ACK_CAPABILITY,
      });
    });

    try {
      const value = delivery(fixture.provider);
      const ingress = liveIngress(fixture.provider, callback.url);
      const result = await fixture.create().deliverLive(ingress, value, FRAMED, ACK_CAPABILITY);

      assert.equal(authorization, `Bearer ${LOCAL_TOKEN}`);
      assert.deepEqual(requestBody, {
        delivery: value,
        framed: FRAMED,
        ackCapability: ACK_CAPABILITY,
        binding: {
          bindingId: ingress.bindingId,
          bindingRevision: ingress.bindingRevision,
        },
      });
      assert.deepEqual(result, { receipt: `${fixture.provider}-accepted`, processed: false });
      assert.equal(JSON.stringify(result).includes(ACK_CAPABILITY), false);
      assert.equal(JSON.stringify(result).includes(LOCAL_TOKEN), false);
    } finally {
      await callback.close();
    }
  });

  test(`${fixture.name} live callback errors never reflect capability-bearing response bodies`, async () => {
    const callback = await startLoopback(async (request, response) => {
      const body = await readJson(request) as { ackCapability?: unknown };
      response.writeHead(503, { "content-type": "text/plain" });
      response.end(`hostile reflection: ${String(body.ackCapability)} ${request.headers.authorization ?? ""}`);
    });

    try {
      await assert.rejects(
        fixture.create().deliverLive(
          liveIngress(fixture.provider, callback.url),
          delivery(fixture.provider),
          FRAMED,
          ACK_CAPABILITY,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error instanceof ProviderPreDispatchError, false);
          assert.equal(error.message, `${fixture.name} live ingress 503`);
          assert.equal(error.message.includes(ACK_CAPABILITY), false);
          assert.equal(error.message.includes(LOCAL_TOKEN), false);
          return true;
        },
      );
    } finally {
      await callback.close();
    }
  });

  test(`${fixture.name} classifies a callback 4xx as a deterministic no-turn rejection`, async () => {
    const callback = await startLoopback(async (request, response) => {
      const body = await readJson(request) as { ackCapability?: unknown };
      response.writeHead(422, { "content-type": "text/plain" });
      response.end(`hostile reflection: ${String(body.ackCapability)} ${request.headers.authorization ?? ""}`);
    });

    try {
      await assert.rejects(
        fixture.create().deliverLive(
          liveIngress(fixture.provider, callback.url),
          delivery(fixture.provider),
          FRAMED,
          ACK_CAPABILITY,
        ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderPreDispatchError);
          assert.equal(error.code, "live_ingress_rejected");
          assert.equal(error.message, "live_ingress_rejected");
          assert.equal(error.message.includes(ACK_CAPABILITY), false);
          assert.equal(error.message.includes(LOCAL_TOKEN), false);
          return true;
        },
      );
    } finally {
      await callback.close();
    }
  });

  test(`${fixture.name} rejects a successful response that reflects dispatch authority as receipt`, async () => {
    const callback = await startLoopback(async (_request, response) => {
      json(response, 200, { receipt: `reflected:${ACK_CAPABILITY}:${LOCAL_TOKEN}` });
    });

    try {
      await assert.rejects(
        fixture.create().deliverLive(
          liveIngress(fixture.provider, callback.url),
          delivery(fixture.provider),
          FRAMED,
          ACK_CAPABILITY,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, `${fixture.name} live ingress invalid response`);
          assert.equal(error.message.includes(ACK_CAPABILITY), false);
          assert.equal(error.message.includes(LOCAL_TOKEN), false);
          return true;
        },
      );
    } finally {
      await callback.close();
    }
  });

  test(`${fixture.name} preflight rejects an unsupported permission profile without provider invocation`, () => {
    const provider = fixture.create();
    assert.ok(provider.preflight);
    assert.throws(
      () => provider.preflight!({
        ...delivery(fixture.provider).subscription,
        permissionProfile: "unsupported-secret-profile",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderPreDispatchError);
        assert.equal(error.code, "provider_permission_profile_invalid");
        assert.equal(error.message, "provider_permission_profile_invalid");
        assert.equal(error.message.includes("unsupported-secret-profile"), false);
        return true;
      },
    );
  });
}

async function startLoopback(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "callback_failed");
    });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback callback did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/deliver`,
    close: () => close(server),
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function liveIngress(provider: Provider, callbackUrl: string): LiveIngress {
  return {
    actor: "ariadne",
    provider,
    callbackUrl,
    sessionId: "session-1",
    surfaceVersion: "test",
    bindingId: "binding-17",
    bindingRevision: 17,
    expiresAt: 10_000,
  };
}

function delivery(provider: Provider): Delivery {
  return {
    id: 41,
    eventId: "Ev41",
    actor: "ariadne",
    status: "dispatching",
    reasons: [],
    leaseGeneration: 8,
    claimedBy: "mac",
    attempts: 3,
    coalesceKey: "ariadne:C1:100.0",
    coalescedEventIds: ["Ev41"],
    initialSnapshot: null,
    snapshotTs: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    subscription: {
      actor: "ariadne",
      provider,
      providerSurface: "live",
      providerVersion: "test",
      sessionId: "session-1",
      homeEdge: "mac",
      workspace: "hive",
      edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
      wakePolicy: "live_only",
      permissionProfile: "read-only",
      leaseTtlMs: 30_000,
      deliveryTtlMs: 300_000,
      homeGraceMs: 0,
      spawnRateLimit: 1,
      expiresAt: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    event: {
      eventId: "Ev41",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100.0",
      messageTs: "100.1",
      senderId: "U1",
      senderKind: "user",
      actor: "ariadne",
      text: "WAKE: ariadne",
      raw: {},
      receivedAt: "2026-08-01T00:00:00.000Z",
    },
  };
}
