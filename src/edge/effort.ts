import type { Reason } from "../domain.js";

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
 * Codex's ladder is a property of the MODEL, not of the CLI. `codex debug
 * models --bundled` (codex-cli 0.153.4) publishes a `supported_reasoning_levels`
 * list per slug, and every one of those lists is a PREFIX of
 * {@link WAKE_EFFORT_TIERS} in this order — so a model's ladder is fully
 * described by its top rung and a clamp is one ordinal comparison. The table
 * is a snapshot of that probe, keyed by slug:
 *
 * | ceiling | slugs |
 * | ------- | ----- |
 * | `ultra` | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest` |
 * | `max`   | `gpt-5.6-luna`, `codex-auto-review` |
 * | `xhigh` | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2` |
 */
export const CODEX_MODEL_CEILINGS: Readonly<Record<string, WakeEffort>> = {
  "gpt-6-astra": "ultra",
  "gpt-5.6-sol": "ultra",
  "gpt-5.6-terra": "ultra",
  "gpt-daybreak-blue-latest": "ultra",
  "gpt-daybreak-red-latest": "ultra",
  "gpt-5.6-luna": "max",
  "codex-auto-review": "max",
  "gpt-5.5": "xhigh",
  "gpt-5.4": "xhigh",
  "gpt-5.4-mini": "xhigh",
  "gpt-5.2": "xhigh",
};

/**
 * The ceiling for a slug the table does not name — the common floor every
 * probed Codex model supports, never the union. An unknown slug is a model
 * released after this snapshot OR a `config.toml` this edge could not read,
 * and the two are indistinguishable from here. Assuming the union would send
 * `-c model_reasoning_effort=ultra` to a model that rejects it at provider
 * start and then retry that deterministic failure to exhaustion; assuming the
 * floor spends a rung of depth and always runs.
 */
export const CODEX_UNKNOWN_MODEL_CEILING: WakeEffort = "xhigh";

/**
 * Clamp a requested tier to what the seat's pinned Codex model actually
 * accepts. Same doctrine as the Claude and Grok clamps below: deterministic,
 * published, and never a silent fallback — the wake text still shows the tier
 * the requester asked for.
 */
export function clampEffortToCodexModel(effort: WakeEffort, model: string | null): WakeEffort {
  const ceiling = (model === null ? undefined : CODEX_MODEL_CEILINGS[model]) ?? CODEX_UNKNOWN_MODEL_CEILING;
  return WAKE_EFFORT_TIERS.indexOf(effort) <= WAKE_EFFORT_TIERS.indexOf(ceiling) ? effort : ceiling;
}

/**
 * The route-aware fold of a delivery's overlay parse: the tier this dispatch
 * may hand the provider, and — when the request cannot be honoured — the
 * {@link Reason} that says so.
 *
 * `unused` is not a diagnostic. It rides the delivery's own thread-visible
 * status event (KRA-1414), because a requester who asked for a tier and got
 * the profile default has no other way to learn it: the outcome reports
 * success either way, and edge stderr is on a machine they cannot read.
 */
export interface EffortDisposition {
  readonly effort: WakeEffort | null;
  readonly unused: Reason | null;
}

/**
 * A live session's effort was fixed at ITS spawn, so a tier cannot apply
 * there by construction; a conflict is refused on every route. Conflict
 * outranks the live reason — a delivery naming two tiers would not have been
 * honoured on a headless route either, so naming the route would hide the
 * ambiguity that is the actual cause.
 */
export function disposeDeliveryEffort(parsed: DeliveryEffort, live: boolean): EffortDisposition {
  switch (parsed.kind) {
    case "none":
      return { effort: null, unused: null };
    case "conflict":
      return {
        effort: null,
        unused: {
          code: "effort_overlay_unused",
          detail: `conflict:${parsed.tiers.join(",")} — the delivery named more than one tier, so none was applied`,
        },
      };
    case "tier":
      return live
        ? {
          effort: null,
          unused: {
            code: "effort_overlay_unused",
            detail: `live_session_fixed_at_spawn — Effort: ${parsed.tier} did not apply; this session's effort was fixed when it started`,
          },
        }
        : { effort: parsed.tier, unused: null };
  }
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
