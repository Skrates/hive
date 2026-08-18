import assert from "node:assert/strict";
import { test } from "node:test";
import { clampEffortToXhigh, parseDeliveryEffort, parseWakeEffort, WAKE_EFFORT_TIERS } from "./effort.js";
import { claudeEffortArgs, codexEffortArgs, grokEffortArgs } from "./providers.js";

test("a bare Effort line yields its tier; absence yields null", () => {
  assert.equal(parseWakeEffort("WAKE: talos\n\nTICKET: KRA-1 x\nEffort: xhigh\nbody"), "xhigh");
  assert.equal(parseWakeEffort("WAKE: talos\n\nTICKET: KRA-1 x\nbody"), null);
  assert.equal(parseWakeEffort(""), null);
});

test("every wake-grammar tier parses", () => {
  for (const tier of WAKE_EFFORT_TIERS) {
    assert.equal(parseWakeEffort(`Effort: ${tier}`), tier);
  }
});

test("the line is exact — embedded, suffixed, or invalid-tier mentions never bind", () => {
  // Mid-sentence mention: prose about effort is not a directive.
  assert.equal(parseWakeEffort("we should raise Effort: xhigh next time"), null);
  // Trailing text after the tier: not the published grammar.
  assert.equal(parseWakeEffort("Effort: xhigh (requested by label)"), null);
  // Unknown tier: fail closed, never coerce.
  assert.equal(parseWakeEffort("Effort: turbo"), null);
  // Case drift: the dispatcher emits lowercase; anything else is not the grammar.
  assert.equal(parseWakeEffort("Effort: XHIGH"), null);
  assert.equal(parseWakeEffort("effort: xhigh"), null);
});

test("conflicting tiers are a human ambiguity — fail closed; repeats are not a conflict", () => {
  assert.equal(parseWakeEffort("Effort: low\nEffort: max"), null);
  assert.equal(parseWakeEffort("Effort: high\nquoted:\nEffort: high"), "high");
});

test("CRLF wakes parse — Slack text can arrive carriage-returned", () => {
  assert.equal(parseWakeEffort("WAKE: fable\r\nEffort: medium\r\n"), "medium");
});

test("the overlay fold ranges over the delivery, not one of its trusted messages", () => {
  // Overlay arrives only in a coalesced follow-up — same authority surface
  // as the initiating wake, and the same text the prompt will carry.
  assert.equal(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\ndo the thing" },
      coalescedMessages: [{ text: "WAKE: talos\n\nEffort: max\nalso this" }],
    }),
    "max",
  );
  // Distinct tiers across the delivery are a conflict — fail closed. The
  // initiating message must not silently win.
  assert.equal(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\nEffort: low\ndo the thing" },
      coalescedMessages: [{ text: "WAKE: talos\n\nEffort: max\nalso this" }],
    }),
    null,
  );
  // Repeats of one tier across messages are not a conflict.
  assert.equal(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\nEffort: high\ndo the thing" },
      coalescedMessages: [{ text: "WAKE: talos\n\nEffort: high\nalso this" }],
    }),
    "high",
  );
  // Zero coalesced messages is the initiating text alone.
  assert.equal(
    parseDeliveryEffort({
      event: { text: "WAKE: talos\n\nEffort: xhigh\ndo the thing" },
      coalescedMessages: [],
    }),
    "xhigh",
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
