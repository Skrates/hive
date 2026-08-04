import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { isAdmitted, parseAddressedWake, type AdmissionPolicy } from "../addressing.js";
import type { ReplaySnapshot, SlackEventInput } from "../domain.js";
import type { BrokerService, SlackTransport } from "./service.js";

interface SlackMessageEvent {
  type: "message";
  channel: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  app_id?: string;
  bot_id?: string;
  subtype?: string;
  metadata?: { event_type?: string };
}

interface SlackEnvelopeBody {
  event_id?: unknown;
  event?: unknown;
  [key: string]: unknown;
}

interface SlackEventIngester {
  ingest(event: SlackEventInput, initialSnapshot?: unknown | null): unknown;
  /** Actors already bound to (channelId, threadTs) — the thread-affinity target set. */
  boundActors(channelId: string, threadTs: string): string[];
}

/**
 * ADR-0003 R-1: a message from outside the closed trust set is dropped and the
 * drop is visible in its thread. The notice is durably enqueued through the
 * broker outbox rather than posted inline, so a Slack hiccup cannot lose it.
 */
export interface DropNotifier {
  noticeDroppedSender(channelId: string, threadTs: string, senderId: string): void;
}

export const MISSING_SLACK_EVENT_ID_DIAGNOSTIC =
  "hive Slack event refused: missing event_id";
const UNACKNOWLEDGED_SLACK_ENVELOPE_DIAGNOSTIC =
  "hive Slack envelope was not acknowledged";

export interface SlackEnvelopeHandlerInput {
  body: SlackEnvelopeBody;
  ack(): Promise<void>;
}

export interface SlackEnvelopeHandlerContext {
  workspaceId: string;
  policy: AdmissionPolicy;
  broker: SlackEventIngester;
  dropNotifier?: DropNotifier;
  now?: () => Date;
  logDiagnostic?: (message: string) => void;
}

/**
 * Admit and durably ingest one Events API envelope before acknowledging it to Slack.
 *
 * BrokerService.ingest commits its SQLite transaction synchronously. Therefore reaching ack means
 * either the event and its delivery are durable, or this event_id was already durably ingested by
 * an earlier delivery attempt. An acknowledgement failure is safe: Slack can redeliver the same
 * event_id in a fresh Socket Mode envelope and the store deduplicates it.
 */
export async function handleSlackEnvelope(
  { body, ack }: SlackEnvelopeHandlerInput,
  {
    workspaceId,
    policy,
    broker,
    dropNotifier,
    now = () => new Date(),
    logDiagnostic = (message) => console.error(message),
  }: SlackEnvelopeHandlerContext,
): Promise<void> {
  const eventId = typeof body.event_id === "string" && body.event_id.length > 0
    ? body.event_id
    : null;
  if (!eventId) {
    // Never derive a durable identity from envelope_id: it identifies one Socket Mode delivery
    // attempt, not the underlying Slack event. A fixed diagnostic keeps hostile body data out of
    // logs, and ACK prevents an identity-less envelope from retrying forever.
    logDiagnostic(MISSING_SLACK_EVENT_ID_DIAGNOSTIC);
    await ack();
    return;
  }

  const event = asSlackMessageEvent(body.event);
  if (!event?.text) {
    await ack();
    return;
  }
  // Hive's own outbox posts (receipts, outcomes, notices) carry hive_* message
  // metadata. They are never re-ingested as wakes: an agent outcome that quotes
  // a `WAKE:` line must not recursively mint a fresh trusted delivery.
  if (event.metadata?.event_type?.startsWith("hive_")) {
    await ack();
    return;
  }
  // An explicit WAKE:/NEXT envelope names its recipient and always takes
  // precedence. Without one, thread affinity may still route the message to the
  // actors already bound to its thread — but only after the same admission
  // checks. Parsing is not routing; admission decides first.
  const addressed = parseAddressedWake(event.text);
  const senderKind = event.user ? "user" : "app";
  const senderId = event.user ?? event.app_id ?? event.bot_id;
  const threadTs = event.thread_ts ?? event.ts;

  // Surface occupancy first: a message in a workspace or channel Hive does not
  // occupy is silently ignored — posting notices into foreign channels is not
  // Hive's place.
  if (!policy.workspaceIds.has(workspaceId) || !policy.channelIds.has(event.channel)) {
    await ack();
    return;
  }
  // Admission is never weakened by affinity. A message from a principal outside
  // the closed trust set is dropped. An addressed drop is thread-visible
  // (ADR-0003 R-1): delivered-but-silently-swallowed would be indistinguishable
  // from delivered-and-ignored. An envelope-less drop stays silent — it matches
  // today's "no envelope → ignored" behavior and keeps stray channel chatter
  // from spamming trust-set notices.
  if (!senderId || !isAdmitted(policy, {
    workspaceId,
    channelId: event.channel,
    senderId,
    senderKind,
  })) {
    if (addressed && senderId && dropNotifier) {
      dropNotifier.noticeDroppedSender(event.channel, threadTs, senderId);
    }
    await ack();
    return;
  }

  // Admitted. An explicit envelope targets its named actor and binds that actor
  // to the thread going forward. Otherwise thread affinity routes to every actor
  // already bound to this thread (derived from the persisted store, so it
  // survives a broker restart). A thread with no binding and no envelope is
  // ignored exactly as before.
  const targets = addressed
    ? [addressed.actor]
    : broker.boundActors(event.channel, threadTs);
  if (targets.length === 0) {
    await ack();
    return;
  }

  const receivedAt = now().toISOString();
  for (const actor of targets) {
    // One Slack message fans out to one delivery per target actor. A lone
    // explicit envelope keeps the Slack event_id verbatim; affinity fan-out
    // derives a per-actor durable identity so the slack_events primary key never
    // collides across a multi-actor thread, while a Slack redelivery of the same
    // event still deduplicates per actor and coalesces per actor as today.
    const perActorEventId = addressed && targets.length === 1 ? eventId : `${eventId}#${actor}`;
    const normalized: SlackEventInput = {
      eventId: perActorEventId,
      workspaceId,
      channelId: event.channel,
      threadTs,
      messageTs: event.ts,
      senderId,
      senderKind,
      actor,
      text: event.text,
      raw: body,
      receivedAt,
    };
    await broker.ingest(normalized);
  }
  await ack();
}

