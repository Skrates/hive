import { withDeadline } from "./deadline.js";
import type { ProbeOutcome } from "./probe.js";

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
 * Silence alone cannot tell either of those from a channel where nobody is
 * talking. So when the link goes quiet the watchdog does not guess: it PROBES
 * (`SlackLinkProbe`) — posting its own canaries to the commons and waiting for
 * them to come back over the same link. Only then does it decide:
 *
 *   - Canaries return → the link carries our traffic. The channel is quiet, not
 *     deaf: reset the streak, take no action at all. (KRA-1357: without this the
 *     broker exited on any quiet quarter-hour, and Socket Mode has no replay, so
 *     every such exit risked dropping whatever arrived during the restart gap.)
 *   - A canary never returns, or could not be posted → silence stays unexplained
 *     and the escalation below runs on *falsifiable transport evidence*:
 *       - If the forced reconnect never re-established the transport (no
 *         `connected` since the restart), the socket is wedged — exit(1) so the
 *         supervisor (systemd) restarts the whole process.
 *       - If the reconnect DID re-establish but events still aren't flowing, the
 *         link is up-but-deaf. One more in-process reconnect is attempted; if the
 *         stream is STILL silent a full window after that, the process exits(1)
 *         for a supervisor restart.
 *
 * Incident 2026-08-11 (three deaf windows in one afternoon) settled the
 * up-but-deaf escalation empirically: in-process reconnects never recovered the
 * stream (8+ consecutive deaf cycles observed), while a process restart cured it
 * immediately, three out of three times — and Slack redelivered recent unacked
 * events after each restart. That escalation is unchanged; the probe only
 * decides whether it is entered at all.
 *
 * Every step logs loudly — the original incident cost an hour precisely because
 * the old broker logged nothing.
 */
export interface WatchdogPort {
  /**
   * Epoch-ms of the last genuine inbound Slack envelope, or null if none yet.
   * "Genuine" excludes the watchdog's own canaries: a probe that counted as
   * activity would make the next cycle read the link as busy and never probe.
   */
  lastEventAt(): number | null;
  /** Epoch-ms of the last transport `connected` transition, or null if never. */
  lastConnectAt(): number | null;
  /** True if any subscription is live — silence only matters when a wake could arrive. */
  hasActiveSubscription(): boolean;
  /**
   * Send a canary round over the link and report whether our own traffic came
   * back within `timeoutMs` per canary. Must not throw: an unsendable probe is
   * reported as `"unavailable"`, which proves nothing either way.
   */
  probeLink(timeoutMs: number): Promise<ProbeOutcome>;
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
  | "cycle_in_flight"
  | "idle_no_subscription"
  | "healthy"
  | "quiet_not_deaf"
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

/**
 * The "short window" one canary gets to come home. A Socket Mode round trip is
 * about a second in practice (KRA-1357 measured one at under a second), so this
 * is generous by an order of magnitude while staying far inside a stale window.
 */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * How long a forced reconnect gets before the watchdog stops waiting on it.
 * `restart()` awaits a WebSocket disconnect and a Socket Mode handshake, neither
 * of which is bounded by the SDK; a hung one would hold the single-flight cycle
 * open forever and skip every later interval. Abandoning the await is safe: it
 * leaves the connect clock stale, which is exactly the wedged-transport evidence
 * the next cycle exits on.
 */
export const RESTART_TIMEOUT_MS = 30_000;

export class SlackDeafnessWatchdog {
  private staleStreak = 0;
  /** True while a cycle is running — a probe round can outlast a short interval. */
  private cycleInFlight = false;
  /** Epoch-ms of the watchdog's own last forced reconnect, or null if none pending. */
  private lastRestartMs: number | null = null;

  constructor(
    private readonly port: WatchdogPort,
    private readonly staleMs: number,
    private readonly probeTimeoutMs: number = PROBE_TIMEOUT_MS,
    private readonly restartTimeoutMs: number = RESTART_TIMEOUT_MS,
  ) {}

