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

test("a wake binds to the attestation id and doctrine commit of its profile", () => {
  const read = readWakeAttestation(profileWith(record()));
  assert.equal(read.ok, true);
  const binding = bindingFor(read, "gnomon");
  assert.equal(binding.attestationId, "sha256:" + "e".repeat(64));
  assert.equal(binding.doctrineCommit, "a".repeat(40));
  assert.equal(binding.absence, null);
});

test("an absent attestation is a named absence, never a silent null binding", () => {
  const read = readWakeAttestation(mkdtempSync(join(tmpdir(), "weave-empty-")));
  assert.equal(read.ok, false);
  const binding = bindingFor(read, "gnomon");
  assert.equal(binding.attestationId, null);
  assert.equal(binding.absence, "no_attestation_file");
});

test("an unparseable attestation is distinguished from a missing one", () => {
  const read = readWakeAttestation(profileWith("{ not json"));
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});

test("an unknown schema is refused rather than read field-by-field", () => {
  const read = readWakeAttestation(profileWith(record({ schema: "weave.attestation/99" })));
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unknown_schema");
});

test("a record missing the bound fields is incomplete, not partially believed", () => {
  for (const broken of [
    record({ attestation_id: 7 }),
    record({ doctrine: {} }),
    record({ actor: null }),
  ]) {
    const read = readWakeAttestation(profileWith(broken));
    assert.equal(read.ok, false);
    assert.equal(bindingFor(read, "gnomon").absence, "attestation_incomplete");
  }
});

test("a profile installed for another seat keeps its evidence and flags the mismatch", () => {
  // The 2026-08-15 scar: a seat dispatched from the wrong config dir. The id
  // is exactly what identifies the profile it actually ran, so it must be
  // recorded — dropping it would erase the evidence the mismatch is made of.
  const read = readWakeAttestation(profileWith(record({ actor: "theoros" })));
  assert.equal(read.ok, true);
  const binding = bindingFor(read, "gnomon");
  assert.equal(binding.attestationId, "sha256:" + "e".repeat(64));
  assert.equal(binding.absence, "attestation_actor_mismatch");
});

test("reading an attestation never throws into the dispatch path", () => {
  // A directory where the file should be: open/fstat refuses it as unreadable.
  const dir = mkdtempSync(join(tmpdir(), "weave-eisdir-"));
  mkdirSync(join(dir, ATTESTATION_FILENAME));
  const read = readWakeAttestation(dir);
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});

test("a FIFO attestation is unreadable instead of blocking the edge loop", { timeout: 1_000 }, () => {
  // dispatchClaimed reads this before its first await; a blocking FIFO would
  // stall every co-tenant delivery on the edge.
  const dir = mkdtempSync(join(tmpdir(), "weave-fifo-"));
  execFileSync("mkfifo", [join(dir, ATTESTATION_FILENAME)]);
  const read = readWakeAttestation(dir);
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});

test("the live-register wire form round-trips a successful read", () => {
  const read = readWakeAttestation(profileWith(record()));
  const parsed = parseAttestationWire(attestationWire(read));
  assert.deepEqual(parsed, read);
});

test("a missing live-register attestation is treated as unset, not unreadable", () => {
  assert.equal(parseAttestationWire(undefined), undefined);
  assert.equal(parseAttestationWire(null), undefined);
});

test("an oversized attestation is unreadable instead of an unbounded read", () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-huge-"));
  writeFileSync(join(dir, ATTESTATION_FILENAME), "x".repeat(MAX_ATTESTATION_BYTES + 1));
  const read = readWakeAttestation(dir);
  assert.equal(read.ok, false);
  assert.equal(bindingFor(read, "gnomon").absence, "attestation_unreadable");
});
