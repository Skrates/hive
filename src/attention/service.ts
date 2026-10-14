import type { BrokerStore } from "../broker/store.js";
import {
  ATTENTION_SCHEMA_VERSION,
  validateAttentionCommand,
  validateSourceBindCommand,
  type Capabilities,
  type EventView,
  type ItemState,
  type ItemView,
  type QueuePage,
  type Receipt,
  type ReturnGuard,
  type SourceView,
} from "./contract.js";
import { ATTENTION_EDGE_PROTOCOL } from "./route.js";
import {
  ATTENTION_STORE_VERSION,
  AttentionRefusal,
  type AttentionPrincipal,
  type AttentionStore,
  type CommandOutcome,
} from "./store.js";

/** Every action this broker accepts, for capability discovery. */
export const ATTENTION_ACTIONS = [
  "summon", "amend", "withdraw", "add", "start", "next", "resolve", "defer", "requeue", "cancel",
  "retry_return", "reroute_return", "source_bind", "source_revoke",
] as const;

/** An authenticated caller, as the HTTP adapter resolved it from credentials alone. */
export type AttentionCaller =
  | { kind: "operator" }
  /** `operator` is true only when this edge request also carried the operator credential. */
  | { kind: "edge"; edgeId: string; operator: boolean; sourceId: string | null };

const ITEM_STATES: readonly ItemState[] = ["queued", "active", "deferred", "resolved", "cancelled"];

/**
 * Caller resolution and command handling (ADR-0004 §7). The HTTP adapter authenticates; this
 * decides which principal acts and hands validated shapes to the store. No model, network
 * request or artifact fetch happens on this path (I12).
 */
export class AttentionService {
  constructor(
    readonly store: AttentionStore,
    private readonly broker: BrokerStore,
    /** Proves an operator-supplied thread exists before a returning source commits to it. */
    private readonly validateThread: (channelId: string, threadTs: string) => Promise<void>,
  ) {}

  capabilities(): Capabilities {
    return {
      schema_version: ATTENTION_SCHEMA_VERSION,
      broker_uuid: this.broker.brokerUuid,
      enabled: this.store.enabled,
      store_schema_version: ATTENTION_STORE_VERSION,
      human_id: this.store.humanId,
      actions: [...ATTENTION_ACTIONS],
      return_modes: ["pinned_session", "actor_context", "none"],
      edge_protocol: ATTENTION_EDGE_PROTOCOL,
      disabled_note: this.store.enabled
        ? null
        : "attention is disabled: no new mutations and no new return publication. Reads stay available, and "
          + "deliveries already minted keep their ordinary Hive lifecycle — disabling never cancels a running provider turn.",
    };
  }

  command(caller: AttentionCaller, body: unknown, expectedBrokerUuid: string | null): CommandOutcome {
    const validated = validateAttentionCommand(body);
    if (!validated.ok) throw new AttentionRefusal(422, validated.code, validated.detail);
    let principal: AttentionPrincipal;
    if (caller.kind === "operator") {
      principal = { kind: "operator" };
    } else {
      if (caller.sourceId === null) {
        throw new AttentionRefusal(403, "source_required", "a seat mutation presents its source binding; human acts use the operator credential directly");
      }
      // A handle minted against one broker never writes to another (A20).
      if (expectedBrokerUuid !== this.broker.brokerUuid) {
        throw new AttentionRefusal(409, "broker_mismatch", "this source handle was issued by a different broker; bind again against this one");
      }
      principal = { kind: "source", edgeId: caller.edgeId, sourceId: caller.sourceId };
    }
    return this.store.execute(principal, validated.value);
  }

  async bind(caller: AttentionCaller, body: unknown, options: { recoverOnly?: boolean } = {}): Promise<CommandOutcome> {
    if (caller.kind !== "edge") {
      throw new AttentionRefusal(403, "edge_required", "a source is enrolled through its own edge, which supplies the local evidence");
    }
    const validated = validateSourceBindCommand(body);
    if (!validated.ok) throw new AttentionRefusal(422, validated.code, validated.detail);
    const command = validated.value;
    const thread = command.payload.thread;
    // A replay is answered from the ledger without touching Slack; only a fresh enrollment
    // naming an explicit thread proves that thread first, outside any transaction.
    if (thread !== null && options.recoverOnly !== true && this.store.committedReceipt(command.command_id, { kind: "operator" }) === null) {
      try {
        await this.validateThread(thread.channel_id, thread.thread_ts);
      } catch (error) {
        if (slackSaidUnreadable(error)) {
          throw new AttentionRefusal(422, "invalid_thread", `${thread.channel_id}/${thread.thread_ts} is not a readable Slack thread`);
        }
        // Rate limits, transport failures and Slack's own outages say nothing about the
        // thread; nothing was written, so the same bind is simply retried.
        throw new AttentionRefusal(503, "slack_unavailable", "Slack could not be asked about the return thread; nothing was bound — retry the same bind");
      }
    }
    return this.store.bindSource({ edgeId: caller.edgeId, operator: caller.operator }, command, options);
  }

