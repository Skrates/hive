/**
 * The review outbox worker (design §8.1).
 *
 * `drainOnce` runs one pass per sink — Slack and GitHub, started together and independent —
 * and each pass claims at most one pending effect per target, renders refreshes from `read()`
 * *now*, re-checks actionable applicability against the current Review (§6.D7/§6.D8/§6.C3/§6.G3
 * — the one place request transport pauses and resumes), dispatches through the ports, and
 * marks the row. Publication is serialized per target: the store hands out one row per target
 * and a sink's passes never overlap, so a delayed worker can never publish an older verdict —
 * it never carried one. What one sink's port does cannot delay another's, neither by marking
 * (the two sinks' rows are distinct targets) nor by a hung await (the two passes are distinct).
 *
 * A GitHub dispatch is time-boxed and the expiry aborts the call, so a call the pass has given
 * up on cannot land after the retry that replaced it.
 *
 * What a port answers is recorded as a projection fact (§8.1 "edited in place through
 * `projection_handles`"; §6.D5 "the request stores references"): the board comment id, the
 * check-run id per head, the Slack thread, and the delivery id / summon comment id on the
 * request. Recording happens before the row is marked sent, so a lost mark re-dispatches
 * against the handle rather than creating a second comment.
 */
import { retryBackoffMs } from "../domain.js";
import type { Clock } from "../time.js";
import { iso } from "../time.js";
import type { Effect, Policy, ReviewState, TransportRef } from "./contract.js";
import {
  announcePayload,
  noticePayload,
  applicability,
  deliveryPayload,
  parseTarget,
  sinkOf,
  summonPayload,
  type EffectSink,
  type EffectTarget,
} from "./effects.js";
import { boardComment, checkRun, slackBoardLine, threadState } from "./render.js";
import type { UnknownSourceRecord } from "./store.js";

/**
 * GitHub-side projections (M1). `null` in M0: the Slack board line is the one projection.
 *
 * Every method takes the dispatch's `AbortSignal` and must carry it into whatever it does on
 * the wire. The publisher time-boxes each call ({@link REVIEW_GITHUB_DISPATCH_TIMEOUT_MS}) and
 * requeues the row on expiry; without cancellation the abandoned call would still be in flight
 * and could land *after* the retry — overwriting a check, board comment or thread with an older
 * render, or creating a second board comment because the retry saw no handle yet. The timeout
 * therefore aborts the request rather than merely stopping the wait.
 */
export interface ReviewGitHubPort {
  createOrUpdateCheckRun(input: {
    repositoryId: number;
    headSha: string;
    existingId: number | null;
    name: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
  }, signal: AbortSignal): Promise<{ checkRunId: number }>;
  createOrUpdateBoardComment(input: {
    repositoryId: number;
    prNumber: number;
    existingId: number | null;
    body: string;
  }, signal: AbortSignal): Promise<{ commentId: number }>;
  resolveThread(input: { repositoryId: number; commentId: number }, signal: AbortSignal): Promise<void>;
  unresolveThread(input: { repositoryId: number; commentId: number }, signal: AbortSignal): Promise<void>;
  /** Summons ("@codex review"). */
  postComment(input: { repositoryId: number; prNumber: number; body: string }, signal: AbortSignal): Promise<{ commentId: number; summonLogin: string }>;
}

/**
 * The same port as the dispatch code calls it: no signal parameter, because the time-box owns
 * the signal it passes down. Nothing but {@link timeboxedGitHub} produces one.
 */
export type TimeboxedGitHubPort = {
  [K in keyof ReviewGitHubPort]: ReviewGitHubPort[K] extends (input: infer I, signal: AbortSignal) => infer R
    ? (input: I) => R
    : never;
};

/** Implemented on `BrokerStore`: system-origin Hive deliveries and the board line (§8.1 Slack). */
export interface SystemWakePort {
  mintSystemWake(input: { actor: string; channelId: string; threadTs: string | null; text: string; dedupeKey: string }): { deliveryId: number };
  postBoardLine(input: { channelId: string; threadTs: string | null; text: string }): { outboxId: number };
  /** The Slack message ts an outbox row was posted as; null until the outbox has drained it. */
  outboxMessageTs(outboxId: number): string | null;
}

