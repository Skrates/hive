import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ATTESTATION_FILENAME,
  MAX_ATTESTATION_BYTES,
  attestationWire,
  parseAttestationWire,
  readWakeAttestation,
} from "./attestation.js";
import { bindingFor } from "./store.js";

function profileWith(record: unknown | string): string {
  const dir = mkdtempSync(join(tmpdir(), "weave-attestation-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ATTESTATION_FILENAME),
    typeof record === "string" ? record : JSON.stringify(record, null, 2),
  );
  return dir;
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "weave.attestation/1",
    attestation_id: "sha256:" + "e".repeat(64),
    actor: "gnomon",
    doctrine: { remote: "RationallyPrime/weave-doctrine", commit: "a".repeat(40) },
    ...overrides,
  };
}

test("a wake binds to the attestation id and doctrine commit of its profile", async () => {
  const read = await readWakeAttestation(profileWith(record()));
  assert.equal(read.ok, true);
  const binding = bindingFor(read, "gnomon");
  assert.equal(binding.attestationId, "sha256:" + "e".repeat(64));
  assert.equal(binding.doctrineCommit, "a".repeat(40));
  assert.equal(binding.absence, null);
});

test("an absent attestation is a named absence, never a silent null binding", async () => {
  const read = await readWakeAttestation(mkdtempSync(join(tmpdir(), "weave-empty-")));
  assert.equal(read.ok, false);
  const binding = bindingFor(read, "gnomon");
  assert.equal(binding.attestationId, null);
  assert.equal(binding.absence, "no_attestation_file");
});

test("an unparseable attestation is distinguished from a missing one", async () => {
  const read = await readWakeAttestation(profileWith("{ not json"));
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});

test("an unknown schema is refused rather than read field-by-field", async () => {
  const read = await readWakeAttestation(profileWith(record({ schema: "weave.attestation/99" })));
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unknown_schema");
});

test("a record missing the bound fields is incomplete, not partially believed", async () => {
  for (const broken of [
    record({ attestation_id: 7 }),
    record({ doctrine: {} }),
    record({ actor: null }),
  ]) {
    const read = await readWakeAttestation(profileWith(broken));
    assert.equal(read.ok, false);
    assert.equal(bindingFor(read, "gnomon").absence, "attestation_incomplete");
  }
});

test("empty attestation fields are incomplete, matching the wire parser's strictness", async () => {
  // The tampered/partially-installed shape: present, typed, and empty. The
  // reader must name the absence — forwarding ok:true would make the strict
  // wire parser kill the live daemon, turning "does not refuse" into a refusal.
  for (const broken of [
    record({ attestation_id: "" }),
    record({ doctrine: { commit: "" } }),
    record({ actor: "" }),
  ]) {
    const read = await readWakeAttestation(profileWith(broken));
    assert.equal(read.ok, false);
    assert.equal(bindingFor(read, "gnomon").absence, "attestation_incomplete");
  }
});

test("a profile installed for another seat keeps its evidence and flags the mismatch", async () => {
  // The 2026-08-15 scar: a seat dispatched from the wrong config dir. The id
  // is exactly what identifies the profile it actually ran, so it must be
  // recorded — dropping it would erase the evidence the mismatch is made of.
  const read = await readWakeAttestation(profileWith(record({ actor: "theoros" })));
  assert.equal(read.ok, true);
  const binding = bindingFor(read, "gnomon");
  assert.equal(binding.attestationId, "sha256:" + "e".repeat(64));
  assert.equal(binding.absence, "attestation_actor_mismatch");
});

test("reading an attestation never throws into the dispatch path", async () => {
  // A directory where the file should be: open/stat refuses it as unreadable.
  const dir = mkdtempSync(join(tmpdir(), "weave-eisdir-"));
  mkdirSync(join(dir, ATTESTATION_FILENAME));
  const read = await readWakeAttestation(dir);
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});

test("a FIFO attestation is unreadable instead of blocking the edge loop", { timeout: 1_000 }, async () => {
  // O_NONBLOCK's half of the guarantee: a FIFO with no writer opens rather than
  // parking, and `stat` then refuses it. The regular-file half — a stalled
  // network mount, which O_NONBLOCK does not bound — is answered by doing this
  // on the threadpool instead of the event loop, which no unit test can
  // usefully simulate without a real stalled mount.
  const dir = mkdtempSync(join(tmpdir(), "weave-fifo-"));
  execFileSync("mkfifo", [join(dir, ATTESTATION_FILENAME)]);
  const read = await readWakeAttestation(dir);
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});

test("the live-register wire form round-trips a successful read", async () => {
  const read = await readWakeAttestation(profileWith(record()));
  const parsed = parseAttestationWire(attestationWire(read));
  assert.deepEqual(parsed, read);
});

test("a missing live-register attestation is treated as unset, not unreadable", () => {
  assert.equal(parseAttestationWire(undefined), undefined);
  assert.equal(parseAttestationWire(null), undefined);
});

test("an oversized attestation is unreadable instead of an unbounded read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-huge-"));
  writeFileSync(join(dir, ATTESTATION_FILENAME), "x".repeat(MAX_ATTESTATION_BYTES + 1));
  const read = await readWakeAttestation(dir);
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});
