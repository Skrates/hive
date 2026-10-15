import { createHash, randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import type { AttentionCommand, ItemView, QueuePage, Receipt, ResolutionOutcome } from "./contract.js";
import { ago, artifactLine, inert, itemLabel, returnDescription } from "./render.js";
import type { AttentionService } from "./service.js";
import { AttentionRefusal, type AttentionStore } from "./store.js";

/**
 * The Slack front end (ADR-0004 Amendment 1). Slack is a projection and a remote control over the
 * same broker commands the CLI sends — never a second record:
 *
 * - one DM card per open item, posted once (Slack's own pop-up is the single notification, S-1)
 *   and updated in place on every later change;
 * - the app's Home tab shows the queue;
 * - a modal makes the decision; "Take next" is the primary path, "Answer this one" the rare,
 *   recorded override (S-3);
 * - only the configured human's Slack user acts, and only as the operator for next, resolve,
 *   defer and cancel (S-4).
 *
 * Every seat-written string is rendered as `plain_text` (S-6): Slack never interprets it.
 */

type Block = Record<string, unknown>;
export interface SlackView {
  type: "home" | "modal";
  [key: string]: unknown;
}

/** The narrow Slack surface this module uses; the broker binds it to the bot's WebClient. */
export interface AttentionSlackApi {
  openDm(userId: string): Promise<string>;
  post(channel: string, text: string, blocks: Block[]): Promise<string>;
  update(channel: string, ts: string, text: string, blocks: Block[]): Promise<void>;
  publishHome(userId: string, view: SlackView): Promise<void>;
  openModal(triggerId: string, view: SlackView): Promise<void>;
}

export function webClientSlackApi(web: WebClient): AttentionSlackApi {
  return {
    async openDm(userId) {
      const result = await web.conversations.open({ users: userId });
      const id = result.channel?.id;
      if (!id) throw new Error("Slack conversations.open returned no channel");
      return id;
    },
    async post(channel, text, blocks) {
      const result = await web.chat.postMessage({
        channel, text, blocks, unfurl_links: false, unfurl_media: false,
        // hive_* metadata: the ingress never treats a Hive post as a wake (ADR-0003).
        metadata: { event_type: "hive_attention_card", event_payload: {} },
      } as Parameters<WebClient["chat"]["postMessage"]>[0]);
      if (!result.ts) throw new Error("Slack chat.postMessage returned no ts");
      return result.ts;
    },
    async update(channel, ts, text, blocks) {
      await web.chat.update({ channel, ts, text, blocks } as Parameters<WebClient["chat"]["update"]>[0]);
    },
    async publishHome(userId, view) {
      await web.views.publish({ user_id: userId, view } as unknown as Parameters<WebClient["views"]["publish"]>[0]);
    },
    async openModal(triggerId, view) {
      await web.views.open({ trigger_id: triggerId, view } as unknown as Parameters<WebClient["views"]["open"]>[0]);
    },
  };
}

// ───────────────────────────── rendering (pure) ─────────────────────────────

const ELLIPSIS = " …[shortened]";

/** Seat text as Slack plain_text: control characters made inert, length-bounded with a marker. */
export function plain(text: string, max = 3000): { type: "plain_text"; text: string; emoji: false } {
  const inertText = inert(text);
  const bounded = inertText.length > max ? `${inertText.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}` : inertText;
  return { type: "plain_text", text: bounded.length === 0 ? " " : bounded, emoji: false };
}

/** Hive's own fixed labels; never carries seat text. */
function label(text: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text };
}

const OPEN_STATES = new Set<ItemView["state"]>(["queued", "active", "deferred"]);
const OUTCOMES: readonly ResolutionOutcome[] = ["approved", "changes_requested", "answered", "selected", "delegated", "completed"];

/** The notification text (what the pop-up shows): the item and its title, nothing else. */
export function cardText(item: ItemView): string {
  return plain(`${itemLabel(item.item_id)} · ${item.packet.title}`, 150).text;
}

