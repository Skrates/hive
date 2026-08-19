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

function collectWakeEffort(text: string): Set<WakeEffort> {
  const found = new Set<WakeEffort>();
  for (const line of text.split("\n")) {
    const match = EFFORT_LINE.exec(line.trimEnd());
    const tier = match?.[1];
    if (tier !== undefined && isWakeEffort(tier)) found.add(tier);
  }
  return found;
}

/**
 * Delivery-wide overlay parse. Distinguishes the three outcomes of the
 * found-set fold so a conflict cannot masquerade as absence.
 */
export type DeliveryEffort =
  | { readonly kind: "none" }
  | { readonly kind: "tier"; readonly tier: WakeEffort }
  | { readonly kind: "conflict"; readonly tiers: readonly WakeEffort[] };

function classifyEffort(found: Set<WakeEffort>): DeliveryEffort {
  if (found.size === 0) return { kind: "none" };
  if (found.size === 1) {
    const tier = [...found][0];
    return tier === undefined ? { kind: "none" } : { kind: "tier", tier };
  }
  return { kind: "conflict", tiers: [...found] };
}

/**
 * Overlay for one delivery: initiating text plus every coalesced follow-up,
 * through the found-set fold. Each message is collected on its own so a
 * join cannot mint a directive no single message contains.
 *
 * `none` on zero `Effort:` lines (profile default applies — the no-label
 * wake stays byte-identical in behavior). `conflict` on two distinct tiers
 * (a human ambiguity; fail closed rather than guess a precedence). Repeats
 * of the same tier are not a conflict.
 */
export function parseDeliveryEffort(
  delivery: { event: { text: string }; coalescedMessages: readonly { text: string }[] },
): DeliveryEffort {
  const found = new Set<WakeEffort>();
  for (const text of [delivery.event.text, ...delivery.coalescedMessages.map((message) => message.text)]) {
    for (const tier of collectWakeEffort(text)) found.add(tier);
  }
  return classifyEffort(found);
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