/** An effect row as the publisher sees it: the contract's `Effect` plus its ledger columns. */
export interface PublishableEffect extends Effect {
  reviewId: string;
  attempts: number;
}

/**
 * What the publisher needs from `ReviewStore` (module map §3), no more. `readById` is the
 * one member the map does not list: an effect row names its Review by id, not by key.
 */
export interface PublisherStore {
  readById(reviewId: string): ReviewState | null;
  policy(repositoryId: number, version: number | "latest"): Policy | null;
  /** §8.1 / §6.D5: the facts a dispatch establishes, recorded on the Review outside the fold. */
  readonly projections: {
    recordBoardComment(reviewId: string, commentId: number): void;
    recordCheckRun(reviewId: string, headSha: string, checkRunId: number): void;
    recordSlackThread(reviewId: string, channelId: string, threadTs: string): void;
    recordSlackBoardOutbox(reviewId: string, channelId: string, outboxId: number): void;
    slackBoardOutboxId(reviewId: string, channelId: string): number | null;
    recordTransport(reviewId: string, effectId: string, requestId: string, ref: TransportRef): void;
  };
  /** §7 step 3: Codex records classified `unknown`, surfaced on the board and never promoted. */
  readonly sourceRecords: {
    unknown(reviewId: string): UnknownSourceRecord[];
  };
  readonly effects: {
    /** §8.1: the due rows of one sink (plus any row whose target names no sink — see the store). */
    pendingByTarget(now: string, sink: EffectSink, limit?: number): PublishableEffect[];
    claim(effectId: string): PublishableEffect | null;
    markSent(effectId: string): void;
    markObsolete(effectId: string): void;
    markFailed(effectId: string, nextAttemptAt: string): void;
    coalesceRefresh(target: string): number;
  };
}

export interface ReviewPublisherPorts {
  github: ReviewGitHubPort | null;
  slack: SystemWakePort;
}

/** The ports as the dispatch code holds them: the GitHub side already time-boxed. */
interface DispatchPorts {
  github: TimeboxedGitHubPort | null;
  slack: SystemWakePort;
}

/** §8.1: every sink publishes on its own pass. */
const SINKS: readonly EffectSink[] = ["slack", "github"];

/** Thrown by a dispatch that cannot proceed; the row is marked failed and retried behind backoff. */
class DispatchError extends Error {}

/**
 * How long one GitHub port call may take before the row is failed instead of awaited (§8.1).
 * A pass is sequential and single-flight, so a call that never resolves — a socket the peer
 * forgot, an App-token fetch behind a black hole — would otherwise wedge review publication
 * for the life of the process, not just its own row. Thirty seconds is far beyond any healthy
 * GitHub response and six housekeeping ticks, so a timeout is always a fault, never load; the
 * row then retries under the ordinary attempt-bounded backoff, visibly.
 */
export const REVIEW_GITHUB_DISPATCH_TIMEOUT_MS = 30_000;

/**
 * Run `call` under a signal this function aborts once `ms` have passed, and reject then.
 *
 * Aborting is the point: the row is failed and requeued on expiry, so the abandoned call must
 * not still be able to reach GitHub. A port that ignores its signal and answers late answers
 * into a discarded promise — nothing is recorded and nothing is marked — but the write it
 * carried would already have happened, which is why the ports honour the signal on the wire.
 */
