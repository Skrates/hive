import { SocketModeClient } from "@slack/socket-mode";
import { ErrorCode, WebClient } from "@slack/web-api";
import { classifyAddressedWake, isAdmitted, type AdmissionPolicy } from "../addressing.js";
import type { ReplaySnapshot, SlackEventInput, SlackReadiness } from "../domain.js";
import { SlackSendError, type BrokerService, type SlackTransport } from "./service.js";

interface SlackMessageEvent {
  type: "message" | "app_mention";
  channel: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  app_id?: string;
  bot_id?: string;
  subtype?: string;
  metadata?: {
    event_type?: string;
    event_payload?: Record<string, unknown>;
  };
}

interface SlackEnvelopeBody {
  event?: SlackMessageEvent;
  event_id?: string;
  team_id?: string;
  authorizations?: Array<{ team_id?: string }>;
}

export interface SlackWebApi {
	conversations: {
		history?(input: Record<string, unknown>): Promise<{ messages?: unknown[] }>;
		replies(input: Record<string, unknown>): Promise<{
			messages?: unknown[];
			response_metadata?: { next_cursor?: string };
		}>;
	};
	chat: {
		postMessage(input: Record<string, unknown>): Promise<{ ts?: string }>;
	};
	auth: {
		test(): Promise<{ bot_id?: string; user_id?: string }>;
	};
}

interface SlackIngressBroker {
  ingest(event: SlackEventInput): { created: boolean; deliveryId: number | null };
	diagnoseIngress(
		eventId: string,
		channelId: string,
		threadTs: string,
		reason: string,
		text: string,
	): unknown;
}

export interface SlackIngressOutcome {
  disposition: "routed" | "duplicate" | "ignored" | "unroutable";
  reason:
    | "delivery_created"
    | "duplicate_event"
    | "unsupported_event"
    | "hive_reply"
    | "workspace_mismatch"
    | "missing_text"
    | "missing_sender"
    | "not_admitted"
    | "not_addressed"
    | "malformed_explicit_envelope"
    | "no_active_subscription";
  eventId: string;
  channelId?: string;
  actor?: string;
}

