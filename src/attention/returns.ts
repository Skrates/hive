import { SeatWakeRefusedError, type BrokerStore } from "../broker/store.js";
import type { Clock } from "../time.js";
import type { AttentionContinuationTarget, ItemView, SourceView } from "./contract.js";
import { artifactLine, itemLabel, slackInert } from "./render.js";
import { effectiveDeliveryRoute } from "./route.js";
import { ATTENTION_RETURN_BATCH, type AttentionStore, type ReturnRow } from "./store.js";

/** A source without a usable subscription is looked at again after this long — never a tight loop. */
export const RETURN_BLOCKED_RETRY_MS = 60_000;
/** The inline continuation envelope bound; the full packet is one edge read away. */
export const MAX_CONTINUATION_CHARS = 8_000;

export interface ReturnDrainResult {
  minted: number;
  blocked: number;
  failed: number;
  settled: number;
}

/**
 * Turns persisted return intents into ordinary Hive deliveries (ADR-0004 §10).
 *
 * Two bounded passes per drain: due unminted returns, then minted returns whose core delivery
 * is terminal or gone. Minting and the `minted` phase commit in one synchronous transaction on
 * the broker's own handle, with no network request inside it; the ordinary outbox and delivery
 * lifecycle carry the transport afterwards. Once minted, core Hive owns retries, backoff,
 * attempt limits and TTL — this never mints a replacement behind a delivery to evade them.
 */
export class AttentionReturnPublisher {
  private running: Promise<ReturnDrainResult> | null = null;