function statusLine(item: ItemView): string {
  if (item.state === "resolved") {
    const phase = item.return === null ? "no return" : `return ${item.return.phase}`;
    return `✅ resolved (${item.outcome ?? "?"}) — ${phase}`;
  }
  if (item.state === "cancelled") return "✖️ cancelled";
  if (item.state === "deferred") return item.deferred_until === null ? "⏸ deferred (held)" : `⏸ deferred until ${item.deferred_until}`;
  if (item.state === "active") return "▶️ active — you are on this one";
  return "🕓 queued";
}

/** The DM card for one item (S-1, S-2). Buttons only while the item is open. */
export function cardBlocks(item: ItemView, now: Date): Block[] {
  const packet = item.packet;
  const blocks: Block[] = [
    { type: "header", text: plain(`${itemLabel(item.item_id)} · ${packet.title}`, 150) },
    { type: "context", elements: [plain(`${packet.kind} · ${packet.project_id} / ${packet.work_id} · revision ${item.revision}`, 2000)] },
    { type: "section", text: label("*Do*") },
    { type: "section", text: plain(packet.requested_action) },
    { type: "section", text: label("*Context*") },
    { type: "section", text: plain(packet.context) },
  ];
  if (packet.artifacts.length > 0) {
    blocks.push({ type: "section", text: label("*Open*") });
    blocks.push({ type: "section", text: plain(packet.artifacts.map((artifact) => `• ${artifactLine(artifact)}`).join("\n")) });
  }
  const estimate = packet.estimate_minutes === null ? "" : ` · about ${packet.estimate_minutes} min of your time`;
  if (packet.deadline_at !== null) blocks.push({ type: "context", elements: [label(`⏰ *Deadline* ${packet.deadline_at} (display only)`)] });
  blocks.push({ type: "section", text: label(`*Unblocks*${estimate}`) });
  blocks.push({ type: "section", text: plain(packet.unblocks) });
  blocks.push({
    type: "context",
    elements: [plain(`Return: ${returnDescription(item.source, item.return_mode)} · summoned ${ago(item.created_at, now)}`, 2000)],
  });
  blocks.push({ type: "context", elements: [label(statusLine(item))] });
  if (OPEN_STATES.has(item.state)) {
    const buttons: Block[] = [
      { type: "button", style: "primary", action_id: "atn_take_next", text: { type: "plain_text", text: "Take next" }, value: "next" },
    ];
    if (item.state === "queued") {
      buttons.push({ type: "button", action_id: "atn_answer_this", text: { type: "plain_text", text: "Answer this one" }, value: String(item.item_id) });
    }
    if (item.state === "active") {
      buttons.push({ type: "button", action_id: "atn_decide", text: { type: "plain_text", text: "Decide" }, value: String(item.item_id) });
    }
    blocks.push({ type: "actions", block_id: `atn_card_${item.item_id}`, elements: buttons });
  }
  return blocks;
}

const HOME_LIST_LIMIT = 15;

