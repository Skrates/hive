import assert from "node:assert/strict";
import test from "node:test";
import type { HivePrincipal } from "./catalog.js";
import { formatBrokerHandle } from "./handles.js";
import { createHiveMcpAdapter } from "./sdk-v2.js";
import {
  TEST_BROKER_UUID,
  applyCredentialFirewallForTest,
  createHiveMcpConformanceAdapter,
  jsonResponse,
  jsonRpcErrorCode,
  modernRequest,
  rawRequest,
} from "./test-support.js";

const EDGE_PRINCIPAL: HivePrincipal = {
  id: "edge-machine-1",
  kind: "edge",
  edgeId: "edge-1",
  scopes: [],
};

test("production discovery is modern-only, stateless, and advertises no unimplemented surface", async (t) => {
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: { async authenticate() { return EDGE_PRINCIPAL; } },
  });
  t.after(() => adapter.close());

  const first = await adapter.fetch(modernRequest("server/discover"));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("mcp-session-id"), null);
  assert.equal(first.headers.get("last-event-id"), null);
  const body = await jsonResponse(first);
  const result = body.result as Record<string, unknown>;
  assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(result.capabilities, {});
  assert.equal(result.resultType, "complete");
  assert.equal(result.ttlMs, 5_000);
  assert.equal(result.cacheScope, "private");
  assert.deepEqual(
    (result._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"],
    { name: "hive", version: "0.4.0" },
  );

  const productionReadSurface = await adapter.fetch(modernRequest("resources/list", {}, { id: 3 }));
  assert.equal(productionReadSurface.status, 404);
  assert.equal(jsonRpcErrorCode(await jsonResponse(productionReadSurface)), -32_601);

  const legacy = await adapter.fetch(rawRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy", version: "1" },
    },
  }));
  assert.equal(legacy.status, 400);
  assert.equal(jsonRpcErrorCode(await jsonResponse(legacy)), -32_022);
});

test("conformance fixture is principal-filtered, request-local, and limited to own edge health", async (t) => {
  let currentPrincipal: HivePrincipal = EDGE_PRINCIPAL;
  let factoryCalls = 0;
  let healthReads = 0;
  const adapter = createHiveMcpConformanceAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: { async authenticate() { return currentPrincipal; } },
  }, {
      onServerCreated(principal) {
        factoryCalls += 1;
        assert.notEqual(principal, currentPrincipal);
      },
      async readRequestingEdgeHealth(edgeId, principal) {
        healthReads += 1;
        assert.equal(edgeId, "edge-1");
        assert.equal(principal.edgeId, "edge-1");
        return {
          edgeId,
          status: "healthy",
          observedAt: "2026-08-01T00:00:00.000Z",
          credential: "must-not-escape",
        } as HiveMcpHealthWithCredential;
      },
    },
  );
  t.after(() => adapter.close());
  const ownUri = formatBrokerHandle(TEST_BROKER_UUID, "edge", { edgeId: "edge-1" });

  const discoveries = await Promise.all([
    adapter.fetch(modernRequest("server/discover", {}, { id: 1 })),
    adapter.fetch(modernRequest("server/discover", {}, { id: 2 })),
  ]);
  assert.deepEqual(discoveries.map((response) => response.status), [200, 200]);
  for (const response of discoveries) {
    const result = (await jsonResponse(response)).result as Record<string, unknown>;
    assert.deepEqual(result.capabilities, { resources: { listChanged: false } });
  }

  const listed = await adapter.fetch(modernRequest("resources/list", {}, { id: 3 }));
  assert.equal(listed.status, 200);
  const listResult = (await jsonResponse(listed)).result as Record<string, unknown>;
  const resources = listResult.resources as Array<Record<string, unknown>>;
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.name, "hive.edge.health");
  assert.equal(resources[0]?.uri, ownUri);
  assert.equal(listResult.ttlMs, 5_000);
  assert.equal(listResult.cacheScope, "private");

  const read = await adapter.fetch(modernRequest(
    "resources/read",
    { uri: ownUri },
    { id: 4, name: ownUri },
  ));
  assert.equal(read.status, 200);
  const readResult = (await jsonResponse(read)).result as Record<string, unknown>;
  assert.equal(readResult.ttlMs, 0);
  assert.equal(readResult.cacheScope, "private");
  const content = (readResult.contents as Array<Record<string, unknown>>)[0];
  assert.equal(content?.uri, ownUri);
  assert.deepEqual(JSON.parse(String(content?.text)), {
    edgeId: "edge-1",
    status: "healthy",
    observedAt: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(healthReads, 1);
  assert.equal(factoryCalls, 4);

  currentPrincipal = { id: "operator-1", kind: "operator", scopes: ["edge:read"] };
  const afterRevocation = await adapter.fetch(modernRequest("server/discover", {}, { id: 5 }));
  const revokedResult = (await jsonResponse(afterRevocation)).result as Record<string, unknown>;
  assert.deepEqual(revokedResult.capabilities, {});

  currentPrincipal = { ...EDGE_PRINCIPAL, edgeId: "edge-2" };
  const crossEdge = await adapter.fetch(modernRequest(
    "resources/read",
    { uri: ownUri },
    { id: 6, name: ownUri },
  ));
  assert.ok((await jsonResponse(crossEdge)).error);
  assert.equal(healthReads, 1);
});

