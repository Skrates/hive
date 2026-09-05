/** Read-only, machine-local inventory. No Slack credentials and no listening port. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import type { ProfileReport } from "./report.js";
import { CodexAppServerClient } from "../codex/app-server.js";

export type ProfileObservation = z.infer<typeof ProfileReport>;

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}
function optionalJson(path: string): Record<string, any> {
  return existsSync(path) ? readJson(path) : {};
}

/** Hash a whole skill, including relative paths, executable bits, and extra files. */
export function treeDigest(root: string): string {
  const digest = createHash("sha256");
  function visit(path: string, relative: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("symlink inventory unverified");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      digest.update(JSON.stringify([relative, Boolean(stat.mode & 0o111), bytes.length]));
      digest.update(bytes);
    } else throw new Error("non-file inventory unverified");
  }
  visit(root, "");
  return digest.digest("hex");
}

function run(command: string[], env: NodeJS.ProcessEnv): string {
  const [file, ...args] = command;
  if (!file) throw new Error("missing command");
  return execFileSync(file, args, { env, encoding: "utf8", timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export async function probeProfile(actor: string, root: string, provider: ProfileObservation["provider"], skillsDirectory: string | null = join(root, "skills")): Promise<ProfileObservation> {
  const now = () => new Date().toISOString();
  const skillsRoot = skillsDirectory?.startsWith("~/") ? join(homedir(), skillsDirectory.slice(2)) : skillsDirectory;
  const result: ProfileObservation = { actor, provider, accountProfile: root, sourceHost: hostname(), skillsRoot, observedAt: now(),
    usageProfileId: null, usageEdgeId: null, auth: { state: "unverified", observedAt: now() },
    mcp: [], skills: {}, doctrineCommit: null, plugins: [], inventory: { state: "observed", observedAt: now() } };
  if (!existsSync(root)) { result.inventory.state = "profile_missing"; return result; }
  try {
    const collector = optionalJson(join(root, "ai-usage/config.json"));
    result.usageProfileId = typeof collector.profile_id === "string" ? collector.profile_id : null;
    result.usageEdgeId = typeof collector.edge_id === "string" ? collector.edge_id : null;
    const manifest = skillsRoot ? optionalJson(join(skillsRoot, ".weave-doctrine-manifest.json")) : {};
    result.doctrineCommit = typeof manifest.doctrine_commit === "string" ? manifest.doctrine_commit : null;
    if (skillsRoot && existsSync(skillsRoot)) for (const name of readdirSync(skillsRoot).sort()) {
      if (name.startsWith(".")) continue;
      try { if (lstatSync(join(skillsRoot, name)).isDirectory()) result.skills[name] = treeDigest(join(skillsRoot, name)); }
      catch { result.skills[name] = "unverified"; }
    }
    const settings = optionalJson(join(root, "settings.json"));
    const installed = optionalJson(join(root, "plugins/installed_plugins.json")).plugins ?? {};
    const expected = settings.enabledPlugins ?? {};
    for (const name of [...new Set([...Object.keys(installed), ...Object.keys(expected)])].sort()) {
      const entries = installed[name];
      const userEntries = Array.isArray(entries) ? entries.filter(e => e.scope === "user") : [];
      const entry = userEntries.length === 1 ? userEntries[0] : null;
      let intended: string | null = null;
      const [pluginName, market] = name.split("@");
      const catalog = market ? optionalJson(join(root, "plugins/marketplaces", market, ".claude-plugin/marketplace.json")) : {};
      const catalogEntry = Array.isArray(catalog.plugins) ? catalog.plugins.find((p: any) => p.name === pluginName) : null;
      if (typeof catalogEntry?.version === "string") intended = catalogEntry.version;
      const version = typeof entry?.version === "string" ? entry.version : null;
      result.plugins.push({ name, installed: version, intended,
        state: expected[name] === true && !entry ? "missing" : entry && !existsSync(entry.installPath) ? "missing_files"
          : intended && version !== intended ? "version_differs" : "version_unverified" });
    }
    // Codex cache directories prove disk presence only, never which version a session loaded.
    const cache = join(root, "plugins/cache");
    if (provider === "codex" && existsSync(cache)) for (const market of readdirSync(cache).sort()) {
      if (!lstatSync(join(cache, market)).isDirectory()) continue;
      for (const plugin of readdirSync(join(cache, market)).sort()) {
        const pluginRoot = join(cache, market, plugin);
        if (!lstatSync(pluginRoot).isDirectory()) continue;
        const versions = readdirSync(pluginRoot).filter(n => !n.startsWith(".") && lstatSync(join(pluginRoot, n)).isDirectory());
        result.plugins.push({ name: `${plugin}@${market}`, installed: versions.join(", ") || null,
          intended: null, state: "cached_only" });
      }
    }
  } catch { result.inventory = { state: "inventory_incomplete", observedAt: now() }; }

  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root };
  // Do not use an inherited API key to declare the pinned subscription authenticated.
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (provider === "claude") {
    const claude = process.env.HIVE_CLAUDE_COMMAND ?? "claude";
    try {
      let raw: string;
      try { raw = run([claude, "auth", "status", "--json"], env); }
      catch (error) {
        const output = (error as { stdout?: string }).stdout;
        if (!output) throw error;
        raw = output;
      }
      const status = JSON.parse(raw);
      result.auth = { state: status.loggedIn === false || status.authenticated === false ? "reauth_required"
        : status.loggedIn === true || status.authenticated === true ? "local_login_present" : "unverified", observedAt: now() };
    } catch { result.auth = { state: "check_failed", observedAt: now() }; }
    // `claude mcp list` performs connection health checks. Only fixed verdicts and names leave this process.
    try {
      const output = run([claude, "mcp", "list"], env);
      for (const line of output.split("\n")) {
        const match = line.match(/^([\w.@/:-]+):\s.*(?: - |—)(.*)$/u);
        if (!match) continue;
        const verdict = match[2] ?? "";
        const state = /Needs authentication|Needs auth/i.test(verdict) ? "reauth_required"
          : /✓ Connected|Connected$/u.test(verdict) ? "connected"
          : /Failed to connect/i.test(verdict) ? "connection_failed" : "unverified";
        result.mcp.push({ name: match[1]!, state, observedAt: now() });
      }
    } catch { result.mcp.push({ name: "connection check", state: "check_failed", observedAt: now() }); }
  } else if (provider === "codex") {
    const client = new CodexAppServerClient(join(root, "app-server-control/app-server-control.sock"));
    try {
      await client.connect();
      const status = await client.readMaintenance();
      result.auth = { state: status.loggedIn ? "local_login_present" : "reauth_required", observedAt: now() };
      for (const server of status.servers) result.mcp.push({ name: server.name,
        state: server.authStatus === "notLoggedIn" ? "reauth_required" : server.toolsAvailable ? "tools_available" : "unverified", observedAt: now() });
    } catch { result.mcp.push({ name: "pinned app-server", state: "check_failed", observedAt: now() }); }
    finally { await client.close().catch(() => undefined); }
  }
  if (!result.mcp.length) result.mcp.push({ name: "MCP inventory", state: "unverified", observedAt: now() });
  result.observedAt = now();
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [actor, provider, root, skillsDirectory] = process.argv.slice(2);
  if (!actor || !root || (provider !== "codex" && provider !== "claude" && provider !== "grok")) throw new Error("usage: profile-probe ACTOR PROVIDER PROFILE_PATH");
  const expanded = root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
  // An absent probe is different from an absent profile. Always report the explicit requested profile.
  process.stdout.write(JSON.stringify(await probeProfile(actor, expanded, provider,
    skillsDirectory === "null" ? null : skillsDirectory ?? join(expanded, "skills"))) + "\n");
}