/** The Home tab: the queue as FIFO sees it (S-2). */
export function homeView(page: QueuePage, now: Date): SlackView {
  const status = page.status;
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: "Attention queue" } },
    {
      type: "context",
      elements: [label(`${status.eligible_count} eligible · ${status.deferred_count} deferred · returns: `
        + `${status.returns_pending} pending, ${status.returns_minted} in flight, ${status.returns_blocked} blocked, ${status.returns_failed} failed`
        + ` · as of ${page.as_of}`)],
    },
    { type: "actions", elements: [{ type: "button", style: "primary", action_id: "atn_take_next", text: { type: "plain_text", text: "Take next" }, value: "next" }] },
    { type: "divider" },
  ];
  const active = page.items.find((item) => item.state === "active");
  if (active) {
    blocks.push({ type: "section", text: label("*Active*") });
    blocks.push({
      type: "section",
      text: plain(`${itemLabel(active.item_id)} · ${active.packet.project_id} · ${active.packet.title}`),
      accessory: { type: "button", action_id: "atn_decide", text: { type: "plain_text", text: "Decide" }, value: String(active.item_id) },
    });
  }
  // A deferral whose time has come is eligible (the next `next` promotes it), so it is listed
  // with what Take next would select, not among the deferred.
  const due = (item: ItemView): boolean => item.state === "deferred" && item.deferred_until !== null && item.deferred_until <= now.toISOString();
  const queued = page.items.filter((item) => item.state === "queued" || due(item));
  blocks.push({ type: "section", text: label(queued.length === 0 ? "*Next up* — nothing waiting" : "*Next up* (FIFO)") });
  for (const item of queued.slice(0, HOME_LIST_LIMIT)) {
    blocks.push({
      type: "section",
      text: plain(`${itemLabel(item.item_id)} · ${item.packet.project_id} · ${item.packet.title} (${item.packet.kind}, ${ago(item.created_at, now)})`),
      accessory: { type: "button", action_id: "atn_answer_this", text: { type: "plain_text", text: "Answer this one" }, value: String(item.item_id) },
    });
  }
  if (queued.length > HOME_LIST_LIMIT) blocks.push({ type: "context", elements: [label(`… and ${queued.length - HOME_LIST_LIMIT} more`)] });
  const deferred = page.items.filter((item) => item.state === "deferred" && !due(item));
  if (deferred.length > 0) {
    blocks.push({ type: "section", text: label("*Deferred*") });
    for (const item of deferred.slice(0, HOME_LIST_LIMIT)) {
      blocks.push({ type: "section", text: plain(`${itemLabel(item.item_id)} · ${item.packet.title} — ${item.deferred_until === null ? "held" : `until ${item.deferred_until}`}`) });
    }
  }
  if (status.route_warnings.length > 0) {
    blocks.push({ type: "section", text: label("*Returns needing you* — `hive attention show <id>`") });
    for (const warning of status.route_warnings.slice(0, HOME_LIST_LIMIT)) {
      blocks.push({ type: "section", text: plain(`⚠ ${itemLabel(warning.item_id)} generation ${warning.generation} ${warning.phase}: ${warning.reason}`) });
    }
  }
  return { type: "home", blocks };
}

interface ModalMetadata { item_id: number; revision: number; command_id: string }

/** The decision modal (S-2): one command id minted per opening, the rendered revision fenced (S-5). */
export function decisionModal(item: ItemView, commandId: string = randomUUID(), notice: string | null = null): SlackView {
  const metadata: ModalMetadata = { item_id: item.item_id, revision: item.revision, command_id: commandId };
  const packet = item.packet;
  const blocks: Block[] = [];
  if (notice !== null) blocks.push({ type: "context", elements: [label(notice)] });
  blocks.push(
    { type: "section", text: plain(`${packet.title}\n\nDo: ${packet.requested_action}\n\nContext: ${packet.context}\n\nUnblocks: ${packet.unblocks}`
      + (packet.deadline_at === null ? "" : `\n\nDeadline: ${packet.deadline_at} (display only)`)) },
    { type: "context", elements: [plain(`${packet.kind} · ${packet.project_id} / ${packet.work_id} · revision ${item.revision} · return: ${returnDescription(item.source, item.return_mode)}`, 2000)] },
    {
      type: "input", block_id: "decision", label: { type: "plain_text", text: "Decision" },
      element: {
        type: "radio_buttons", action_id: "value",
        initial_option: { text: { type: "plain_text", text: "Resolve" }, value: "resolve" },
        options: [
          { text: { type: "plain_text", text: "Resolve" }, value: "resolve" },
          { text: { type: "plain_text", text: "Defer" }, value: "defer" },
          { text: { type: "plain_text", text: "Cancel" }, value: "cancel" },
        ],
      },
    },
    {
      type: "input", block_id: "outcome", optional: true, label: { type: "plain_text", text: "Outcome (resolve)" },
      element: {
        type: "static_select", action_id: "value", placeholder: { type: "plain_text", text: "Choose an outcome" },
        options: OUTCOMES.map((outcome) => ({ text: { type: "plain_text", text: outcome.replace("_", " ") }, value: outcome })),
      },
    },
    {
      type: "input", block_id: "response", optional: true, label: { type: "plain_text", text: "Response (resolve) — sent verbatim to the seat" },
      element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 2900 },
    },
    {
      type: "input", block_id: "until", optional: true, label: { type: "plain_text", text: "Defer until (empty = hold indefinitely)" },
      element: { type: "datetimepicker", action_id: "value" },
    },
    {
      type: "input", block_id: "reason", optional: true, label: { type: "plain_text", text: "Reason (defer or cancel)" },
      element: { type: "plain_text_input", action_id: "value", max_length: 1000 },
    },
    {
      type: "input", block_id: "next", optional: true, label: { type: "plain_text", text: "Then" },
      element: {
        type: "checkboxes", action_id: "value",
        initial_options: [{ text: { type: "plain_text", text: "Take next" }, value: "next" }],
        options: [{ text: { type: "plain_text", text: "Take next" }, value: "next" }],
      },
    },
  );
  return {
    type: "modal",
    callback_id: "atn_decision",
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: itemLabel(item.item_id).slice(0, 24) },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Close" },
    blocks,
  };
}

