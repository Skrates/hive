import { z } from "zod";
import type { AddressedWake } from "./domain.js";

// The envelope grammar. An actor token is `[a-z][a-z0-9_-]*`; a recipient LIST is
// one or more tokens separated by commas. Separators are HORIZONTAL whitespace
// only (`H`) so the list stays on the first envelope line — a comma cannot reach
// across a newline into body text. The trailing `(H*,)` group is a malformed
// sentinel: a comma immediately after the last well-formed token means the author
// intended a further recipient that failed the grammar, so the whole line is not
// an envelope (malformed ≠ unknown — an unknown but well-formed name still routes,
// and dead-letters through the KRA-925 notice).
const H = "[^\\S\\r\\n]";
const ACTOR = "[a-z][a-z0-9_-]*";
const LIST = `${ACTOR}(?:${H}*,${H}*${ACTOR})*`;
const WAKE_PATTERN = new RegExp(`^\\s*WAKE:${H}*(${LIST})(${H}*,)?`, "im");
const NEXT_PATTERN = new RegExp(`^\\s*NEXT${H}+(${LIST})(${H}*,)?`, "im");

function resolveEnvelope(match: RegExpExecArray): AddressedWake | null {
  // A dangling comma after the captured list signals an intended-but-malformed
  // recipient — reject the whole line rather than silently waking the prefix.
  if (match[2]) return null;
  const actors = [...new Set(match[1]!.split(",").map((token) => token.trim().toLowerCase()))];
  return { actors, envelope: match[0].trim() };
}

export function parseAddressedWake(text: string): AddressedWake | null {
  const wake = WAKE_PATTERN.exec(text);
  if (wake) return resolveEnvelope(wake);

  // NEXT is an explicit recipient envelope. Sender authority comes from Slack admission, never
  // from the decorative in-body actor tag used by the shared Hive app.
  const next = NEXT_PATTERN.exec(text);
  if (next) return resolveEnvelope(next);
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
