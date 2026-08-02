import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ProtocolErrorCode,
  parseJSONRPCMessage,
} from "@modelcontextprotocol/server";
import { createHiveMcpAdapter } from "./sdk-v2.js";
import { MCP_CONFORMANCE_MANIFEST } from "./schemas.js";
import {
  TEST_BROKER_UUID,
  jsonResponse,
  jsonRpcErrorCode,
  modernRequest,
} from "./test-support.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("unofficial Tasks schema and specification are exact commit artifacts", async () => {
  const tasks = MCP_CONFORMANCE_MANIFEST.tasksExtension;
  assert.equal(tasks.status, "experimental-unofficial");
  assert.equal(tasks.commit, "2c1425d9a288b9b1f489430fe1e00bb392b47e48");
  const schemaBytes = await readFile(resolve(ROOT, tasks.schema.vendoredPath));
  const specificationBytes = await readFile(resolve(ROOT, tasks.specification.vendoredPath));
  assert.equal(sha256(schemaBytes), tasks.schema.sha256);
  assert.equal(sha256(specificationBytes), tasks.specification.sha256);

  const schema = JSON.parse(schemaBytes.toString("utf8")) as Record<string, unknown>;
  assert.equal(schema.$id, "https://modelcontextprotocol.io/ext-tasks/schema.json");
  assert.deepEqual([...collectMethodConstants(schema)].sort(), [
    "notifications/tasks",
    "tasks/cancel",
    "tasks/get",
    "tasks/update",
  ]);
  const definitions = schema.$defs as Record<string, unknown>;
  for (const required of [
    "CancelTaskRequest",
    "CreateTaskResult",
    "DetailedTask",
    "GetTaskRequest",
    "InputRequiredTask",
    "TaskStatusNotification",
    "UpdateTaskRequest",
  ]) assert.ok(definitions[required], required);

  const specification = specificationBytes.toString("utf8");
  assert.match(specification, /io\.modelcontextprotocol\/tasks/);
  assert.match(specification, /tasks\/get/);
  assert.match(specification, /tasks\/update/);
  assert.match(specification, /tasks\/cancel/);
  assert.match(specification, /notifications\/tasks/);
  assert.match(specification, /ttlMs/);
  assert.match(specification, /pollIntervalMs/);
});

test("Tasks extension code is normalized separately from stable-core MRTR", () => {
  const tasks = MCP_CONFORMANCE_MANIFEST.tasksExtension;
  assert.equal(tasks.upstreamMissingCapabilityCode, -32_003);
  assert.equal(tasks.hiveStableCoreMissingCapabilityCode, -32_021);
  assert.equal(
    tasks.hiveStableCoreMissingCapabilityCode,
    ProtocolErrorCode.MissingRequiredClientCapability,
  );
  assert.notEqual(
    tasks.upstreamMissingCapabilityCode,
    tasks.hiveStableCoreMissingCapabilityCode,
  );
});

test("Tasks missing-capability error is normalized at the raw-wire boundary", async () => {
  const upstreamWire = '{"jsonrpc":"2.0","id":12,"error":{"code":-32003,"message":"Missing required client capability","data":{"requiredCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}}}}}';
  const upstream = new Response(upstreamWire, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(upstreamWire)),
      "content-encoding": "gzip",
      "content-md5": "stale-md5",
      "cache-control": "public,max-age=86400",
      "digest": "sha-256=stale",
      "etag": '"stale"',
      "hive-edge-credential": "TASKS-HEADER-SECRET-CANARY",
      "last-event-id": "owner-private-debug-path",
      "mcp-session-id": "stale-session",
      "x-owner-debug-path": "/owner/private/store",
    },
  });
  const normalized = await normalizeTasksExtensionWireResponse(upstream);
  assert.equal(normalized.status, 400);
  assert.equal(normalized.headers.get("content-type"), "application/json");
  assert.equal(normalized.headers.get("cache-control"), "no-store");
  for (const header of [
    "content-length",
    "content-encoding",
    "content-md5",
    "digest",
    "etag",
    "hive-edge-credential",
    "last-event-id",
    "mcp-session-id",
    "x-owner-debug-path",
  ]) assert.equal(normalized.headers.has(header), false, header);
  assert.deepEqual([...normalized.headers.keys()].sort(), ["cache-control", "content-type"]);
  const serialized = await normalized.text();
  assert.equal(serialized.includes("-32003"), false);
  assert.equal(serialized.includes("TASKS-HEADER-SECRET-CANARY"), false);
  assert.equal(serialized.includes("/owner/private/store"), false);
  const body = JSON.parse(serialized) as {
    jsonrpc: string;
    id: number;
    error: { code: number; data: unknown };
  };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 12);
  assert.equal(body.error.code, ProtocolErrorCode.MissingRequiredClientCapability);
  assert.deepEqual(body.error.data, {
    requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
  });
  assert.deepEqual(parseJSONRPCMessage(body), body);

  const unrelated = Response.json({
    jsonrpc: "2.0",
    id: 12,
    error: { code: -32_601, message: "Method not found" },
  });
  assert.equal(await normalizeTasksExtensionWireResponse(unrelated), unrelated);
  for (const malformed of [
    {
      jsonrpc: "2.0",
      id: 12,
      error: {
        code: MCP_CONFORMANCE_MANIFEST.tasksExtension.upstreamMissingCapabilityCode,
        message: "wrong extension",
        data: { requiredCapabilities: { extensions: { "other/extension": {} } } },
      },
    },
    {
      jsonrpc: "2.0",
      id: 12,
      error: {
        code: MCP_CONFORMANCE_MANIFEST.tasksExtension.upstreamMissingCapabilityCode,
        message: "failed with TASKS-SECRET-CANARY at /owner/private/store",
        data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
      },
    },
    {
      jsonrpc: "2.0",
      id: 12,
      error: {
        code: MCP_CONFORMANCE_MANIFEST.tasksExtension.upstreamMissingCapabilityCode,
        data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
      },
    },
    {
      jsonrpc: "2.0",
      id: 1.5,
      error: {
        code: MCP_CONFORMANCE_MANIFEST.tasksExtension.upstreamMissingCapabilityCode,
        message: "fractional id",
        data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
      },
    },
    {
      jsonrpc: "2.0",
      id: 12,
      result: {},
      error: {
        code: MCP_CONFORMANCE_MANIFEST.tasksExtension.upstreamMissingCapabilityCode,
        message: "result and error",
        data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
      },
    },
  ]) {
    const malformedResponse = Response.json(malformed);
    await assert.rejects(
      () => normalizeTasksExtensionWireResponse(malformedResponse),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "invalid_tasks_missing_capability_wire_error");
        assert.equal(String(error).includes("TASKS-SECRET-CANARY"), false);
        assert.equal(String(error).includes("/owner/private/store"), false);
        return true;
      },
    );
    assert.equal(malformedResponse.bodyUsed, true);
  }
});