// ───────────────────────────── the front end ─────────────────────────────

/** What the Socket Mode handler acknowledges with, and the work to do right after the ack. */
export interface InteractionResult {
  ack?: Record<string, unknown>;
  after?: () => Promise<void>;
}

export const SLACK_CARD_BATCH = 25;

export class AttentionSlackFrontEnd {
  private running: Promise<number> | null = null;
  private dmChannel: string | null = null;
  private since: string | null = null;
  /** A Home publication that failed is retried on the next pass even if no card changed. */
  private homeDirty = false;

  constructor(
    private readonly store: AttentionStore,
    private readonly service: AttentionService,
    private readonly api: AttentionSlackApi,
    private readonly humanSlackUserId: string,
    private readonly clock: { now(): Date },
    private readonly log: (line: string) => void = () => {},
  ) {}

  /**
   * One housekeeping pass (S-7): post a card for each open item that has none, update every card
   * whose item changed, then refresh the Home tab if anything moved. Single-flight; a Slack failure
   * leaves the card due for the next pass and never touches a command.
   */
  drainOnce(): Promise<number> {
    if (this.running) return this.running;
    const active = this.drain();
    this.running = active;
    const clear = (): void => { if (this.running === active) this.running = null; };
    active.then(clear, clear);
    return active;
  }

  private async drain(): Promise<number> {
    let changed = 0;
    this.since ??= this.store.slackCardsSince(this.clock.now().toISOString());
    for (const { item, card } of this.store.cardsDue(this.humanSlackUserId, this.since, SLACK_CARD_BATCH)) {
      try {
        const now = this.clock.now();
        if (card === null) {
          const channel = await this.dm();
          const ts = await this.api.post(channel, cardText(item), cardBlocks(item, now));
          this.store.recordCard(item.item_id, this.humanSlackUserId, channel, ts, item);
        } else {
          await this.api.update(card.channelId, card.messageTs, cardText(item), cardBlocks(item, now));
          this.store.recordCard(item.item_id, this.humanSlackUserId, card.channelId, card.messageTs, item);
        }
        changed += 1;
      } catch (error) {
        // Ids and the error class only — never packet text.
        this.log(`[attention-slack] card for ${itemLabel(item.item_id)} not synced: ${errorName(error)}`);
      }
    }
    if (changed > 0 || this.homeDirty) await this.refreshHome();
    return changed;
  }

  private async dm(): Promise<string> {
    this.dmChannel ??= await this.api.openDm(this.humanSlackUserId);
    return this.dmChannel;
  }

