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
    // Required on a registration: a caller with nothing to report names the
    // absence rather than omitting the field. This is what `control.ts` mints
    // for a surface that sent no attestation.
    runtimeAttestation: { ok: false, absence: "attestation_unreported" } as const,
    cwd: null,
    attentionProtocol: 0,
    ...overrides,
  };
}

test("§3.2 session custody binds one attested actor; renewal keeps it and expiry or deregistration revokes it", () => {
  let now = 0;
  const live = new LiveIngressRegistry({ now: () => now });
  const input = registration({ runtimeAttestation: first });
  live.register(input, 60_000);
  const custody = live.sessionCustody("thread-1");
  assert.ok(custody.available);
  assert.deepEqual(live.resolveSession(custody.token), { actor: "ariadne", session_id: "thread-1" });
  now = 30_000;
  live.register(input, 60_000);
  assert.deepEqual(live.sessionCustody("thread-1"), custody);
  now = 90_001;
  assert.equal(live.resolveSession(custody.token), null);
  live.register(input, 60_000);
  const next = live.sessionCustody("thread-1");
  assert.ok(next.available);
  assert.notEqual(next.token, custody.token);
  live.deregister("ariadne", "codex", "thread-1");
  assert.equal(live.resolveSession(next.token), null);
});

test("§3.2 shared-edge sessions remain distinct; ambiguous or unattested custody is explicitly deferred", () => {
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  const ariadne = live.sessionCustody("thread-1");
  assert.ok(ariadne.available);
  live.register(registration({ actor: "theoros", sessionId: "thread-2", runtimeAttestation: {
    ok: true, attestation: { ...first.attestation, actor: "theoros" },
  } }), 60_000);
  const theoros = live.sessionCustody("thread-2");
  assert.ok(theoros.available);
  assert.notEqual(ariadne.token, theoros.token);
  assert.deepEqual(live.resolveSession(theoros.token), { actor: "theoros", session_id: "thread-2" });
  live.register(registration({ actor: "theoros", runtimeAttestation: first }), 60_000);
  assert.deepEqual(live.sessionCustody("thread-1"), { available: false, reason: "session_actor_ambiguous" });
  assert.equal(live.resolveSession(ariadne.token), null);
  live.deregister("theoros", "codex", "thread-1");
  assert.equal(live.resolveSession(ariadne.token), null, "removing an ambiguous peer does not revive the old token");
  live.register(registration({ runtimeAttestation: second }), 60_000);
  assert.deepEqual(live.sessionCustody("thread-1"), { available: false, reason: "session_attestation_unproven" });
  assert.deepEqual(live.sessionCustody("missing"), { available: false, reason: "session_not_registered" });
});

test("two sessions of one actor retain independent custody; a bare id shared across providers revokes only that id", () => {
  const live = new LiveIngressRegistry();
  const a = registration({ sessionId: "A", runtimeAttestation: first });
  live.register(a, 60_000);
  const tokenA = live.sessionCustody("A");
  assert.ok(tokenA.available);
  live.register({ ...a, sessionId: "B" }, 60_000);
  const tokenB = live.sessionCustody("B");
  assert.ok(tokenB.available);
  live.register(a, 60_000);
  assert.deepEqual(live.sessionCustody("A"), tokenA);
  assert.deepEqual(live.resolveSession(tokenB.token), { actor: "ariadne", session_id: "B" });

  live.register({ ...a, provider: "claude" }, 60_000);
  assert.deepEqual(live.sessionCustody("A"), { available: false, reason: "session_actor_ambiguous" });
  live.deregister("ariadne", "claude", "A");
  assert.equal(live.resolveSession(tokenA.token), null);
  const fresh = live.sessionCustody("A");
  assert.ok(fresh.available);
  assert.notEqual(fresh.token, tokenA.token);
  live.deregister("ariadne", "codex", "A");
  assert.equal(live.resolveSession(fresh.token), null);
  assert.deepEqual(live.sessionCustody("B"), tokenB);
});

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

test("a heartbeat reporting the unreported absence leaves a known snapshot alone", () => {
  // The other side of the same coin: `attestation_unreported` arriving as the
  // NEW report adds nothing and must not disturb a known snapshot. Asymmetric
  // by design — as the PREVIOUS value it means the start snapshot was never
  // known, which is why the test above ends ambiguous and this one does not.
  // (The field can no longer be omitted, so the absence is the only shape this
  // case takes — naming it "an omitted field" would describe a dead input.)
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  const renewed = live.register(
    registration({ runtimeAttestation: { ok: false, absence: "attestation_unreported" } }),
    60_000,
  );
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

test("ADR-0004 a stopping session withdraws only itself; routing falls back to a session still live", () => {
  let clock = 1_000_000;
  const live = new LiveIngressRegistry({ now: () => clock });
  live.register(registration({ sessionId: "A", socketPath: "/tmp/a.sock" }), 60_000);
  clock += 1_000;
  live.register(registration({ sessionId: "B", socketPath: "/tmp/b.sock" }), 60_000);

  // A stops while B is the actor's current route: B is untouched.
  live.deregister("ariadne", "codex", "A");
  assert.equal(live.getExact("ariadne", "codex", "A"), null, "the stopped session is no longer live");
  assert.equal(live.get("ariadne", "codex")?.sessionId, "B");
  assert.equal(live.getExact("ariadne", "codex", "B")?.socketPath, "/tmp/b.sock");

  // B stops while A is still open: ordinary routing falls back to A.
  live.register(registration({ sessionId: "A", socketPath: "/tmp/a.sock" }), 60_000);
  clock += 1_000;
  live.register(registration({ sessionId: "B", socketPath: "/tmp/b.sock" }), 60_000);
  live.deregister("ariadne", "codex", "B");
  assert.equal(live.get("ariadne", "codex")?.sessionId, "A");
  assert.equal(live.getExact("ariadne", "codex", "B"), null);
});

test("ADR-0004 interleaved sessions reconcile each heartbeat against its own session", () => {
  const live = new LiveIngressRegistry();
  live.register(registration({ sessionId: "A", runtimeAttestation: first }), 60_000);
  live.register(registration({ sessionId: "B", runtimeAttestation: second }), 60_000);
  // A reinstall under A's still-running process: A's next report disagrees with A's own first.
  const renewed = live.register(registration({ sessionId: "A", runtimeAttestation: second }), 60_000);
  assert.deepEqual(renewed.runtimeAttestation, { ok: false, absence: "attestation_ambiguous" });
  assert.deepEqual(live.getExact("ariadne", "codex", "B")?.runtimeAttestation, second);
});
