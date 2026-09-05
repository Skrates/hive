import { randomUUID } from "node:crypto";
import type { ProbeWatcher } from "./canary.js";
import { withDeadline } from "./deadline.js";
import { safeErrorName } from "./slack.js";

/**
 * The end-to-end canary that tells a QUIET Slack link from a DEAF one.
 *
 * The deafness watchdog can only see one thing directly: no events have arrived
 * for a while. That silence is ambiguous — "nobody is talking" and "somebody
 * else is consuming our stream" produce the identical signal — and until
 * 2026-09-05 the watchdog resolved the ambiguity by assuming the worse case,
 * which exited the broker on any quiet quarter-hour (KRA-1357).
 *
 * A canary removes the ambiguity from one side: post a marker to a channel Hive
 * occupies and wait for it to come back over the Socket Mode link. If our own
 * traffic reaches us, the link carries events and the channel is merely quiet.
 * If it does not, the existing escalation (reconnect, then exit for systemd) is
 * exactly right.
 *
 * Why a ROUND of canaries and not one: Slack fans each event to exactly one of
 * an app's open connections, so a second consumer stealing the stream wins each
 * event independently — a single canary would still reach us about half the
 * time and reset the streak. Requiring every canary of a round to return makes
 * a thief fail the round with probability 1 - 2^-N (87.5% at N=3) while a
 * healthy link passes it every time. One lost canary short-circuits the round:
 * there is nothing left to prove.
 *
 * Every canary is stamped `hive_*` like every other Hive outbox post, so
 * admission drops it before any envelope is parsed — the anti-recursion
 * invariant stays total and a canary can never mint a delivery.
 */

/**
 * Whether the link carried our own traffic back.
 *   "alive"       — every canary of the round returned; the link is quiet, not deaf.
 *   "silent"      — a canary was posted and never came back; deafness evidence.
 *   "unavailable" — the canary could not be posted at all (Slack Web API refused
 *                   or is unreachable), so the probe proves NOTHING in either
 *                   direction and the caller must fall back to transport evidence.
 */
export type ProbeOutcome = "alive" | "silent" | "unavailable";

/** Canaries per probe round; the round is "alive" only if every one returns. */
export const PROBE_CANARIES = 3;

export interface ProbePoster {
  /** Post one canary carrying `nonce`, stamped `PROBE_EVENT_TYPE`; resolves its message ts. */
  postCanary(nonce: string): Promise<string>;
  /** Best-effort removal of a posted canary — its job ends the moment it is observed. */
  deleteCanary(messageTs: string): Promise<void>;
}

export class SlackLinkProbe {
  constructor(
    private readonly poster: ProbePoster,
    private readonly watcher: ProbeWatcher,
    private readonly log: (message: string) => void = (message) => console.error(message),
    private readonly newNonce: () => string = () => randomUUID(),
  ) {}

  /** Run one probe round. `timeoutMs` bounds each canary, not the round. */
  async run(timeoutMs: number): Promise<ProbeOutcome> {
    for (let canary = 1; canary <= PROBE_CANARIES; canary += 1) {
      const outcome = await this.sendOne(canary, timeoutMs);
      // A single canary that never returned already falsifies the round.
      if (outcome !== "alive") return outcome;
    }
    return "alive";
  }

  private async sendOne(index: number, timeoutMs: number): Promise<ProbeOutcome> {
    const nonce = this.newNonce();
    // Register the waiter BEFORE posting: on a healthy link the event can arrive
    // over the socket before chat.postMessage's own HTTP response returns.
    const watch = this.watcher.watchCanary(nonce, timeoutMs);
    let messageTs: string;
    try {
      messageTs = await withDeadline(this.poster.postCanary(nonce), timeoutMs, "canary post");
    } catch (error) {
      // The post failed — but Slack may have accepted it anyway, and the event
      // may still be in flight. Abandoning the waiter here would forfeit the
      // rest of its window, so the canary keeps its full deadline: an arrival is
      // direct proof the link carried our traffic and outranks a failed call.
      if (await watch.arrived) {
        this.log(
          `[watchdog] canary ${index}/${PROBE_CANARIES} returned over the link although its post failed `
          + `(${safeErrorName(error)}) — the link is alive; this canary stays in the channel unreaped`,
        );
        return "alive";
      }
      // R-3: a probe we could not send is reported as un-provable, never as
      // deafness. The error TYPE only — a Slack error can carry body text.
      this.log(
        `[watchdog] canary ${index}/${PROBE_CANARIES} could not be posted (${safeErrorName(error)}) `
        + "— the link probe proves nothing this cycle",
      );
      return "unavailable";
    }
    const arrived = await watch.arrived;
    void this.poster.deleteCanary(messageTs).catch((error: unknown) => {
      this.log(
        `[watchdog] canary ${index}/${PROBE_CANARIES} could not be removed from the commons `
        + `(${safeErrorName(error)}) — it stays visible; harmless, admission drops it`,
      );
    });
    if (!arrived) {
      this.log(
        `[watchdog] canary ${index}/${PROBE_CANARIES} did not return within ${Math.round(timeoutMs / 1_000)}s `
        + "— our own traffic is not reaching us over the Socket Mode link",
      );
      return "silent";
    }
    return "alive";
  }
}
