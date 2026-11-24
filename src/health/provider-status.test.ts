import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_STATUS_OUTPUT_BYTES, providerStatus } from "./provider-status.js";

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

/** A fake Codex app-server whose single MCP server lists tools until its response reaches `bytes`. */
function writeLargeInventoryProvider(root: string, bytes: number): string {
  const command = join(root, "provider");
  writeFileSync(command, `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(!r.id)return;
 let result={};if(r.method==='account/read')result={account:{type:'chatgpt'}};
 if(r.method==='mcpServerStatus/list'){const tools={};const schema={description:'x'.repeat(4000)};
  for(let i=0;i*4100<${bytes};i++)tools['tool_'+i]=schema;
  result={data:[{name:'codex_apps',authStatus:'oAuth',tools}],nextCursor:null};}
 process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});`, { mode: 0o755 });
  return command;
}

test("a ChatGPT apps inventory larger than 2 MiB still reports the login and its server", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-status-large-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Ariadne's real codex_apps response was 4.4 MB, which the former 2 MiB bound refused.
  const status = await providerStatus(writeLargeInventoryProvider(root, 4_500_000), "codex", process.env);
  assert.equal(status.loggedIn, true);
  assert.deepEqual(status.servers.map(s => [s.name, s.toolsAvailable]), [["codex_apps", true]]);
});

test("output beyond the bound is still refused as unavailable", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-status-bound-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(providerStatus(writeLargeInventoryProvider(root, MAX_STATUS_OUTPUT_BYTES + 4_000_000), "codex", process.env),
    /provider status unavailable/);
});
