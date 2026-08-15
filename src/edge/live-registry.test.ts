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

test("a live session keeps the attestation captured when it first registered", () => {
  const live = new LiveIngressRegistry();
  live.register(registration({ runtimeAttestation: first }), 60_000);
  const renewed = live.register(registration({ runtimeAttestation: second }), 60_000);
  assert.deepEqual(renewed.runtimeAttestation, first);
  assert.deepEqual(live.get("ariadne", "codex")?.runtimeAttestation, first);
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
