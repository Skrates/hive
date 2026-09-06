import assert from "node:assert/strict";
import test from "node:test";
import { validateEffect } from "./contract.js";
import { applicability, deliveryPayload, formatTarget, parseTarget, targetKind, type EffectTarget } from "./effects.js";
import { hold, request, review, SHA_A, SHA_B } from "./fixtures.js";

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

// §6.C3: closed pauses transport, merged is terminal; §6.G3: a summons-blocking hold pauses
// review-request transport only — the exhaustion episode's retrospective and gate delivery
// (§6.G4) go out under the exhaustion hold that blocks summons.
test("applicability: closed withholds, merged obsoletes, a summons-blocking hold withholds review requests but not the retrospective", () => {
  const summon: EffectTarget = { kind: "summon", requestId: "req_obs:run_1_1" };
  const delivery: EffectTarget = { kind: "delivery", actor: "talos", requestId: "req_obs:run_1_1" };
  assert.equal(applicability(summon, review({ lifecycle: "closed", requests: [request()] })), "withheld");
  assert.equal(applicability(delivery, review({ lifecycle: "closed", requests: [request()] })), "withheld");
  assert.equal(applicability(summon, review({ lifecycle: "merged", requests: [request()] })), "obsolete");
  assert.equal(applicability(delivery, review({ lifecycle: "merged", requests: [request()] })), "obsolete");

  const retro = request({ id: "req_retro", kind: "retrospective", mode: null, assignee: "theoros", required: false });
  const blocking = hold({ id: "hold_x", kind: "exhaustion", by: { kind: "system", caused_by: "ans_1" }, blocks: { readiness: true, summons: true } });
  const heldReview = review({ requests: [request(), retro], holds: [blocking] });
  assert.equal(applicability(summon, heldReview), "withheld");
  assert.equal(applicability(delivery, heldReview), "withheld");
  assert.equal(applicability({ kind: "delivery", actor: "theoros", requestId: "req_retro" }, heldReview), "applicable", "the retrospective goes out under the hold");
  assert.equal(applicability({ kind: "delivery", actor: "talos", requestId: "req_retro" }, heldReview), "applicable", "so does the author's gate delivery");

  const readinessOnly = review({ requests: [request()], holds: [hold({ blocks: { readiness: true, summons: false } })] });
  assert.equal(applicability(summon, readinessOnly), "applicable", "a hold that does not block summons pauses nothing");
  const releasedHold = review({ requests: [request()], holds: [hold({ ...blocking, released: { by: { kind: "operator", id: "hakon" }, at: "2026-09-06T13:00:00.000Z", reason: "granted" } })] });
  assert.equal(applicability(summon, releasedHold), "applicable", "a released hold pauses nothing");
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
