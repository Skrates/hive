/**
 * Effect targets and actionable payloads (design §8.1, §6.D7, §6.D8).
 *
 * The reducer emits effects; the publisher reads them back. This module is the one place
 * both sides agree on what a `target` string means and what an actionable `payload`
 * carries. It is pure: no I/O, no clock.
 */
import type { Effect, Request, Review } from "./contract.js";
import { contractSchema } from "./contract.js";

/**
 * §8.1: the sink a target publishes through. Every target names exactly one, so one sink's
 * failure, backoff, or absence never gates another's row.
 */
export type EffectSink = "github" | "slack";

/** §8.1 — the seven targets. `refresh` for check/board/thread, `actionable` for the rest. */
export type EffectTarget =
  | { kind: "check"; repo: string; headSha: string }
  | { kind: "board"; sink: EffectSink; reviewId: string }
  | { kind: "thread"; commentId: number }
  | { kind: "delivery"; actor: string; requestId: string }
  | { kind: "summon"; requestId: string }
  | { kind: "announce"; reviewId: string }
  | { kind: "notice"; actor: string; subjectKey: string };

/**
 * The grammar is single-sourced from the vendored contract's `Effect.target` pattern so a
 * string this module parses is exactly a string Ajv would admit, and vice versa.
 */
const TARGET_PATTERN: RegExp = (() => {
  const effect = contractSchema.$defs.Effect as { properties: { target: { pattern: string } } };
  return new RegExp(effect.properties.target.pattern);
})();

/** §8.1: parse a target string. Throws on anything the contract pattern would refuse. */
export function parseTarget(target: string): EffectTarget {
  if (!TARGET_PATTERN.test(target)) {
    throw new Error(`effect target does not follow the §8.1 grammar: ${JSON.stringify(target)}`);
  }
  const colon = target.indexOf(":");
  const kind = target.slice(0, colon);
  const rest = target.slice(colon + 1);
  switch (kind) {
    case "check": {
      // `<owner/repo>:<40-hex>` — the repo never carries a colon, the sha is fixed-width, so
      // the last colon is the separator.
      const split = rest.lastIndexOf(":");
      return { kind: "check", repo: rest.slice(0, split), headSha: rest.slice(split + 1) };
    }
    case "board": {
      // `board:<sink>:<review>` — the sink is a fixed token with no colon, so the first colon
      // separates it from a review id that may itself carry colons (`rev_obs:<run>`).
      const split = rest.indexOf(":");
      const sink = rest.slice(0, split);
      if (sink !== "github" && sink !== "slack") throw new Error(`board effect target names no sink: ${JSON.stringify(target)}`);
      return { kind: "board", sink, reviewId: rest.slice(split + 1) };
    }
    case "thread":
      return { kind: "thread", commentId: Number(rest) };
    case "delivery": {
      // Actor ids are `[a-z0-9-]+` (no colon); a request id may contain colons
      // (`req_obs:<run>_1`), so only the first colon separates.
      const split = rest.indexOf(":");
      return { kind: "delivery", actor: rest.slice(0, split), requestId: rest.slice(split + 1) };
    }
    case "summon":
      return { kind: "summon", requestId: rest };
    case "announce":
      return { kind: "announce", reviewId: rest };
    case "notice": {
      // Actor ids are `[a-z0-9-]+` (no colon); a subject key is `<head_sha>:<base_ref>`, so
      // only the first colon separates.
      const split = rest.indexOf(":");
      return { kind: "notice", actor: rest.slice(0, split), subjectKey: rest.slice(split + 1) };
    }
    default:
      throw new Error(`effect target kind is not in the §8.1 grammar: ${JSON.stringify(kind)}`);
  }
}

/** §8.1: the inverse of {@link parseTarget}; `parseTarget(formatTarget(t))` is identity. */
export function formatTarget(target: EffectTarget): string {
  switch (target.kind) {
    case "check":
      return `check:${target.repo}:${target.headSha}`;
    case "board":
      return `board:${target.sink}:${target.reviewId}`;
    case "thread":
      return `thread:${target.commentId}`;
    case "delivery":
      return `delivery:${target.actor}:${target.requestId}`;
    case "summon":
      return `summon:${target.requestId}`;
    case "announce":
      return `announce:${target.reviewId}`;
    case "notice":
      return `notice:${target.actor}:${target.subjectKey}`;
  }
}

/** §8.1: the board's sinks, in the order the reducer emits a refresh for each. */
export const BOARD_SINKS: readonly EffectSink[] = ["github", "slack"];

/**
 * §8.1: which port a target dispatches through. The publisher orders a pass by this — the
 * Slack sink never queues behind a GitHub call that is slow or hung — and the two sinks'
 * rows are independent everywhere else (claim, backoff, coalescing) because they are
 * different targets.
 */
export function sinkOf(target: EffectTarget): EffectSink {
  switch (target.kind) {
    case "board":
      return target.sink;
    case "check":
    case "thread":
    case "summon":
      return "github";
    case "delivery":
    case "announce":
    case "notice":
      return "slack";
  }
}

/** §8.1: refresh targets re-render from `read()`; actionable targets check applicability. */
export function targetKind(target: EffectTarget): Effect["kind"] {
  switch (target.kind) {
    case "check":
    case "board":
    case "thread":
      return "refresh";
    case "delivery":
    case "summon":
    case "announce":
    case "notice":
      return "actionable";
  }
}

// ---------------------------------------------------------------------------------------
// Actionable payloads — what `decide` puts in `Effect.payload`; the publisher reads them back.