  constructor(
    private readonly store: AttentionStore,
    private readonly broker: BrokerStore,
    private readonly clock: Clock,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Single-flight, like every other housekeeping job. */
  drainOnce(): Promise<ReturnDrainResult> {
    if (this.running) return this.running;
    const active = Promise.resolve().then(() => this.drain());
    this.running = active;
    const clear = (): void => { if (this.running === active) this.running = null; };
    active.then(clear, clear);
    return active;
  }

  private drain(): ReturnDrainResult {
    const result: ReturnDrainResult = { minted: 0, blocked: 0, failed: 0, settled: 0 };
    // Disabled pauses unminted publication; minted deliveries keep their ordinary lifecycle,
    // and their terminal outcomes are still recorded so history stays truthful.
    if (this.store.enabled) {
      for (const row of this.store.dueReturns(ATTENTION_RETURN_BATCH)) {
        try {
          const outcome = this.store.db.transaction(() => this.publish(row.return_id)).immediate();
          if (outcome !== null) result[outcome] += 1;
        } catch (error) {
          // Never the response body: ids and the error only.
          this.log(`[attention] return ${row.return_id} (item ${row.item_id}, generation ${row.generation}) publication failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const row of this.store.settleableReturns(ATTENTION_RETURN_BATCH)) {
      try {
        if (this.store.db.transaction(() => this.store.settleIfTerminal(this.store.returnRow(row.return_id)!, this.clock.now())).immediate()) {
          result.settled += 1;
        }
      } catch (error) {
        this.log(`[attention] return ${row.return_id} settlement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  private publish(returnId: number): "minted" | "blocked" | "failed" | null {
    const row = this.store.returnRow(returnId);
    if (!row || (row.phase !== "pending" && row.phase !== "blocked")) return null;
    const item = this.store.item(row.item_id)!;
    const source = this.store.source(row.source_id)!;
    const target = JSON.parse(row.target_json) as AttentionContinuationTarget;
    const subscription = this.broker.getSubscription(source.actor);
    const retryAt = new Date(this.clock.now().getTime() + RETURN_BLOCKED_RETRY_MS).toISOString();
    if (!subscription || (subscription.expiresAt !== null && new Date(subscription.expiresAt).getTime() <= this.clock.now().getTime())) {
      this.store.markReturnBlocked(row.return_id, `actor_unroutable: ${source.actor} has no live subscription`, retryAt);
      return "blocked";
    }
    const route = effectiveDeliveryRoute(subscription, target);
    if (route.kind === "refused") {
      // Permanent drift waits for the operator: a pinned return is never downgraded to
      // actor_context on its own (I09).
      this.store.markReturnFailed(row.return_id, `${route.code}: ${route.detail}`);
      return "failed";
    }
    if (source.thread === null) {
      this.store.markReturnFailed(row.return_id, "return_thread_missing: the source has no Slack thread to return through");
      return "failed";
    }
    try {
      const { deliveryId } = this.broker.mintSystemWake({
        origin: "attention",
        actor: source.actor,
        channelId: source.thread.channel_id,
        threadTs: source.thread.thread_ts,
        text: continuationText(this.store.brokerUuid, item, source, row),
        render: commonsRender(item, row),
        dedupeKey: `${row.resolution_command_id}:${row.generation}`,
        continuationTarget: target,
      });
      this.store.markReturnMinted(row.return_id, deliveryId);
      return "minted";
    } catch (error) {
      if (!(error instanceof SeatWakeRefusedError)) throw error;
      if (error.code === "unroutable_actor") {
        this.store.markReturnBlocked(row.return_id, `actor_unroutable: ${error.message}`, retryAt);
        return "blocked";
      }
      this.store.markReturnFailed(row.return_id, `${error.code}: ${error.message}`);
      return "failed";
    }
  }
}

/**
 * The continuation the originating seat receives. Everything needed to act is inline; the
 * complete packet is one `hive attention show` away. The human response and artifact
 * identities are never truncated: when the artifact list would not fit, it is replaced by a
 * pointer, not shortened.
 */
export function continuationText(brokerUuid: string, item: ItemView, source: SourceView, row: Pick<ReturnRow, "resolution_command_id" | "generation" | "mode">): string {
  const packet = item.packet;
  const route = row.mode === "pinned_session"
    ? `Route: pinned_session — this is the session that summoned it (${source.session_id ?? "?"}, cwd ${source.cwd ?? "?"}).`
    : "Route: actor_context — context restored. This is NOT the original provider session or checkout: "
      + "restore the work context from the saved packet and its artifacts before acting, in the repository this work belongs to.";
  const head = [
    `Attention return ${itemLabel(item.item_id)} (broker ${brokerUuid}; resolution ${row.resolution_command_id}, generation ${row.generation}).`,
    `Work: project ${packet.project_id} · work ${packet.work_id} · intervention ${packet.intervention_key} (${packet.kind}): ${packet.title}`,
    route,
    `Human outcome: ${item.outcome ?? "?"}`,
    "Human response (verbatim):",
    "<<<",
    item.response ?? "",
    ">>>",
  ];
  const tail = [
    `Full packet: hive attention show ${item.item_id} --json`,
    "Apply this decision within your existing permissions, then report through normal Hive completion. "
      + "A redelivery carries the same resolution and generation. Another human decision needs a new intervention key.",
  ];
  const artifacts = packet.artifacts.length === 0
    ? []
    : ["Artifacts:", ...packet.artifacts.map((artifact) => `  - ${artifactLine(artifact)}`)];
  const full = [...head, ...artifacts, ...tail].join("\n");
  if (full.length <= MAX_CONTINUATION_CHARS) return full;
  return [...head, `Artifacts: ${packet.artifacts.length} — listed in full by \`hive attention show ${item.item_id} --json\`.`, ...tail].join("\n");
}

/** The commons line: who is being returned to, and for what — never the response body. */
export function commonsRender(item: ItemView, row: Pick<ReturnRow, "generation" | "mode">): string {
  return `${itemLabel(item.item_id)} resolved (${item.outcome ?? "?"}) — ${slackInert(item.packet.project_id)} / ${slackInert(item.packet.title)}; `
    + `return generation ${row.generation}, ${row.mode === "pinned_session" ? "saved session" : "context restored"}.`;
}