  async refreshHome(): Promise<void> {
    try {
      const page = this.store.queue(this.store.humanId, { states: ["active", "queued", "deferred"], limit: 100 });
      await this.api.publishHome(this.humanSlackUserId, homeView(page, this.clock.now()));
      this.homeDirty = false;
    } catch (error) {
      this.homeDirty = true;
      this.log(`[attention-slack] home tab not published: ${errorName(error)}`);
    }
  }

  /** `app_home_opened`: publish the current queue for the human; anyone else sees nothing. */
  async homeOpened(event: { user?: unknown; tab?: unknown }): Promise<void> {
    if (event.user !== this.humanSlackUserId || (event.tab !== undefined && event.tab !== "home")) return;
    await this.refreshHome();
  }

  /** An `interactive` Socket Mode payload: block actions on a card or the Home tab, or the modal. */
  async interactive(payload: Record<string, unknown>): Promise<InteractionResult> {
    const user = (payload.user as { id?: unknown } | undefined)?.id;
    if (user !== this.humanSlackUserId) {
      // S-4: not the human — refused before any command is built.
      this.log(`[attention-slack] interaction from ${typeof user === "string" ? user : "unknown"} refused: not the queue's human`);
      return {};
    }
    if (payload.type === "block_actions") return this.blockAction(payload);
    if (payload.type === "view_submission") return this.viewSubmission(payload);
    return {};
  }

  private blockAction(payload: Record<string, unknown>): InteractionResult {
    const action = (payload.actions as Array<{ action_id?: unknown; value?: unknown; action_ts?: unknown }> | undefined)?.[0];
    const triggerId = typeof payload.trigger_id === "string" ? payload.trigger_id : null;
    if (!action || triggerId === null) return {};
    const actionId = String(action.action_id ?? "");
    const pickedId = Number(action.value);
    // A Socket Mode redelivery carries the same action_ts: the same command id, so it replays.
    const commandId = derivedCommandId(`${String(payload.user && (payload.user as { id: string }).id)}:${actionId}:${String(action.action_ts)}`);
    return {
      after: async () => {
        try {
          let item: ItemView | null = null;
          let notice: string | null = null;
          if (actionId === "atn_take_next" || actionId === "atn_answer_this") {
            const pick = actionId === "atn_answer_this" && Number.isSafeInteger(pickedId) ? pickedId : null;
            const receipt = this.run({ schema_version: 1, command_id: commandId, action: "next", payload: { human_id: this.store.humanId, item_id: pick } });
            const selection = receipt.selection;
            item = selection?.item ?? null;
            if (selection?.selection_reason === "already_active" && pick !== null && item?.item_id !== pick) {
              notice = "_You already have an active item — finish, defer or cancel it first._";
            }
            if (item === null) {
              await this.refreshHome();
              return;
            }
          } else if (actionId === "atn_decide" && Number.isSafeInteger(pickedId)) {
            item = this.store.item(pickedId);
            if (item === null || item.state !== "active") {
              await this.refreshHome();
              return;
            }
          } else {
            return;
          }
          await this.api.openModal(triggerId, decisionModal(item, randomUUID(), notice));
          await this.drainOnce();
        } catch (error) {
          this.log(`[attention-slack] ${actionId} failed: ${errorName(error)}`);
        }
      },
    };
  }

