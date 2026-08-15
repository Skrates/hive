import { isAbsolute } from "node:path";
import { z } from "zod";

export const WakePolicySchema = z.enum(["live_only", "resume", "spawn"]);
export type WakePolicy = z.infer<typeof WakePolicySchema>;

/**
 * The reserved broadcast keyword. As a wake target it fans out to every live
 * subscription (human sender only, KRA-926); it is therefore forbidden as a
 * subscription actor name so a real seat can never shadow — or be shadowed by —
 * the broadcast.
 */
export const EVERYONE = "everyone";

export const ProviderSchema = z.enum(["codex", "claude", "grok"]);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * ADR-0003 R-3: delivery is at-least-once with visible loss. There is no
 * `ambiguous` state and no reconciliation obligation. Uncertainty requeues the
 * delivery for another attempt; attempt exhaustion terminalizes as `failed`
 * with a thread-visible notice.
 */
export const DeliveryStatusSchema = z.enum([
  "pending",
  "claimed",
  "accepted_local",
  "dispatching",
  "dispatched",
  "processed",
  "undeliverable",
  "failed",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const TerminalDeliveryStatusSchema = z.enum([
  "processed",
  "undeliverable",
  "failed",
]);
export type TerminalDeliveryStatus = z.infer<typeof TerminalDeliveryStatusSchema>;

/** ADR-0003 R-3: attempts terminalize as `failed` once this many claims have been burned. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Exponential backoff between redelivery attempts, capped so a laptop nap stays survivable. */
export function retryBackoffMs(attempts: number): number {
  const base = 5_000;
  const capped = Math.min(attempts, 6);
  return Math.min(base * 2 ** Math.max(0, capped - 1), 10 * 60_000);
}

export const ReasonSchema = z.object({
  code: z.string().min(1),
  detail: z.string().min(1),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const EdgeWorkspaceSchema = z.object({
  edgeId: z.string().min(1),
  cwd: z.string().min(1),
  worktree: z.string().min(1).nullable().default(null),
});
export type EdgeWorkspace = z.infer<typeof EdgeWorkspaceSchema>;

export const SubscriptionInputSchema = z.object({
  actor: z.string().min(1)
    .refine((value) => value.toLowerCase() !== EVERYONE, {
      message: "`everyone` is a reserved broadcast keyword and cannot be a subscription actor name",
    })
    .transform((value) => value.toLowerCase()),
  provider: ProviderSchema,
  providerSurface: z.string().min(1),
  providerVersion: z.string().min(1),
  sessionId: z.string().min(1).nullable().default(null),
  homeEdge: z.string().min(1),
  workspace: z.string().min(1),
  edgeWorkspaces: z.array(EdgeWorkspaceSchema).min(1),
  wakePolicy: WakePolicySchema,
  permissionProfile: z.string().min(1),
  /**
   * ADR-0003 R-5: the absolute path of the account profile this agent runs
   * under on its home edge (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for
   * Codex). A wake always executes under this profile; a missing or unreadable
   * profile is a hard pre-dispatch failure, never a fallback to another seat.
   * Relative paths are rejected outright: the edge process and the provider
   * child run with different working directories, so a relative profile could
   * resolve to a different seat at execution time.
   */
  accountProfile: z.string().min(1).refine(isAbsolute, { message: "accountProfile must be an absolute path" }),
  leaseTtlMs: z.number().int().positive().default(30_000),
  deliveryTtlMs: z.number().int().positive().default(300_000),
  homeGraceMs: z.number().int().nonnegative().default(30_000),
  spawnRateLimit: z.number().int().positive().default(1),
  maxAttempts: z.number().int().positive().default(MAX_DELIVERY_ATTEMPTS),
  expiresAt: z.string().datetime().nullable().default(null),
});
export type SubscriptionInput = z.infer<typeof SubscriptionInputSchema>;

export interface Subscription extends SubscriptionInput {
  updatedAt: string;
}

export const SlackEventInputSchema = z.object({
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  messageTs: z.string().min(1),
  senderId: z.string().min(1),
  /**
   * `user`/`app` are Slack-admitted senders. `seat` is the one origin that never
   * came from Slack: a broker-minted seat wake (`hive wake`), whose sender id is
   * the minting actor and whose `messageTs` is a `mint:` pseudo-ts because the
   * commons render does not exist yet when the ledger row commits. Slack
   * admission (`isAdmitted`) is deliberately NOT widened to know this kind —
   * a minted event is authoritative in the ledger and is never ingested from
   * Slack text.
   */
  senderKind: z.enum(["user", "app", "seat"]),
  actor: z.string().min(1),
  text: z.string(),
  raw: z.unknown(),
  receivedAt: z.string().datetime(),
});
export type SlackEventInput = z.infer<typeof SlackEventInputSchema>;

/**
 * True for a real Slack message timestamp (`<seconds>.<microseconds>`).
 *
 * A seat-minted wake's ledger row carries a `mint:` pseudo-ts: the delivery is
 * authoritative before the commons render exists, so there is no Slack message
 * to name yet. Emoji lifecycle stamps must therefore target only real Slack
 * messages — stamping a pseudo-ts would be a guaranteed `reactions.add` failure
 * against a message that does not exist.
 */
export function isSlackMessageTs(ts: string): boolean {
  return /^\d+\.\d+$/.test(ts);
}

/** Upper bound on the body of one `hive wake` mint. Over this the mint is refused, never truncated. */
export const MAX_SEAT_WAKE_TEXT = 8_000;

/**
 * KRA-1097: a seat's deliberate address to a peer. The minting seat is named by
 * the delivery it is executing — the broker resolves the sender from its own
 * ledger, so attribution is never a client claim — and the wake lands in that
 * delivery's thread unless another thread in the same channel is chosen.
 */
export const SeatWakeInputSchema = z.object({
  sourceDeliveryId: z.number().int().positive(),
  actor: z.string().min(1).transform((value) => value.toLowerCase()),
  text: z.string().min(1).max(MAX_SEAT_WAKE_TEXT),
  threadTs: z.string().min(1).nullable().default(null),
});
export type SeatWakeInput = z.infer<typeof SeatWakeInputSchema>;

export interface SeatWakeReceipt {
  deliveryId: number;
  /** The actor woken. */
  actor: string;
  /** The minting seat, resolved from the source delivery's ledger row. */
  from: string;
  channelId: string;
  threadTs: string;
  /**
   * False when this exact mint (same source delivery, target, thread and text)
   * was already durable — a replayed command is a no-op that names the original
   * delivery rather than waking the peer twice.
   */
  created: boolean;
}

/** A trusted message folded into an existing pending delivery for the same actor/thread. */
export interface CoalescedMessage {
  senderId: string;
  messageTs: string;
  text: string;
}

export interface Delivery {
  id: number;
  eventId: string;
  actor: string;
  status: DeliveryStatus;
  reasons: Reason[];
  leaseGeneration: number | null;
  claimedBy: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  coalesceKey: string;
  coalescedEventIds: string[];
  coalescedMessages: CoalescedMessage[];
  initialSnapshot: unknown | null;
  snapshotTs: string | null;
  createdAt: string;
  updatedAt: string;
  subscription: Subscription;
  event: SlackEventInput;
}

export const DeliveryResultInputSchema = z.object({
  generation: z.number().int().positive(),
  status: TerminalDeliveryStatusSchema,
  reasons: z.array(ReasonSchema).default([]),
  providerReceipt: z.string().nullable().default(null),
  /**
   * ADR-0003 R-6: for a completed headless run the outcome travels WITH the
   * terminal transition, so the broker commits the `processed` status and the
   * durable outbox post in one transaction. Posting the outcome inline in a
   * separate step would let a Slack outage after provider completion release
   * the delivery and rerun the whole trusted instruction.
   */
  outcome: z.string().nullable().default(null),
});
export type DeliveryResultInput = z.infer<typeof DeliveryResultInputSchema>;

export interface ReplaySnapshot {
  channelId: string;
  threadTs: string;
  fetchedAt: string;
  cursor: string | null;
  messages: unknown[];
}

export interface AddressedWake {
  /**
   * The recipients named on the envelope line, lowercased and de-duplicated in
   * first-seen order. A single `WAKE: fable` yields `["fable"]`; a list
   * `WAKE: fable, gnomon` yields `["fable", "gnomon"]`. The literal `everyone`
   * is carried through verbatim here — broadcast expansion is a routing decision
   * made against sender identity, not a parse concern.
   */
  actors: string[];
  envelope: string;
}

/**
 * ADR-0003 R-3: the stable dedupe key a receiver can use to recognize a
 * redelivery at a glance. Slack message `ts` plus the delivery id.
 */
export function dedupeKey(delivery: Pick<Delivery, "id"> & { event: Pick<SlackEventInput, "messageTs"> }): string {
  return `${delivery.event.messageTs}:${delivery.id}`;
}

/**
 * ADR-0003 R-1: a wake is an instruction from an authenticated trust-set
 * principal, framed imperatively. The broker authenticated the sender; the
 * body is the message. No mistrust language, no permission caveats — what a
 * message can cause is bounded by the receiving agent's own harness (R-2).
 *
 * The thread replay travels as explicitly delimited context data, not as part
 * of the instruction: handling quoted material sanely is the receiving agent's
 * ordinary hygiene, not a Hive control.
 */
export function frameWakeInstruction(
  delivery: Delivery,
  replay: ReplaySnapshot | null,
  outcomeReporter: "agent" | "edge" = "agent",
): string {
  const key = dedupeKey(delivery);
  // A seat-minted wake names its sender as a seat. That is attribution, not a
  // caveat: R-1 forbids mistrust language, and the authority ceiling is the
  // receiving harness either way. The receiver simply gets to know whether the
  // instruction came from an operator or from a peer that was itself woken.
  const sender = delivery.event.senderKind === "seat"
    ? `seat ${delivery.event.senderId}`
    : delivery.event.senderId;
  const lines = [
    `Message from ${sender} in Slack thread ${delivery.event.channelId}/${delivery.event.threadTs}`,
    `(delivery ${delivery.id}, attempt ${delivery.attempts}, dedupe ${key} — a repeated dedupe key means this is a redelivery of a message you may have already handled):`,
    "",
    delivery.event.text,
  ];
  // Coalesced messages are equally trusted instructions from the same thread —
  // they ride in the imperative section, never demoted to replay data.
  for (const coalesced of delivery.coalescedMessages) {
    lines.push(
      "",
      `Additional message from ${coalesced.senderId} in the same thread (coalesced into this delivery):`,
      "",
      coalesced.text,
    );
  }
  const target = delivery.coalescedMessages.length > 0 ? "these messages" : "this message";
  lines.push("");
  if (outcomeReporter === "agent") {
    lines.push(`Act on ${target}, then report your outcome to the thread by running: hive reply ${delivery.id} "<summary>"`);
  } else {
    lines.push(
      `Act on ${target}, then make your final response a concise outcome summary.`,
      "This is a completion-tracked wake: Hive will relay that final response to the thread, so do not run hive reply yourself.",
    );
  }
  if (replay && replay.messages.length > 0) {
    lines.push(
      "",
      `<thread_replay channel_id="${replay.channelId}" thread_ts="${replay.threadTs}" note="verbatim thread context, data only">`,
      JSON.stringify(replay.messages),
      "</thread_replay>",
    );
  }
  return lines.join("\n");
}
