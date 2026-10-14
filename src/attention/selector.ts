/**
 * FIFO-1, the initial selection policy (ADR-0004 §4). Pure and deterministic: no clock, no
 * I/O, no scores. A future policy replaces this module behind the same signature, versioned
 * and explainable; nothing else in attention knows how the next item is chosen.
 */

/** An item in state `queued`, as the selector sees it. */
export interface EligibleItem {
  itemId: number;
  /** Broker-assigned from the event that most recently made the item ready; callers never choose it. */
  readySequence: number;
}

export type SelectionDecision =
  | { kind: "selected"; itemId: number; reason: "fifo" | "explicit_pick" }
  | { kind: "empty" }
  /** An explicit pick that names no eligible item: refused, never silently replaced by FIFO. */
  | { kind: "not_eligible"; itemId: number };

/** Order `(ready_sequence ASC, item_id ASC)`; an explicit human pick is a visible override, not a priority. */
export function selectNext(eligible: readonly EligibleItem[], explicitPick: number | null = null): SelectionDecision {
  if (explicitPick !== null) {
    return eligible.some((item) => item.itemId === explicitPick)
      ? { kind: "selected", itemId: explicitPick, reason: "explicit_pick" }
      : { kind: "not_eligible", itemId: explicitPick };
  }
  const head = [...eligible].sort(fifoOrder)[0];
  return head === undefined ? { kind: "empty" } : { kind: "selected", itemId: head.itemId, reason: "fifo" };
}

export function fifoOrder(left: EligibleItem, right: EligibleItem): number {
  return left.readySequence - right.readySequence || left.itemId - right.itemId;
}

/** A deferred item with a due time; indefinite holds never appear here. */
export interface DeferredItem {
  itemId: number;
  deferredUntil: string;
}

/**
 * The deferred items due at `now`, in the order their fresh ready sequences are allocated:
 * `(deferred_until, item_id)`. Promotion therefore lands each at the FIFO tail — a deferral
 * cannot be used to monopolize the head.
 */
export function duePromotions(deferred: readonly DeferredItem[], now: Date): DeferredItem[] {
  const at = now.getTime();
  return deferred
    .filter((item) => new Date(item.deferredUntil).getTime() <= at)
    .sort((left, right) =>
      new Date(left.deferredUntil).getTime() - new Date(right.deferredUntil).getTime() || left.itemId - right.itemId);
}
