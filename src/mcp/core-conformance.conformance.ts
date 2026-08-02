import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProtocolErrorCode } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import {
  AUTHENTICATION_HEADER_MANIFEST,
  HIVE_HANDLE_MANIFEST,
  MCP_CONFORMANCE_MANIFEST,
  MCP_POTENTIAL_CAPABILITY_CATALOG,
  MCP_SCHEMA_PROVENANCE,
  validateAuthenticationHeaderManifest,
  validateHiveHandleManifest,
  validateMcpConformanceManifest,
  validateMcpPotentialCapabilityCatalog,
} from "./schemas.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("stable-core fixture provenance is exact, vendored, and final-2026", async () => {
  const core = MCP_CONFORMANCE_MANIFEST.stableCore;
  assert.equal(core.status, "stable");
  assert.equal(core.protocolVersion, "2026-07-28");
  assert.equal(core.fixtures.commit, "cc4b41617ce3601b1290d67216ea0b194a3cd9ac");
  assert.equal(core.fixtures.tree, "76fe303cf95eb4cbdf7f78b750ffa4a4b3eb51cc");
  assert.equal(core.fixtures.gitBlob, "eeeae659cd3eaae264d88bee1134eaad50656e1b");

  const bytes = await readFile(resolve(ROOT, core.fixtures.vendoredPath));
  assert.equal(bytes.byteLength, core.fixtures.size);
  assert.equal(sha256(bytes), core.fixtures.sha256);
  const fixture = JSON.parse(bytes.toString("utf8")) as {
    revision: string;
    directoryCount: number;
    fileCount: number;
    directories: Record<string, readonly string[]>;
  };
  assert.equal(fixture.revision, core.protocolVersion);
  assert.equal(fixture.directoryCount, 87);
  assert.equal(fixture.fileCount, 128);
  for (const required of [
    "CallToolResult",
    "DiscoverRequest",
    "DiscoverResult",
    "InputRequiredResult",
    "ServerCapabilities",
  ]) assert.ok(fixture.directories[required], required);
});

test("pinned split-v2 stable error vocabulary uses final-core MRTR codes", () => {
  assert.equal(ProtocolErrorCode.MissingRequiredClientCapability, -32_021);
  assert.equal(ProtocolErrorCode.UnsupportedProtocolVersion, -32_022);
  assert.equal(ProtocolErrorCode.MethodNotFound, -32_601);
});

test("all 128 official final-core examples satisfy their named pinned schema", async () => {
  const core = MCP_CONFORMANCE_MANIFEST.stableCore;
  const [manifestBytes, schemaBytes] = await Promise.all([
    readFile(resolve(ROOT, core.fixtures.vendoredPath)),
    readFile(resolve(ROOT, core.schemaTwin.vendoredPath)),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    directories: Record<string, readonly string[]>;
    fileCount: number;
  };
  const schema = JSON.parse(schemaBytes.toString("utf8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
  addFormats(ajv);
  // The canonical schema uses these as annotations. `uri` is validated by
  // ajv-formats; the two spec-specific formats remain annotation-only, as in
  // the pinned SDK corpus harness.
  ajv.addFormat("byte", true);
  ajv.addFormat("uri-template", true);
  ajv.addSchema(schema, "mcp-final-core");

  let parsed = 0;
  for (const [directory, files] of Object.entries(manifest.directories)) {
    const validate = ajv.compile({ $ref: `mcp-final-core#/$defs/${directory}` });
    for (const file of files) {
      const fixturePath = resolve(
        ROOT,
        core.fixtures.corpus.vendoredPath,
        directory,
        file,
      );
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
      assert.equal(
        validate(fixture),
        true,
        `${directory}/${file}: ${ajv.errorsText(validate.errors)}`,
      );
      parsed += 1;
    }
  }
  assert.equal(parsed, manifest.fileCount);
  assert.equal(parsed, 128);
});

test("generated security manifests are recursively immutable at runtime", () => {
  for (const value of [
    MCP_CONFORMANCE_MANIFEST,
    MCP_CONFORMANCE_MANIFEST.stableCore,
    AUTHENTICATION_HEADER_MANIFEST,
    AUTHENTICATION_HEADER_MANIFEST.responseHeaders,
    AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0],
    HIVE_HANDLE_MANIFEST,
    HIVE_HANDLE_MANIFEST.broker,
    HIVE_HANDLE_MANIFEST.broker[0],
    MCP_POTENTIAL_CAPABILITY_CATALOG,
    MCP_POTENTIAL_CAPABILITY_CATALOG.resources,
    MCP_POTENTIAL_CAPABILITY_CATALOG.tools[0],
  ]) assert.equal(Object.isFrozen(value), true);
  assert.equal(
    Reflect.set(
      AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0] as unknown as object,
      "method",
      "hive.evil",
    ),
    false,
  );
  assert.equal(
    AUTHENTICATION_HEADER_MANIFEST.responseHeaders[0].method,
    "hive.delivery.claim",
  );
});

test("generated standalone validators enforce every canonical Hive schema", async () => {
  const cases = [
    ["conformance", validateMcpConformanceManifest, MCP_CONFORMANCE_MANIFEST],
    ["authenticationHeaders", validateAuthenticationHeaderManifest, AUTHENTICATION_HEADER_MANIFEST],
    ["handleKinds", validateHiveHandleManifest, HIVE_HANDLE_MANIFEST],
    ["potentialCapabilities", validateMcpPotentialCapabilityCatalog, MCP_POTENTIAL_CAPABILITY_CATALOG],
  ] as const;
  for (const [name, validate, canonical] of cases) {
    assert.equal(validate(canonical), true, name);
    for (const hostile of [{}, null, { credential: "raw-secret" }]) {
      assert.equal(validate(hostile), false, `${name}: ${JSON.stringify(hostile)}`);
    }
    const provenance = MCP_SCHEMA_PROVENANCE[name];
    const bytes = await readFile(resolve(ROOT, provenance.path));
    assert.equal(sha256(bytes), provenance.sha256, name);
    const schema = JSON.parse(bytes.toString("utf8")) as { $id: string; examples: unknown[] };
    assert.equal(schema.$id, provenance.$id, name);
    assert.deepEqual(schema.examples, [canonical], name);
  }
});

test("root pnpm check reaches generated drift, import policy, and both conformance lanes", async () => {
  const packageJson = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts.check ?? "", /check:mcp-generated/);
  assert.match(packageJson.scripts.check ?? "", /check:mcp-imports/);
  assert.match(packageJson.scripts.check ?? "", /pnpm test/);
  assert.match(packageJson.scripts.test ?? "", /test:mcp-core/);
  assert.match(packageJson.scripts.test ?? "", /test:mcp-tasks/);
  assert.equal(
    packageJson.scripts["test:mcp-core"],
    "node --test dist/mcp/core-conformance.conformance.js",
  );
  assert.equal(
    packageJson.scripts["test:mcp-tasks"],
    "node --test dist/mcp/tasks-conformance.conformance.js",
  );
  await Promise.all([
    access(resolve(ROOT, "src/mcp/core-conformance.conformance.ts")),
    access(resolve(ROOT, "src/mcp/tasks-conformance.conformance.ts")),
  ]);
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