export async function handleSlackIngressEvent(
  body: SlackEnvelopeBody,
  envelopeId: string,
  workspaceId: string,
  policy: AdmissionPolicy,
  broker: SlackIngressBroker,
): Promise<SlackIngressOutcome> {
  const eventId = String(body.event_id ?? envelopeId);
  const event = body.event;
  if (!event || (event.type !== "message" && event.type !== "app_mention")) {
    return { disposition: "ignored", reason: "unsupported_event", eventId };
  }
  // Broker replies carry this marker. Never feed our own correlated output back through
  // addressing: an agent response is untrusted text and may legitimately begin with WAKE/NEXT.
  if (event.metadata?.event_type === "hive_delivery_reply") {
    return { disposition: "ignored", reason: "hive_reply", eventId, channelId: event.channel };
  }
  const eventWorkspaceId = body.team_id
    ?? body.authorizations?.find((authorization) => authorization.team_id)?.team_id;
  if (!eventWorkspaceId || eventWorkspaceId !== workspaceId) {
    return { disposition: "ignored", reason: "workspace_mismatch", eventId, channelId: event.channel };
  }
  if (!event.text) {
    return { disposition: "ignored", reason: "missing_text", eventId, channelId: event.channel };
  }

  // Bot-originated Slack events carry `bot_id`; prefer their app ID when Slack also supplies one.
  // Human messages relayed by a connector can carry both `user` and `app_id` but no `bot_id`, so
  // the human identity must win there. With no user at all, app_id is the sender authority.
  const senderKind = event.bot_id || (!event.user && event.app_id) ? "app" : "user";
  const senderId = event.bot_id
    ? (event.app_id ?? event.bot_id)
    : (event.user ?? event.app_id);
  if (!senderId) {
    return { disposition: "ignored", reason: "missing_sender", eventId, channelId: event.channel };
  }
  if (!isAdmitted(policy, {
    workspaceId: eventWorkspaceId,
    channelId: event.channel,
    senderId,
    senderKind,
  })) {
    // Do not reveal routing configuration to an identity outside the admission boundary.
    return { disposition: "ignored", reason: "not_admitted", eventId, channelId: event.channel };
  }

  const threadTs = event.thread_ts ?? event.ts;
  const addressing = classifyAddressedWake(
    event.text,
    policy.mentionActors ?? new Map(),
    policy.routerMentionIds ?? new Set(),
  );
	  if (addressing.kind === "ignored") {
	    if (addressing.reason === "malformed_explicit_envelope") {
		broker.diagnoseIngress(
			eventId,
			event.channel,
			threadTs,
			addressing.reason,
			"Hive ignored this wake: use `WAKE: actor`, `NEXT actor`, a configured direct mention, or `<@Hive> actor:` for the shared router. No agent was dispatched.",
		);
    }
    return {
      disposition: "ignored",
      reason: addressing.reason,
      eventId,
      channelId: event.channel,
    };
  }

  const normalized: SlackEventInput = {
    eventId,
    workspaceId: eventWorkspaceId,
    channelId: event.channel,
    threadTs,
    messageTs: event.ts,
    senderId,
    senderKind,
    actor: addressing.wake.actor,
    text: event.text,
    raw: body,
    receivedAt: new Date().toISOString(),
  };
  const result = broker.ingest(normalized);
  if (!result.created) {
    return {
      disposition: "duplicate",
      reason: "duplicate_event",
      eventId,
      channelId: event.channel,
      actor: addressing.wake.actor,
    };
  }
  if (result.deliveryId === null) {
    return {
      disposition: "unroutable",
      reason: "no_active_subscription",
      eventId,
      channelId: event.channel,
      actor: addressing.wake.actor,
    };
  }
  return {
    disposition: "routed",
    reason: "delivery_created",
    eventId,
    channelId: event.channel,
    actor: addressing.wake.actor,
  };
}

export class SlackWebTransport implements SlackTransport {
		  private readonly web: SlackWebApi;
		private identityPromise: Promise<{ botId: string | null; userId: string | null }> | null = null;
		private botState: SlackReadiness["bot"] = "unchecked";
		private botUpdatedAt = new Date(0).toISOString();

	  constructor(botToken: string, web?: SlackWebApi) {
	    this.web = web ?? (new WebClient(botToken, slackWebClientOptions()) as unknown as SlackWebApi);
	  }

	async preflight(channelIds: Iterable<string>): Promise<void> {
		if (this.botState !== "ready") this.setBotState("checking");
		try {
			const channelId = [...channelIds][0];
			if (!channelId || !this.web.conversations.history) throw new Error("slack_history_preflight_unavailable");
			const identity = await this.web.auth.test();
			if (!identity.bot_id && !identity.user_id) throw new Error("slack_identity_missing");
			await this.web.conversations.history({ channel: channelId, limit: 1, inclusive: true });
			this.identityPromise = Promise.resolve({
				botId: typeof identity.bot_id === "string" ? identity.bot_id : null,
				userId: typeof identity.user_id === "string" ? identity.user_id : null,
			});
			this.setBotState("ready");
		} catch (error) {
			this.identityPromise = null;
			this.setBotState("failed");
			throw error;
		}
	}

	botReadiness(): Pick<SlackReadiness, "bot" | "updatedAt"> {
		return { bot: this.botState, updatedAt: this.botUpdatedAt };
	}

