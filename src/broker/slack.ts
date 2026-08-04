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
  const addressed = parseAddressedWake(event.text);
  if (!addressed) {
    await ack();
    return;
  }
  const senderKind = event.user ? "user" : "app";
  const senderId = event.user ?? event.app_id ?? event.bot_id;
  // Surface admission first: a message in a workspace or channel Hive does not
  // occupy is silently ignored — posting notices into foreign channels is not
  // Hive's place. Inside an admitted surface, an addressed message from a
  // principal outside the closed trust set is dropped with a thread notice
  // (ADR-0003 R-1): delivered-but-silently-swallowed would be indistinguishable
  // from delivered-and-ignored, and silence is always a defect.
  if (!policy.workspaceIds.has(workspaceId) || !policy.channelIds.has(event.channel)) {
    await ack();
    return;
  }
  if (!senderId || !isAdmitted(policy, {
    workspaceId,
    channelId: event.channel,
    senderId,
    senderKind,
  })) {
    if (senderId && dropNotifier) {
      dropNotifier.noticeDroppedSender(event.channel, event.thread_ts ?? event.ts, senderId);
    }
    await ack();
    return;
  }

  const normalized: SlackEventInput = {
    eventId,
    workspaceId,
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    messageTs: event.ts,
    senderId,
    senderKind,
    actor: addressed.actor,
    text: event.text,
    raw: body,
    receivedAt: now().toISOString(),
  };

  await broker.ingest(normalized);
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
  private socket: SocketModeClient | null = null;
  private lastActivityMs: number | null = null;

  constructor(
    private readonly appToken: string,
    private readonly workspaceId: string,
    private readonly policy: AdmissionPolicy,
    private readonly broker: BrokerService,
    private readonly log: (message: string) => void = (message) => console.error(message),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** True once the Socket Mode client has been started and not yet stopped. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * Epoch-ms of the last sign of life from the Slack link: a received envelope,
   * or a (re)connect transition. Null before the first `start()`. The deafness
   * watchdog reads this to distinguish a live-but-quiet link from a wedged one
   * (half-open socket, or a second Socket Mode consumer stealing the stream).
   */
  lastActivityAt(): number | null {
    return this.lastActivityMs;
  }

  async start(): Promise<void> {
    if (this.socket) return;
    const socket = new SocketModeClient({ appToken: this.appToken });
    // A (re)connect is a genuine sign of life — bump activity so a healthy link
    // that merely refreshed its connection is never mistaken for deaf.
    socket.on("connected", () => {
      this.lastActivityMs = this.clock();
    });
    // @slack/socket-mode unwraps Events API envelopes and emits the inner event type ("message"),
    // not the outer "events_api" envelope type.
    socket.on("message", async ({ body, ack }) => {
      this.lastActivityMs = this.clock();
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
      } catch (error) {
        // No acknowledgement was sent if ingest failed. If acknowledgement itself failed, the
        // committed event is also safe to redeliver. Surface the error CODE so a wedged handler is
        // visible in logs, while keeping hostile event body data out of stderr.
        this.log(`${UNACKNOWLEDGED_SLACK_ENVELOPE_DIAGNOSTIC}: ${safeErrorMessage(error)}`);
      }
    });
    this.socket = socket;
    this.lastActivityMs = this.clock();
    await socket.start();
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.disconnect();
  }

  /** Tear down and re-establish the Socket Mode client — the watchdog's recovery action. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

/**
 * Reduce an unknown error to a short, log-safe string: our own structured error
 * messages are safe; a bare object collapses to its type. Never echoes an event body.
 */
function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return typeof error === "string" ? error.slice(0, 300) : "non-error thrown";
}
