import assert from "node:assert/strict";
import test from "node:test";
import { validateEffect } from "./contract.js";
import { applicability, deliveryPayload, formatTarget, parseTarget, targetKind, type EffectTarget } from "./effects.js";
import { request, review, SHA_A, SHA_B } from "./fixtures.js";

const TARGETS: Array<[string, EffectTarget]> = [
  [`check:skrates/hive:${SHA_A}`, { kind: "check", repo: "skrates/hive", headSha: SHA_A }],
  ["board:rev_obs:run_1", { kind: "board", reviewId: "rev_obs:run_1" }],
  ["thread:9001", { kind: "thread", commentId: 9001 }],
  ["delivery:talos:req_obs:run_1_1", { kind: "delivery", actor: "talos", requestId: "req_obs:run_1_1" }],
  ["summon:req_obs:run_1_1", { kind: "summon", requestId: "req_obs:run_1_1" }],
  ["announce:rev_obs:run_1", { kind: "announce", reviewId: "rev_obs:run_1" }],
];

// §8.1: the grammar round-trips, tolerates colons inside ids (module map §1), and agrees
// with the contract's own `Effect.target` pattern in both directions.
test("target grammar parses and formats every §8.1 kind, colons in ids included", () => {
  for (const [text, target] of TARGETS) {
    assert.deepEqual(parseTarget(text), target, text);
    assert.equal(formatTarget(target), text);
    const validated = validateEffect({ effect_id: "eff_1", kind: targetKind(target), target: text, payload: null });
    assert.equal(validated.ok, true, text);
  }
});

test("target grammar refuses what the contract refuses", () => {
  for (const bad of ["check:skrates/hive:abc", "thread:0", "thread:x", "delivery:Talos:req_1", "gate:rev_1", "board:"]) {
    assert.throws(() => parseTarget(bad), /grammar/, bad);
    assert.equal(validateEffect({ effect_id: "e", kind: "refresh", target: bad, payload: null }).ok, false, bad);
  }
});

test("refresh vs actionable follows the target kind (§8.1)", () => {
  assert.equal(targetKind({ kind: "check", repo: "a/b", headSha: SHA_A }), "refresh");
  assert.equal(targetKind({ kind: "board", reviewId: "r" }), "refresh");
  assert.equal(targetKind({ kind: "thread", commentId: 1 }), "refresh");
  assert.equal(targetKind({ kind: "delivery", actor: "a", requestId: "r" }), "actionable");
  assert.equal(targetKind({ kind: "summon", requestId: "r" }), "actionable");
  assert.equal(targetKind({ kind: "announce", reviewId: "r" }), "actionable");
});

// §6.D7: a summon (and a delivery) is applicable only while its request is pending at the
// current subject; §6.D8: `mergeable === false` withholds, `null` never does.
test("applicability: pending at the current subject ⇒ applicable; otherwise obsolete; conflicts withhold", () => {
  const summon: EffectTarget = { kind: "summon", requestId: "req_obs:run_1_1" };
  const delivery: EffectTarget = { kind: "delivery", actor: "talos", requestId: "req_obs:run_1_1" };
  const pending = review({ requests: [request()] });
  assert.equal(applicability(summon, pending), "applicable");
  assert.equal(applicability(delivery, pending), "applicable");

  assert.equal(applicability(summon, review({ requests: [request({ status: "answered" })] })), "obsolete");
  assert.equal(applicability(summon, review({ requests: [request({ status: "cancelled" })] })), "obsolete");
  assert.equal(applicability(summon, review({ requests: [] })), "obsolete");
  // Subject moved on: the request at SHA_A is no longer at the current subject.
  const moved = review({ requests: [request()] });
  moved.subject = { ...moved.subject, key: `${SHA_B}:main`, head_sha: SHA_B };
  assert.equal(applicability(summon, moved), "obsolete");

  const conflicting = review({ requests: [request()] });
  conflicting.observed = { ...conflicting.observed, mergeable: false };
  assert.equal(applicability(summon, conflicting), "withheld");
  assert.equal(applicability(delivery, conflicting), "withheld");
  const unknown = review({ requests: [request()] });
  unknown.observed = { ...unknown.observed, mergeable: null };
  assert.equal(applicability(summon, unknown), "applicable");
});

test("applicability: announce needs a merged Review; refreshes always apply", () => {
  const announce: EffectTarget = { kind: "announce", reviewId: "rev_obs:run_1" };
  assert.equal(applicability(announce, review()), "obsolete");
  assert.equal(applicability(announce, review({ lifecycle: "merged" })), "applicable");
  const conflicting = review();
  conflicting.observed = { ...conflicting.observed, mergeable: false };
  assert.equal(applicability({ kind: "board", reviewId: "r" }, conflicting), "applicable");
  assert.equal(applicability({ kind: "check", repo: "a/b", headSha: SHA_A }, conflicting), "applicable");
  assert.equal(applicability({ kind: "thread", commentId: 1 }, conflicting), "applicable");
});

test("payload readers return null for anything but the documented shape", () => {
  assert.equal(deliveryPayload(null), null);
  assert.equal(deliveryPayload({ actor: "talos" }), null);
  assert.deepEqual(
    deliveryPayload({ actor: "talos", request_id: "req_1", text: "burn", dedupe_key: "eff_1" }),
    { actor: "talos", request_id: "req_1", text: "burn", dedupe_key: "eff_1" },
  );
});
