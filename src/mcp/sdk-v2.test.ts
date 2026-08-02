import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
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

test("adapter firewall retains the entry credential snapshot across asynchronous authentication", async (t) => {
  const secret = "mutable-request-secret-canary";
  let authenticationEntered!: () => void;
  const entered = new Promise<void>((resolve) => { authenticationEntered = resolve; });
  let resumeAuthentication!: () => void;
  const resume = new Promise<void>((resolve) => { resumeAuthentication = resolve; });
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate(request) {
        assert.equal(request.headers.get("authorization"), `Bearer ${secret}`);
        authenticationEntered();
        await resume;
        return EDGE_PRINCIPAL;
      },
    },
  });
  t.after(() => adapter.close());

  const request = modernRequest("server/discover", {}, {
    id: secret,
    headers: { authorization: `Bearer ${secret}` },
  });
  const pending = adapter.fetch(request);
  await entered;
  request.headers.delete("authorization");
  resumeAuthentication();
  const response = await pending;
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes(secret), false);
});

test("adapter rejects invalid UTF-8 JSON after authentication but before SDK dispatch", async (t) => {
  let authenticationCalls = 0;
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate() {
        authenticationCalls += 1;
        return EDGE_PRINCIPAL;
      },
    },
  });
  t.after(() => adapter.close());

  const marker = "invalid-utf8-request-id";
  const template = modernRequest("server/discover", {}, { id: marker });
  const serialized = await template.text();
  const bytes = new TextEncoder().encode(serialized);
  const markerOffset = serialized.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  bytes[markerOffset] = 0xff;
  const request = new Request(template.url, {
    method: "POST",
    headers: template.headers,
    body: bytes,
  });
  const response = await adapter.fetch(request);
  assert.equal(response.status, 400);
  assert.equal(jsonRpcErrorCode(await jsonResponse(response)), -32_700);
  assert.equal(authenticationCalls, 1);
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

  let earlyBodyCancelled = false;
  const neverSettlingBody = new ReadableStream<Uint8Array>({
    cancel() {
      earlyBodyCancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const badHostTemplate = modernRequest("server/discover", {}, {
    headers: { host: "attacker.invalid" },
  });
  const badHostWithOpenBody = new Request(badHostTemplate.url, {
    method: "POST",
    headers: badHostTemplate.headers,
    body: neverSettlingBody,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const earlyRejected = await resolvesWithin(adapter.fetch(badHostWithOpenBody), 100);
  assert.equal(earlyRejected.status, 403);
  assert.equal(earlyBodyCancelled, true);
  assert.equal(authenticationCalls, 0);

  const requestOnlySecret = "full-signed-grant-canary";
  const rejectedHiveHeader = await adapter.fetch(modernRequest("server/discover", {}, {
    headers: { "Hive-Expired-Live-Injection-Capability": requestOnlySecret },
  }));
  assert.equal(rejectedHiveHeader.status, 400);
  assert.equal((await rejectedHiveHeader.text()).includes(requestOnlySecret), false);
  assert.equal(authenticationCalls, 0);

  const ambiguousAuthorization = "Bearer duplicate-alpha-secret, Bearer duplicate-beta-secret";
  const rejectedComponentReflection = await adapter.fetch(modernRequest("server/discover", {}, {
    headers: {
      authorization: ambiguousAuthorization,
      host: "duplicate-alpha-secret",
    },
  }));
  const componentBody = await rejectedComponentReflection.text();
  assert.equal(rejectedComponentReflection.status, 403);
  assert.equal(componentBody.includes("duplicate-alpha-secret"), false);
  assert.equal(componentBody.includes("duplicate-beta-secret"), false);
  assert.equal(authenticationCalls, 0);

  const rejectedAmbiguousAuthorization = await adapter.fetch(modernRequest("server/discover", {}, {
    headers: { authorization: ambiguousAuthorization },
  }));
  assert.equal(rejectedAmbiguousAuthorization.status, 400);
  assert.equal(authenticationCalls, 0);

  for (const collidingBearer of ["id", "jsonrpc", "2.0", "CONTENT"]) {
    const rejectedCollision = await adapter.fetch(modernRequest("server/discover", {}, {
      headers: { authorization: `Bearer ${collidingBearer}` },
    }));
    assert.equal(rejectedCollision.status, 500, collidingBearer);
    assert.equal(rejectedCollision.headers.get("content-type"), "application/json");
    assert.deepEqual(await jsonResponse(rejectedCollision), {
      jsonrpc: "2.0",
      error: { code: -32_603, message: "Internal error." },
      id: null,
    });
    assert.equal(authenticationCalls, 0, collidingBearer);

    const rejectedHiveCollision = await adapter.fetch(modernRequest("server/discover", {}, {
      headers: { "Hive-Expired-Live-Injection-Capability": collidingBearer },
    }));
    assert.equal(rejectedHiveCollision.status, 500, collidingBearer);
    assert.equal(rejectedHiveCollision.headers.get("content-type"), "application/json");
    assert.deepEqual(await jsonResponse(rejectedHiveCollision), {
      jsonrpc: "2.0",
      error: { code: -32_603, message: "Internal error." },
      id: null,
    });
    assert.equal(authenticationCalls, 0, collidingBearer);
  }

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

  const missingVersion = modernRequest("server/discover");
  missingVersion.headers.delete("mcp-protocol-version");
  const rejectedMissingVersion = await adapter.fetch(missingVersion);
  assert.equal(rejectedMissingVersion.status, 401);
  assert.equal(jsonRpcErrorCode(await jsonResponse(rejectedMissingVersion)), -32_000);
  assert.equal(authenticationCalls, 2);

  const rejectedContentType = await adapter.fetch(
    modernRequest("server/discover", {}, { headers: { "content-type": "text/plain" } }),
  );
  assert.equal(rejectedContentType.status, 415);
  assert.equal(jsonRpcErrorCode(await jsonResponse(rejectedContentType)), -32_000);
  const rejectedAccept = await adapter.fetch(
    modernRequest("server/discover", {}, { headers: { accept: "application/json" } }),
  );
  assert.equal(rejectedAccept.status, 406);
  assert.equal(jsonRpcErrorCode(await jsonResponse(rejectedAccept)), -32_000);
  assert.equal(authenticationCalls, 2);
});

test("transport metadata rejection is prompt and cancels open bodies before authentication", async (t) => {
  let authenticationCalls = 0;
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate() {
        authenticationCalls += 1;
        return EDGE_PRINCIPAL;
      },
    },
  });
  t.after(() => adapter.close());

  for (const fixture of [
    { method: "POST", headers: { "content-type": "text/plain" }, status: 415 },
    { method: "POST", headers: { accept: "application/json" }, status: 406 },
    { method: "DELETE", headers: {}, status: 405 },
  ] as const) {
    let bodyCancelled = false;
    const openBody = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const template = modernRequest("server/discover", {}, { headers: fixture.headers });
    const request = new Request(template.url, {
      method: fixture.method,
      headers: template.headers,
      body: openBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await resolvesWithin(adapter.fetch(request), 100);
    assert.equal(response.status, fixture.status);
    assert.equal(bodyCancelled, true);
  }
  assert.equal(authenticationCalls, 0);
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

  const duplicateSecret = "duplicate-sse-canary";
  const duplicateEvent =
    'data: {"echoed":"\\u0064uplicate-sse-canary","echoed":"safe"}\n\n';
  const protectedDuplicate = await applyCredentialFirewallForTest(
    new Response(duplicateEvent, { headers: { "content-type": "text/event-stream" } }),
    `Bearer ${duplicateSecret}`,
  );
  await assert.rejects(() => protectedDuplicate.text(), /credential_reflection/);

  const invalidUtf8Secret = "invalid-sse-utf8-canary";
  const invalidPrefix = encoder.encode('data: {"echoed":"');
  const invalidSuffix = encoder.encode('\\u0069nvalid-sse-utf8-canary"}\n\n');
  const invalidEvent = new Uint8Array(invalidPrefix.byteLength + 1 + invalidSuffix.byteLength);
  invalidEvent.set(invalidPrefix, 0);
  invalidEvent[invalidPrefix.byteLength] = 0xff;
  invalidEvent.set(invalidSuffix, invalidPrefix.byteLength + 1);
  const protectedInvalidUtf8 = await applyCredentialFirewallForTest(
    new Response(invalidEvent, { headers: { "content-type": "text/event-stream" } }),
    `Bearer ${invalidUtf8Secret}`,
  );
  await assert.rejects(
    () => protectedInvalidUtf8.text(),
    /credential_firewall_invalid_sse_utf8/,
  );

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
  let crOnlyController!: ReadableStreamDefaultController<Uint8Array>;
  const openCrOnly = new ReadableStream<Uint8Array>({
    start(controller) {
      crOnlyController = controller;
      controller.enqueue(encoder.encode(crOnlyBytes));
    },
  });
  const protectedCrOnly = await applyCredentialFirewallForTest(
    new Response(openCrOnly, { headers: { "content-type": "text/event-stream" } }),
    "Bearer absent-cr-canary",
  );
  const crOnlyReader = protectedCrOnly.body!.getReader();
  const firstCrOnlyChunk = await resolvesWithin(crOnlyReader.read(), 100);
  assert.equal(firstCrOnlyChunk.done, false);
  assert.equal(new TextDecoder().decode(firstCrOnlyChunk.value), crOnlyBytes);
  const crlfContinuation = "\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n\n";
  crOnlyController.enqueue(encoder.encode(crlfContinuation));
  crOnlyController.close();
  let streamed = crOnlyBytes;
  for (;;) {
    const chunk = await crOnlyReader.read();
    if (chunk.done) break;
    streamed += new TextDecoder().decode(chunk.value);
  }
  assert.equal(streamed, crOnlyBytes + crlfContinuation);

  const lateSecret = "late-sse-backpressure-canary";
  const oneSafeEvent = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
  const lateReflectedEvent =
    `data: {"jsonrpc":"2.0","id":2,"result":{"echoed":${JSON.stringify(lateSecret)}}}\n\n`;
  const protectedLazy = await applyCredentialFirewallForTest(
    new Response(oneSafeEvent.repeat(20_000) + lateReflectedEvent, {
      headers: { "content-type": "text/event-stream" },
    }),
    `Bearer ${lateSecret}`,
  );
  const lazyReader = protectedLazy.body!.getReader();
  const firstLazyEvent = await resolvesWithin(lazyReader.read(), 100);
  assert.equal(firstLazyEvent.done, false);
  assert.equal(new TextDecoder().decode(firstLazyEvent.value), oneSafeEvent);
  await lazyReader.cancel();

  const manyEvents = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'.repeat(20_000);
  const protectedManyEvents = await applyCredentialFirewallForTest(
    new Response(manyEvents, { headers: { "content-type": "text/event-stream" } }),
    "Bearer absent-many-events-canary",
  );
  assert.equal(await resolvesWithin(protectedManyEvents.text(), 2_000), manyEvents);

  const oneLongEvent = `:${"a".repeat(40_000)}\n\n`;
  const tinyChunks = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const character of oneLongEvent) controller.enqueue(encoder.encode(character));
      controller.close();
    },
  });
  const protectedTinyChunks = await applyCredentialFirewallForTest(
    new Response(tinyChunks, { headers: { "content-type": "text/event-stream" } }),
    "Bearer absent-long-event-canary",
  );
  assert.equal(await resolvesWithin(protectedTinyChunks.text(), 1_500), oneLongEvent);

  const nearMatchSecret = `${"a".repeat(1_999)}b`;
  const nearMatchEvent = `:${"a".repeat(200_000)}\n\n`;
  const protectedNearMatch = await applyCredentialFirewallForTest(
    new Response(nearMatchEvent, { headers: { "content-type": "text/event-stream" } }),
    `Bearer ${nearMatchSecret}`,
  );
  assert.equal(await protectedNearMatch.text(), nearMatchEvent);

  const quotedParameterSecret = "sse-quoted-parameter-canary";
  const quotedParameter = await applyCredentialFirewallForTest(
    new Response(
      `data: {"echoed":"\\u0073${quotedParameterSecret.slice(1)}"}\n\n`,
      { headers: { "content-type": 'text/event-stream; profile="a,b"' } },
    ),
    `Bearer ${quotedParameterSecret}`,
  );
  await assert.rejects(() => quotedParameter.text(), /credential_reflection/);

  const ambiguous = await applyCredentialFirewallForTest(
    new Response('data: {"safe":true}\n\n', {
      headers: { "content-type": "text/event-stream, text/plain" },
    }),
    "Bearer absent-ambiguous-sse-canary",
  );
  assert.equal(ambiguous.status, 500);
  assert.equal(ambiguous.headers.get("content-type"), "application/json");

  const malformedParameter = await applyCredentialFirewallForTest(
    new Response('data: {"safe":true}\n\n', {
      headers: { "content-type": "text/event-stream; profile=" },
    }),
    "Bearer absent-malformed-sse-canary",
  );
  assert.equal(malformedParameter.status, 500);
  assert.equal(malformedParameter.headers.get("content-type"), "application/json");
});

