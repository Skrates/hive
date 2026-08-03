import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0003 retains ADR-0002 D3: the stable MCP TypeScript v2 packages stay
// exactly pinned, and no MCP SDK import may appear outside the (future)
// src/mcp adapter boundary. The unified v1 SDK left with the Claude channel
// surface and may not return.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src");

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packages = Object.entries(packageJson.dependencies ?? {})
  .filter(([name]) => name.startsWith("@modelcontextprotocol/"));
for (const [name, version] of packages) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${name} must use an exact version, got ${version}`);
  if (name === "@modelcontextprotocol/sdk") fail("unified v1 MCP SDK must not return as a dependency");
}

for (const file of await walk(src)) {
  if (!file.endsWith(".ts")) continue;
  const projectPath = relative(root, file);
  const text = await readFile(file, "utf8");
  const importsMcpSdk = /(?:from\s*|import\s*\(|import\s*|require\s*\()\s*["']@modelcontextprotocol\//.test(text);
  if (importsMcpSdk && !projectPath.startsWith("src/mcp/")) {
    fail(`MCP SDK import escaped adapter boundary: ${projectPath}`);
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