  /**
   * Queue, item and event reads are the shared private-workspace view, but a source's session,
   * cwd and originating delivery are its own edge's business: another edge sees them redacted.
   */
  private redact<T extends ItemView>(item: T, caller: AttentionCaller): T {
    if (caller.kind === "operator" || item.source === null || item.source.edge_id === caller.edgeId) return item;
    return { ...item, source: { ...item.source, session_id: null, session_absence: "redacted_for_other_edge", cwd: null, source_delivery_id: null } };
  }

  queue(humanId: string | null, state: string | null, after: string | null, limit: number | null, caller: AttentionCaller): QueuePage {
    let states: ItemState[] | undefined;
    if (state === "all") states = [...ITEM_STATES];
    else if (state !== null) {
      const named = state.split(",");
      if (!named.every((entry): entry is ItemState => (ITEM_STATES as readonly string[]).includes(entry))) {
        throw new AttentionRefusal(400, "invalid_state", `state must be one of ${ITEM_STATES.join(", ")} or all`);
      }
      states = named;
    }
    const page = this.store.queue(humanId ?? this.store.humanId, {
      ...(states ? { states } : {}),
      after,
      ...(limit !== null ? { limit } : {}),
    });
    return { ...page, items: page.items.map((item) => this.redact(item, caller)) };
  }

  item(itemId: number, caller: AttentionCaller): ItemView {
    const view = this.store.item(itemId);
    if (!view) throw new AttentionRefusal(404, "item_not_found", `no attention item ${itemId}`);
    return this.redact(view, caller);
  }

  events(itemId: number, caller: AttentionCaller): EventView[] {
    this.item(itemId, caller);
    return this.store.events(itemId);
  }

  receipt(commandId: string, caller: AttentionCaller): Receipt {
    const receipt = this.store.committedReceipt(commandId, caller.kind === "operator" ? caller : { kind: "edge", edgeId: caller.edgeId });
    // An unknown id and one issued elsewhere look the same: not this caller's to read.
    if (!receipt) throw new AttentionRefusal(404, "command_not_found", `no committed attention command ${commandId} for this caller`);
    return receipt;
  }

  /**
   * The operator reads any source; an edge reads only the sources it issued, as `sources()` is
   * operator-only — a source's session and cwd are its edge's business. Another edge's source
   * answers exactly as an unknown one does.
   */
  source(sourceId: string, caller: AttentionCaller): SourceView {
    const view = this.store.source(sourceId);
    if (!view || (caller.kind === "edge" && view.edge_id !== caller.edgeId)) {
      throw new AttentionRefusal(404, "source_not_found", `no attention source ${sourceId} for this caller`);
    }
    return view;
  }

  sources(): SourceView[] {
    return this.store.sources();
  }

  returnGuard(caller: AttentionCaller, resolutionCommandId: string, generation: number, deliveryId: number, leaseGeneration: number): ReturnGuard {
    if (caller.kind !== "edge") throw new AttentionRefusal(403, "edge_required", "the return guard validates an edge's own claimed delivery");
    return this.store.returnGuard(caller.edgeId, resolutionCommandId, generation, deliveryId, leaseGeneration);
  }
}

/** Slack platform errors that are its own transient trouble, not a verdict on the thread. */
const TRANSIENT_SLACK_PLATFORM_ERRORS = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout", "ratelimited"]);

/** Only Slack's definitive platform answer (thread_not_found, channel_not_found, …) refuses the thread. */
export function slackSaidUnreadable(error: unknown): boolean {
  const failure = error as { code?: unknown; data?: { error?: unknown } } | null;
  return failure?.code === "slack_webapi_platform_error"
    && typeof failure.data?.error === "string"
    && !TRANSIENT_SLACK_PLATFORM_ERRORS.has(failure.data.error);
}