async function timebox<T>(call: (signal: AbortSignal) => Promise<T>, ms: number, what: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DispatchError(`GitHub ${what} did not answer within ${ms}ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The same port, with every call time-boxed by {@link REVIEW_GITHUB_DISPATCH_TIMEOUT_MS} and
 * aborted when the box expires.
 */
function timeboxedGitHub(port: ReviewGitHubPort, ms: number): TimeboxedGitHubPort {
  return {
    createOrUpdateCheckRun: (input) => timebox((signal) => port.createOrUpdateCheckRun(input, signal), ms, "createOrUpdateCheckRun"),
    createOrUpdateBoardComment: (input) => timebox((signal) => port.createOrUpdateBoardComment(input, signal), ms, "createOrUpdateBoardComment"),
    resolveThread: (input) => timebox((signal) => port.resolveThread(input, signal), ms, "resolveThread"),
    unresolveThread: (input) => timebox((signal) => port.unresolveThread(input, signal), ms, "unresolveThread"),
    postComment: (input) => timebox((signal) => port.postComment(input, signal), ms, "postComment"),
  };
}

export class ReviewPublisher {
  /** The in-flight pass of each sink, if any. Independent by construction (§8.1). */
  private readonly inFlight = new Map<EffectSink, Promise<number>>();
  private readonly ports: DispatchPorts;

  constructor(
    private readonly store: PublisherStore,
    ports: ReviewPublisherPorts,
    private readonly clock: Clock,
    githubTimeoutMs: number = REVIEW_GITHUB_DISPATCH_TIMEOUT_MS,
  ) {
    this.ports = {
      slack: ports.slack,
      github: ports.github === null ? null : timeboxedGitHub(ports.github, githubTimeoutMs),
    };
  }

  /**
   * One pass per sink over that sink's pending effects, one row per target, started together
   * and joined together. Returns the number of effects handled (sent or marked obsolete) across
   * both; withheld and unclaimable rows are left for the next pass.
   *
   * Single-flight is *per sink*: a call arriving while a sink's pass is running joins that pass
   * — which is what keeps per-target publication serialized across callers — but starts a fresh
   * pass for every sink that is idle. One global fence would have made Slack delivery wait out
   * whatever the GitHub pass was doing: a Slack row queued after the pass listed its rows sat
   * until every remaining GitHub row had answered or timed out (up to 100 rows × 30 s), which
   * is exactly the coupling §8.1 forbids.
   */
  drainOnce(): Promise<number> {
    const passes = SINKS.map((sink) => this.drainSink(sink));
    return Promise.all(passes).then((handled) => handled.reduce((sum, n) => sum + n, 0));
  }

  /** The named sink's in-flight pass, or a new one. */
  private drainSink(sink: EffectSink): Promise<number> {
    const running = this.inFlight.get(sink);
    if (running !== undefined) return running;
    const pass = this.pass(sink);
    this.inFlight.set(sink, pass);
    const done = (): void => { if (this.inFlight.get(sink) === pass) this.inFlight.delete(sink); };
    pass.then(done, done);
    return pass;
  }

  /** Join every claimed dispatch before the broker closes its database on shutdown. */
  async stop(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }

  private async pass(sink: EffectSink): Promise<number> {
    const rows = this.boardFirst(this.store.effects.pendingByTarget(iso(this.clock), sink));
    let handled = 0;
    for (const row of rows) {
      if (await this.handle(row)) handled += 1;
    }
    return handled;
  }

  /**
   * §8.1: within a sink's pass the board row leads. The loop has to stay sequential — per-target
   * serialization is what keeps a delayed worker from publishing an older verdict — so a slow
   * call delays whatever follows it; a pass holds one sink's rows only, so what follows is
   * never another sink's work.
   *
   * `board:slack` leads the Slack pass because it is the row that opens the Review's Slack
   * thread, and every other Slack row waits unclaimed until that thread exists. The opener still
   * only reaches the outbox in this pass, so the wait is one tick either way; leading keeps that
   * tick from becoming two.
   *
   * A target that does not parse sorts last: `handle` fails it without touching a port. Such a
   * row belongs to no sink, so it is listed in every sink's pass and the claim decides which
   * pass fails it.
   */
  private boardFirst(rows: PublishableEffect[]): PublishableEffect[] {
    const board: PublishableEffect[] = [];
    const rest: PublishableEffect[] = [];
    const unparsed: PublishableEffect[] = [];
    for (const row of rows) {
      let target: EffectTarget | null;
      try {
        target = parseTarget(row.target);
      } catch {
        target = null;
      }
      if (target === null) unparsed.push(row);
      else if (target.kind === "board" && sinkOf(target) === "slack") board.push(row);
      else rest.push(row);
    }
    return [...board, ...rest, ...unparsed];
  }

  private async handle(row: PublishableEffect): Promise<boolean> {
    let target: EffectTarget;
    try {
      target = parseTarget(row.target);
    } catch (error) {
      // The store validated the row's shape on the way in (§E2), so this is a defect, not
      // an input; it is retried behind backoff so it stays visible rather than dropped.
      this.fail(row, error);
      return false;
    }

    const review = this.store.readById(row.reviewId);
    if (review === null) {
      // No Review to render or to check against: the row can never become applicable.
      this.store.effects.markObsolete(row.effect_id);
      return true;
    }

    if (row.kind === "actionable") {
      // §D8: a withheld row is not claimed — it stays pending, attempts untouched, and is
      // looked at again on the next pass when `mergeable` may have flipped.
      if (applicability(target, review) === "withheld") return false;
      // M0 has no GitHub port; a summon must neither be lost nor marked, so it waits.
      if (target.kind === "summon" && this.ports.github === null) return false;
      // Slack actionables wait unclaimed for the channel's board opener to drain: the thread
      // ts only exists once the outbox has posted the board line, so this row cannot name a
      // thread yet. The wait is always at least one tick — `board:slack` sorts ahead of these
      // rows in this same pass (§8.1, `slackFirst`) but only queues the opener into the
      // outbox. `housekeepingTick` drains that outbox independently of this pass on the same
      // tick, so the ts is recorded before the next pass looks at these rows again.
      if (applicability(target, review) === "applicable" &&
        (target.kind === "delivery" || target.kind === "notice" || target.kind === "announce") &&
        this.slackPolicy(review) !== null && this.slackThread(review) === null) return false;
    }

    if (row.kind === "refresh") {
      // §8.1: pending refreshes for one target coalesce into the newest. Coalescing before
      // the claim means that if a newer refresh landed since the listing, this row is the one
      // obsoleted and the claim below fails — the newer row renders on the next pass.
      this.store.effects.coalesceRefresh(row.target);
    }

    const claimed = this.store.effects.claim(row.effect_id);
    if (claimed === null) return false;

    try {
      if (row.kind === "refresh") {
        // Re-read after the claim: the render is from the Review *now*, never from whatever
        // state existed when the row was queued.
        const current = this.store.readById(row.reviewId);
        if (current === null) {
          this.store.effects.markObsolete(row.effect_id);
          return true;
        }
        return this.mark(row, await this.refresh(target, current));
      }
      // §D7 / §8.1: applicability is re-checked against the current Review at dispatch.
      const current = this.store.readById(row.reviewId);
      if (current === null) {
        this.store.effects.markObsolete(row.effect_id);
        return true;
      }
      const verdict = applicability(target, current);
      if (verdict === "obsolete") {
        this.store.effects.markObsolete(row.effect_id);
        return true;
      }
      if (verdict === "withheld") {
        // Claimed between the pre-check and now; give it back to the queue behind a short
        // backoff rather than hold the claim.
        this.store.effects.markFailed(row.effect_id, this.nextAttemptAt(row.attempts));
        return false;
      }
      return this.mark(row, await this.actionable(target, row, current));
    } catch (error) {
      this.fail(row, error);
      return false;
    }
  }

  private mark(row: PublishableEffect, outcome: "sent" | "obsolete"): boolean {
    if (outcome === "sent") this.store.effects.markSent(row.effect_id);
    else this.store.effects.markObsolete(row.effect_id);
    return true;
  }

  private fail(row: PublishableEffect, error: unknown): void {
    console.error("hive review effect failed", row.effect_id, row.target, error);
    this.store.effects.markFailed(row.effect_id, this.nextAttemptAt(row.attempts));
  }

  private nextAttemptAt(attempts: number): string {
    return new Date(this.clock.now().getTime() + retryBackoffMs(attempts + 1)).toISOString();
  }

  // -------------------------------------------------------------------------------------
  // Refreshes: render from the current state and push to every sink that exists.

  private async refresh(target: EffectTarget, state: ReviewState): Promise<"sent" | "obsolete"> {
    const github = this.ports.github;
    switch (target.kind) {
      case "board": {
        // §8.1: one sink per row. The two board sinks are independent targets, so a GitHub
        // comment that fails or hangs marks only its own row failed — the Slack line, which
        // opens the Review's thread, is queued by its own row on the same pass.
        const unknown = this.store.sourceRecords.unknown(state.id);
        if (target.sink === "github") {
          // No GitHub port is a configuration, not a failure (M0, §1 F-2): the sink does not
          // exist, so its row is retired rather than retried, as a check's row already is.
          if (github === null) return "obsolete";
          const existingId = state.projection_handles.board_comment_id;
          const { commentId } = await github.createOrUpdateBoardComment({
            repositoryId: state.key.repository_id,
            prNumber: state.key.pr_number,
            existingId,
            body: boardComment(state, unknown),
          });
          // §8.1: one comment per Review, created once. The id is recorded the moment it exists.
          if (existingId === null) this.store.projections.recordBoardComment(state.id, this.positiveId(commentId, "board comment"));
          return "sent";
        }
        // A policy that names no Slack channel is a defect, not a configuration: the row fails
        // visibly behind backoff rather than retiring the Review's one Slack projection.
        const slack = this.slackPolicy(state);
        if (slack === null) throw new DispatchError("board has no configured Slack channel");
        const threadTs = this.slackThread(state);
        const { outboxId } = this.ports.slack.postBoardLine({ channelId: slack.channel_id, threadTs, text: slackBoardLine(state, unknown) });
        // The first line opens the Review's thread; its ts is learned once the outbox drains it.
        if (threadTs === null && this.store.projections.slackBoardOutboxId(state.id, slack.channel_id) === null) {
          this.store.projections.recordSlackBoardOutbox(state.id, slack.channel_id, outboxId);
        }
        return "sent";
      }
      case "check": {
        // A check names one head; once the subject has moved on, no verdict is published
        // for a head nobody is at (§8.1 "at the current head").
        if (github === null || target.headSha !== state.subject.head_sha) return "obsolete";
        const render = checkRun(state);
        const existingId = state.projection_handles.check_run_ids[target.headSha] ?? null;
        const { checkRunId } = await github.createOrUpdateCheckRun({
          repositoryId: state.key.repository_id,
          headSha: target.headSha,
          existingId,
          ...render,
        });
        if (existingId === null) this.store.projections.recordCheckRun(state.id, target.headSha, this.positiveId(checkRunId, "check run"));
        return "sent";
      }
      case "thread": {
        if (github === null) return "obsolete";
        const op = threadState(state, target.commentId);
        if (op === null) return "obsolete";
        const input = { repositoryId: state.key.repository_id, commentId: target.commentId };
        if (op === "resolve") await github.resolveThread(input);
        else await github.unresolveThread(input);
        return "sent";
      }
      case "delivery":
      case "summon":
      case "announce":
      case "notice":
        throw new DispatchError(`${target.kind} is not a refresh target`);
    }
  }

  // -------------------------------------------------------------------------------------
  // Actionables: already known applicable; dispatch exactly what the payload says.

  private async actionable(
    target: EffectTarget,
    row: PublishableEffect,
    state: ReviewState,
  ): Promise<"sent" | "obsolete"> {
    switch (target.kind) {
      case "notice": {
        const payload = noticePayload(row.payload);
        if (payload === null) throw new DispatchError("conflict notice carries no payload");
        const slack = this.slackPolicy(state);
        if (slack === null) throw new DispatchError("conflict notice has no Slack channel");
        this.ports.slack.mintSystemWake({ actor: payload.actor, channelId: slack.channel_id,
          threadTs: this.slackThread(state), text: payload.text, dedupeKey: payload.dedupe_key });
        return "sent";
      }
      case "delivery": {
        const payload = deliveryPayload(row.payload);
        if (payload === null) throw new DispatchError(`delivery effect ${row.effect_id} carries no delivery payload`);
        const slack = this.slackPolicy(state);
        if (slack === null) {
          throw new DispatchError(`policy v${state.policy_version} for repository ${state.key.repository_id} names no Slack channel`);
        }
        // §D5 / R-3: the ledger owns attempts; an unroutable actor throws out of the port
        // and this row retries behind backoff, visibly.
        const { deliveryId } = this.ports.slack.mintSystemWake({
          actor: payload.actor,
          channelId: slack.channel_id,
          threadTs: this.slackThread(state),
          text: payload.text,
          dedupeKey: payload.dedupe_key,
        });
        // §D5: the request stores the reference; the delivery ledger owns the attempts.
        this.store.projections.recordTransport(state.id, row.effect_id, target.requestId, { delivery_id: this.positiveId(deliveryId, "delivery") });
        return "sent";
      }
      case "summon": {
        const payload = summonPayload(row.payload);
        if (payload === null) throw new DispatchError(`summon effect ${row.effect_id} carries no summon payload`);
        const github = this.ports.github;
        if (github === null) throw new DispatchError("summon dispatched without a GitHub port");
        const { commentId, summonLogin } = await github.postComment({
          repositoryId: state.key.repository_id,
          prNumber: state.key.pr_number,
          body: `${payload.text}\n\nHive request ${target.requestId}; effect ${row.effect_id}; attempt ${row.attempts + 1}. Repeated delivery of this request is a retry of the same review obligation.`,
        });
        this.store.projections.recordTransport(state.id, row.effect_id, target.requestId, { summon_comment_id: this.positiveId(commentId, "summon comment"), summon_login: summonLogin });
        return "sent";
      }
      case "announce": {
        const payload = announcePayload(row.payload);
        if (payload === null) throw new DispatchError(`announce effect ${row.effect_id} carries no announce payload`);
        const slack = this.slackPolicy(state);
        if (slack === null) throw new DispatchError("merge announcement has no Slack channel");
        this.ports.slack.postBoardLine({ channelId: slack.channel_id, threadTs: this.slackThread(state), text: payload.text });
        return "sent";
      }
      case "check":
      case "board":
      case "thread":
        throw new DispatchError(`${target.kind} is not an actionable target`);
    }
  }

  /**
   * The Review's Slack thread: the recorded ts, or — the first board line having been queued
   * but its ts not yet recorded — the ts the outbox posted it as, recorded now. Null while the
   * first line is still unsent; Slack actionables remain pending until its coordinate is known.
   */
  private slackThread(state: ReviewState): string | null {
    const channel = this.slackPolicy(state)?.channel_id;
    if (channel === undefined) return null;
    const recorded = state.projection_handles.slack_thread_ts;
    if (recorded !== null) return recorded;
    const outboxId = this.store.projections.slackBoardOutboxId(state.id, channel);
    if (outboxId === null) return null;
    const ts = this.ports.slack.outboxMessageTs(outboxId);
    if (ts === null) return null;
    this.store.projections.recordSlackThread(state.id, channel, ts);
    return ts;
  }

  /** A port answered without an id: the dispatch happened, but there is nothing to edit in place through. */
  private positiveId(id: number, what: string): number {
    if (Number.isInteger(id) && id >= 1) return id;
    throw new DispatchError(`${what} dispatched but the port returned no id (${id}); nothing to record`);
  }

  /** §6.I: the Review's own policy version, never the repo's latest. */
  private slackPolicy(state: ReviewState): Policy["slack"] {
    const policy = this.store.policy(state.key.repository_id, state.policy_version);
    if (policy === null) {
      throw new DispatchError(`policy v${state.policy_version} for repository ${state.key.repository_id} is missing`);
    }
    return policy.slack;
  }
}
