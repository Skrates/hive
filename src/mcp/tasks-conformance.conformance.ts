import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProtocolErrorCode } from "@modelcontextprotocol/server";
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
