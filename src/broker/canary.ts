/**
 * The watchdog's canary bookkeeping — pure, and deliberately free of any Slack
 * dependency so both the ingress that observes canaries and the probe that
 * sends them can share it (and so it can be tested without a socket).
 */

/**
 * Metadata stamp carried by every canary. It MUST keep the `hive_` prefix:
 * Slack admission drops `hive_*`-stamped messages before an envelope is parsed,
 * which is what keeps a canary from ever being read as a wake.
 */
export const PROBE_EVENT_TYPE = "hive_watchdog_probe";

/**
 * How long past its waiter's deadline a canary nonce stays recognisable. It only
 * has to outlive the echoes one canary produces after it is observed — chiefly
 * the `message_deleted` event from reaping it — so that none of them are ever
 * counted as channel activity.
 */
export const CANARY_MEMORY_MS = 60_000;

export interface CanaryWatch {
  /** Resolves true when the canary arrives over the link, false at `timeoutMs`. Never rejects. */
  arrived: Promise<boolean>;
  /** Abandon the wait — the post failed, so nothing will ever arrive. */
  cancel(): void;
}

export interface ProbeWatcher {
  /** Register a one-shot waiter for `nonce` BEFORE the canary is posted. */
  watchCanary(nonce: string, timeoutMs: number): CanaryWatch;
}

export class CanaryRegistry implements ProbeWatcher {
  /** Pending waiters, keyed by nonce. */
  private readonly waiters = new Map<string, (arrived: boolean) => void>();
  /**
   * Nonces still recognisable as ours, with their expiry. Kept past the waiter
   * itself so a canary's whole footprint — its arrival, and the
   * `message_deleted` echo of reaping it — stays out of the event clock.
   */
  private readonly nonces = new Map<string, number>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /**
   * Register a one-shot waiter for a canary nonce. The probe calls this BEFORE
   * posting, because on a healthy link the event can arrive over the socket
   * before `chat.postMessage`'s own HTTP response returns.
   */
  watchCanary(nonce: string, timeoutMs: number): CanaryWatch {
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
    this.nonces.set(nonce, this.clock() + timeoutMs + CANARY_MEMORY_MS);
    return { arrived, cancel: () => finish(false) };
  }

  /**
   * True when this envelope carries one of our own canary nonces — settling its
   * waiter if one is still pending. Matching runs over the whole raw payload so
   * it holds for every shape a canary comes back in: the message itself, and the
   * `message_deleted` echo whose nonce sits in `previous_message`.
   */
  observe(body: unknown): boolean {
    this.prune();
    if (this.nonces.size === 0) return false;
    let payload: string;
    try {
      payload = JSON.stringify(body) ?? "";
    } catch {
      // An envelope that will not serialise cannot be matched. Treat it as
      // ordinary traffic rather than silently discounting it.
      return false;
    }
    let matched = false;
    for (const nonce of this.nonces.keys()) {
      if (!payload.includes(nonce)) continue;
      matched = true;
      this.waiters.get(nonce)?.(true);
    }
    return matched;
  }

  private prune(): void {
    if (this.nonces.size === 0) return;
    const now = this.clock();
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt <= now) this.nonces.delete(nonce);
    }
  }
}
