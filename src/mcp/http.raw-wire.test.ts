import assert from "node:assert/strict";
import test from "node:test";
import { formatBrokerHandle } from "./handles.js";
import {
  TEST_BROKER_UUID,
  TEST_PROTOCOL_VERSION,
  createHiveMcpConformanceAdapter,
  jsonResponse,
  jsonRpcErrorCode,
  modernRequest,
  rawRequest,
} from "./test-support.js";

const PRINCIPAL = {
  id: "raw-wire-edge",
  kind: "edge" as const,
  edgeId: "edge-raw",
  scopes: [],
};

test("raw modern wire enforces the final envelope and HTTP profile before factory dispatch", async (t) => {
  let factoryCalls = 0;
  const adapter = createHiveMcpConformanceAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: { async authenticate() { return PRINCIPAL; } },
  }, {
      onServerCreated() { factoryCalls += 1; },
      async readRequestingEdgeHealth(edgeId) {
        return { edgeId, status: "healthy", observedAt: "2026-08-01T00:00:00.000Z" };
      },
    },
  );
  t.after(() => adapter.close());
  const edgeUri = formatBrokerHandle(TEST_BROKER_UUID, "edge", { edgeId: "edge-raw" });

  const valid = await adapter.fetch(modernRequest("server/discover"));
  assert.equal(valid.status, 200);
  assert.equal(factoryCalls, 1);

  const cases: ReadonlyArray<{
    name: string;
    request: Request;
    status: number;
    code: number;
    id?: string | number | null;
    mismatchData?: boolean;
    secretCanary?: string;
  }> = [
    {
      name: "missing protocol header",
      request: deleteHeader(modernRequest("server/discover"), "mcp-protocol-version"),
      status: 400,
      code: -32_020,
      id: 1,
      mismatchData: true,
    },
    {
      name: "rejected Host cannot reflect the raw bearer",
      request: modernRequest("server/discover", {}, {
        headers: {
          authorization: "Bearer raw-bearer-host-canary",
          host: "raw-bearer-host-canary",
        },
      }),
      status: 403,
      code: -32_000,
      secretCanary: "raw-bearer-host-canary",
    },
    {
      name: "rejected Origin cannot reflect the raw bearer",
      request: modernRequest("server/discover", {}, {
        headers: {
          authorization: "Bearer raw-bearer-origin-canary",
          origin: "https://raw-bearer-origin-canary.invalid",
        },
      }),
      status: 403,
      code: -32_000,
      secretCanary: "raw-bearer-origin-canary",
    },
    {
      name: "missing version header cannot reflect body-carried bearer",
      request: deleteHeader(modernRequest("server/discover", {}, {
        protocolVersion: "raw-bearer-missing-version-canary",
        headers: { authorization: "Bearer raw-bearer-missing-version-canary" },
      }), "mcp-protocol-version"),
      status: 400,
      code: -32_020,
      secretCanary: "raw-bearer-missing-version-canary",
    },
    {
      name: "version mismatch cannot reflect header-carried bearer",
      request: modernRequest("server/discover", {}, {
        headers: {
          authorization: "Bearer raw-bearer-version-mismatch-canary",
          "mcp-protocol-version": "raw-bearer-version-mismatch-canary",
        },
      }),
      status: 400,
      code: -32_020,
      secretCanary: "raw-bearer-version-mismatch-canary",
    },
    {
      name: "unsupported matching version cannot reflect bearer",
      request: modernRequest("server/discover", {}, {
        protocolVersion: "raw-bearer-unsupported-version-canary",
        headers: {
          authorization: "Bearer raw-bearer-unsupported-version-canary",
          "mcp-protocol-version": "raw-bearer-unsupported-version-canary",
        },
      }),
      status: 400,
      code: -32_022,
      secretCanary: "raw-bearer-unsupported-version-canary",
    },
    {
      name: "JSON-RPC request id cannot reflect the raw bearer",
      request: modernRequest("server/discover", {}, {
        id: "raw-bearer-request-id-canary",
        protocolVersion: "2026-01-01",
        headers: {
          authorization: "Bearer raw-bearer-request-id-canary",
          "mcp-protocol-version": "2026-01-01",
        },
      }),
      status: 400,
      code: -32_022,
      id: null,
      secretCanary: "raw-bearer-request-id-canary",
    },
    {
      name: "method mismatch cannot reflect header-carried bearer",
      request: modernRequest("server/discover", {}, {
        headers: {
          authorization: "Bearer raw-bearer-method-canary",
          "mcp-method": "raw-bearer-method-canary",
        },
      }),
      status: 400,
      code: -32_020,
      secretCanary: "raw-bearer-method-canary",
    },
    {
      name: "name mismatch cannot reflect header-carried bearer",
      request: modernRequest("resources/read", { uri: edgeUri }, {
        name: "raw-bearer-name-canary",
        headers: { authorization: "Bearer raw-bearer-name-canary" },
      }),
      status: 400,
      code: -32_020,
      secretCanary: "raw-bearer-name-canary",
    },
    {
      name: "protocol header and envelope disagree",
      request: modernRequest("server/discover", {}, {
        headers: { "mcp-protocol-version": "2026-01-01" },
      }),
      status: 400,
      code: -32_020,
    },
    {
      name: "matching but unsupported revision",
      request: modernRequest("server/discover", {}, {
        protocolVersion: "2026-01-01",
        headers: { "mcp-protocol-version": "2026-01-01" },
      }),
      status: 400,
      code: -32_022,
    },
    {
      name: "missing client capabilities envelope",
      request: rawRequest(
        modernBody("server/discover", {
          "io.modelcontextprotocol/protocolVersion": TEST_PROTOCOL_VERSION,
        }),
        modernHeaders("server/discover"),
      ),
      status: 400,
      code: -32_602,
    },
    {
      name: "missing method header",
      request: deleteHeader(modernRequest("server/discover"), "mcp-method"),
      status: 400,
      code: -32_020,
    },
    {
      name: "missing resource name header",
      request: modernRequest("resources/read", { uri: edgeUri }),
      status: 400,
      code: -32_020,
    },
    {
      name: "mismatched resource name header",
      request: modernRequest("resources/read", { uri: edgeUri }, {
        name: `${edgeUri}-wrong`,
      }),
      status: 400,
      code: -32_020,
    },
    {
      name: "unknown modern method",
      request: modernRequest("hive.unknown"),
      status: 404,
      code: -32_601,
    },
    {
      name: "wrong content type",
      request: modernRequest("server/discover", {}, {
        headers: { "content-type": "text/plain" },
      }),
      status: 415,
      code: -32_000,
    },
    {
      name: "Accept omits SSE",
      request: modernRequest("server/discover", {}, {
        headers: { accept: "application/json" },
      }),
      status: 406,
      code: -32_000,
    },
    {
      name: "Accept omits JSON",
      request: modernRequest("server/discover", {}, {
        headers: { accept: "text/event-stream" },
      }),
      status: 406,
      code: -32_000,
    },
    {
      name: "invalid JSON",
      request: rawRequest("{", modernHeaders("server/discover")),
      status: 400,
      code: -32_700,
    },
    {
      name: "JSON-RPC batch",
      request: rawRequest(
        [modernBody("server/discover", modernEnvelope())],
        modernHeaders("server/discover"),
      ),
      status: 400,
      code: -32_600,
    },
    {
      name: "GET session operation",
      request: bareMethodRequest("GET"),
      status: 405,
      code: -32_000,
    },
    {
      name: "DELETE session operation",
      request: bareMethodRequest("DELETE"),
      status: 405,
      code: -32_000,
    },
  ];

  for (const fixture of cases) {
    const response = await adapter.fetch(fixture.request);
    const raw = await response.text();
    assert.equal(response.status, fixture.status, fixture.name);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(
      jsonRpcErrorCode(parsed),
      fixture.code,
      fixture.name,
    );
    if ("id" in fixture) assert.equal(parsed.id, fixture.id, fixture.name);
    if (fixture.mismatchData) {
      const error = parsed.error as Record<string, unknown>;
      assert.ok((error.data as Record<string, unknown>).mismatch, fixture.name);
    }
    assert.equal(raw.includes("test-secret-never-forward"), false, fixture.name);
    if (fixture.secretCanary) {
      assert.equal(raw.includes(fixture.secretCanary), false, fixture.name);
      assert.equal(response.statusText.includes(fixture.secretCanary), false, fixture.name);
      for (const [name, value] of response.headers.entries()) {
        assert.equal(name.includes(fixture.secretCanary), false, fixture.name);
        assert.equal(value.includes(fixture.secretCanary), false, fixture.name);
      }
    }
  }
  assert.equal(
    factoryCalls,
    2,
    "only the validly enveloped unknown method constructs a filtered server before its 404",
  );
});

function modernEnvelope(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": TEST_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function modernBody(method: string, envelope: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { _meta: envelope },
  };
}

function modernHeaders(method: string): Record<string, string> {
  return {
    "mcp-protocol-version": TEST_PROTOCOL_VERSION,
    "mcp-method": method,
  };
}

function deleteHeader(request: Request, name: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(name);
  return new Request(request, { headers });
}

function bareMethodRequest(method: "GET" | "DELETE"): Request {
  return new Request("http://localhost/mcp", {
    method,
    headers: {
      host: "localhost",
      authorization: "Bearer test-secret-never-forward",
    },
  });
}
