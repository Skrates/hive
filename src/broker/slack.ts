import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { isAdmitted, parseAddressedWake, type AdmissionPolicy } from "../addressing.js";
import { EVERYONE, type ReplaySnapshot, type SlackEventInput } from "../domain.js";
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

/**
 * The durable outcome of one ingest. `created` distinguishes a fresh event row
 * from a redelivery of one already ingested (deduped by the slack_events primary
 * key). `deliveryId` is null when the event was recorded but no live subscription
 * absorbed it into a delivery — the silent dead-letter signal. A fresh event with
 * no delivery means the wake reached no one, and is what earns a thread notice.
 */
export interface IngestResult {
  created: boolean;
  deliveryId: number | null;
}

interface SlackEventIngester {
  ingest(event: SlackEventInput, initialSnapshot?: unknown | null): IngestResult;
  /** Actors already bound to (channelId, threadTs) — the thread-affinity target set. */
  boundActors(channelId: string, threadTs: string): string[];
  /**
   * Actors targeted by this raw Slack event, frozen on first sight so a lost-ACK
   * redelivery routes to the same set even if the thread's bindings changed.
   */
  freezeAffinityTargets(rawEventId: string, channelId: string, threadTs: string): string[];
  /** Every actor with a live subscription — the `everyone` broadcast target set. */
  liveActors(): string[];
}

/**
 * ADR-0003 R-1: a message from outside the closed trust set is dropped and the
 * drop is visible in its thread. The notice is durably enqueued through the
 * broker outbox rather than posted inline, so a Slack hiccup cannot lose it.
 */
export interface DropNotifier {
  noticeDroppedSender(channelId: string, threadTs: string, senderId: string): void;
  /**
   * An admitted wake named — or thread affinity resolved to — an actor with no
   * live subscription, so the event was durably recorded but woke no one. The
   * notice makes that dead-letter visible in the thread rather than swallowing
   * it. Same durable-outbox path as {@link noticeDroppedSender}, and it names
   * only the actor — never the message body.
   */
  noticeUnroutableActor(channelId: string, threadTs: string, actor: string): void;
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
  // Admission is never weakened by affinity. ADR-0003 R-1 makes every message
  // from an identified principal outside the closed trust set thread-visible on
  // an admitted surface. Whether a trusted sender would currently have an
  // affinity target is irrelevant: silently acknowledging the rejected message
  // would make the trust boundary invisible to the sender and operator.
  if (!senderId || !isAdmitted(policy, {
    workspaceId,
    channelId: event.channel,
    senderId,
    senderKind,
  })) {
    if (senderId && dropNotifier) {
      dropNotifier.noticeDroppedSender(event.channel, threadTs, senderId);
    }
    await ack();
    return;
  }

  // Admitted. An explicit envelope targets the actors it names — one or a
  // comma-separated list — and binds each to the thread going forward. Otherwise
  // thread affinity routes to every actor already bound to this thread — frozen by
  // raw event ID on first sight, so a lost-ACK redelivery reaches exactly the set
  // bound when the message was first seen and never an actor that joined afterward
  // (derived from the persisted store, so it also survives a broker restart). A
  // thread with no binding and no envelope is ignored exactly as before.
  //
  // `everyone` is the one keyword the parser does not resolve: a lone `everyone`
  // from a HUMAN fans out to every live subscription. From a bot it is NOT
  // expanded — it flows through as the literal, unsubscribable target `everyone`,
  // which dead-letters through the KRA-925 unroutable notice (visible, zero
  // deliveries, idempotent on redelivery). This is load-bearing: an agent posts
  // ingress under the trusted bot user, and a quoted "WAKE: everyone" in an agent
  // reply must never chain-wake the fleet.
  const broadcast = addressed?.actors.length === 1
    && addressed.actors[0] === EVERYONE
    && senderKind === "user";
  const targets = addressed
    ? (broadcast ? broker.liveActors() : addressed.actors)
    : broker.freezeAffinityTargets(eventId, event.channel, threadTs);
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
    // A fresh event row that minted no delivery means this actor has no live
    // subscription: the wake was durably recorded but reached no one. Surface
    // that dead-letter in the thread. Keyed on `created` so a lost-ACK
    // redelivery (which dedupes to created:false) can never double-post the
    // notice. Covers both entry points — an explicit envelope and affinity
    // fan-out — since every target passes through this ingest.
    const result = broker.ingest(normalized);
    if (result.created && result.deliveryId === null && dropNotifier) {
      dropNotifier.noticeUnroutableActor(event.channel, threadTs, actor);
    }
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

