import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { age, collectCanvas, renderCanvas, type CanvasSnapshot } from "./canvas.js";
import { probeProfile, treeDigest } from "./profile-probe.js";
import { ProfileReport } from "./report.js";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const now = "2026-09-05T15:00:00.000Z";
function snapshot(): CanvasSnapshot {
  return { generatedAt: now, doctrineCommit: "a".repeat(40),
    seats: ["one", "never"].map(actor => ({ actor, provider: "claude", machine: "shared-host", profile: `/profiles/${actor}`,
      intendedSkills: {}, intendedPlugins: [], subscription: null, delivery: null })),
    pools: [{ id: "pool-shared", provider: "claude", label: "Max", identity_state: "verified", status: "auth_expired",
      sampled_at: "2026-09-01T00:00:00.000Z", received_at: now, windows: [], profiles: [{ id: "collector-one", binding_confidence: "subject" }] }],
    doctor: [{ profile_id: "collector-one", edge_id: "edge", provider: "claude", configured: true, last_received_at: now,
      last_sampled_at: now, last_outcome: "conflict", pool_id: "pool-shared", last_conflict: { kind: "invalid_reset", at: now } },
    { profile_id: "silent", edge_id: "edge", provider: null, configured: true, last_received_at: null,
      last_sampled_at: null, last_outcome: null, pool_id: null, last_conflict: null }],
    probes: [], failedProbes: ["one"], usageState: "ready", brokerState: "observed",
    bindings: [{ actor: "one", profileId: "collector-one", edgeId: "edge" },
      { actor: "never", profileId: "silent", edgeId: "edge" }], archiveUrl: "https://example.test/archive",
  };
}

test("only roster seats appear, including no-reading placeholders", () => {
  const s = snapshot();
  const before = structuredClone(s);
  const output = renderCanvas(s);
  assert.match(output, /\| Never · shared-host \| No reading/);
  assert.doesNotMatch(output, /collector:|Quota pools|Collector observations|Plugin \/ marketplace|pool-shared/);
  assert.match(output, /maintenance check failed/);
  assert.match(output, /latest quota rejected \(invalid_reset\)/);
  assert.deepEqual(s, before);
});

test("receipt age cannot refresh quota age; reset details stay in the evidence", () => {
  assert.equal(age("nonsense", now), "invalid observation time");
  assert.equal(age("2026-09-06T00:00:00Z", now), "invalid observation time");
  const s = snapshot();
  s.pools[0]!.windows = [{ label: "7d", utilization: 0.54, resets_at: "2026-09-07T15:00:00.000Z" }];
  const output = renderCanvas(s);
  assert.match(output, /7d 54%/);
  assert.doesNotMatch(output, /Reset in|2d 0h/);
  assert.match(output, /quota sample 4d ago/);

});

test("retired and independent collectors cannot add extra rows or alerts", () => {
  const s = snapshot();
  s.doctor.push({ ...s.doctor[0]!, configured: true, profile_id: "unrelated" });
  s.doctor.push({ ...s.doctor[0]!, configured: false, profile_id: "retired" });
  assert.doesNotMatch(renderCanvas(s), /unrelated|retired|collector:/);
});

test("explicit shared binding wins over an old probe's collector mapping", async () => {
  const s = snapshot();
  s.seats[0]!.subscription = { edge: "edge", lastSeen: now, expiresAt: null, sessionId: null };
  const p = { ...await probeProfile("one", "/missing-health-test-profile", "claude"),
    edgeId: "edge", accountProfile: "/profiles/one", observedAt: now,
    usageProfileId: "obsolete-mac", usageEdgeId: "edge-mac" };
  s.probes.push(p);
  s.bindings[1] = { actor: "never", profileId: "collector-one", edgeId: "edge" };
  s.doctor[0]!.last_outcome = "accepted";
  s.pools[0] = { ...s.pools[0]!, status: "ok", sampled_at: now,
    windows: [{ label: "7d", utilization: 0.5, resets_at: null }] };
  const output = renderCanvas(s);
  assert.equal((output.match(/7d 50%/g) ?? []).length, 2);
  assert.match(output, /One \+ Never share one subscription/);
  assert.match(output, /2 seats · 1 subscription/);
  assert.doesNotMatch(output, /obsolete-mac|quota collector has no matched report|invalid_reset/);
});

