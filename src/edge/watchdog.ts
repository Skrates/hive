/**
 * Liveness watchdog for the workstation edge.
 *
 * Incident 2026-08-15 (agent-cx53): the edge process stayed `active` under
 * systemd for ~80 minutes while claiming nothing. Five deliveries published
 * between 14:17Z and 14:37Z were never picked up, a completed 77-minute
 * headless turn had its outcome relay stranded, and recovery required a human
 * noticing and running `systemctl restart hive-edge`. Every health surface the
 * machine offered — unit state, process liveness, open sockets — said green.
 *
 * This is the same shape the broker's {@link SlackDeafnessWatchdog} was built
 * for one hop up: a component that stays "connected" but stops delivering. The
 * edge had no equivalent, so any hang anywhere in the run loop parked it deaf
 * forever. The bounds added alongside this watchdog (a timeout on every broker
 * request, a wall-clock deadline on every dispatch, a bounded capacity park)
 * close the mechanisms we can name; this closes the class, including the
 * mechanism nobody has named yet.
 *
 * The evidence it acts on is a *completed broker poll*, not mere loop activity:
 * a loop that spins on an error it cannot recover from is exactly as deaf as
 * one that never returns, and only the poll distinguishes reaching the broker
 * from believing you did.
 *
 * There is no cheaper recovery than a restart — an edge holds no reconnectable
 * transport of its own — so the escalation is a bounded stale budget and then
 * exit(1) for systemd's `Restart=`. Restarting a healthy-but-quiet edge costs
 * nothing: `recoverInterruptedDispatches` releases anything caught mid-flight
 * and the broker redelivers behind the dedupe key.
 */
export interface EdgeWatchdogPort {
  /** Epoch-ms of the last COMPLETED broker claim round-trip, or null if none since boot. */
  lastPollAt(): number | null;
  /**
   * True when every dispatch slot is occupied. A saturated edge is legitimately
   * not polling, so silence proves nothing about its health — see the note on
   * {@link EdgeLivenessWatchdog.check} about what covers that window instead.
   */
  saturated(): boolean;
  /** Terminate the process for the supervisor to restart. */
  exit(code: number): void;
  /** Current epoch-ms. */
  now(): number;
  /** Loud, structured log sink. */
  log(message: string): void;
}

export type EdgeWatchdogAction = "healthy" | "saturated" | "stale" | "exited";

/**
 * Consecutive stale cycles tolerated before the watchdog exits. Two, so a
 * single broker blip or a restart of the broker itself cannot bounce every edge
 * on the tailnet; a genuine wedge still terminalizes within two windows.
 */
const MAX_STALE_CYCLES = 2;

export class EdgeLivenessWatchdog {
  private staleStreak = 0;
  /** Last `lastPollAt` this watchdog observed; `undefined` until the first check. */
  private seenPollAt: number | null | undefined = undefined;

  constructor(
    private readonly port: EdgeWatchdogPort,
    private readonly staleMs: number,
  ) {}

  /**
   * Evaluate one cycle. Intended to be driven on an interval of roughly
   * `staleMs`, so a stale cycle grants a full window before the next can
   * escalate.
   *
   * A saturated edge is reported, never escalated: it is not polling because
   * every slot is running a turn, which is ordinary. The bound that keeps that
   * window finite is the dispatch deadline in `EdgeService` — without it, a
   * permanently saturated edge would be a permanent blind spot here, and this
   * watchdog would be a check that cannot fail for its reason.
   *
   * Saturation does not forgive silence it covered. A completed poll that
   * landed *before* the slots filled is recovery, not silence: that
   * advancement resets the streak even on a saturated check, so a later
   * desaturated window starts a fresh budget.
   */
  check(): EdgeWatchdogAction {
    const last = this.port.lastPollAt();
    const idleMs = last === null ? Number.POSITIVE_INFINITY : this.port.now() - last;
    // Reset before the saturated early return. A poll that filled the last
    // slot is recovery, not silence: leaving the streak intact here used to
    // exit a recovered edge the moment a slot freed mid-long-poll.
    if (pollHasAdvanced(this.seenPollAt, last) || idleMs < this.staleMs) {
      this.staleStreak = 0;
    }
    this.seenPollAt = last;

    if (this.port.saturated()) {
      this.port.log("[edge-watchdog] every dispatch slot is busy — not polling, and not judging liveness this cycle");
      return "saturated";
    }

    if (idleMs < this.staleMs) {
      return "healthy";
    }

    this.staleStreak += 1;
    const idleLabel = Number.isFinite(idleMs) ? `${Math.round(idleMs / 1_000)}s` : "∞ (no completed poll since boot)";
    const staleLabel = `${Math.round(this.staleMs / 1_000)}s`;

    if (this.staleStreak >= MAX_STALE_CYCLES) {
      this.port.log(
        `[edge-watchdog] no completed broker poll for ${idleLabel} (≥ ${staleLabel}) across ${this.staleStreak} `
        + "consecutive cycles with slots free — the edge is deaf; exiting(1) for supervisor restart",
      );
      this.port.exit(1);
      return "exited";
    }

    this.port.log(
      `[edge-watchdog] no completed broker poll for ${idleLabel} (≥ ${staleLabel}) with slots free `
      + `— stale cycle ${this.staleStreak} of ${MAX_STALE_CYCLES} before exit`,
    );
    return "stale";
  }
}

function pollHasAdvanced(previous: number | null | undefined, last: number | null): boolean {
  if (previous === undefined || last === null) return false;
  if (previous === null) return true;
  return last > previous;
}
