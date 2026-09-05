/**
 * The watchdog's canary bookkeeping — pure, and deliberately free of any Slack
 * dependency so both the ingress that observes canaries and the probe that
 * sends them can share it (and so it can be tested without a socket).
 */

/**
 * Metadata stamp carried by every canary. It MUST keep the `hive_` prefix:
 * Slack admission drops `hive_*`-stamped messages before an envelope is parsed,
 * which is what keeps a canary from ever being read as a wake. It is also the
 * canary's identity — an envelope is one of ours because it carries this stamp
 * and a nonce in its metadata, never because its text mentions one. Message
 * text is quotable by anyone in the channel, and a quoted nonce that could
 * settle a probe would let an unrelated message mask a canary that a competing
 * Socket Mode consumer actually swallowed.
 */
export const PROBE_EVENT_TYPE = "hive_watchdog_probe";

/**
 * Hard bound on one canary's HTTP call. The probe's own deadline is the
 * authority on how long a canary may take; this only guarantees the socket
 * underneath it cannot outlive that decision, since the Slack WebClient ships
 * with no request timeout and a ~30-minute retry policy.
 */
export const CANARY_REQUEST_TIMEOUT_MS = 10_000;

export interface CanaryWatch {
  /**
   * Resolves true when the canary arrives over the link, false at `timeoutMs`.
   * Never rejects, and there is deliberately no way to abandon it early: a
   * canary keeps its whole window even when its own post failed, because Slack
   * may have accepted that post and the event may still be in flight.
   */
  arrived: Promise<boolean>;
}

export interface ProbeWatcher {
  /** Register a one-shot waiter for `nonce` BEFORE the canary is posted. */
  watchCanary(nonce: string, timeoutMs: number): CanaryWatch;
}

/**
 * The principal a canary must come back FROM before it can prove anything:
 * the broker's own Slack bot user (`auth.test` on the bot token that posts the
 * canaries) and the channel it posts them to. The stamp and the nonce are
 * content — quotable, copyable by any app in the channel — so they identify
 * canary *traffic* but never settle a probe on their own.
 */
export interface CanaryIdentity {
  userId: string;
  channelId: string;
}

export class CanaryIdentityUnboundError extends Error {
  constructor() {
    super("the canary registry has no bound identity — bind the broker's Slack principal before probing");
    this.name = "CanaryIdentityUnboundError";
  }
}

/**
 * One registry, two consumers with opposite error costs (hive#54's
 * retrospective, `scar-split-the-predicate-by-consumer`):
 *
 * - {@link observe}'s RETURN VALUE classifies traffic — "is this envelope a
 *   canary?" — so the ingress can keep it off the event clock. That must be
 *   WIDE: the edit and delete echoes of a canary are still not conversation,
 *   and counting one would make the next cycle read the link as busy and skip
 *   the probe that would have proved it alive.
 * - {@link observe}'s SIDE EFFECT settles a waiter, which is the watchdog's
 *   entire liveness proof. That must be NARROW and fail closed: only the
 *   original delivery of a message we posted, from our own principal, in our
 *   probe channel, while a waiter for that nonce is still pending. A deletion
 *   echo is not an arrival — a competing consumer may have taken the creation
 *   event while this connection was handed the independently distributed
 *   deletion — and a stamped envelope from any other sender is a forgery.
 */
export class CanaryRegistry implements ProbeWatcher {
  /** Pending waiters, keyed by nonce. */
  private readonly waiters = new Map<string, (arrived: boolean) => void>();
  private identity: CanaryIdentity | null = null;

  /** Name the principal whose original messages may settle a waiter. */
  bind(identity: CanaryIdentity): void {
    this.identity = identity;
  }

  /**
   * Register a one-shot waiter for a canary nonce. The probe calls this BEFORE
   * posting, because on a healthy link the event can arrive over the socket
   * before `chat.postMessage`'s own HTTP response returns.
   */
  watchCanary(nonce: string, timeoutMs: number): CanaryWatch {
    // A waiter nobody can settle would time out as `silent` every round and
    // escalate a healthy link — the failure this whole probe exists to prevent.
    if (this.identity === null) throw new CanaryIdentityUnboundError();
    let settle!: (arrived: boolean) => void;
    const arrived = new Promise<boolean>((resolve) => { settle = resolve; });
    const finish = (seen: boolean): void => {
      // A delete that removes nothing means this waiter already settled — a
      // promise must never be resolved twice with contradicting evidence.
      if (!this.waiters.delete(nonce)) return;
      clearTimeout(timer);
      settle(seen);
    };
    // Deliberately NOT unref'd: the deadline is seconds long and the broker's
    // shutdown force-exits, so it can never hold the process open — while an
    // unref'd deadline makes `arrived` unreachable whenever nothing else holds
    // the loop, which is exactly what a test harness looks like.
    const timer = setTimeout(() => finish(false), timeoutMs);
    this.waiters.set(nonce, finish);
    return { arrived };
  }

  /**
   * True when this envelope is canary traffic — ANY canary-stamped shape, not
   * only a nonce we are waiting on, because a canary is never channel activity:
   * the arrival, a late one past its deadline, one left over from a previous
   * broker process, and the echo of reaping one all belong to the probe, not
   * to the conversation.
   *
   * A pending waiter is settled only by the original posted-message shape
   * from the bound principal in the bound channel (see the class doc).
   */
  observe(body: unknown): boolean {
    const nonce = canaryNonceOf(body);
    if (nonce === null) return false;
    if (this.identity !== null && isOwnOriginalCanary(body, nonce, this.identity)) {
      this.waiters.get(nonce)?.(true);
    }
    return true;
  }
}

/**
 * The narrow shape that may settle a waiter: a plain `message` event (no
 * subtype — `message_changed` and `message_deleted` carry the stamp under
 * `message`/`previous_message`, never at the top level), in the probe channel,
 * from the broker's own bot user, whose own top-level metadata carries `nonce`.
 */
function isOwnOriginalCanary(body: unknown, nonce: string, identity: CanaryIdentity): boolean {
  const event = record(record(body)?.event);
  if (!event) return false;
  if (event.type !== "message" || event.subtype !== undefined) return false;
  if (event.channel !== identity.channelId || event.user !== identity.userId) return false;
  const metadata = record(event.metadata);
  if (metadata?.event_type !== PROBE_EVENT_TYPE) return false;
  return record(metadata.event_payload)?.nonce === nonce;
}

/**
 * The canary nonce this envelope carries in its metadata, or null if it is not
 * a canary. Slack repeats a message's metadata under `message` and
 * `previous_message` for the edit and delete shapes, so reaping a canary is
 * recognised as canary traffic too.
 */
function canaryNonceOf(body: unknown): string | null {
  const event = record(record(body)?.event);
  if (!event) return null;
  for (const candidate of [event, record(event.message), record(event.previous_message)]) {
    const metadata = record(candidate?.metadata);
    if (metadata?.event_type !== PROBE_EVENT_TYPE) continue;
    const nonce = record(metadata.event_payload)?.nonce;
    if (typeof nonce === "string" && nonce.length > 0) return nonce;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