  /**
   * Lifecycle stamps are idempotent by contract: redelivery re-stamps the same
   * emoji and Slack answers `already_reacted`, which is success, not failure.
   */
  async react(channelId: string, messageTs: string, name: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel: channelId, timestamp: messageTs, name });
    } catch (error) {
      const code = (error as { data?: { error?: string } }).data?.error;
      if (code === "already_reacted") return;
      throw error;
    }
  }
}

export class SlackSocketIngress {
  private socket: SocketModeClient | null = null;
  private starting = false;
  private lastEventMs: number | null = null;
  private lastConnectMs: number | null = null;

  constructor(
    private readonly appToken: string,
    private readonly workspaceId: string,
    private readonly policy: AdmissionPolicy,
    private readonly broker: BrokerService,
    private readonly log: (message: string) => void = (message) => console.error(message),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** True once the Socket Mode client has fully started and not yet stopped. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * Epoch-ms of the last genuine inbound Slack envelope, or null before any has
   * arrived. This is *event* activity — real traffic flowing over the link — and
   * is deliberately NOT bumped by a (re)connect. A connection can be perfectly
   * established yet deaf (a half-open socket, or a second Socket Mode consumer
   * stealing the event stream), so the deafness watchdog must read event flow,
   * not connection state, when deciding whether the link has gone silent.
   */
  lastEventAt(): number | null {
    return this.lastEventMs;
  }

  /**
   * Epoch-ms of the last `connected` transition, or null before the first one.
   * This is *transport* liveness — proof the socket re-established — kept
   * separate from {@link lastEventAt} so the watchdog can tell "the reconnect
   * succeeded but events still aren't flowing" (ambiguous: quiet vs. stolen
   * stream) from "the reconnect never took" (a wedged transport worth exiting).
   */
  lastConnectAt(): number | null {
    return this.lastConnectMs;
  }

  async start(): Promise<void> {
    // Single-flight: never build a second client while one is live or a start is
    // already in flight (the watchdog's restart and a shutdown could otherwise race).
    if (this.socket || this.starting) return;
    this.starting = true;
    try {
      const socket = new SocketModeClient({ appToken: this.appToken });
      // A (re)connect is transport liveness only — it is NOT evidence that Slack
      // events are flowing. Stamping event activity here is exactly what masked the
      // 2026-08-04 incident: every forced reconnect looked like a fresh event, so a
      // link that stayed connected-but-deaf never tripped the watchdog.
      socket.on("connected", () => {
        this.lastConnectMs = this.clock();
      });
      // `slack_event` fires once per inbound envelope of every type — the SDK's
      // all-envelope signal. This is the true "events are flowing" evidence, so it
      // (and only it) stamps the event-activity clock. It never acks or processes;
      // durable ingestion runs off the unwrapped inner `message` event below.
      socket.on("slack_event", () => {
        this.lastEventMs = this.clock();
      });
      // @slack/socket-mode unwraps Events API envelopes and emits the inner event type ("message"),
      // not the outer "events_api" envelope type.
      socket.on("message", async ({ body, ack }) => {
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
              noticeUnroutableActor: (channelId, threadTs, actor) => {
                this.broker.store.enqueueThreadNotice(
                  channelId,
                  threadTs,
                  `⚠️ no live subscription for actor \`${actor}\` — this wake reached no one. \`hive status\` lists live actors.`,
                );
              },
            },
          });
        } catch (error) {
          // No acknowledgement was sent if ingest failed. If acknowledgement itself failed, the
          // committed event is also safe to redeliver. Surface the error TYPE so a wedged handler is
          // visible in logs, while keeping hostile event body data (and any secret- or prompt-shaped
          // text an exception message might carry) out of stderr.
          this.log(`${UNACKNOWLEDGED_SLACK_ENVELOPE_DIAGNOSTIC}: ${safeErrorName(error)}`);
        }
      });
      try {
        await socket.start();
      } catch (error) {
        // A rejected start must not leave a half-built client behind advertising
        // `connected === true` or blocking a later retry. Best-effort tear down, then rethrow.
        await socket.disconnect().catch(() => {});
        throw error;
      }
      // Publish the socket only after startup resolves — never before — so a failed
      // start can never report false connected state.
      this.socket = socket;
    } finally {
      this.starting = false;
    }
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
 * Reduce an unknown error to its TYPE name only — never its message. An exception
 * raised while handling a Slack envelope can carry event body text, and thus
 * secret- or prompt-shaped data; the class name is a code identifier that cannot.
 * Truncating the message is not sanitisation, so we drop it entirely.
 */
export function safeErrorName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name;
  return "non-error thrown";
}