test("stale maintenance groups uncertainty without repeating old reauthentication or drift", async () => {
  const s = snapshot();
  const p = { ...await probeProfile("one", "/missing-health-test-profile", "claude"),
    edgeId: "edge", accountProfile: "/profiles/one", observedAt: "2026-09-02T15:00:00.000Z" };
  p.mcp = [{ name: "Vercel", state: "reauth_required", observedAt: p.observedAt }];
  s.seats[0]!.subscription = { edge: "edge", lastSeen: now, expiresAt: null, sessionId: null };
  s.seats[0]!.intendedSkills = { changed: "new" }; p.skills = { changed: "old" };
  s.probes = [p];
  const output = renderCanvas(s);
  assert.match(output, /maintenance checks stale \(3d ago\)/);
  assert.doesNotMatch(output, /reconnect Vercel|skills differ/);
});

test("fresh reauthentication problems are grouped by service without plugin inventories", async () => {
  const s = snapshot();
  const p = { ...await probeProfile("one", "/missing-health-test-profile", "claude"),
    edgeId: "edge", accountProfile: "/profiles/one", observedAt: now };
  p.mcp = ["api", "builds", "bindings", "observability"].map(name => ({ name: `plugin:cloudflare:cloudflare-${name}`, state: "reauth_required", observedAt: now }));
  s.seats[0]!.subscription = { edge: "edge", lastSeen: now, expiresAt: null, sessionId: null }; s.probes = [p];
  const output = renderCanvas(s);
  assert.match(output, /reconnect Cloudflare/);
  assert.equal((output.match(/Cloudflare/g) ?? []).length, 1);
  assert.doesNotMatch(output, /cloudflare-api|cloudflare-builds/);
});

test("health still requires the exact edge and absolute profile", async () => {
  const s = snapshot();
  s.seats[0]!.subscription = { edge: "cx53", lastSeen: now, expiresAt: null, sessionId: null };
  const p = { ...await probeProfile("one", "/missing-health-test-profile", "claude"), edgeId: "cx53",
    accountProfile: "/profiles/one", observedAt: now };
  s.probes = [p];
  assert.doesNotMatch(renderCanvas(s), /\*\*One:\*\* maintenance not observed/);
  p.edgeId = "mac";
  assert.match(renderCanvas(s), /maintenance not observed/);
  p.edgeId = "cx53"; s.seats[0]!.profile = "~/profiles/one";
  assert.match(renderCanvas(s), /maintenance not observed/);
});

test("expired subscriptions and unavailable feeds remain explicit", () => {
  const s = snapshot();
  s.seats[0]!.subscription = { edge: "edge", lastSeen: now, expiresAt: "2026-09-05T14:59:00.000Z", sessionId: "live" };
  s.usageState = "unavailable";
  const output = renderCanvas(s);
  assert.match(output, /Hive edge expired/);
  assert.match(output, /usage feed unavailable/);
  assert.match(output, /quota unavailable/);
});

test("probe reads an explicitly declared skills directory", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-health-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, "external-skills");
  mkdirSync(join(skills, "test-skill"), { recursive: true });
  writeFileSync(join(skills, "test-skill/SKILL.md"), "declared skill");
  const result = await probeProfile("seat", root, "grok", skills);
  assert.equal(result.skillsRoot, skills);
  assert.equal(result.skills["test-skill"], treeDigest(join(skills, "test-skill")));
});

