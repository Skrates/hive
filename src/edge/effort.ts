/**
 * Per-delivery effort overlay (weave-doctrine effort-label pair, edge half).
 *
 * The wake text is the transport: a dispatcher (or a human writing a manual
 * wake) publishes a bare `Effort: <tier>` line and the edge folds it into the
 * provider invocation at spawn/resume. The seat's profile settings are never
 * touched — the overlay lives and dies with the one CLI invocation, which is
 * what kills the edit-profile-then-revert dance permanently.
 *
 * The line rides the delivery's trusted instruction set: the initiating
 * event text plus every coalesced same-thread follow-up. That is the same
 * authority surface the `WAKE:` envelope rides, and the same texts
 * `frameWakeInstruction` puts in the imperative section. Quoted material
 * in the replay context never reaches this parser.
 */

/**
 * The wake-grammar tiers — the UNION of the provider ladders, so a ticket can
 * request any tier some provider actually has. `ultra` is Codex's top rung
 * (max + agent swarm); providers whose ladder stops lower clamp to their own
 * ceiling.
 */
export const WAKE_EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type WakeEffort = (typeof WAKE_EFFORT_TIERS)[number];

const EFFORT_LINE = new RegExp(`^Effort: (${WAKE_EFFORT_TIERS.join("|")})$`);

function isWakeEffort(value: string): value is WakeEffort {
  return (WAKE_EFFORT_TIERS as readonly string[]).includes(value);
}

/**
 * The single effort tier a wake requests, or null.
 *
 * Null on zero `Effort:` lines (profile default applies — the no-label wake
 * stays byte-identical in behavior) and on *conflicting* lines (two distinct
 * tiers is a human ambiguity; fail closed to the profile default rather than
 * guess a precedence). Repeats of the same tier are not a conflict. The
 * unit of that fold is the delivery — one provider invocation — not one of
 * the trusted messages that invocation carries.
 */
export function parseWakeEffort(text: string): WakeEffort | null {
  const found = new Set<WakeEffort>();
  for (const line of text.split("\n")) {
    const match = EFFORT_LINE.exec(line.trimEnd());
    const tier = match?.[1];
    if (tier !== undefined && isWakeEffort(tier)) found.add(tier);
  }
  if (found.size !== 1) return null;
  return [...found][0] ?? null;
}

/**
 * Overlay for one delivery: initiating text plus every coalesced follow-up,
 * through the same `found.size !== 1` fold as {@link parseWakeEffort}.
 */
export function parseDeliveryEffort(
  delivery: { event: { text: string }; coalescedMessages: readonly { text: string }[] },
): WakeEffort | null {
  return parseWakeEffort(
    [delivery.event.text, ...delivery.coalescedMessages.map((message) => message.text)].join("\n"),
  );
}

/**
 * Grok Build validates `--reasoning-effort` at CLI parse against
 * `low|medium|high|xhigh` (probed live, grok 1.0.4), so `max` and `ultra`
 * clamp down to its ceiling. Claude's ladder tops at `max` (`ultra` clamps
 * there); Codex alone speaks the whole grammar verbatim. The clamps are
 * deterministic doctrine, not silent fallbacks: the wake text still shows the
 * requested tier verbatim, and this mapping is the published contract.
 */
export function clampEffortToXhigh(effort: WakeEffort): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" || effort === "ultra" ? "xhigh" : effort;
}

/** Claude's ceiling is `max` — only Codex's swarm rung sits above it. */
export function clampEffortToMax(effort: WakeEffort): "low" | "medium" | "high" | "xhigh" | "max" {
  return effort === "ultra" ? "max" : effort;
}