  /**
   * Evaluate one watchdog cycle. Intended to be driven on an interval of
   * roughly `staleMs`, so a reconnecting cycle grants the fresh link a full
   * window to prove itself before the next cycle can escalate.
   */
  async check(): Promise<WatchdogAction> {
    // One cycle at a time. A probe round waits on the link, so with a short
    // `staleMs` a cycle can still be running when the next one fires; two
    // overlapping cycles would post two canary rounds and count the same silence
    // twice on the way to a spurious exit.
    if (this.cycleInFlight) {
      this.port.log(
        "[watchdog] previous cycle still in flight (its link probe outlasted the interval) — skipping this one",
      );
      return "cycle_in_flight";
    }
    this.cycleInFlight = true;
    try {
      return await this.evaluate();
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async evaluate(): Promise<WatchdogAction> {
    if (!this.port.hasActiveSubscription()) {
      // No agent to wake — silence is expected. Don't let a quiet-but-healthy
      // idle period accrue toward a restart/exit.
      this.reset();
      return "idle_no_subscription";
    }

    if (this.idleMs() < this.staleMs) {
      this.reset();
      return "healthy";
    }

    // A quiet channel and a stolen stream look identical from here. Ask the link
    // itself before spending a reconnect — let alone the process.
    const eventClockBefore = this.port.lastEventAt();
    const probe = await this.probe();

    // The probe waits on the link, and a genuine wake can arrive while it does.
    // That arrival disproves the silence this cycle was reacting to and outranks
    // the probe's own verdict — including "unavailable", where the canary could
    // not be sent at all while the link was carrying traffic the whole time.
    // The test is MOVEMENT of the event clock, not how recent it now looks: a
    // probe window can outlast `staleMs` (which is allowed down to 10s), and an
    // event that arrived during the wait is proof even once it is stale again.
    const eventClockAfter = this.port.lastEventAt();
    const idleMs = this.idleMs();
    const idleLabel = describeIdle(idleMs);
    const staleLabel = `${Math.round(this.staleMs / 1_000)}s`;
    if (eventClockAfter !== null && eventClockAfter !== eventClockBefore) {
      this.port.log(
        `[watchdog] a Slack event arrived while the link probe ran (idle now ${idleLabel}) — the silence is over`,
      );
      this.reset();
      return "healthy";
    }

    if (probe === "alive") {
      this.port.log(
        `[watchdog] no Slack events for ${idleLabel} (≥ ${staleLabel}) but every canary returned over the link `
        + "— quiet, not deaf; no reconnect",
      );
      this.reset();
      return "quiet_not_deaf";
    }
    if (probe === "unavailable") {
      this.port.log(
        `[watchdog] the link probe was unavailable this cycle (idle ${idleLabel} ≥ ${staleLabel}) `
        + "— silence stays unexplained; escalating on transport evidence alone",
      );
    }

    this.staleStreak += 1;

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
        // Up-but-deaf, our own canaries are not coming home, and the in-process
        // reconnect budget is spent. Empirically (2026-08-11) only a process
        // restart recovers this state — exit for the supervisor, and Slack
        // redelivers recent unacked events on reconnect.
        this.port.log(
          `[watchdog] Slack link re-established but STILL silent after ${MAX_DEAF_RECONNECTS} reconnects `
          + `(idle ${idleLabel} ≥ ${staleLabel}, streak ${this.staleStreak}) — up-but-deaf; the link did not carry `
          + "our own canaries either, and in-process reconnects are exhausted (they never recover this state) "
          + "— exiting(1) for supervisor restart",
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
      await this.forceRestart();
      return "reconnected_still_deaf";
    }

    this.port.log(
      `[watchdog] no Slack events for ${idleLabel} (≥ ${staleLabel}) while subscriptions are live, and the link `
      + "did not carry our own canaries — forcing a Socket Mode reconnect",
    );
    await this.forceRestart();
    return "restarted";
  }

  /**
   * Force one reconnect, and never wait on it forever. A reconnect that hangs or
   * throws is not a reason to hold the cycle open — the transport clock records
   * what actually happened, and a reconnect that never re-established is read as
   * wedged by the next cycle, which exits for the supervisor.
   */
  private async forceRestart(): Promise<void> {
    this.lastRestartMs = this.port.now();
    try {
      await withDeadline(this.port.restart(), this.restartTimeoutMs, "socket restart");
    } catch (error) {
      this.port.log(
        `[watchdog] the forced reconnect did not complete (${errorName(error)}) — abandoning it; the transport `
        + "clock stays stale, so the next cycle reads it as wedged and exits for the supervisor",
      );
    }
  }

  /**
   * A probe that throws is a broken probe, not a deaf link: it must never abort
   * the cycle (that would leave a genuinely deaf broker undetected forever) and
   * it must never be read as evidence.
   */
  private async probe(): Promise<ProbeOutcome> {
    try {
      return await this.port.probeLink(this.probeTimeoutMs);
    } catch {
      return "unavailable";
    }
  }

  /** Milliseconds since the last non-canary Slack envelope; ∞ if none ever arrived. */
  private idleMs(): number {
    const last = this.port.lastEventAt();
    return last === null ? Number.POSITIVE_INFINITY : this.port.now() - last;
  }

  private reset(): void {
    this.staleStreak = 0;
    this.lastRestartMs = null;
  }
}

function describeIdle(idleMs: number): string {
  return Number.isFinite(idleMs) ? `${Math.round(idleMs / 1_000)}s` : "∞ (no event since boot)";
}

/**
 * The exception TYPE only. A restart or probe failure can carry Slack body text,
 * so the message is dropped entirely rather than truncated.
 */
function errorName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name;
  return "non-error thrown";
}
