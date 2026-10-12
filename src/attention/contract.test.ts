import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalInstant, validateAttentionCommand, validateContinuationTarget } from "./contract.js";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts/attention/examples");

function examples(kind: "valid" | "invalid"): Array<{ name: string; value: unknown }> {
  const dir = join(EXAMPLES, kind);
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
    .map((name) => ({ name, value: JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown }));
}

function validatorFor(name: string) {
  return name.startsWith("continuation.") ? validateContinuationTarget : validateAttentionCommand;
}

test("every valid attention example passes the contract it names", () => {
  const valid = examples("valid");
  assert.ok(valid.length >= 5);
  for (const { name, value } of valid) {
    const result = validatorFor(name)(value);
    assert.equal(result.ok, true, `${name}: ${result.ok ? "" : result.detail}`);
  }
});

test("every invalid attention example is refused as schema_rejected", () => {
  const invalid = examples("invalid");
  assert.ok(invalid.length >= 6);
  for (const { name, value } of invalid) {
    const result = validatorFor(name)(value);
    assert.equal(result.ok, false, `${name} must be refused`);
    if (!result.ok) assert.equal(result.code, "schema_rejected");
  }
});

test("a body that names an actor or principal is refused, never silently stripped", () => {
  const summon = examples("valid").find((entry) => entry.name === "command.summon.json")!.value as Record<string, unknown>;
  for (const field of ["actor", "principal", "source_id", "source_delivery_id"]) {
    const result = validateAttentionCommand({ ...summon, [field]: "ariadne" });
    assert.equal(result.ok, false, field);
  }
});

test("timestamps canonicalize to UTC milliseconds and impossible dates are refused", () => {
  assert.equal(canonicalInstant("2026-10-13T11:00:00+02:00"), "2026-10-13T09:00:00.000Z");
  assert.equal(canonicalInstant("2026-10-13T09:00:00.123456Z"), "2026-10-13T09:00:00.123Z");
  assert.equal(canonicalInstant("2026-13-45T09:00:00Z"), null);
});