test("stable split-v2 core rejects Tasks methods pending KRA-901 beside-SDK dispatcher", async (t) => {
  const adapter = createHiveMcpAdapter({
    brokerUuid: TEST_BROKER_UUID,
    authenticator: {
      async authenticate() {
        return { id: "tasks-conformance-edge", kind: "edge", edgeId: "edge-1", scopes: [] };
      },
    },
  });
  t.after(() => adapter.close());

  for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
    const response = await adapter.fetch(modernRequest(method, { taskId: "task-1" }));
    assert.equal(response.status, 404, method);
    assert.equal(jsonRpcErrorCode(await jsonResponse(response)), -32_601, method);
  }
});

function collectMethodConstants(value: unknown, methods = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodConstants(item, methods);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      record.method
      && typeof record.method === "object"
      && typeof (record.method as Record<string, unknown>).const === "string"
    ) methods.add((record.method as Record<string, unknown>).const as string);
    for (const item of Object.values(record)) collectMethodConstants(item, methods);
  }
  return methods;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const MISSING_REQUIRED_CLIENT_CAPABILITY = "Missing required client capability";

/** Raw-wire conformance oracle only. KRA-901 owns the production beside-SDK dispatcher. */
async function normalizeTasksExtensionWireResponse(response: Response): Promise<Response> {
  if (!isUnambiguousJsonContentType(response.headers.get("content-type"))) return response;
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text()) as unknown;
  } catch {
    return response;
  }
  if (!isRecord(body) || !isRecord(body.error)) return response;
  const tasks = MCP_CONFORMANCE_MANIFEST.tasksExtension;
  if (body.error.code !== tasks.upstreamMissingCapabilityCode) return response;
  if (
    !hasExactKeys(body, ["jsonrpc", "id", "error"])
    || body.jsonrpc !== "2.0"
    || !isValidRequestId(body.id)
    || !hasExactKeys(body.error, ["code", "message", "data"])
    || body.error.message !== MISSING_REQUIRED_CLIENT_CAPABILITY
    || !requiresExactTasksExtension(body.error.data)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("invalid_tasks_missing_capability_wire_error");
  }
  await response.body?.cancel().catch(() => {});
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: body.id,
    error: {
      code: tasks.hiveStableCoreMissingCapabilityCode,
      message: MISSING_REQUIRED_CLIENT_CAPABILITY,
      data: body.error.data,
    },
  }), {
    status: 400,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}

function requiresExactTasksExtension(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["requiredCapabilities"])) return false;
  const requiredCapabilities = value.requiredCapabilities;
  if (!isRecord(requiredCapabilities) || !hasExactKeys(requiredCapabilities, ["extensions"])) {
    return false;
  }
  const extensions = requiredCapabilities.extensions;
  if (!isRecord(extensions) || !hasExactKeys(extensions, ["io.modelcontextprotocol/tasks"])) {
    return false;
  }
  const extension = extensions["io.modelcontextprotocol/tasks"];
  return isRecord(extension) && hasExactKeys(extension, []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const expectedSorted = [...expected].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expectedSorted.length
    && actual.every((key, index) => key === expectedSorted[index]);
}

function isValidRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function isUnambiguousJsonContentType(value: string | null): boolean {
  if (!value || value.includes(",")) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
