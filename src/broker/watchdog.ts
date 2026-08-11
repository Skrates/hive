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
 * too long. On the first stale cycle it forces a reconnect. If a second
 * consecutive cycle is still silent, the escalation is decided by *falsifiable
 * transport evidence*, never by silence alone:
 *
 *   - If the forced reconnect never re-established the transport (no `connected`
 *     since the restart), the socket is wedged — exit(1) so the supervisor
 *     (systemd) restarts the whole process.
 *   - If the reconnect DID re-establish but events still aren't flowing, the
 *     link is up-but-deaf. One more in-process reconnect is attempted; if the
 *     stream is STILL silent a full window after that, the process exits(1) for
 *     a supervisor restart.
 *
 * Incident 2026-08-11 (three deaf windows in one afternoon) settled the
 * up-but-deaf escalation empirically: in-process reconnects never recovered the
 * stream (8+ consecutive deaf cycles observed), while a process restart cured it
 * immediately, three out of three times — and Slack redelivered recent unacked
 * events after each restart. The old fear ("exiting would crash-loop a quiet
 * broker") priced the wrong side: restarting a genuinely quiet-but-healthy
 * broker loses nothing (there are no events to drop, and anything arriving
 * mid-restart is redelivered), whereas staying alive deaf silently drops wakes.
 * Without an end-to-end canary, quiet-vs-stolen still can't be told apart
 * (docs/adr/0002 §D15, KRA-906 remains the sound *detection* fix) — so the
 * watchdog now treats sustained silence under live subscriptions as
 * restart-worthy after a bounded reconnect budget, accepting the occasional
 * harmless restart of a quiet broker.
 *
 * Every step logs loudly — the original incident cost an hour precisely because
 * the old broker logged nothing.
 */
export interface WatchdogPort {
  /** Epoch-ms of the last genuine inbound Slack envelope, or null if none yet. */
  lastEventAt(): number | null;
  /** Epoch-ms of the last transport `connected` transition, or null if never. */
  lastConnectAt(): number | null;
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

export type WatchdogAction =
  | "idle_no_subscription"
  | "healthy"
  | "restarted"
  | "reconnected_still_deaf"
  | "exited";

/**
 * In-process reconnect attempts allowed against an up-but-deaf link before the
 * watchdog escalates to exit(1). Two attempts = the streak-1 reconnect plus one
 * retry; empirically (2026-08-11) even one is optimistic — in-process reconnects
 * never recovered a deaf stream — but the second attempt keeps a margin against
 * exiting a genuinely quiet channel on a single silent window.
 */
const MAX_DEAF_RECONNECTS = 2;

export class SlackDeafnessWatchdog {
  private staleStreak = 0;
  /** Epoch-ms of the watchdog's own last forced reconnect, or null if none pending. */
  private lastRestartMs: number | null = null;

  constructor(
    private readonly port: WatchdogPort,
    private readonly staleMs: number,
  ) {}

  /**
   * Evaluate one watchdog cycle. Intended to be driven on an interval of
   * roughly `staleMs`, so a reconnecting cycle grants the fresh link a full
   * window to prove itself before the next cycle can escalate.
   */
  async check(): Promise<WatchdogAction> {
    if (!this.port.hasActiveSubscription()) {
      // No agent to wake — silence is expected. Don't let a quiet-but-healthy
      // idle period accrue toward a restart/exit.
      this.reset();
      return "idle_no_subscription";
    }

    const last = this.port.lastEventAt();
    const idleMs = last === null ? Number.POSITIVE_INFINITY : this.port.now() - last;
    if (idleMs < this.staleMs) {
      this.reset();
      return "healthy";
    }

    this.staleStreak += 1;
    const idleLabel = Number.isFinite(idleMs) ? `${Math.round(idleMs / 1_000)}s` : "∞ (no event since boot)";
    const staleLabel = `${Math.round(this.staleMs / 1_000)}s`;

    if (this.staleStreak >= 2) {
      // A reconnect was already forced last cycle and events STILL haven't
      // resumed. The transport's own liveness decides the escalation.
      const restartedAt = this.lastRestartMs;
      const connectedAt = this.port.lastConnectAt();
      const reconnected = restartedAt !== null && connectedAt !== null && connectedAt >= restartedAt;
      if (!reconnected) {
        // The forced reconnect never took — the transport is wedged. A full
        // process restart is the sound recovery.
        this.port.log(
          `[watchdog] forced reconnect did not re-establish the Slack transport (idle ${idleLabel} ≥ ${staleLabel}, `
          + `streak ${this.staleStreak}) — exiting(1) for supervisor restart`,
        );
        this.port.exit(1);
        return "exited";
      }
      if (this.staleStreak > MAX_DEAF_RECONNECTS) {
        // Up-but-deaf and the in-process reconnect budget is spent. Empirically
        // (2026-08-11) only a process restart recovers this state — exit for the
        // supervisor, and Slack redelivers recent unacked events on reconnect.
        this.port.log(
          `[watchdog] Slack link re-established but STILL silent after ${MAX_DEAF_RECONNECTS} reconnects `
          + `(idle ${idleLabel} ≥ ${staleLabel}, streak ${this.staleStreak}) — up-but-deaf; in-process reconnects `
          + "are exhausted (they never recover this state) — exiting(1) for supervisor restart "
          + "(sound quiet-vs-stolen detection needs the D15 canary — KRA-906)",
        );
        this.port.exit(1);
        return "exited";
      }
      // Up-but-deaf with reconnect budget remaining: one more in-process attempt.
      this.port.log(
        `[watchdog] Slack link re-established but STILL silent (idle ${idleLabel} ≥ ${staleLabel}, streak ${this.staleStreak}) `
        + "— up-but-deaf (half-open recovered, or a second consumer is stealing the stream); reconnecting again "
        + `(attempt ${this.staleStreak} of ${MAX_DEAF_RECONNECTS} before exit)`,
      );
      this.lastRestartMs = this.port.now();
      await this.port.restart();
      return "reconnected_still_deaf";
    }

    this.port.log(
      `[watchdog] no Slack events for ${idleLabel} (≥ ${staleLabel}) while subscriptions are live `
      + "— forcing a Socket Mode reconnect",
    );
    this.lastRestartMs = this.port.now();
    await this.port.restart();
    return "restarted";
  }

  private reset(): void {
    this.staleStreak = 0;
    this.lastRestartMs = null;
  }
}
