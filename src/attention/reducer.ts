import type { ItemState } from "./contract.js";

/**
 * Item transitions as pure decisions (ADR-0004 §5). The store reads the facts, asks here,
 * and applies the answer; this module never touches SQLite, the clock or the network.
 *
 * Order of refusal is fixed so a caller always learns the most fundamental defect first:
 * authority (403), then revision (409), then state (409), then argument (422).
 */

export interface ItemFacts {
  state: ItemState;
  revision: number;
  ownerPrincipal: string;
  /** The exact source that created a seat item; null for human-origin work. */
  sourceId: string | null;
}

/** Who is asking. Only an authenticated operator may move the active slot (I02). */
export type ActCaller =
  | { kind: "operator" }
  | { kind: "source"; sourceId: string; ownerPrincipal: string };

export type ItemAct =
  | { kind: "amend" }
  | { kind: "withdraw" }
  | { kind: "claim" }
  | { kind: "resolve" }
  | { kind: "defer"; until: string | null; now: string }
  | { kind: "requeue" }
  | { kind: "cancel" };

export type EventType =
  | "amended"
  | "withdrawn"
  | "claimed"
  | "resolved"
  | "deferred"
  | "requeued"
  | "cancelled";

export interface Refusal {
  ok: false;
  status: 403 | 409 | 422;
  error: string;
  detail: string;
}

export type Decision = { ok: true; to: ItemState; event: EventType } | Refusal;

const OPEN: ReadonlySet<ItemState> = new Set(["queued", "active", "deferred"]);

function refuse(status: Refusal["status"], error: string, detail: string): Refusal {
  return { ok: false, status, error, detail };
}

export function decide(item: ItemFacts, act: ItemAct, caller: ActCaller, expectedRevision: number): Decision {
  // Authority. A source writes only its own item (exact source id, not merely the same actor:
  // a re-enrolled source does not silently inherit write access) and only amend/withdraw.
  if (caller.kind === "source") {
    if (act.kind !== "amend" && act.kind !== "withdraw") {
      return refuse(403, "operator_only", `${act.kind} is an operator act; a source produces requests only`);
    }
    if (item.sourceId !== caller.sourceId || item.ownerPrincipal !== caller.ownerPrincipal) {
      return refuse(403, "not_item_owner", "this item was not submitted by the calling source");
    }
  } else if (act.kind === "withdraw") {
    return refuse(403, "producer_only", "withdraw is the owning producer's act; the operator cancels");
  }

  // I05: stale decisions are refused, never applied to a newer packet silently.
  if (expectedRevision !== item.revision) {
    return refuse(409, "revision_conflict", `expected revision ${expectedRevision}, item is at ${item.revision}`);
  }

  const from = item.state;
  const terminal = !OPEN.has(from);
  switch (act.kind) {
    case "amend":
      if (terminal) return refuse(409, "item_terminal", `a ${from} item is never reopened; a follow-up round uses a new intervention key`);
      return { ok: true, to: from, event: "amended" };
    case "withdraw":
      if (from === "active") return refuse(409, "item_active", "an active item cannot be withdrawn from under the human");
      if (terminal) return refuse(409, "item_terminal", `item is already ${from}`);
      return { ok: true, to: "cancelled", event: "withdrawn" };
    case "claim":
      if (from !== "queued") return refuse(409, "item_not_eligible", `only a queued item can be claimed; this one is ${from}`);
      return { ok: true, to: "active", event: "claimed" };
    case "resolve":
      if (from !== "active") return refuse(409, "item_not_active", `only the active item can be resolved; this one is ${from}`);
      return { ok: true, to: "resolved", event: "resolved" };
    case "defer":
      if (from !== "queued" && from !== "active") {
        return refuse(409, "item_not_deferrable", `only a queued or active item can be deferred; this one is ${from}`);
      }
      if (act.until !== null && new Date(act.until).getTime() <= new Date(act.now).getTime()) {
        return refuse(422, "until_not_future", `deferral time ${act.until} is not after ${act.now}; use null for an indefinite hold`);
      }
      return { ok: true, to: "deferred", event: "deferred" };
    case "requeue":
      if (from !== "deferred") return refuse(409, "item_not_deferred", `only a deferred item can be requeued; this one is ${from}`);
      return { ok: true, to: "queued", event: "requeued" };
    case "cancel":
      if (terminal) return refuse(409, "item_terminal", `item is already ${from}`);
      return { ok: true, to: "cancelled", event: "cancelled" };
  }
}
