import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  contractSchema,
  contractValidator,
  definitionForModel,
  validateAction,
  validateExternalResult,
  validatePolicy,
} from "./contract.js";

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts/conformance");

interface CorpusCase {
  model: string;
  instance: unknown;
  expect?: { code: string; why: string };
}

function corpus(kind: "valid" | "invalid"): Array<{ name: string; body: CorpusCase }> {
  const dir = join(CORPUS, kind);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length >= 12, `${kind} corpus has at least 12 cases`);
  return files.map((name) => ({ name, body: JSON.parse(readFileSync(join(dir, name), "utf8")) as CorpusCase }));
}

// §2.1: the corpus, not the schema file alone, is what makes it one contract — every valid
// instance is admitted and every invalid one refused `malformed`, exactly as pydantic rules.
test("conformance corpus: valid instances are admitted", () => {
  for (const { name, body } of corpus("valid")) {
    const validate = contractValidator<unknown>(definitionForModel(body.model));
    const result = validate(body.instance);
    assert.equal(result.ok, true, `${name}: ${result.ok ? "" : result.detail}`);
  }
});

test("conformance corpus: invalid instances are refused malformed", () => {
  for (const { name, body } of corpus("invalid")) {
    assert.equal(body.expect?.code, "malformed", `${name} expects malformed`);
    const validate = contractValidator<unknown>(definitionForModel(body.model));
    const result = validate(body.instance);
    assert.equal(result.ok, false, `${name}: admitted but expected malformed (${body.expect?.why})`);
    if (!result.ok) assert.equal(result.code, "malformed");
  }
});

test("conformance corpus covers every one of the thirteen verbs (§4)", () => {
  const kinds = new Set(
    corpus("valid")
      .filter(({ body }) => body.model === "action")
      .map(({ body }) => (body.instance as { kind: string }).kind),
  );
  assert.deepEqual(
    [...kinds].sort(),
    [
      "AdmitExternalResult", "AdoptPolicy", "Answer", "CancelRequest", "ClassifyFinding", "GrantRounds",
      "Hold", "ObservePR", "OpenRequest", "Release", "ResolveFinding", "RetractAnswer",
      "SetReviewerAvailability",
    ],
  );
});

test("validators return typed values and one-defect details", () => {
  const ok = validateAction({ kind: "GrantRounds", n: 1, reason: "one more" });
  assert.ok(ok.ok);
  if (ok.ok && ok.value.kind === "GrantRounds") assert.equal(ok.value.n, 1);

  const bad = validateAction({ kind: "GrantRounds", n: "1", reason: "one more" });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "malformed");
    assert.match(bad.detail, /^Action: /);
  }

  const extra = validatePolicy({ version: 1 });
  assert.equal(extra.ok, false);
});

test("§2.2 structural invariants are carried by the schema, not by code here", () => {
  // Only human_gate / stack may release on subject change (§G3).
  const hold = (kind: string, release_on: string) =>
    validateAction({ kind: "Hold", hold: { kind, reason: "r", release_on, blocks: { readiness: true, summons: false } } });
  assert.equal(hold("human_gate", "subject_change").ok, true);
  assert.equal(hold("operator", "subject_change").ok, false);
  assert.equal(hold("operator", "explicit").ok, true);
  // No fingerprint is invented for Codex (§2.3).
  const external = validateExternalResult({
    schema_version: "1", source: "codex", reviewed_head: "a".repeat(40), verdict: "clean", findings: [],
    source_record: { kind: "review", id: 1, version: "v1" }, submitted_at: "2026-09-06T00:00:00Z",
  });
  assert.equal(external.ok, true);
});

test("unknown $defs names fail loudly", () => {
  assert.throws(() => contractValidator("NoSuchThing"), /no \$defs\/NoSuchThing/);
  assert.throws(() => definitionForModel("no_such_model"), /exports no model/);
  assert.ok("Action" in contractSchema.$defs);
});