test("skill drift includes added files and executable changes; profile schema rejects secret fields", t => {
  const root = mkdtempSync(join(tmpdir(), "hive-health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "skill"));
  writeFileSync(join(root, "skill/SKILL.md"), "intent");
  const original = treeDigest(join(root, "skill"));
  chmodSync(join(root, "skill/SKILL.md"), 0o755);
  assert.notEqual(treeDigest(join(root, "skill")), original);
  assert.equal(ProfileReport.safeParse({ token: "must never reach the canvas" }).success, false);
});


test("unverified hashes and unknown plugin versions are not drift or absence", async () => {
  const s = snapshot();
  const p = { ...await probeProfile("one", "/missing-health-test-profile", "claude"),
    edgeId: "edge", accountProfile: "/profiles/one", observedAt: now };
  p.inventory = { state: "observed", observedAt: now };
  p.skills = { unknown: "unverified", changed: "b".repeat(64) };
  p.plugins = [{ name: "versionless", installed: null, intended: null, state: "version_unverified" }];
  s.seats[0]!.subscription = { edge: "edge", lastSeen: now, expiresAt: null, sessionId: null };
  s.seats[0]!.intendedSkills = { unknown: "a".repeat(64), changed: "a".repeat(64) };
  s.seats[0]!.intendedPlugins = ["versionless"]; s.probes = [p];
  const output = renderCanvas(s);
  assert.match(output, /1 skills differ from intended/);
  assert.match(output, /1 skills could not be checked/);
  assert.doesNotMatch(output, /2 skills differ|plugins need checking/);
  p.plugins[0]!.state = "version_differs"; p.plugins[0]!.intended = "1.0";
  assert.doesNotMatch(renderCanvas(s), /plugins need checking/);
});

test("the native probe keeps a present versionless plugin unverified", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-versionless-"));
  const old = process.env.HIVE_CLAUDE_COMMAND;
  t.after(() => { if (old === undefined) delete process.env.HIVE_CLAUDE_COMMAND; else process.env.HIVE_CLAUDE_COMMAND = old; rmSync(root, {recursive:true,force:true}); });
  const cli = join(root, "claude");
  writeFileSync(join(root, "settings.json"), JSON.stringify({enabledPlugins:{"example@market":true}}));
  mkdirSync(join(root, "plugins/marketplaces/market/.claude-plugin"), {recursive:true});
  writeFileSync(join(root, "plugins/marketplaces/market/.claude-plugin/marketplace.json"), JSON.stringify({plugins:[{name:"example",version:"1.0"}]}));
  writeFileSync(cli, `#!/usr/bin/env node\nconsole.log(process.argv[2]==='plugin' ? JSON.stringify([{id:'example@market',scope:'user',enabled:true,installPath:${JSON.stringify(root)}}]) : JSON.stringify({loggedIn:true}));\n`, {mode:0o700});
  process.env.HIVE_CLAUDE_COMMAND = cli;
  const report = await probeProfile("one", root, "claude");
  assert.equal(report.plugins[0]?.state, "version_unverified");
  assert.equal(report.plugins[0]?.installed, null);
});

test("collection retains exact persisted evidence and chooses the last changed delivery", async t => {
  const root = mkdtempSync(join(tmpdir(), "hive-canvas-collect-"));
  const token = process.env.HIVE_USAGE_READ_TOKEN; delete process.env.HIVE_USAGE_READ_TOKEN;
  t.after(() => { if (token !== undefined) process.env.HIVE_USAGE_READ_TOKEN = token; rmSync(root,{recursive:true,force:true}); });
  const doctrine = join(root,"doctrine");
  for (const dir of ["seats", "templates/claude", "skills"]) mkdirSync(join(doctrine,dir),{recursive:true});
  writeFileSync(join(doctrine,"seats/registry.json"),JSON.stringify({one:{provider:"claude",machine:"edge",profile_dir:"/profiles/one",skills:[]}}));
  writeFileSync(join(doctrine,"templates/claude/settings.json"),JSON.stringify({enabledPlugins:{}}));
  execFileSync("git",["init","-q",doctrine]);
  execFileSync("git",["-C",doctrine,"add","."]);
  execFileSync("git",["-C",doctrine,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","fixture"]);
  const dbPath = join(root,"broker.sqlite"); const db = new Database(dbPath);
  t.after(() => db.close());
  db.exec(`CREATE TABLE subscriptions(actor TEXT,provider TEXT,account_profile TEXT,home_edge TEXT,session_id TEXT,expires_at TEXT);
    CREATE TABLE edges(edge_id TEXT,last_seen_at TEXT);
    CREATE TABLE deliveries(delivery_id INTEGER,actor TEXT,status TEXT,updated_at TEXT);
    CREATE TABLE profile_health(actor TEXT,edge_id TEXT,report_json TEXT);`);
  const time = new Date().toISOString();
  const report = await probeProfile("one","/profiles/one","claude");
  report.observedAt=time;report.auth={state:"local_login_present",observedAt:time};report.inventory={state:"observed",observedAt:time};
  db.prepare("INSERT INTO subscriptions VALUES ('one','claude','/profiles/one','edge',NULL,NULL)").run();
  db.prepare("INSERT INTO edges VALUES ('edge',?)").run(time);
  db.prepare("INSERT INTO deliveries VALUES (1,'one','failed',?), (2,'one','processed',?)").run(time,"2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO profile_health VALUES ('one','edge',?)").run(JSON.stringify(report));
  const config = {doctrineRoot:doctrine,brokerDb:dbPath,usageUrl:"https://example.invalid",archiveUrl:"https://example.test/archive",
    usageBindings:[{actor:"one",edgeId:"edge",profileId:"collector-one"}],
    probes:[{actor:"one",edgeId:"wrong-edge",command:[process.execPath,"-e",`process.stdout.write(${JSON.stringify(JSON.stringify(report))})`]}]};
  const s = await collectCanvas(config);
  assert.equal(s.probes.length,2);
  assert.equal(s.seats[0]?.delivery?.id,1);
  assert.match(renderCanvas(s),/last delivery failed/);
  assert.doesNotMatch(renderCanvas(s),/maintenance not observed/);
  db.exec("DELETE FROM subscriptions"); config.probes[0]!.edgeId="edge";
  const unenrolled = await collectCanvas(config);
  assert.doesNotMatch(renderCanvas(unenrolled),/maintenance not observed/);
});
