import { z } from "zod";
import type { AddressedWake } from "./domain.js";

const WAKE_PATTERN =
  /^[ \t]*(?:\[actor=[a-z][a-z0-9_-]*\][ \t]*)?(WAKE:[ \t]*([a-z][a-z0-9_-]*)\b)/i;
const NEXT_PATTERN =
  /^[ \t]*(?:\[actor=[a-z][a-z0-9_-]*\][ \t]*)?(NEXT[ \t]+([a-z][a-z0-9_-]*)\b)/i;
const LEADING_MENTION_PATTERN =
  /^[ \t]*(?:\[actor=[a-z][a-z0-9_-]*\][ \t]*)?<@([uw][a-z0-9]+)>(?=[ \t]|[,;:\u2013\u2014-]|$)/i;
const LEADING_ROUTER_MENTION_PATTERN =
  /^[ \t]*(?:\[actor=[a-z][a-z0-9_-]*\][ \t]*)?<@([uw][a-z0-9]+)>[ \t]+([a-z][a-z0-9_-]*):/i;
const EXPLICIT_ENVELOPE_ATTEMPT_PATTERN = /^[ \t]*(?:\[actor=[^\]\r\n]+\][ \t]*)?(?:WAKE\b|NEXT\b)/i;

export type AddressingDecision =
  | { kind: "addressed"; wake: AddressedWake }
  | { kind: "ignored"; reason: "malformed_explicit_envelope" | "not_addressed" };

export function parseAddressedWake(
  text: string,
  mentionActors: ReadonlyMap<string, string> = new Map(),
  routerMentionIds: ReadonlySet<string> = new Set(),
): AddressedWake | null {
  const wake = WAKE_PATTERN.exec(text);
  if (wake?.[1] && wake[2]) {
    return { actor: wake[2].toLowerCase(), envelope: wake[1].trim() };
  }

  // NEXT is an explicit recipient envelope. Sender authority comes from Slack admission, never
  // from the decorative in-body actor tag used by the shared Hive app.
  const next = NEXT_PATTERN.exec(text);
  if (next?.[1] && next[2]) {
    return { actor: next[2].toLowerCase(), envelope: next[1].trim() };
  }

  // Slack serializes a real user mention as <@U…>. A shared bot identity must name its target
  // explicitly as `<@BOT> actor:`. It never inherits authority from a display name or from the
  // decorative sender tag. Keeping the mention and actor on one line also prevents quoted or
  // later-line content from becoming a router envelope.
  const mention = LEADING_MENTION_PATTERN.exec(text);
  if (mention?.[1]) {
    const mentionId = mention[1].toUpperCase();
    if (routerMentionIds.has(mentionId)) {
      const router = LEADING_ROUTER_MENTION_PATTERN.exec(text);
      if (router?.[1]?.toUpperCase() === mentionId && router[2]) {
        const actor = router[2].toLowerCase();
        return { actor, envelope: `<@${mention[1]}> ${actor}:` };
      }
      // A configured router mention is never allowed to fall through to a direct identity map.
      return null;
    }

    // A distinct per-actor Slack identity remains a valid direct mention wake.
    const actor = mentionActors.get(mentionId);
    if (actor) return { actor: actor.toLowerCase(), envelope: `<@${mention[1]}>` };
  }
  return null;
}

export function classifyAddressedWake(
  text: string,
  mentionActors: ReadonlyMap<string, string> = new Map(),
  routerMentionIds: ReadonlySet<string> = new Set(),
): AddressingDecision {
  const wake = parseAddressedWake(text, mentionActors, routerMentionIds);
  if (wake) return { kind: "addressed", wake };
  if (EXPLICIT_ENVELOPE_ATTEMPT_PATTERN.test(text)) {
    return { kind: "ignored", reason: "malformed_explicit_envelope" };
  }
  const mention = LEADING_MENTION_PATTERN.exec(text);
  if (mention?.[1] && routerMentionIds.has(mention[1].toUpperCase())) {
    return { kind: "ignored", reason: "malformed_explicit_envelope" };
  }
  return { kind: "ignored", reason: "not_addressed" };
}

export interface AdmissionPolicy {
  workspaceIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
  userIds: ReadonlySet<string>;
  appIds: ReadonlySet<string>;
  mentionActors?: ReadonlyMap<string, string>;
  routerMentionIds?: ReadonlySet<string>;
}

export const AdmissionPolicySchema = z.object({
  workspaceIds: z.array(z.string().regex(/^T[A-Z0-9]+$/i)).min(1)
	.transform((values) => new Set(values.map((value) => value.toUpperCase()))),
  channelIds: z.array(z.string().regex(/^[CDG][A-Z0-9]+$/i)).min(1)
	.transform((values) => new Set(values.map((value) => value.toUpperCase()))),
  userIds: z.array(z.string().regex(/^[UW][A-Z0-9]+$/i))
	.transform((values) => new Set(values.map((value) => value.toUpperCase()))),
  appIds: z.array(z.string().regex(/^A[A-Z0-9]+$/i))
	.transform((values) => new Set(values.map((value) => value.toUpperCase()))),
  mentionActors: z
    .record(
      z.string().regex(/^[UW][A-Z0-9]+$/i),
      z.string().regex(/^[a-z][a-z0-9_-]*$/i),
    )
    .default({})
    .transform(
      (values) =>
        new Map(
          Object.entries(values).map(([userId, actor]) => [
            userId.toUpperCase(),
            actor.toLowerCase(),
          ]),
        ),
    ),
  routerMentionIds: z
    .array(z.string().regex(/^[UW][A-Z0-9]+$/i))
    .default([])
    .transform((values) => new Set(values.map((userId) => userId.toUpperCase()))),
}).superRefine((policy, context) => {
	if (policy.userIds.size === 0 && policy.appIds.size === 0) {
		context.addIssue({ code: "custom", message: "at least one admitted user or app is required" });
	}
});

export interface AdmissionCandidate {
  workspaceId: string;
  channelId: string;
  senderId: string;
  senderKind: "user" | "app";
}

export function isAdmitted(policy: AdmissionPolicy, candidate: AdmissionCandidate): boolean {
	const workspaceId = candidate.workspaceId.toUpperCase();
	const channelId = candidate.channelId.toUpperCase();
	const senderId = candidate.senderId.toUpperCase();
  if (!policy.workspaceIds.has(workspaceId)) return false;
  if (!policy.channelIds.has(channelId)) return false;
  return candidate.senderKind === "user"
	? policy.userIds.has(senderId)
	: policy.appIds.has(senderId);
}
