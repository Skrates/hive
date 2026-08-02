import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src");
const allowedProductionImports = new Set([
  "src/channel/claude.ts",
  "src/mcp/sdk-v2-internal.ts",
  "src/mcp/sdk-v2-validation.ts",
]);

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packages = Object.entries(packageJson.dependencies ?? {})
  .filter(([name]) => name.startsWith("@modelcontextprotocol/"));
for (const [name, version] of packages) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${name} must use an exact version, got ${version}`);
}

for (const file of await walk(src)) {
  if (!file.endsWith(".ts")) continue;
  const projectPath = relative(root, file);
  const text = await readFile(file, "utf8");
  const importsMcpSdk = /(?:from\s*|import\s*\(|import\s*|require\s*\()\s*["']@modelcontextprotocol\//.test(text);
  const importsGeneratedInternals = /(?:from\s*|import\s*\(|import\s*|require\s*\()\s*["'][^"']*generated\/(?:artifacts|validators)(?:\.js)?["']/.test(text);
  const importsAdapterInternals = /(?:from\s*|import\s*\(|import\s*|require\s*\()\s*["'][^"']*sdk-v2-internal(?:\.js)?["']/.test(text);
  const importsTestSupport = /(?:from\s*|import\s*\(|import\s*|require\s*\()\s*["'][^"']*test-support(?:\.js)?["']/.test(text);
  const referencesRawHiveSchema = text.includes("schemas/mcp/");
  const isTest = /\.(test|conformance)\.ts$/.test(file);
  if (
    importsAdapterInternals
    && !["src/mcp/sdk-v2.ts", "src/mcp/test-support.ts"].includes(projectPath)
  ) fail(`MCP adapter internals escaped production/test facade: ${projectPath}`);
  if (importsTestSupport && !isTest) {
    fail(`MCP test support imported by production source: ${projectPath}`);
  }
  if (importsGeneratedInternals && projectPath !== "src/mcp/schemas.ts") {
    fail(`generated MCP internals escaped schema facade: ${projectPath}`);
  }
  if (referencesRawHiveSchema && projectPath !== "src/mcp/generated/artifacts.ts") {
    fail(`raw Hive MCP schema escaped generator boundary: ${projectPath}`);
  }
  if (!importsMcpSdk) continue;
  if (!isTest && !allowedProductionImports.has(projectPath)) {
    fail(`MCP SDK import escaped adapter boundary: ${projectPath}`);
  }
  if (projectPath === "src/channel/claude.ts" && !text.includes("@modelcontextprotocol/sdk")) {
    fail("Claude quarantine must remain on the unified v1 SDK until KRA-908");
  }
  if (projectPath !== "src/channel/claude.ts" && text.includes("@modelcontextprotocol/sdk")) {
    fail(`unified v1 SDK escaped Claude quarantine: ${projectPath}`);
  }
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
