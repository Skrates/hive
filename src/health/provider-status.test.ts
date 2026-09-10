import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { providerStatus } from "./provider-status.js";

test("status probes use only read methods, paginate MCP status, and omit private account fields", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "provider");
  const calls = join(root, "calls");
  writeFileSync(command, `#!${process.execPath}
const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},r.method+'\\n');if(!r.id)return;
 let result={};if(r.method==='account/read')result={account:{email:'private@example.test'}};
 if(r.method==='_x.ai/auth/info')result={principalId:'private-principal'};
 if(r.method==='mcpServerStatus/list')result={data:[{name:r.params.cursor?'second':'first',authStatus:'oAuth',tools:{safe_tool:{}}}],nextCursor:r.params.cursor?null:'page2'};
 console.log(JSON.stringify({id:r.id,result}));
});`, { mode: 0o755 });
  const codex = await providerStatus(command, "codex", process.env);
  assert.deepEqual(codex.servers.map(s => s.name), ["first", "second"]);
  assert.equal(codex.loggedIn, true);
  assert.ok(!JSON.stringify(codex).includes("private"));
  const grok = await providerStatus(command, "grok", process.env);
  assert.equal(grok.loggedIn, true);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["initialize", "initialized", "account/read", "mcpServerStatus/list", "mcpServerStatus/list", "initialize", "_x.ai/auth/info"]);
});