  private viewSubmission(payload: Record<string, unknown>): InteractionResult {
    const view = payload.view as { callback_id?: unknown; private_metadata?: unknown; state?: { values?: Record<string, Record<string, Record<string, unknown>>> } } | undefined;
    if (!view || view.callback_id !== "atn_decision") return {};
    let metadata: ModalMetadata;
    try {
      metadata = JSON.parse(String(view.private_metadata)) as ModalMetadata;
    } catch {
      return { ack: { response_action: "errors", errors: { decision: "This form lost its context; close it and open the item again." } } };
    }
    const values = view.state?.values ?? {};
    const field = (block: string): Record<string, unknown> | undefined => values[block]?.value;
    const decision = (field("decision")?.selected_option as { value?: string } | undefined)?.value ?? "resolve";
    const outcome = (field("outcome")?.selected_option as { value?: string } | undefined)?.value;
    // Verbatim (S-2): the seat receives exactly what was typed; trimming only decides emptiness.
    const response = typeof field("response")?.value === "string" ? String(field("response")!.value) : "";
    const reason = typeof field("reason")?.value === "string" ? String(field("reason")!.value).trim() : "";
    const until = typeof field("until")?.selected_date_time === "number" ? new Date(Number(field("until")!.selected_date_time) * 1000).toISOString() : null;
    const selectNext = ((field("next")?.selected_options as unknown[] | undefined) ?? []).length > 0;
    const base = { item_id: metadata.item_id, expected_revision: metadata.revision, select_next: selectNext };

    let command: AttentionCommand;
    if (decision === "resolve") {
      const errors: Record<string, string> = {};
      if (!outcome) errors.outcome = "Choose an outcome.";
      if (response.trim().length === 0) errors.response = "Write the response the seat will receive.";
      if (Object.keys(errors).length > 0) return { ack: { response_action: "errors", errors } };
      command = { schema_version: 1, command_id: metadata.command_id, action: "resolve", payload: { ...base, outcome: outcome as ResolutionOutcome, response } };
    } else if (decision === "defer" || decision === "cancel") {
      if (reason.length === 0) return { ack: { response_action: "errors", errors: { reason: `Give a reason to ${decision}.` } } };
      command = decision === "defer"
        ? { schema_version: 1, command_id: metadata.command_id, action: "defer", payload: { ...base, reason, until } }
        : { schema_version: 1, command_id: metadata.command_id, action: "cancel", payload: { ...base, reason } };
    } else {
      return { ack: { response_action: "errors", errors: { decision: "Choose resolve, defer or cancel." } } };
    }

    let receipt: Receipt;
    try {
      receipt = this.run(command);
    } catch (error) {
      if (error instanceof AttentionRefusal) {
        if (["revision_conflict", "item_not_active", "item_terminal", "item_not_found"].includes(error.code)) {
          const current = this.store.item(metadata.item_id);
          if (current !== null && current.state === "active") {
            // S-5: never applied to an outdated packet — show the current one instead.
            return { ack: { response_action: "update", view: decisionModal(current, randomUUID(), `_This item changed (now revision ${current.revision}). Review it and decide again._`) } };
          }
          return { ack: { response_action: "errors", errors: { decision: `This item is no longer active (${error.code}). Close this and check the queue.` } } };
        }
        return { ack: { response_action: "errors", errors: { decision: `${error.code}: ${error.message}`.slice(0, 300) } } };
      }
      this.log(`[attention-slack] decision on ${itemLabel(metadata.item_id)} failed: ${errorName(error)}`);
      return { ack: { response_action: "errors", errors: { decision: "The broker could not record this; try again." } } };
    }
    const nextItem = receipt.selection?.item ?? null;
    const after = async (): Promise<void> => { await this.drainOnce(); };
    if (selectNext && nextItem !== null && nextItem.state === "active") {
      // "Take next" chosen: the modal turns into the next item's, in place.
      return { ack: { response_action: "update", view: decisionModal(nextItem) }, after };
    }
    return { ack: { response_action: "clear" }, after };
  }

  private run(command: AttentionCommand): Receipt {
    return this.service.command({ kind: "operator" }, command, null).receipt;
  }
}

/** A stable UUID-shaped command id from a Slack interaction identity (S-5). */
export function derivedCommandId(identity: string): string {
  const hex = createHash("sha256").update(`hive-attention-slack/v1\0${identity}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown; data?: { error?: unknown } }).data?.error ?? (error as { code?: unknown }).code;
    const name = error instanceof Error ? error.name : "Error";
    return typeof code === "string" ? `${name} (${code})` : name;
  }
  return "Error";
}
