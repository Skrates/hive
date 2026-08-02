import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizedRegisteredCapabilities,
  validateHivePrincipal,
  type HivePrincipal,
  type McpPotentialCapability,
} from "./catalog.js";
import {
  AUTHENTICATION_HEADER_MANIFEST,
  HIVE_HANDLE_MANIFEST,
  MCP_POTENTIAL_CAPABILITY_CATALOG,
} from "./schemas.js";

test("principal validation is type-strict and kind-bound", () => {
  const valid = validateHivePrincipal({
    id: "edge-1",
    kind: "edge",
    edgeId: "edge-1",
    scopes: ["delivery:claim"],
  });
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(Object.isFrozen(valid.scopes), true);

  for (const hostile of [
    { id: 1, kind: "edge", edgeId: "edge-1", scopes: [] },
    { id: "edge-1", kind: "edge", edgeId: 1, scopes: [] },
    { id: "edge-1", kind: "edge", scopes: [] },
    { id: "operator-1", kind: "operator", edgeId: "edge-1", scopes: [] },
    {
      id: "edge-1",
      kind: "edge",
      edgeId: "edge-1",
      scopes: [{ toString() { return "delivery:claim"; } }],
    },
  ]) {
    assert.throws(
      () => validateHivePrincipal(hostile as unknown as HivePrincipal),
      /invalid_hive_principal/,
    );
  }
});

test("generated potential catalog partitions every handle and owns every secret route", () => {
  assert.equal(MCP_POTENTIAL_CAPABILITY_CATALOG.resources.length, 25);
  assert.equal(MCP_POTENTIAL_CAPABILITY_CATALOG.referenceOnlyHandles.length, 2);
  assert.equal(MCP_POTENTIAL_CAPABILITY_CATALOG.tools.length, 37);
  const catalogKinds = new Set([
    ...MCP_POTENTIAL_CAPABILITY_CATALOG.resources.map((entry) => entry.handleKind),
    ...MCP_POTENTIAL_CAPABILITY_CATALOG.referenceOnlyHandles.map((entry) => entry.handleKind),
  ]);
  assert.deepEqual(catalogKinds, new Set([
    ...HIVE_HANDLE_MANIFEST.broker.map((entry) => entry.kind),
    ...HIVE_HANDLE_MANIFEST.edge.map((entry) => entry.kind),
  ]));

  const tools = new Map(MCP_POTENTIAL_CAPABILITY_CATALOG.tools.map((entry) => [entry.name, entry]));
  for (const entry of AUTHENTICATION_HEADER_MANIFEST.responseHeaders) {
    const alternateMethods = "alternateMethods" in entry ? entry.alternateMethods : [];
    for (const method of [entry.method, ...alternateMethods]) {
      assert.equal(tools.get(method)?.server, entry.server, method);
    }
  }
  for (const entry of AUTHENTICATION_HEADER_MANIFEST.requestOnlyHeaders) {
    assert.ok(tools.has(entry.method), entry.method);
  }
});

test("discovery intersection requires potential definition, registration, and current authority", () => {
  const principal = validateHivePrincipal({
    id: "operator-1",
    kind: "operator",
    scopes: ["event:read", "dispatch:plan"],
  });
  const authorized = authorizedRegisteredCapabilities(
    "broker",
    {
      resourceHandleKinds: ["event", "delivery", "reasonCodes", "not-potential"],
      toolNames: ["hive.dispatch.plan", "hive.delivery.claim", "hive.live.describe", "hive.not_real"],
    },
    principal,
    (capability, current) =>
      capability.callerRule === "authenticated-client"
      || declaredScopes(capability).some((scope) => current.scopes.includes(scope)),
  );
  assert.deepEqual(authorized.resources.map((entry) => entry.handleKind), ["event", "reasonCodes"]);
  assert.deepEqual(authorized.tools.map((entry) => entry.name), ["hive.dispatch.plan"]);
  assert.equal(Object.isFrozen(authorized), true);
  assert.equal(Object.isFrozen(authorized.resources), true);
  assert.equal(Object.isFrozen(authorized.tools), true);

  const nothingRegistered = authorizedRegisteredCapabilities(
    "broker",
    { resourceHandleKinds: [], toolNames: [] },
    principal,
    () => true,
  );
  assert.deepEqual(nothingRegistered, { resources: [], tools: [] });
});

function declaredScopes(capability: McpPotentialCapability): readonly string[] {
  return "discoveryAnyScopes" in capability ? capability.discoveryAnyScopes : [];
}
