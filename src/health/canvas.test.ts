import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { age, renderCanvas, type CanvasSnapshot } from "./canvas.js";
import { probeProfile, treeDigest } from "./profile-probe.js";
import { ProfileReport } from "./report.js";

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
    bindings: [{ actor: "one", profileId: "collector-one", edgeId: "edge" }], accountChanges: [],
  };
}

test("never-seen seats and collectors remain visible and a pool failure is not profile auth", () => {
  const output = renderCanvas(snapshot());
  assert.match(output, /\| never \|/);
  assert.match(output, /\| collector: silent \|/);
  assert.match(output, /maintenance probe unreachable or failed \(not an auth verdict\)/);
  assert.match(output, /pool status auth_expired \(pool evidence, not this profile's auth test\)/);
  assert.match(output, /latest usage rejected: invalid_reset/);
  assert.match(output, /quota sample 4d ago/);
});

test("receipt age cannot refresh a quota sample, and future/invalid dates never look fresh", () => {
  assert.equal(age("nonsense", now), "invalid observation time");
  assert.equal(age("2026-09-06T00:00:00Z", now), "invalid observation time");
  const output = renderCanvas(snapshot());
  assert.match(output, /2026-09-01T00:00:00.000Z \(4d ago\)/);
  assert.match(output, /2026-09-05T15:00:00.000Z \(0m ago\)/);
});

test("same actor under a different pinned profile cannot supply a health verdict", async () => {
  const s = snapshot();
  const p = await probeProfile("one", "/missing-health-test-profile", "claude");
  p.observedAt = now; p.auth = { state: "local_login_present", observedAt: now };
  s.probes.push(p);
  assert.doesNotMatch(renderCanvas(s), /local_login_present/);
});

test("account replacement annotates history without fabricating or merging quota pools", () => {
  const s = snapshot();
  s.accountChanges = [{ actors: ["one", "never"], label: "Shared personal Max", note: "Previous Team samples are historical; new identity unreported." }];
  const output = renderCanvas(s);
  assert.match(output, /Shared personal Max, shared by one, never/);
  assert.match(output, /pool-shared \/ Max/);
  assert.equal(s.pools.length, 1);
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
