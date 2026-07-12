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
    this.socket.on("events_api", async ({ body, ack, envelope_id }) => {
      await ack();
      try {
        const event = body.event as SlackMessageEvent | undefined;
        if (!event || event.type !== "message" || !event.text) return;
        const addressed = parseAddressedWake(event.text);
        if (!addressed) return;
        const senderKind = event.user ? "user" : "app";
        const senderId = event.user ?? event.app_id ?? event.bot_id;
        if (!senderId) return;
        if (!isAdmitted(this.policy, {
          workspaceId: this.workspaceId,
          channelId: event.channel,
          senderId,
          senderKind,
        })) return;

        const normalized: SlackEventInput = {
          eventId: String(body.event_id ?? envelope_id),
          workspaceId: this.workspaceId,
          channelId: event.channel,
          threadTs: event.thread_ts ?? event.ts,
          messageTs: event.ts,
          senderId,
          senderKind,
          actor: addressed.actor,
          text: event.text,
          raw: body,
          receivedAt: new Date().toISOString(),
        };
        this.broker.ingest(normalized);
      } catch (error) {
        // Socket Mode has already been acknowledged. Persisted operational logging is installed by
        // the host; stderr is intentionally credential-free.
        console.error("hive Slack event failed", error instanceof Error ? error.message : String(error));
      }
    });
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
  }
}
