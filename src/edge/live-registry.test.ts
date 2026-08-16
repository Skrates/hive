import assert from "node:assert/strict";
import test from "node:test";
import type { AttestationRead } from "./attestation.js";
import { LiveIngressRegistry } from "./live-registry.js";

const first: AttestationRead = {
  ok: true,
  attestation: { attestationId: "sha256:old", doctrineCommit: "a".repeat(40), actor: "ariadne" },
};
const second: AttestationRead = {
  ok: true,
  attestation: { attestationId: "sha256:new", doctrineCommit: "b".repeat(40), actor: "ariadne" },
};

function registration(overrides: Partial<Parameters<LiveIngressRegistry["register"]>[0]> = {}) {
  return {
    actor: "ariadne",
    provider: "codex" as const,
    socketPath: "/tmp/x.sock",
    sessionId: "thread-1",
    surfaceVersion: "test",
    ...overrides,
  };
}

test("a live session keeps its first snapshot while the surface keeps reporting the same artifacts", () => {
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  const renewed = live.register(registration({ runtimeAttestation: { ...first } }), 60_000);
  assert.deepEqual(renewed.runtimeAttestation, first);
  assert.deepEqual(live.get("ariadne", "codex")?.runtimeAttestation, first);
});

test("a session whose reports disagree is named ambiguous, not guessed", () => {
  // The hook is a fresh process per boundary: a mid-session reinstall under a
  // still-running process and a crash-then-resume of the same sessionId under
  // new artifacts send the identical report sequence. sessionId equality is not
  // proof the loaded runtime survived, so neither report may be asserted.
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  const renewed = live.register(registration({ runtimeAttestation: second }), 60_000);
  assert.deepEqual(renewed.runtimeAttestation, { ok: false, absence: "attestation_ambiguous" });
});

test("an ambiguous session stays ambiguous when the reports agree again", () => {
  // A later agreeing report cannot restore knowledge the edge never held.
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  live.register(registration({ runtimeAttestation: second }), 60_000);
  const settled = live.register(registration({ runtimeAttestation: second }), 60_000);
  assert.deepEqual(settled.runtimeAttestation, { ok: false, absence: "attestation_ambiguous" });
});

test("a session whose reports are both absences keeps the first, more specific one", () => {
  // Neither report offers an id, so no guess is on the table: the session's
  // own start evidence is the better record, and "ambiguous" would be a
  // strictly less informative absence.
  const live = new LiveIngressRegistry();
  const missing: AttestationRead = { ok: false, absence: "no_attestation_file" };
  live.register(registration({ runtimeAttestation: missing }), 60_000);
  const renewed = live.register(
    registration({ runtimeAttestation: { ok: false, absence: "attestation_unreadable" } }),
    60_000,
  );
  assert.deepEqual(renewed.runtimeAttestation, missing);
});

test("an install under a live session that had none is ambiguous, not adopted", () => {
  // A record appearing mid-session says nothing about what the running process
  // loaded — that half of the disagreement asserts an id on no evidence.
  const live = new LiveIngressRegistry();
  live.register(
    registration({ runtimeAttestation: { ok: false, absence: "no_attestation_file" } }),
    60_000,
  );
  const renewed = live.register(registration({ runtimeAttestation: second }), 60_000);
  assert.deepEqual(renewed.runtimeAttestation, { ok: false, absence: "attestation_ambiguous" });
});

test("a session whose first registration reported nothing cannot adopt a later id", () => {
  // The hole this file had: "the prior registration omitted the field" and
  // "there was no prior registration" both reach the registry as `undefined`,
  // so a later report was adopted as though captured at session start. The
  // ingress now names the omission (`attestation_unreported`), which makes the
  // two distinguishable and this case a disagreement rather than an adoption.
  // A session spanning a hook rollout — old hook sends no field, new hook sends
  // one — is the shape; if the profile changed in between, the id is not what
  // the running turn loaded.
  const live = new LiveIngressRegistry();
  live.register(
    registration({ runtimeAttestation: { ok: false, absence: "attestation_unreported" } }),
    60_000,
  );
  const renewed = live.register(registration({ runtimeAttestation: second }), 60_000);
  assert.deepEqual(renewed.runtimeAttestation, { ok: false, absence: "attestation_ambiguous" });
});

test("an unreported heartbeat is non-evidence, exactly like an omitted field", () => {
  // The other side of the same coin: `attestation_unreported` arriving as the
  // NEW report adds nothing and must not disturb a known snapshot. Asymmetric
  // by design — as the PREVIOUS value it means the start snapshot was never
  // known, which is why the test above ends ambiguous and this one does not.
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  const renewed = live.register(
    registration({ runtimeAttestation: { ok: false, absence: "attestation_unreported" } }),
    60_000,
  );
  assert.deepEqual(renewed.runtimeAttestation, first);
});

test("a surface that reports no attestation does not disturb the session's snapshot", () => {
  // Silence is not a disagreement — a hook with no CLAUDE_CONFIG_DIR sends none.
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  const renewed = live.register(registration(), 60_000);
  assert.deepEqual(renewed.runtimeAttestation, first);
});

test("a new live session replaces the prior session's attestation", () => {
  const live = new LiveIngressRegistry();
  live.register(registration({ sessionId: "thread-1", runtimeAttestation: first }), 60_000);
  const next = live.register(registration({ sessionId: "thread-2", runtimeAttestation: second }), 60_000);
  assert.deepEqual(next.runtimeAttestation, second);
});

test("a lapsed live registration does not keep a stale snapshot", () => {
  let now = 1_000;
  const live = new LiveIngressRegistry({ now: () => now });
  live.register(registration({ runtimeAttestation: first }), 1_000);
  now = 3_000;
  const next = live.register(registration({ runtimeAttestation: second }), 1_000);
  assert.deepEqual(next.runtimeAttestation, second);
});