	  async replay(channelId: string, threadTs: string): Promise<ReplaySnapshot> {
	    const messages: unknown[] = [];
		let bytes = 0;
		const seenCursors = new Set<string>();
		let pages = 0;
    let cursor: string | undefined;
	    do {
		  pages += 1;
		  if (pages > 20) throw new Error("slack_replay_page_limit_exceeded");
      const response = await this.web.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        inclusive: true,
		include_all_metadata: true,
        ...(cursor ? { cursor } : {}),
      });
		  for (const message of response.messages ?? []) {
			let serialized: string;
			try {
				serialized = JSON.stringify(message);
			} catch {
				throw new Error("slack_replay_limit_exceeded");
			}
			bytes += Buffer.byteLength(serialized, "utf8");
			if (messages.length >= 400 || bytes > 256 * 1024) {
				throw new Error("slack_replay_limit_exceeded");
			}
			messages.push(message);
		  }
		  const nextCursor = response.response_metadata?.next_cursor || undefined;
		  if (nextCursor && seenCursors.has(nextCursor)) throw new Error("slack_replay_cursor_repeated");
		  if (nextCursor) seenCursors.add(nextCursor);
	      cursor = nextCursor;
		  if (cursor && messages.length >= 400) throw new Error("slack_replay_limit_exceeded");
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
	let result;
	try {
		result = await this.web.chat.postMessage({
	      channel: channelId,
      thread_ts: threadTs,
      text,
	  unfurl_links: false,
	  unfurl_media: false,
      metadata: {
        event_type: "hive_delivery_reply",
	        event_payload: metadata,
	      },
		});
	} catch (error) {
		throw classifySlackPostError(error);
	}
    if (!result.ts) throw new Error("Slack reply returned no timestamp");
    return result.ts;
  }

	async findReply(
		channelId: string,
		threadTs: string,
		metadata: Record<string, string>,
	): Promise<string | null> {
			const identity = await this.identity();
			let cursor: string | undefined;
			let scanned = 0;
			const seenCursors = new Set<string>();
			let pages = 0;
			do {
				pages += 1;
				if (pages > 20) throw new Error("slack_reconciliation_page_limit_exceeded");
				const response = await this.web.conversations.replies({
					channel: channelId,
					ts: threadTs,
					limit: 200,
					inclusive: true,
					include_all_metadata: true,
					...(cursor ? { cursor } : {}),
				});
				const page = response.messages ?? [];
				scanned += page.length;
				if (scanned > 2_000) throw new Error("slack_reconciliation_scan_limit_exceeded");
				const found = findCorrelatedHiveReply(page, metadata, identity);
				if (found) return found;
				const nextCursor = response.response_metadata?.next_cursor || undefined;
				if (nextCursor && seenCursors.has(nextCursor)) {
					throw new Error("slack_reconciliation_cursor_repeated");
				}
				if (nextCursor) seenCursors.add(nextCursor);
				cursor = nextCursor;
			} while (cursor);
			return null;
		}

	private identity(): Promise<{ botId: string | null; userId: string | null }> {
		if (!this.identityPromise) {
			this.identityPromise = this.web.auth.test()
				.then((result) => ({
					botId: typeof result.bot_id === "string" ? result.bot_id : null,
					userId: typeof result.user_id === "string" ? result.user_id : null,
				}))
				.catch((error: unknown) => {
					this.identityPromise = null;
					throw error;
				});
		}
			return this.identityPromise;
		}

		private setBotState(state: SlackReadiness["bot"]): void {
			this.botState = state;
			this.botUpdatedAt = new Date().toISOString();
		}
	}

export function slackWebClientOptions() {
	return {
		retryConfig: { retries: 0 },
		rejectRateLimitedCalls: true,
		timeout: 8_000,
	};
}

const PERMANENT_SLACK_REJECTIONS = new Set([
	"account_inactive",
	"channel_not_found",
	"invalid_arguments",
	"invalid_auth",
	"invalid_metadata",
	"is_archived",
	"message_metadata_too_large",
	"metadata_must_be_sent_from_app",
	"missing_scope",
	"no_text",
	"not_authed",
	"not_in_channel",
	"restricted_action",
	"token_revoked",
]);