test("credential firewall cancels the hidden source before replacing a metadata leak", async () => {
  const secret = "metadata-stream-canary";
  let sourceCancelled = false;
  const open = new ReadableStream<Uint8Array>({
    cancel() {
      sourceCancelled = true;
    },
  });
  const protectedResponse = await resolvesWithin(
    applyCredentialFirewallForTest(
      new Response(open, {
        headers: {
          "content-type": "text/event-stream",
          "x-debug-token": secret,
        },
      }),
      `Bearer ${secret}`,
    ),
    100,
  );
  assert.equal(sourceCancelled, true);
  assert.equal(protectedResponse.status, 500);
  const replacementBody = await protectedResponse.text();
  assert.equal(replacementBody.includes(secret), false);

  const blockingSecret = "metadata-cancel-never-settles-canary";
  let blockingCancelCalled = false;
  const blocking = new ReadableStream<Uint8Array>({
    cancel() {
      blockingCancelCalled = true;
      return new Promise<void>(() => {});
    },
  });
  const protectedBlocking = await resolvesWithin(
    applyCredentialFirewallForTest(
      new Response(blocking, {
        headers: {
          "content-type": "application/json",
          "x-debug-token": blockingSecret,
        },
      }),
      `Bearer ${blockingSecret}`,
    ),
    100,
  );
  assert.equal(blockingCancelCalled, true);
  assert.equal(protectedBlocking.status, 500);
  assert.equal((await protectedBlocking.text()).includes(blockingSecret), false);
});