function asSlackMessageEvent(value: unknown): SlackMessageEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Record<keyof SlackMessageEvent, unknown>>;
  if (
    candidate.type !== "message"
    || typeof candidate.channel !== "string" || candidate.channel.length === 0
    || typeof candidate.ts !== "string" || candidate.ts.length === 0
    || (candidate.text !== undefined && typeof candidate.text !== "string")
    || (candidate.thread_ts !== undefined && typeof candidate.thread_ts !== "string")
    || (candidate.user !== undefined && typeof candidate.user !== "string")
    || (candidate.app_id !== undefined && typeof candidate.app_id !== "string")
    || (candidate.bot_id !== undefined && typeof candidate.bot_id !== "string")
  ) return null;
  return candidate as SlackMessageEvent;
}

export class SlackWebTransport implements SlackTransport {
  private readonly web: WebClient;

  constructor(botToken: string) {
    this.web = new WebClient(botToken);
  }

  async replay(channelId: string, threadTs: string): Promise<ReplaySnapshot> {
    const messages: unknown[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.web.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...(response.messages ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return {
      channelId,
      threadTs,
      fetchedAt: new Date().toISOString(),
      cursor: null,
      messages,
    };
  }

  async reply(
    channelId: string,
    threadTs: string,
    text: string,
    metadata: Record<string, string> = {},
  ): Promise<string> {
    const result = await this.web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text,
      metadata: {
        event_type: "hive_delivery_reply",
        event_payload: metadata,
      },
    });
    if (!result.ts) throw new Error("Slack reply returned no timestamp");
    return result.ts;
  }
}

export class SlackSocketIngress {
  private readonly socket: SocketModeClient;

  constructor(
    appToken: string,
    private readonly workspaceId: string,
    private readonly policy: AdmissionPolicy,
    private readonly broker: BrokerService,
  ) {
    this.socket = new SocketModeClient({ appToken });
  }

  async start(): Promise<void> {
    // @slack/socket-mode unwraps Events API envelopes and emits the inner event type ("message"),
    // not the outer "events_api" envelope type.
    this.socket.on("message", async ({ body, ack }) => {
      try {
        await handleSlackEnvelope({ body, ack }, {
          workspaceId: this.workspaceId,
          policy: this.policy,
          broker: this.broker,
          dropNotifier: {
            noticeDroppedSender: (channelId, threadTs, senderId) => {
              this.broker.store.enqueueThreadNotice(
                channelId,
                threadTs,
                `⛔ message from ${senderId} was not delivered — sender is not in the Hive trust set`,
              );
            },
          },
        });
      } catch {
        // No acknowledgement was sent if ingest failed. If acknowledgement itself failed, the
        // committed event is also safe to redeliver. Keep hostile event/error data out of stderr.
        console.error(UNACKNOWLEDGED_SLACK_ENVELOPE_DIAGNOSTIC);
      }
    });
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
  }
}
