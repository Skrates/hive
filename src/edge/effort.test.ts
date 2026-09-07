import assert from "node:assert/strict";
import { test } from "node:test";
import { clampEffortToXhigh, parseDeliveryEffort, WAKE_EFFORT_TIERS } from "./effort.js";
import { claudeEffortArgs, codexEffortArgs, grokEffortArgs } from "./providers.js";

function singleMessage(text: string) {
  return { event: { text }, coalescedMessages: [] as const };
}

test("a bare Effort line yields its tier; absence yields none", () => {
  assert.deepEqual(
    parseDeliveryEffort(singleMessage("WAKE: talos\n\nTICKET: KRA-1 x\nEffort: xhigh\nbody")),
    { kind: "tier", tier: "xhigh" },
  );
  assert.deepEqual(parseDeliveryEffort(singleMessage("WAKE: talos\n\nTICKET: KRA-1 x\nbody")), { kind: "none" });
  assert.deepEqual(parseDeliveryEffort(singleMessage("")), { kind: "none" });
});

test("every wake-grammar tier parses", () => {
  for (const tier of WAKE_EFFORT_TIERS) {
    assert.deepEqual(parseDeliveryEffort(singleMessage(`Effort: ${tier}`)), { kind: "tier", tier });
  }
});

/** The same text carried by a coalesced follow-up instead of the initiating wake. */
function coalescedMessage(text: string) {
  return { event: { text: "WAKE: talos\n\ndo the thing" }, coalescedMessages: [{ text }] };
}

// Texts that look like the directive but are not the published grammar. Every
// row must fail closed from EITHER position of the trusted instruction set: a
// coalesced follow-up carries the same authority as the initiating wake, so
// exactness asserted only on `event.text` leaves the fold's other branch
// unguarded. (The positive control — a well-formed line in a coalesced
// follow-up that DOES bind — is the overlay-fold test below.)
const NON_DIRECTIVES = [
  "we should raise Effort: xhigh next time", // mid-sentence mention: prose is not a directive
  "Effort: xhigh (requested by label)", // trailing text after the tier
  "Effort: turbo", // unknown tier: fail closed, never coerce
  "Effort: XHIGH", // tier case drift: the dispatcher emits lowercase
  "effort: xhigh", // key case drift
  "   Effort: max", // leading whitespace: only trailing is tolerated (for CRLF)
  "\tEffort: max",
];

test("the line is exact — embedded, suffixed, indented, or invalid-tier mentions never bind", () => {
  for (const text of NON_DIRECTIVES) {
    assert.deepEqual(parseDeliveryEffort(singleMessage(text)), { kind: "none" }, `initiating: ${JSON.stringify(text)}`);
    assert.deepEqual(parseDeliveryEffort(coalescedMessage(text)), { kind: "none" }, `coalesced: ${JSON.stringify(text)}`);
  }
});

test("conflicting tiers are a human ambiguity — fail closed; repeats are not a conflict", () => {
  assert.deepEqual(parseDeliveryEffort(singleMessage("Effort: low\nEffort: max")), {
    kind: "conflict",
    tiers: ["low", "max"],
  });
  assert.deepEqual(parseDeliveryEffort(singleMessage("Effort: high\nquoted:\nEffort: high")), {
    kind: "tier",
    tier: "high",
  });
});

test("CRLF wakes parse — Slack text can arrive carriage-returned", () => {
  assert.deepEqual(parseDeliveryEffort(singleMessage("WAKE: fable\r\nEffort: medium\r\n")), {
    kind: "tier",
    tier: "medium",
  });
});

test("the overlay fold ranges over the delivery, not one of its trusted messages", () => {
  // Overlay arrives only in a coalesced follow-up — same authority surface
  // as the initiating wake, and the same text the prompt will carry.
  assert.deepEqual(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\ndo the thing" },
      coalescedMessages: [{ text: "WAKE: talos\n\nEffort: max\nalso this" }],
    }),
    { kind: "tier", tier: "max" },
  );
  // Distinct tiers across the delivery are a conflict — fail closed. The
  // initiating message must not silently win, and the result is not `none`.
  assert.deepEqual(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\nEffort: low\ndo the thing" },
      coalescedMessages: [{ text: "WAKE: talos\n\nEffort: max\nalso this" }],
    }),
    { kind: "conflict", tiers: ["low", "max"] },
  );
  // Repeats of one tier across messages are not a conflict.
  assert.deepEqual(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\nEffort: high\ndo the thing" },
      coalescedMessages: [{ text: "WAKE: talos\n\nEffort: high\nalso this" }],
    }),
    { kind: "tier", tier: "high" },
  );
  // Zero coalesced messages is the initiating text alone.
  assert.deepEqual(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\nEffort: xhigh\ndo the thing" },
      coalescedMessages: [],
    }),
    { kind: "tier", tier: "xhigh" },
  );
  // Absence is its own kind — the caller can tell it from a conflict.
  assert.deepEqual(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\ndo the thing" },
      coalescedMessages: [],
    }),
    { kind: "none" },
  );
});

test("a join cannot mint a directive no single message contains", () => {
  // Split across the message boundary: naive join("") would assemble
  // `Effort: max` from two innocent fragments. Each message is collected
  // on its own, so the fold must stay `none`.
  assert.deepEqual(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\nEffort:" },
      coalescedMessages: [{ text: " max\nalso this" }],
    }),
    { kind: "none" },
  );
});

test("tiers above a provider's ceiling clamp to that ceiling", () => {
  assert.equal(clampEffortToXhigh("max"), "xhigh");
  assert.equal(clampEffortToXhigh("ultra"), "xhigh");
  assert.equal(clampEffortToXhigh("low"), "low");
});

test("provider arg folds: null is byte-identical absence; tiers land in each provider's spelling", () => {
  assert.deepEqual(claudeEffortArgs(null), []);
  assert.deepEqual(grokEffortArgs(null), []);
  assert.deepEqual(codexEffortArgs(null), []);

  // Claude's ladder tops at max — Codex's swarm rung clamps down to it.
  assert.deepEqual(claudeEffortArgs("max"), ["--effort", "max"]);
  assert.deepEqual(claudeEffortArgs("ultra"), ["--effort", "max"]);
  assert.deepEqual(claudeEffortArgs("low"), ["--effort", "low"]);

  // Grok parse-validates low|medium|high|xhigh — max and ultra arrive clamped.
  assert.deepEqual(grokEffortArgs("xhigh"), ["--reasoning-effort", "xhigh"]);
  assert.deepEqual(grokEffortArgs("max"), ["--reasoning-effort", "xhigh"]);
  assert.deepEqual(grokEffortArgs("ultra"), ["--reasoning-effort", "xhigh"]);

  // Codex's ladder IS the wake grammar — verbatim through ultra, no mapping.
  assert.deepEqual(codexEffortArgs("high"), ["-c", "model_reasoning_effort=high"]);
  assert.deepEqual(codexEffortArgs("max"), ["-c", "model_reasoning_effort=max"]);
  assert.deepEqual(codexEffortArgs("ultra"), ["-c", "model_reasoning_effort=ultra"]);
});
