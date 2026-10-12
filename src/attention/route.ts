import { createHash } from "node:crypto";
import type { Subscription } from "../domain.js";
import type { AttentionContinuationTarget } from "./contract.generated.js";

/**
 * The attention edge protocol (ADR-0004 §10). An edge declares it per claim request; a
 * delivery carrying `required_edge_protocol = 1` is never handed to a claim that omits it,
 * so an old edge can never claim — and silently ignore the constraints of — an attention
 * continuation.
 */
export const ATTENTION_EDGE_PROTOCOL = 1;

/**
 * The account-profile fingerprint a pinned return is bound to: a hash of the canonical
 * provider / home-edge / profile-path identity. It never reads or hashes credential
 * contents; a profile whose path, provider or home edge moved is a different route.
 */
export function profileFingerprint(subscription: Pick<Subscription, "provider" | "homeEdge" | "accountProfile">): string {
  return createHash("sha256")
    .update(["hive-attention-profile/v1", subscription.provider, subscription.homeEdge, subscription.accountProfile].join("\0"))
    .digest("hex");
}

export type EffectiveRoute =
  /** No target, or a context-restored return: the actor's ordinary current routing and capacity. */
  | { kind: "ordinary" }
  /**
   * Exactly one captured session on its home edge. `mayResume` is the subscription's policy:
   * a `live_only` actor stays live-only and nothing here ever spawns.
   */
  | { kind: "pinned"; homeEdge: string; sessionId: string; cwd: string; mayResume: boolean }
  /** The captured route no longer agrees with the actor's enrollment: an explicit route failure. */
  | { kind: "refused"; code: AttentionRouteRefusal; detail: string };

export type AttentionRouteRefusal =
  | "attention_actor_changed"
  | "attention_provider_changed"
  | "attention_profile_changed"
  | "attention_home_edge_changed"
  | "attention_slot_incompatible";

/**
 * The one route rule for a delivery, used by both the broker's claim eligibility and the
 * edge's live-versus-resume choice, so the two can never disagree about where a pinned
 * return may run. It derives a per-delivery route and never rewrites the subscription: the
 * permission profile and every other policy field still come from the actor's current
 * enrollment, never from an older, possibly more permissive snapshot.
 */
export function effectiveDeliveryRoute(
  subscription: Subscription,
  target: AttentionContinuationTarget | null,
): EffectiveRoute {
  if (target === null || target.mode === "actor_context") return { kind: "ordinary" };
  const pinned = target.pinned;
  if (target.actor !== subscription.actor) {
    return { kind: "refused", code: "attention_actor_changed", detail: `return was captured for ${target.actor}, delivery routes ${subscription.actor}` };
  }
  if (pinned.provider !== subscription.provider) {
    return { kind: "refused", code: "attention_provider_changed", detail: `captured on ${pinned.provider}, actor now enrolled on ${subscription.provider}` };
  }
  if (pinned.home_edge !== subscription.homeEdge) {
    return { kind: "refused", code: "attention_home_edge_changed", detail: `captured on edge ${pinned.home_edge}, actor's home edge is now ${subscription.homeEdge}` };
  }
  if (pinned.account_profile_fingerprint !== profileFingerprint(subscription)) {
    return { kind: "refused", code: "attention_profile_changed", detail: "the actor's account profile binding changed since the session was captured" };
  }
  if (subscription.turnSlots > 1) {
    // A multi-slot actor's worktrees belong to the slot scheduler; resuming one behind its
    // back is exactly what the per-slot cwd exists to prevent.
    return { kind: "refused", code: "attention_slot_incompatible", detail: "a multi-slot actor cannot take an exact-session return; reroute as actor_context" };
  }
  return {
    kind: "pinned",
    homeEdge: pinned.home_edge,
    sessionId: pinned.session_id,
    cwd: pinned.cwd,
    mayResume: subscription.wakePolicy !== "live_only",
  };
}
