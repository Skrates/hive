/**
 * Per-delivery effort overlay (weave-doctrine effort-label pair, edge half).
 *
 * The wake text is the transport: a dispatcher (or a human writing a manual
 * wake) publishes a bare `Effort: <tier>` line and the edge folds it into the
 * provider invocation at spawn/resume. The seat's profile settings are never
 * touched — the overlay lives and dies with the one CLI invocation, which is
 * what kills the edit-profile-then-revert dance permanently.
 *
 * The line rides the *trusted wake message itself* (the delivery's event
 * text), the same authority surface the `WAKE:` envelope rides. Quoted
 * material in the replay context never reaches this parser.
 */

/** The wake-grammar tiers — Claude's vocabulary, the widest of the three. */
export const WAKE_EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;
export type WakeEffort = (typeof WAKE_EFFORT_TIERS)[number];

const EFFORT_LINE = /^Effort: (low|medium|high|xhigh|max)$/;

/**
 * The single effort tier a wake requests, or null.
 *
 * Null on zero `Effort:` lines (profile default applies — the no-label wake
 * stays byte-identical in behavior) and on *conflicting* lines (two distinct
 * tiers is a human ambiguity; fail closed to the profile default rather than
 * guess a precedence). Repeats of the same tier are not a conflict.
 */
export function parseWakeEffort(text: string): WakeEffort | null {
  const found = new Set<WakeEffort>();
  for (const line of text.split("\n")) {
    const match = EFFORT_LINE.exec(line.trimEnd());
    if (match) found.add(match[1] as WakeEffort);
  }
  if (found.size !== 1) return null;
  return [...found][0] ?? null;
}

/**
 * Grok Build validates `--reasoning-effort` at CLI parse against
 * `low|medium|high|xhigh` (probed live, grok 1.0.4) — no `max`, so `max`
 * clamps down to its ceiling. (Codex is NOT this shape: its ladder tops at
 * `ultra`, and its mapping lives beside its adapter.) The clamp is
 * deterministic doctrine, not a silent fallback: the wake text still shows the
 * requested tier verbatim, and this mapping is the published contract.
 */
export function clampEffortToXhigh(effort: WakeEffort): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" ? "xhigh" : effort;
}