test("credential firewall collapses secret-bearing source errors across media types", async () => {
  for (const mediaType of ["application/json", "text/plain", "text/event-stream"]) {
    const secret = `source-error-canary:${mediaType}`;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`downstream failed with ${secret} at /owner/private/store`));
      },
    });
    const protectedResponse = await applyCredentialFirewallForTest(
      new Response(source, { headers: { "content-type": mediaType } }),
      `Bearer ${secret}`,
    );
    if (mediaType === "text/event-stream") {
      await assert.rejects(
        () => protectedResponse.text(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "credential_firewall_source_failure");
          assert.equal(String(error).includes(secret), false);
          assert.equal(String(error).includes("/owner/private/store"), false);
          return true;
        },
      );
    } else {
      assert.equal(protectedResponse.status, 500);
      const body = await protectedResponse.text();
      assert.equal(body.includes(secret), false);
      assert.equal(body.includes("/owner/private/store"), false);
    }
  }
});

test("credential firewall protects short bearer values in decoded JSON semantics", async () => {
  const response = Response.json({ result: { echoed: "tiny" } });
  const protectedResponse = await applyCredentialFirewallForTest(response, "Bearer tiny");
  assert.equal(protectedResponse.status, 500);
  assert.equal((await protectedResponse.text()).includes("tiny"), false);
});