/** §6.D5: a Hive delivery to a seat assignee. `dedupe_key` makes at-least-once self-identifying. */
export interface DeliveryPayload { actor: string; request_id: string; text: string; dedupe_key: string }
/** §6.D5: a summon comment for `codex`, e.g. "@codex review". */
export interface SummonPayload { request_id: string; subject_key: string; text: string }
/** §8.1: the merge announcement, emitted on `lifecycle_changed → merged`. */
export interface AnnouncePayload { review_id: string; text: string }
/**
 * §6.D8: the author's one-per-subject conflict notice. It names no request because it is not
 * request transport — it says why the transport is paused, and so must leave while it is.
 */
export interface NoticePayload { actor: string; text: string; dedupe_key: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read a delivery payload back; `null` when the row does not carry one. */
export function deliveryPayload(payload: Effect["payload"]): DeliveryPayload | null {
  if (!isRecord(payload)) return null;
  const actor = str(payload, "actor");
  const requestId = str(payload, "request_id");
  const text = str(payload, "text");
  const dedupeKey = str(payload, "dedupe_key");
  if (actor === null || requestId === null || text === null || dedupeKey === null) return null;
  return { actor, request_id: requestId, text, dedupe_key: dedupeKey };
}

/** Read a summon payload back; `null` when the row does not carry one. */
export function summonPayload(payload: Effect["payload"]): SummonPayload | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload, "request_id");
  const subjectKey = str(payload, "subject_key");
  const text = str(payload, "text");
  if (requestId === null || subjectKey === null || text === null) return null;
  return { request_id: requestId, subject_key: subjectKey, text };
}

/** Read a notice payload back; `null` when the row does not carry one. */
export function noticePayload(payload: Effect["payload"]): NoticePayload | null {
  if (!isRecord(payload)) return null;
  const actor = str(payload, "actor");
  const text = str(payload, "text");
  const dedupeKey = str(payload, "dedupe_key");
  if (actor === null || text === null || dedupeKey === null) return null;
  return { actor, text, dedupe_key: dedupeKey };
}

/** Read an announce payload back; `null` when the row does not carry one. */
export function announcePayload(payload: Effect["payload"]): AnnouncePayload | null {
  if (!isRecord(payload)) return null;
  const reviewId = str(payload, "review_id");
  const text = str(payload, "text");
  if (reviewId === null || text === null) return null;
  return { review_id: reviewId, text };
}

// ---------------------------------------------------------------------------------------
// Applicability

/**
 * §6.D7 / §6.D8 / §6.C3 / §6.G3 / §8.1 — what an actionable job learns when it re-checks the
 * current Review at dispatch time. Opening a request queues its one transport effect (§D5);
 * this predicate is the one place transport is paused and resumed, so a pause never needs a
 * second effect when it lifts (a closed PR reopening, a conflict clearing, a hold releasing).
 *
 * - `applicable`: dispatch now.
 * - `obsolete`: the world moved on (the request is no longer pending at the current subject,
 *   the Review is merged — terminal for new work — or, for an announce, not merged); the row
 *   is marked and never sent.
 * - `withheld`: the request stays pending and so does the row — §C3 the PR is closed
 *   ("transport paused"), §D8 the PR is `mergeable === false`, or §G3 a summons-blocking hold
 *   is active and the request is a review request (the exhaustion episode's own retrospective
 *   and gate delivery go out under the exhaustion hold it places, §G4). Not obsolete: the row
 *   is dispatched by a later pass once the condition clears.
 */
export type Applicability = "applicable" | "obsolete" | "withheld";

export function applicability(target: EffectTarget, review: Review): Applicability {
  switch (target.kind) {
    case "check":
    case "board":
    case "thread":
      // A refresh never asks: it re-renders whatever the Review says now (§8.1).
      return "applicable";
    case "announce":
      // §8.1: the announcement is the effect of `lifecycle: merged`; a Review that is not
      // merged has nothing to announce.
      return review.lifecycle === "merged" ? "applicable" : "obsolete";
    case "notice":
      // §D8: the conflict notice is not request transport — the pause it explains must never
      // pause it. Only a subject that has moved on makes it moot: the notice named a head the
      // Review has left, and the new head has its own notice if it too conflicts.
      return target.subjectKey === review.subject.key ? "applicable" : "obsolete";
    case "delivery":
    case "summon": {
      const request = review.requests.find((candidate) => candidate.id === target.requestId);
      if (request === undefined) return "obsolete";
      return transportState(review, request);
    }
  }
}

/**
 * The transport half of {@link applicability}, on the request itself: what a delivery or a
 * summon for `request` would learn at dispatch. Shared with the reducer's §D6 housekeeping,
 * which must not count a stall while transport is paused — a request nobody could reach has
 * not stalled.
 */
export function transportState(review: Review, request: Request): Applicability {
  // §D7: the request must still be pending at the current subject.
  if (request.status !== "pending") return "obsolete";
  if (request.subject_key !== review.subject.key) return "obsolete";
  // §C3: merged is terminal for new work; closed pauses.
  if (review.lifecycle === "merged") return "obsolete";
  if (review.lifecycle === "closed") return "withheld";
  // §D8: `false` withholds; `null` (not yet computed) never does.
  if (review.observed.mergeable === false) return "withheld";
  // §G3: `blocks.summons` pauses transport for review requests while the hold is active.
  if (request.kind === "review" && review.holds.some((hold) => hold.released === null && hold.blocks.summons)) return "withheld";
  return "applicable";
}