export function classifySlackPostError(error: unknown): SlackSendError {
	if (isRecord(error) && error.code === ErrorCode.RateLimitedError) {
		const retryAfter = typeof error.retryAfter === "number" ? error.retryAfter * 1_000 : 1_000;
		return new SlackSendError("definite_retryable", "slack_rate_limited", retryAfter);
	}
	if (isRecord(error) && error.code === ErrorCode.PlatformError && isRecord(error.data)
		&& typeof error.data.error === "string" && PERMANENT_SLACK_REJECTIONS.has(error.data.error)) {
		return new SlackSendError("definite_dead", "slack_permanent_rejection");
	}
	return new SlackSendError("uncertain", "slack_send_uncertain");
}

export function findCorrelatedHiveReply(
	messages: unknown[],
	expectedMetadata: Record<string, string>,
	identity: { botId: string | null; userId: string | null },
): string | null {
	const key = expectedMetadata.outbox_key;
	const nonce = expectedMetadata.outbox_nonce;
	if (!key || !nonce || (!identity.botId && !identity.userId)) return null;
	for (const message of messages) {
		if (!isRecord(message) || typeof message.ts !== "string" || !isRecord(message.metadata)) continue;
		const authoredByHive = (identity.botId !== null && message.bot_id === identity.botId)
			|| (identity.userId !== null && message.user === identity.userId);
		if (!authoredByHive || message.metadata.event_type !== "hive_delivery_reply"
			|| !isRecord(message.metadata.event_payload)) continue;
		if (message.metadata.event_payload.outbox_key === key
			&& message.metadata.event_payload.outbox_nonce === nonce) return message.ts;
	}
	return null;
}

export class SlackSocketIngress {
  private readonly socket: SocketModeClient;
	private socketState: SlackReadiness["socket"] = "disconnected";
	private socketUpdatedAt = new Date(0).toISOString();

  constructor(
    appToken: string,
    private readonly workspaceId: string,
    private readonly policy: AdmissionPolicy,
    private readonly broker: BrokerService,
  ) {
    this.socket = new SocketModeClient({ appToken });
	for (const state of ["connecting", "connected", "reconnecting", "disconnecting", "disconnected"] as const) {
		this.socket.on(state, () => {
			this.socketState = state;
			this.socketUpdatedAt = new Date().toISOString();
		});
	}
  }

	readiness(): Pick<SlackReadiness, "socket" | "updatedAt"> {
		return { socket: this.socketState, updatedAt: this.socketUpdatedAt };
	}

  async start(): Promise<void> {
    // @slack/socket-mode unwraps Events API envelopes and emits the inner event type, not the
    // outer "events_api" envelope type. app_mention is registered separately because installations
    // may grant it without broad channel message subscriptions.
	    const receive = async (request: {
      body: unknown;
      ack: () => Promise<void>;
      envelope_id: string;
    }): Promise<void> => {
	      try {
			const outcome = await processSlackSocketRequest(
				request,
				this.workspaceId,
				this.policy,
				this.broker,
			);
        if (outcome.disposition === "ignored" || outcome.disposition === "unroutable") {
          // Log only envelope metadata, never the untrusted Slack body or credentials.
          console.warn("hive Slack ingress", JSON.stringify(outcome));
        }
      } catch (error) {
		// Deliberately do not acknowledge a failed durable write; Slack will redeliver the envelope.
		// Persisted operational logging is installed by the host; stderr is credential-free.
        console.error("hive Slack event failed", error instanceof Error ? error.message : String(error));
      }
    };
    this.socket.on("message", async (request) => receive(request as unknown as Parameters<typeof receive>[0]));
    this.socket.on("app_mention", async (request) => receive(request as unknown as Parameters<typeof receive>[0]));
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
  }
}

export async function processSlackSocketRequest(
	request: { body: unknown; ack: () => Promise<void>; envelope_id: string },
	workspaceId: string,
	policy: AdmissionPolicy,
	broker: SlackIngressBroker,
): Promise<SlackIngressOutcome> {
	const outcome = await handleSlackIngressEvent(
		request.body as SlackEnvelopeBody,
		request.envelope_id,
		workspaceId,
		policy,
		broker,
	);
	await request.ack();
	return outcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
