import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProfile } from "./profile-probe.js";

test("profile diagnostics honor the delivery executable override", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-provider-override-"));
  const command = join(root, "claude");
  writeFileSync(command, '#!/bin/sh\nif [ "$1" = auth ]; then echo \'{"loggedIn":false}\'; exit 1; fi\nif [ "$1" = plugin ]; then echo \'[]\'; exit 0; fi\necho "named-server: endpoint - ✓ Connected"\n', { mode: 0o755 });
  const previous = process.env.HIVE_CLAUDE_COMMAND;
  process.env.HIVE_CLAUDE_COMMAND = command;
  t.after(() => { if (previous === undefined) delete process.env.HIVE_CLAUDE_COMMAND; else process.env.HIVE_CLAUDE_COMMAND = previous; rmSync(root, { recursive: true, force: true }); });
  const report = await probeProfile("test", root, "claude");
  assert.equal(report.auth.state, "reauth_required");
  assert.equal(report.mcp[0]?.name, "named-server");
  assert.equal(report.mcp[0]?.state, "connected");
});

test("native plugin inventory ignores disabled caches and reports active version drift", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-native-plugins-"));
  const command = join(root, "claude");
  const catalog = join(root, "plugins/marketplaces/test/.claude-plugin");
  mkdirSync(catalog, { recursive: true });
  writeFileSync(join(catalog, "marketplace.json"), JSON.stringify({ plugins: [{ name: "active", version: "2" }, { name: "disabled", version: "2" }] }));
  writeFileSync(join(root, "settings.json"), JSON.stringify({ enabledPlugins: { "active@test": true, "disabled@test": false, "missing@test": true } }));
  const plugins = [{ id: "active@test", scope: "user", enabled: true, version: "1", installPath: root },
    { id: "disabled@test", scope: "user", enabled: false, version: "1", installPath: "/deleted-cache" }];
  writeFileSync(command, `#!${process.execPath}\nconsole.log(process.argv[2]==='plugin' ? ${JSON.stringify(JSON.stringify(plugins))} : process.argv[2]==='auth' ? '{"loggedIn":true}' : 'context7: command - ⊘ Disabled for this project (re-enable via /mcp)');\n`, { mode: 0o755 });
  const previous = process.env.HIVE_CLAUDE_COMMAND;
  process.env.HIVE_CLAUDE_COMMAND = command;
  t.after(() => { if (previous === undefined) delete process.env.HIVE_CLAUDE_COMMAND; else process.env.HIVE_CLAUDE_COMMAND = previous; rmSync(root, { recursive: true, force: true }); });
  const report = await probeProfile("test", root, "claude");
  assert.equal(report.inventory.state, "observed");
  assert.deepEqual(report.plugins.map(p => [p.name, p.state]), [["active@test", "version_differs"], ["missing@test", "missing"]]);
  assert.equal(report.mcp[0]?.state, "disabled");
});

test("stopping the reporter releases an active stalled probe promptly", { timeout: 8_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-probe-stop-"));
  const marker = join(root, "started.json");
  const command = join(root, "claude");
  writeFileSync(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,process.ppid])); setInterval(()=>{},1000);\n`, { mode: 0o755 });
  t.after(() => {
    if (existsSync(marker)) for (const pid of JSON.parse(readFileSync(marker, "utf8"))) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const script = `import {startHealthReporter} from ${JSON.stringify(new URL("./edge-reporter.js", import.meta.url).href)};
    import {existsSync} from 'node:fs';
    const stop=startHealthReporter({async healthProfiles(){return [{actor:'test',provider:'claude',accountProfile:${JSON.stringify(root)},skillsDirectory:null}]},async reportHealth(){}},{get(){return null}});
    const wait=setInterval(()=>{if(existsSync(${JSON.stringify(marker)})){clearInterval(wait);stop();console.log('stopped');}},10);`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HIVE_CLAUDE_COMMAND: command }, timeout: 4_000, killSignal: "SIGKILL",
  });
  assert.equal(result.stdout.trim(), "stopped");
});