test("credential firewall keeps canonical JSON-RPC shape for grammar-colliding bearers", async () => {
  for (const secret of ["id", "jsonrpc", "2.0"]) {
    const protectedResponse = await applyCredentialFirewallForTest(
      Response.json({ jsonrpc: "2.0", id: 1, result: { safe: true } }),
      `Bearer ${secret}`,
    );
    assert.equal(protectedResponse.status, 500, secret);
    assert.equal(protectedResponse.headers.get("content-type"), "application/json");
    assert.deepEqual(await jsonResponse(protectedResponse), {
      jsonrpc: "2.0",
      error: { code: -32_603, message: "Internal error." },
      id: null,
    });
  }
});

test("credential firewall never preserves a non-integer upstream JSON-RPC error code", async () => {
  const secret = "invalid-error-code-canary";
  for (const encodedCode of ["1.5", "1e999"]) {
    const response = new Response(
      `{"jsonrpc":"2.0","id":1,"error":{"code":${encodedCode},"message":"safe","echoed":${JSON.stringify(secret)}}}`,
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const protectedResponse = await applyCredentialFirewallForTest(
      response,
      `Bearer ${secret}`,
    );
    const body = await jsonResponse(protectedResponse);
    assert.equal((body.error as Record<string, unknown>).code, -32_603, encodedCode);
    assert.equal(Number.isSafeInteger((body.error as Record<string, unknown>).code), true);
  }
});

test("credential firewall preflights bounded JSON and scans every decoded string", async () => {
  const encoder = new TextEncoder();
  const safeBody = '{"result":{"safe":true}}';
  const protectedSafe = await applyCredentialFirewallForTest(
    new Response(safeBody, { headers: { "content-type": "application/json" } }),
    "Bearer absent-safe-json-canary",
  );
  assert.equal(await protectedSafe.text(), safeBody);

  const lateHeaderSecret = "late-header-secret-canary";
  let mutableMetadataResponse!: Response;
  const mutableMetadataBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      mutableMetadataResponse.headers.set("x-late-secret", lateHeaderSecret);
      controller.enqueue(encoder.encode(safeBody));
      controller.close();
    },
  }, { highWaterMark: 0 });
  mutableMetadataResponse = new Response(mutableMetadataBody, {
    headers: { "content-type": "application/json" },
  });
  const protectedMutableMetadata = await applyCredentialFirewallForTest(
    mutableMetadataResponse,
    `Bearer ${lateHeaderSecret}`,
  );
  assert.equal(protectedMutableMetadata.status, 200);
  assert.equal(protectedMutableMetadata.headers.has("x-late-secret"), false);
  assert.equal(await protectedMutableMetadata.text(), safeBody);

  const openPrefix = `{"padding":[${"0,".repeat(128)}`;
  const open = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(openPrefix));
    },
  });
  const protectedOpen = await resolvesWithin(
    applyCredentialFirewallForTest(
      new Response(open, { headers: { "content-type": "application/json" } }),
      "Bearer absent-open-json-canary",
    ),
    1_500,
  );
  assert.equal(protectedOpen.status, 500);
  assert.equal((await protectedOpen.text()).includes(openPrefix), false);

  for (const mediaType of [
    "application/json",
    "application/problem+json",
    "application/vnd.hive+json; charset=utf-8",
  ]) {
    for (const placement of ["key", "value"] as const) {
      const secret = `suffix-json-canary-${placement}`;
      const escaped = `\\u${secret.charCodeAt(0).toString(16).padStart(4, "0")}${secret.slice(1)}`;
      const reflected = placement === "key"
        ? `{"${escaped}":"safe"}`
        : `{"echoed":"${escaped}"}`;
      assert.equal(reflected.includes(secret), false);
      const protectedResponse = await applyCredentialFirewallForTest(
        new Response(reflected, { headers: { "content-type": mediaType } }),
        `Bearer ${secret}`,
      );
      assert.equal(protectedResponse.status, 500);
      assert.equal((await protectedResponse.text()).includes(secret), false);
    }
  }

  const splitSecret = "split-semantic-canary";
  const splitEscaped = `\\u${splitSecret.charCodeAt(0).toString(16).padStart(4, "0")}${splitSecret.slice(1)}`;
  const splitBody = `{"echoed":"${splitEscaped}"}`;
  assert.equal(splitBody.includes(splitSecret), false);
  const splitAt = splitBody.indexOf("u") + 3;
  const splitJson = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(splitBody.slice(0, splitAt)));
      controller.enqueue(encoder.encode(splitBody.slice(splitAt)));
      controller.close();
    },
  });
  const protectedSplit = await applyCredentialFirewallForTest(
    new Response(splitJson, { headers: { "content-type": "application/problem+json" } }),
    `Bearer ${splitSecret}`,
  );
  assert.equal(protectedSplit.status, 500);
  assert.equal((await protectedSplit.text()).includes(splitSecret), false);

  const duplicateSecret = "duplicate-auth-canary";
  const duplicateBody = '{"echoed":"\\u0064uplicate-auth-canary","echoed":"safe"}';
  const duplicate = await applyCredentialFirewallForTest(
    new Response(duplicateBody, { headers: { "content-type": "application/json" } }),
    `Bearer ${duplicateSecret}`,
  );
  assert.equal(duplicate.status, 500);
  assert.equal((await duplicate.text()).includes(duplicateSecret), false);

  const invalidUtf8Secret = "invalid-utf8-canary";
  const prefix = encoder.encode('{"echoed":"');
  const suffix = encoder.encode('\\u0069nvalid-utf8-canary"}');
  const invalidUtf8 = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
  invalidUtf8.set(prefix, 0);
  invalidUtf8[prefix.byteLength] = 0xff;
  invalidUtf8.set(suffix, prefix.byteLength + 1);
  const invalidUtf8Response = await applyCredentialFirewallForTest(
    new Response(invalidUtf8, { headers: { "content-type": "application/json" } }),
    `Bearer ${invalidUtf8Secret}`,
  );
  assert.equal(invalidUtf8Response.status, 500);
  assert.equal((await invalidUtf8Response.text()).includes(invalidUtf8Secret), false);

  for (const mediaType of ["text/plain", "application/octet-stream", null] as const) {
    const secret = `mislabelled-json-canary-${mediaType ?? "absent"}`;
    const body = encoder.encode(`{"echoed":"\\u${secret.charCodeAt(0).toString(16).padStart(4, "0")}${secret.slice(1)}"}`);
    const headers = mediaType === null ? {} : { "content-type": mediaType };
    const rejected = await applyCredentialFirewallForTest(
      new Response(body, { headers }),
      `Bearer ${secret}`,
    );
    assert.equal(rejected.status, 500, mediaType ?? "absent");
    assert.equal((await rejected.text()).includes(secret), false, mediaType ?? "absent");
  }

  const oversized = await applyCredentialFirewallForTest(
    new Response(" ".repeat(1_048_577), {
      headers: { "content-type": "application/json" },
    }),
    "Bearer absent-oversized-json-canary",
  );
  assert.equal(oversized.status, 500);
  assert.equal((await oversized.text()).includes("absent-oversized-json-canary"), false);
});

test("credential firewall rejects encoded bodies before media-specific scanning", async () => {
  for (const mediaType of ["application/json", "text/plain", "text/event-stream"]) {
    const secret = `encoded-body-canary:${mediaType}`;
    const encoded = gzipSync(Buffer.from(`{"echoed":${JSON.stringify(secret)}}`));
    const protectedResponse = await applyCredentialFirewallForTest(
      new Response(encoded, {
        headers: {
          "content-encoding": "gzip",
          "content-type": mediaType,
        },
      }),
      `Bearer ${secret}`,
    );
    assert.equal(protectedResponse.status, 500);
    assert.equal(protectedResponse.headers.has("content-encoding"), false);
    assert.equal((await protectedResponse.text()).includes(secret), false);
  }
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
