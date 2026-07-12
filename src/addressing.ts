import { z } from "zod";
import type { AddressedWake } from "./domain.js";

const WAKE_PATTERN = /^\s*WAKE:\s*([a-z][a-z0-9_-]*)\b/im;
const ACTOR_PATTERN = /^\s*\[?actor=([a-z][a-z0-9_-]*)\]?/im;

export function parseAddressedWake(text: string): AddressedWake | null {
  const wake = WAKE_PATTERN.exec(text);
  if (wake?.[1]) {
    return { actor: wake[1].toLowerCase(), envelope: wake[0].trim() };
  }

  // Actor tags identify a sender, not a recipient. They are accepted only when an explicit NEXT
  // line addresses the other agent, which keeps ordinary FYI and RECORDED traffic from waking.
  const sender = ACTOR_PATTERN.exec(text)?.[1]?.toLowerCase();
  const next = /^\s*NEXT\s+([a-z][a-z0-9_-]*)\b/im.exec(text);
  if (sender && next?.[1] && next[1].toLowerCase() !== sender) {
    return { actor: next[1].toLowerCase(), envelope: next[0].trim() };
  }
  return null;
}

export interface AdmissionPolicy {
  workspaceIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
  userIds: ReadonlySet<string>;
  appIds: ReadonlySet<string>;
}

export const AdmissionPolicySchema = z.object({
  workspaceIds: z.array(z.string().min(1)).transform((values) => new Set(values)),
  channelIds: z.array(z.string().min(1)).transform((values) => new Set(values)),
  userIds: z.array(z.string().min(1)).transform((values) => new Set(values)),
  appIds: z.array(z.string().min(1)).transform((values) => new Set(values)),
});

export interface AdmissionCandidate {
  workspaceId: string;
  channelId: string;
  senderId: string;
  senderKind: "user" | "app";
}

export function isAdmitted(policy: AdmissionPolicy, candidate: AdmissionCandidate): boolean {
  if (!policy.workspaceIds.has(candidate.workspaceId)) return false;
  if (!policy.channelIds.has(candidate.channelId)) return false;
  return candidate.senderKind === "user"
    ? policy.userIds.has(candidate.senderId)
    : policy.appIds.has(candidate.senderId);
}
