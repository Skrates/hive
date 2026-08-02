import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { formatBrokerHandle } from "./handles.js";
import {
  TEST_BROKER_UUID,
  TEST_PROTOCOL_VERSION,
  createHiveMcpConformanceAdapter,
} from "./test-support.js";

test("split-v2 client stays pinned modern and round-trips discovery plus own-edge health", async (t) => {
  const edgeId = "sdk-client-edge";
  const uri = formatBrokerHandle(TEST_BROKER_UUID, "edge", { edgeId });
  const observed: Array<{
    method: string | null;
    name: string | null;
    protocolVersion: string | null;
    accept: string | null;
    envelope: Record<string, unknown>;
  }> = [];
  const adapter = createHiveMcpConformanceAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate(request) {
        assert.equal(request.headers.get("authorization"), "Bearer sdk-client-token");
        return { id: "sdk-client-principal", kind: "edge", edgeId, scopes: [] };
      },
    },
  }, {
    async readRequestingEdgeHealth(requestedEdgeId) {
      return {
        edgeId: requestedEdgeId,
        status: "healthy",
        observedAt: "2026-08-01T00:00:00.000Z",
      };
    },
  });

  const bridgeFetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("host", "localhost");
    const bridged = new Request(request, { headers });
    const body = await bridged.clone().json() as {
      params?: { _meta?: Record<string, unknown> };
    };
    observed.push({
      method: bridged.headers.get("mcp-method"),
      name: bridged.headers.get("mcp-name"),
      protocolVersion: bridged.headers.get("mcp-protocol-version"),
      accept: bridged.headers.get("accept"),
      envelope: body.params?._meta ?? {},
    });
    return await adapter.fetch(bridged);
  };
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    authProvider: { async token() { return "sdk-client-token"; } },
    fetch: bridgeFetch,
  });
  const client = new Client(
    { name: "hive-conformance-client", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: TEST_PROTOCOL_VERSION } },
    },
  );
  t.after(async () => {
    await client.close();
    await adapter.close();
  });

  await client.connect(transport);
  assert.equal(transport.protocolVersion, TEST_PROTOCOL_VERSION);
  assert.deepEqual(client.getServerVersion(), { name: "hive", version: "0.4.0" });
  const discovery = client.getDiscoverResult() as unknown as Record<string, unknown>;
  assert.deepEqual(discovery.supportedVersions, [TEST_PROTOCOL_VERSION]);
  assert.equal(discovery.ttlMs, 5_000);
  assert.equal(discovery.cacheScope, "private");

  const list = await client.listResources() as unknown as Record<string, unknown>;
  assert.equal((list.resources as Array<Record<string, unknown>>)[0]?.uri, uri);
  assert.equal(list.ttlMs, 5_000);
  assert.equal(list.cacheScope, "private");
  const read = await client.readResource({ uri }) as unknown as Record<string, unknown>;
  assert.equal(read.ttlMs, 0);
  assert.equal(read.cacheScope, "private");
  assert.equal((read.contents as Array<Record<string, unknown>>)[0]?.uri, uri);

  assert.deepEqual(observed.map((request) => request.method), [
    "server/discover",
    "resources/list",
    "resources/read",
  ]);
  assert.equal(observed[2]?.name, uri);
  for (const request of observed) {
    assert.equal(request.protocolVersion, TEST_PROTOCOL_VERSION);
    assert.match(request.accept ?? "", /application\/json/);
    assert.match(request.accept ?? "", /text\/event-stream/);
    assert.equal(
      request.envelope["io.modelcontextprotocol/protocolVersion"],
      TEST_PROTOCOL_VERSION,
    );
    assert.deepEqual(
      request.envelope["io.modelcontextprotocol/clientCapabilities"],
      {},
    );
    assert.deepEqual(
      request.envelope["io.modelcontextprotocol/clientInfo"],
      { name: "hive-conformance-client", version: "1.0.0" },
    );
  }
});
