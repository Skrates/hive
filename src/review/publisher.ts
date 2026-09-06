/**
 * The review outbox worker (design §8.1).
 *
 * One pass (`drainOnce`) claims at most one pending effect per target, renders refreshes
 * from `read()` *now*, re-checks actionable applicability against the current Review
 * (§6.D7/§6.D8/§6.C3/§6.G3 — the one place request transport pauses and resumes), dispatches
 * through the ports, and marks the row. Publication is serialized
 * per target: the store hands out one row per target and passes never overlap, so a delayed
 * worker can never publish an older verdict — it never carried one.
 */
import { retryBackoffMs } from "../domain.js";
import type { Clock } from "../time.js";
import { iso } from "../time.js";
import type { Effect, Policy, ReviewState } from "./contract.js";
import {
  announcePayload,
  applicability,
  deliveryPayload,
  parseTarget,
  summonPayload,
  type EffectTarget,
} from "./effects.js";
import { boardComment, checkRun, slackBoardLine, threadState } from "./render.js";

/** GitHub-side projections (M1). `null` in M0: the Slack board line is the one projection. */
export interface ReviewGitHubPort {
  createOrUpdateCheckRun(input: {
    repositoryId: number;
    headSha: string;
    existingId: number | null;
    name: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
  }): Promise<{ checkRunId: number }>;
  createOrUpdateBoardComment(input: {
    repositoryId: number;
    prNumber: number;
    existingId: number | null;
    body: string;
  }): Promise<{ commentId: number }>;
  resolveThread(input: { repositoryId: number; commentId: number }): Promise<void>;
  unresolveThread(input: { repositoryId: number; commentId: number }): Promise<void>;
  /** Summons ("@codex review"). */
  postComment(input: { repositoryId: number; prNumber: number; body: string }): Promise<{ commentId: number }>;
}

/** Implemented on `BrokerStore`: system-origin Hive deliveries and the board line (§8.1 Slack). */
export interface SystemWakePort {
  mintSystemWake(input: { actor: string; channelId: string; threadTs: string | null; text: string; dedupeKey: string }): { deliveryId: number };
  postBoardLine(input: { channelId: string; threadTs: string | null; text: string }): { outboxId: number };
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
  readonly effects: {
    pendingByTarget(now: string, limit?: number): PublishableEffect[];
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

/** Thrown by a dispatch that cannot proceed; the row is marked failed and retried behind backoff. */
class DispatchError extends Error {}

export class ReviewPublisher {
  private inFlight: Promise<number> | null = null;

  constructor(
    private readonly store: PublisherStore,
    private readonly ports: ReviewPublisherPorts,
    private readonly clock: Clock,
  ) {}

  /**
   * One pass over the pending effects, one row per target. Single-flight: a call while a
   * pass is running joins it rather than racing it, which is what keeps per-target
   * publication serialized across callers. Returns the number of effects handled (sent or
   * marked obsolete); withheld and unclaimable rows are left for the next pass.
   */
  drainOnce(): Promise<number> {
    if (this.inFlight !== null) return this.inFlight;
    const pass = this.pass();
    this.inFlight = pass;
    pass.then(
      () => { if (this.inFlight === pass) this.inFlight = null; },
      () => { if (this.inFlight === pass) this.inFlight = null; },
    );
    return pass;
  }

  private async pass(): Promise<number> {
    const rows = this.store.effects.pendingByTarget(iso(this.clock));
    let handled = 0;
    for (const row of rows) {
      if (await this.handle(row)) handled += 1;
    }
    return handled;
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
        if (github !== null) {
          await github.createOrUpdateBoardComment({
            repositoryId: state.key.repository_id,
            prNumber: state.key.pr_number,
            existingId: state.projection_handles.board_comment_id,
            body: boardComment(state),
          });
        }
        const slack = this.slackPolicy(state);
        if (slack !== null) {
          this.ports.slack.postBoardLine({
            channelId: slack.channel_id,
            threadTs: state.projection_handles.slack_thread_ts,
            text: slackBoardLine(state),
          });
        }
        return "sent";
      }
      case "check": {
        // A check names one head; once the subject has moved on, no verdict is published
        // for a head nobody is at (§8.1 "at the current head").
        if (github === null || target.headSha !== state.subject.head_sha) return "obsolete";
        const render = checkRun(state);
        await github.createOrUpdateCheckRun({
          repositoryId: state.key.repository_id,
          headSha: target.headSha,
          existingId: state.projection_handles.check_run_ids[target.headSha] ?? null,
          ...render,
        });
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
      case "delivery": {
        const payload = deliveryPayload(row.payload);
        if (payload === null) throw new DispatchError(`delivery effect ${row.effect_id} carries no delivery payload`);
        const slack = this.slackPolicy(state);
        if (slack === null) {
          throw new DispatchError(`policy v${state.policy_version} for repository ${state.key.repository_id} names no Slack channel`);
        }
        // §D5 / R-3: the ledger owns attempts; an unroutable actor throws out of the port
        // and this row retries behind backoff, visibly.
        this.ports.slack.mintSystemWake({
          actor: payload.actor,
          channelId: slack.channel_id,
          threadTs: state.projection_handles.slack_thread_ts,
          text: payload.text,
          dedupeKey: payload.dedupe_key,
        });
        return "sent";
      }
      case "summon": {
        const payload = summonPayload(row.payload);
        if (payload === null) throw new DispatchError(`summon effect ${row.effect_id} carries no summon payload`);
        const github = this.ports.github;
        if (github === null) throw new DispatchError("summon dispatched without a GitHub port");
        await github.postComment({
          repositoryId: state.key.repository_id,
          prNumber: state.key.pr_number,
          body: payload.text,
        });
        return "sent";
      }
      case "announce": {
        const payload = announcePayload(row.payload);
        if (payload === null) throw new DispatchError(`announce effect ${row.effect_id} carries no announce payload`);
        const slack = this.slackPolicy(state);
        if (slack !== null) {
          this.ports.slack.postBoardLine({
            channelId: slack.channel_id,
            threadTs: state.projection_handles.slack_thread_ts,
            text: payload.text,
          });
        }
        return "sent";
      }
      case "check":
      case "board":
      case "thread":
        throw new DispatchError(`${target.kind} is not an actionable target`);
    }
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