test("removed session metadata is ignored and stripped before authentication", async (t) => {
  const seen: Array<Record<string, string | null>> = [];
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate(request) {
        seen.push({
          authorization: request.headers.get("authorization"),
          session: request.headers.get("mcp-session-id"),
          resume: request.headers.get("last-event-id"),
        });
        return EDGE_PRINCIPAL;
      },
    },
  });
  t.after(() => adapter.close());

  const response = await adapter.fetch(modernRequest("server/discover", {}, {
    headers: {
      "mcp-session-id": "stale-session",
      "last-event-id": "stale-event",
    },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [{
    authorization: "Bearer test-secret-never-forward",
    session: null,
    resume: null,
  }]);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.equal(response.headers.get("last-event-id"), null);
});

test("a body-consuming authenticator cannot consume the SDK request branch", async (t) => {
  let authenticatedBody = "";
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate(request) {
        authenticatedBody = await request.text();
        return EDGE_PRINCIPAL;
      },
    },
  });
  t.after(() => adapter.close());

  const response = await adapter.fetch(modernRequest("server/discover", {}, { id: 77 }));
  assert.equal(response.status, 200);
  assert.match(authenticatedBody, /"method":"server\/discover"/);
  assert.equal((await jsonResponse(response)).id, 77);
});

test("Host and Origin rejection precede authentication; authentication failures are constant-shape", async (t) => {
  let authenticationCalls = 0;
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate() {
        authenticationCalls += 1;
        return null;
      },
    },
  });
  t.after(() => adapter.close());

  const badHost = await adapter.fetch(modernRequest("server/discover", {}, {
    headers: { host: "attacker.invalid" },
  }));
  assert.equal(badHost.status, 403);
  const badOrigin = await adapter.fetch(modernRequest("server/discover", {}, {
    headers: { origin: "https://attacker.invalid" },
  }));
  assert.equal(badOrigin.status, 403);
  assert.equal(authenticationCalls, 0);

  const unauthenticated = await adapter.fetch(modernRequest("server/discover"));
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), "Bearer");
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
  assert.deepEqual(await jsonResponse(unauthenticated), {
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Authentication required." },
    id: null,
  });
  assert.equal(authenticationCalls, 1);
});

test("clientInfo is optional, display-only, and malformed when present is rejected", async (t) => {
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: { async authenticate() { return EDGE_PRINCIPAL; } },
  });
  t.after(() => adapter.close());

  const absent = await adapter.fetch(modernRequest("server/discover"));
  assert.equal(absent.status, 200);
  const asserted = await adapter.fetch(modernRequest("server/discover", {}, {
    clientInfo: { name: "untrusted-display-only", version: "999" },
  }));
  assert.equal(asserted.status, 200);
  assert.deepEqual(
    ((await jsonResponse(absent)).result as Record<string, unknown>).capabilities,
    ((await jsonResponse(asserted)).result as Record<string, unknown>).capabilities,
  );

  const malformed = await adapter.fetch(modernRequest("server/discover", {}, {
    clientInfo: "not-an-implementation-object",
  }));
  assert.equal(malformed.status, 400);
  assert.equal(jsonRpcErrorCode(await jsonResponse(malformed)), -32_602);
});

