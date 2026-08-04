/**
 * Deafness watchdog for the Slack Socket Mode link.
 *
 * Incident 2026-08-04: the broker's `apps.connections.open` kept succeeding and
 * the TCP link stayed established, yet zero Slack events arrived for hours. Two
 * causes fit that signature and neither surfaces as a client error:
 *   1. a half-open WebSocket (kernel TCP alive, no frames flowing), and
 *   2. a second Socket Mode consumer of the same app stealing the event stream
 *      (Slack fans each event to exactly one of the app's open connections).
 *
 * The watchdog handles both blindly: it does not diagnose *why* the link is
 * silent, only that a link which *should* be carrying events has gone quiet for
 * too long. On the first stale cycle it forces a reconnect; if a second
 * consecutive cycle is still silent, it exits so the supervisor (systemd)
 * restarts the process. Every step logs loudly — the incident cost an hour
 * precisely because the old broker logged nothing.
 */
export interface WatchdogPort {
  /** Epoch-ms of the last sign of life from the Slack link, or null if never. */
  lastActivityAt(): number | null;
  /** True if any subscription is live — silence only matters when a wake could arrive. */
  hasActiveSubscription(): boolean;
  /** Tear down and re-establish the Socket Mode client. */
  restart(): Promise<void>;
  /** Terminate the process for the supervisor to restart. */
  exit(code: number): void;
  /** Current epoch-ms. */
  now(): number;
  /** Loud, structured log sink. */
  log(message: string): void;
}

export type WatchdogAction = "idle_no_subscription" | "healthy" | "restarted" | "exited";

export class SlackDeafnessWatchdog {
  private staleStreak = 0;

  constructor(
    private readonly port: WatchdogPort,
    private readonly staleMs: number,
  ) {}

  /**
   * Evaluate one watchdog cycle. Intended to be driven on an interval of
   * roughly `staleMs`, so a `restarted` cycle grants the fresh link a full
   * window to prove itself before the next cycle can escalate to `exited`.
   */
  async check(): Promise<WatchdogAction> {
    if (!this.port.hasActiveSubscription()) {
      // No agent to wake — silence is expected. Don't let a quiet-but-healthy
      // idle period accrue toward a restart/exit.
      this.staleStreak = 0;
      return "idle_no_subscription";
    }

    const last = this.port.lastActivityAt();
    const idleMs = last === null ? Number.POSITIVE_INFINITY : this.port.now() - last;
    if (idleMs < this.staleMs) {
      this.staleStreak = 0;
      return "healthy";
    }

    this.staleStreak += 1;
    const idleLabel = Number.isFinite(idleMs) ? `${Math.round(idleMs / 1_000)}s` : "∞ (no event since boot)";
    if (this.staleStreak >= 2) {
      this.port.log(
        `[watchdog] Slack link STILL deaf after a forced reconnect (idle ${idleLabel} ≥ ${Math.round(this.staleMs / 1_000)}s, `
        + `streak ${this.staleStreak}) — exiting(1) for supervisor restart`,
      );
      this.port.exit(1);
      return "exited";
    }
    this.port.log(
      `[watchdog] no Slack events for ${idleLabel} (≥ ${Math.round(this.staleMs / 1_000)}s) while subscriptions are live `
      + "— forcing a Socket Mode reconnect",
    );
    await this.port.restart();
    return "restarted";
  }
}
