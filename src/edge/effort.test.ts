import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CODEX_MODEL_CEILINGS,
  CODEX_UNKNOWN_MODEL_CEILING,
  clampEffortToCodexModel,
  clampEffortToXhigh,
  disposeDeliveryEffort,
  parseDeliveryEffort,
  WAKE_EFFORT_TIERS,
} from "./effort.js";
import { claudeEffortArgs, codexEffortArgs, grokEffortArgs, readCodexPinnedModel } from "./providers.js";

/** A throwaway CODEX_HOME holding exactly `config.toml`, removed when `body` returns. */
function withCodexHome<T>(configToml: string | null, body: (codexHome: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "hive-codex-home-"));
  try {
    if (configToml !== null) writeFileSync(join(home, "config.toml"), configToml);
    return body(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

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
  // A null tier returns before the pinned config is even opened, so a
  // nonexistent CODEX_HOME cannot change the no-overlay invocation.
  assert.deepEqual(codexEffortArgs(null, "/nonexistent/codex/home"), []);
  assert.deepEqual(codexEffortArgs(null, null), []);

  // Claude's ladder tops at max — Codex's swarm rung clamps down to it.
  assert.deepEqual(claudeEffortArgs("max"), ["--effort", "max"]);
  assert.deepEqual(claudeEffortArgs("ultra"), ["--effort", "max"]);
  assert.deepEqual(claudeEffortArgs("low"), ["--effort", "low"]);

  // Grok parse-validates low|medium|high|xhigh — max and ultra arrive clamped.
  assert.deepEqual(grokEffortArgs("xhigh"), ["--reasoning-effort", "xhigh"]);
  assert.deepEqual(grokEffortArgs("max"), ["--reasoning-effort", "xhigh"]);
  assert.deepEqual(grokEffortArgs("ultra"), ["--reasoning-effort", "xhigh"]);

  // Codex's ladder is the wake grammar only on a model that speaks all of it.
  withCodexHome('model = "gpt-6-astra"\n', (home) => {
    assert.deepEqual(codexEffortArgs("high", home), ["-c", "model_reasoning_effort=high"]);
    assert.deepEqual(codexEffortArgs("max", home), ["-c", "model_reasoning_effort=max"]);
    assert.deepEqual(codexEffortArgs("ultra", home), ["-c", "model_reasoning_effort=ultra"]);
    assert.deepEqual(codexEffortArgs(null, home), []);
  });
});

test("KRA-1414 falsifier: a below-union model with Effort: ultra gets a tier that model supports", () => {
  // gpt-5.5's live ladder stops at xhigh (codex debug models --bundled,
  // codex-cli 0.153.4). Before the clamp this produced
  // `-c model_reasoning_effort=ultra`, which Codex rejects at provider start —
  // deterministically, so every retry re-earned the same failure.
  withCodexHome('model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n', (home) => {
    assert.deepEqual(codexEffortArgs("ultra", home), ["-c", "model_reasoning_effort=xhigh"]);
    assert.deepEqual(codexEffortArgs("max", home), ["-c", "model_reasoning_effort=xhigh"]);
    // Below the ceiling nothing moves.
    assert.deepEqual(codexEffortArgs("medium", home), ["-c", "model_reasoning_effort=medium"]);
  });
  // gpt-5.6-luna stops one rung lower than the grammar: ultra clamps, max does not.
  withCodexHome('model = "gpt-5.6-luna"\n', (home) => {
    assert.deepEqual(codexEffortArgs("ultra", home), ["-c", "model_reasoning_effort=max"]);
    assert.deepEqual(codexEffortArgs("max", home), ["-c", "model_reasoning_effort=max"]);
  });
});

test("every clamped tier is one the model's own ladder contains, and no clamp raises a tier", () => {
  const ceilings = [...new Set([...Object.values(CODEX_MODEL_CEILINGS), CODEX_UNKNOWN_MODEL_CEILING])];
  for (const model of [...Object.keys(CODEX_MODEL_CEILINGS), "gpt-99-unreleased", null]) {
    const ceiling = model === null ? CODEX_UNKNOWN_MODEL_CEILING : CODEX_MODEL_CEILINGS[model] ?? CODEX_UNKNOWN_MODEL_CEILING;
    for (const tier of WAKE_EFFORT_TIERS) {
      const clamped = clampEffortToCodexModel(tier, model);
      assert.ok(
        WAKE_EFFORT_TIERS.indexOf(clamped) <= WAKE_EFFORT_TIERS.indexOf(ceiling),
        `${String(model)} + ${tier} -> ${clamped} exceeds ${ceiling}`,
      );
      assert.ok(
        WAKE_EFFORT_TIERS.indexOf(clamped) <= WAKE_EFFORT_TIERS.indexOf(tier),
        `${String(model)} + ${tier} -> ${clamped} raised the requested tier`,
      );
    }
  }
  // The table's ceilings are rungs of the wake grammar, so a clamp result is
  // always a tier some model actually publishes.
  for (const ceiling of ceilings) assert.ok(WAKE_EFFORT_TIERS.includes(ceiling));
});