test("credential firewall returns live SSE promptly and catches cross-chunk reflection", async () => {
  const encoder = new TextEncoder();
  const open = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`: ${"safe".repeat(32)}\n\n`));
    },
  });
  const protectedOpen = await resolvesWithin(
    applyCredentialFirewallForTest(
      new Response(open, { headers: { "content-type": "text/event-stream" } }),
      "Bearer sse-open-stream-canary",
    ),
    100,
  );
  assert.equal(protectedOpen.headers.get("content-type"), "text/event-stream");
  const openReader = protectedOpen.body!.getReader();
  const firstOpenChunk = await resolvesWithin(openReader.read(), 100);
  assert.equal(firstOpenChunk.done, false);
  assert.equal(new TextDecoder().decode(firstOpenChunk.value), `: ${"safe".repeat(32)}\n\n`);
  await openReader.cancel();

  const secret = "sse-cross-chunk-canary";
  const reflected = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"safe":true}\n\ndata: ${secret.slice(0, 8)}`));
      controller.enqueue(encoder.encode(`${secret.slice(8)}\n\n`));
      controller.close();
    },
  });
  const protectedReflected = await applyCredentialFirewallForTest(
    new Response(reflected, { headers: { "content-type": "text/event-stream" } }),
    `Bearer ${secret}`,
  );
  await assert.rejects(() => protectedReflected.text(), /credential_reflection/);

  const semanticSecret = "sse-semantic-canary";
  const escapedFirst = `\\u${semanticSecret.charCodeAt(0).toString(16).padStart(4, "0")}`;
  const semanticReflected = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: {"jsonrpc":"2.0","id":1,"result":{"echoed":"${escapedFirst}${semanticSecret.slice(1)}"}}\r`,
      ));
      controller.enqueue(encoder.encode("\n\r\n"));
      controller.close();
    },
  });
  const protectedSemantic = await applyCredentialFirewallForTest(
    new Response(semanticReflected, { headers: { "content-type": "text/event-stream" } }),
    `Bearer ${semanticSecret}`,
  );
  await assert.rejects(() => protectedSemantic.text(), /credential_reflection/);

  const safeBytes = "event: message\ndata: {\"safe\":\"payload\"}\n\n";
  const safe = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(safeBytes.slice(0, 7)));
      controller.enqueue(encoder.encode(safeBytes.slice(7)));
      controller.close();
    },
  });
  const protectedSafe = await applyCredentialFirewallForTest(
    new Response(safe, { headers: { "content-type": "text/event-stream" } }),
    "Bearer absent-sse-canary",
  );
  assert.equal(await protectedSafe.text(), safeBytes);

  const crOnlyBytes = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r\r";
  const protectedCrOnly = await applyCredentialFirewallForTest(
    new Response(crOnlyBytes, { headers: { "content-type": "text/event-stream" } }),
    "Bearer absent-cr-canary",
  );
  assert.equal(await protectedCrOnly.text(), crOnlyBytes);
});

test("credential firewall protects short bearer values in decoded JSON semantics", async () => {
  const response = Response.json({ result: { echoed: "tiny" } });
  const protectedResponse = await applyCredentialFirewallForTest(response, "Bearer tiny");
  assert.equal(protectedResponse.status, 500);
  assert.equal((await protectedResponse.text()).includes("tiny"), false);
});

interface HiveMcpHealthWithCredential {
  readonly edgeId: string;
  readonly status: "healthy";
  readonly observedAt: string;
  readonly credential: string;
}

async function resolvesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed_out_waiting_for_stream_response")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
