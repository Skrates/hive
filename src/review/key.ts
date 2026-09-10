import type { ReviewKey } from "./contract.js";

/**
 * §3.1: a Review's internal identity is GitHub's repository id + PR number;
 * `owner/repo#n` is a display name refreshed from observation. An HTTP or CLI
 * `:key` may be either — the internal form is passed through, the display form
 * is resolved by `ReviewStore.findByDisplay` (module map §1).
 */
export type ParsedReviewKey =
  | { kind: "key"; key: ReviewKey }
  | { kind: "display"; display: string };

const INTERNAL = /^(\d+):(\d+)$/;
// GitHub owner and repository names: alphanumerics, `-`, `_`, `.`; the PR number is an integer.
const DISPLAY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+#(\d+)$/;

export function parseReviewKey(text: string): ParsedReviewKey | null {
  const internal = INTERNAL.exec(text);
  if (internal) {
    const repositoryId = Number(internal[1]);
    const prNumber = Number(internal[2]);
    if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) return null;
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) return null;
    return { kind: "key", key: { repository_id: repositoryId, pr_number: prNumber } };
  }
  const display = DISPLAY.exec(text);
  if (display) {
    if (Number(display[1]) < 1) return null;
    return { kind: "display", display: text };
  }
  return null;
}

/** `"<repository_id>:<pr_number>"` — the internal form as one path segment. */
export function formatReviewKey(key: ReviewKey): string {
  return `${key.repository_id}:${key.pr_number}`;
}