test("an unknown or unreadable pinned model falls to the common floor, never the union", () => {
  // A model slug released after the table's snapshot.
  withCodexHome('model = "gpt-7-unreleased"\n', (home) => {
    assert.deepEqual(codexEffortArgs("ultra", home), ["-c", "model_reasoning_effort=xhigh"]);
  });
  // No config.toml at all.
  withCodexHome(null, (home) => {
    assert.equal(readCodexPinnedModel(home), null);
    assert.deepEqual(codexEffortArgs("ultra", home), ["-c", "model_reasoning_effort=xhigh"]);
  });
  // A config that names no model.
  withCodexHome('approval_policy = "never"\n', (home) => {
    assert.equal(readCodexPinnedModel(home), null);
  });
  assert.equal(CODEX_UNKNOWN_MODEL_CEILING, "xhigh");
});

test("the pinned model read takes the effective model, not the first model-ish key", () => {
  // Ariadne's live cx53 config shape: `model_reasoning_effort` sits directly
  // under `model`, and profile/project tables follow.
  assert.equal(
    withCodexHome(
      [
        'approval_policy = "never"',
        'sqlite_home = "/home/hive/.hive/profiles/ariadne"',
        '',
        'model = "gpt-6-astra"   # ported from the mac',
        'model_reasoning_effort = "medium"',
        'plan_mode_reasoning_effort = "xhigh"',
        '',
        '[features]',
        'hooks = true',
        '',
        '[projects."/home/hive/work-ariadne/hive"]',
        'trust_level = "trusted"',
        '',
      ].join("\n"),
      readCodexPinnedModel,
    ),
    "gpt-6-astra",
  );
  // A selected default profile wins over the root model...
  assert.equal(
    withCodexHome('model = "gpt-6-astra"\nprofile = "lean"\n\n[profiles.lean]\nmodel = "gpt-5.5"\n', readCodexPinnedModel),
    "gpt-5.5",
  );
  // ...but a profile table nobody selected does not.
  assert.equal(
    withCodexHome('model = "gpt-6-astra"\n\n[profiles.lean]\nmodel = "gpt-5.5"\n', readCodexPinnedModel),
    "gpt-6-astra",
  );
  // A selected profile that overrides no model falls back to the root model.
  assert.equal(
    withCodexHome('model = "gpt-6-astra"\nprofile = "lean"\n\n[profiles.lean]\napproval_policy = "never"\n', readCodexPinnedModel),
    "gpt-6-astra",
  );
  // A quoted profile table name resolves the same way.
  assert.equal(
    withCodexHome('profile = "a.b"\n\n[profiles."a.b"]\nmodel = "gpt-5.2"\n', readCodexPinnedModel),
    "gpt-5.2",
  );
});

test("KRA-1414: an overlay a route cannot honour is disposed as a publishable reason", () => {
  // Headless with one tier: honoured, nothing to say.
  assert.deepEqual(
    disposeDeliveryEffort({ kind: "tier", tier: "max" }, false),
    { effort: "max", unused: null },
  );
  // No overlay at all: the byte-identical path, on either route.
  for (const live of [true, false]) {
    assert.deepEqual(disposeDeliveryEffort({ kind: "none" }, live), { effort: null, unused: null });
  }
  // Live with a tier: refused, and the refusal names the route.
  const live = disposeDeliveryEffort({ kind: "tier", tier: "max" }, true);
  assert.equal(live.effort, null);
  assert.equal(live.unused?.code, "effort_overlay_unused");
  assert.match(live.unused?.detail ?? "", /live_session_fixed_at_spawn/);
  assert.match(live.unused?.detail ?? "", /max/);
  // Conflict: refused on BOTH routes, and it outranks the live reason — a
  // delivery naming two tiers was not honourable headless either.
  for (const isLive of [true, false]) {
    const conflict = disposeDeliveryEffort({ kind: "conflict", tiers: ["low", "max"] }, isLive);
    assert.equal(conflict.effort, null);
    assert.equal(conflict.unused?.code, "effort_overlay_unused");
    assert.match(conflict.unused?.detail ?? "", /conflict:low,max/);
    assert.doesNotMatch(conflict.unused?.detail ?? "", /live_session_fixed_at_spawn/);
  }
});
