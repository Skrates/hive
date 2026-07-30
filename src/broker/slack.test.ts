import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode } from "@slack/web-api";
import type { AdmissionPolicy } from "../addressing.js";
import type { SlackEventInput } from "../domain.js";
import {
	classifySlackPostError,
	findCorrelatedHiveReply,
	handleSlackIngressEvent,
	processSlackSocketRequest,
	SlackWebTransport,
	slackWebClientOptions,
	type SlackWebApi,
} from "./slack.js";

class FakeBroker {
  readonly ingested: SlackEventInput[] = [];
  listeners: string[] = [];
	  readonly diagnostics: Array<{
		eventId: string;
    channelId: string;
    threadTs: string;
    reason: string;
    text: string;
  }> = [];
  result: { created: boolean; deliveryId: number | null } = { created: true, deliveryId: 1 };

  ingest(event: SlackEventInput): { created: boolean; deliveryId: number | null } {
    this.ingested.push(event);
    return this.result;
  }

  channelListeners(_channelId: string): string[] {
    return [...this.listeners];
  }

  ingestForActors(
    event: SlackEventInput,
    actors: readonly string[],
  ): {
    created: boolean;
    routes: Array<{ actor: string; deliveryId: number | null }>;
  } {
    const result = this.ingest({ ...event, actor: actors[0]! });
    if (!result.created) return { created: false, routes: [] };
    for (const actor of actors.slice(1)) this.ingested.push({ ...event, actor });
    return {
      created: true,
      routes: actors.map((actor) => ({ actor, deliveryId: result.deliveryId })),
    };
  }

	  diagnoseIngress(
		eventId: string,
	    channelId: string,
    threadTs: string,
    reason: string,
    text: string,
	  ): void {
	    this.diagnostics.push({ eventId, channelId, threadTs, reason, text });
  }
}

const policy: AdmissionPolicy = {
  workspaceIds: new Set(["T1"]),
  channelIds: new Set(["C1"]),
  userIds: new Set(["U1"]),
  appIds: new Set(["A1"]),
  mentionActors: new Map([["UARIADNE", "ariadne"]]),
  routerMentionIds: new Set(["UHIVE"]),
};

function body(
  text: string,
  overrides: Partial<{
    type: "message" | "app_mention";
    channel: string;
    ts: string;
    thread_ts: string;
    user: string;
    app_id: string;
    bot_id: string;
    metadata: { event_type: string; event_payload?: Record<string, unknown> };
  }> = {},
) {
  return {
    event_id: "Ev1",
    team_id: "T1",
    event: {
      type: "message" as const,
      channel: "C1",
      text,
      ts: "101.1",
      user: "U1",
      ...overrides,
    },
  };
}

test("an admitted leading Slack mention routes to its configured actor", async () => {
  const broker = new FakeBroker();
  const outcome = await handleSlackIngressEvent(
    body("<@UARIADNE> — read the thread", { type: "app_mention", thread_ts: "100.1" }),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.deepEqual(outcome, {
    disposition: "routed",
    reason: "delivery_created",
    eventId: "Ev1",
    channelId: "C1",
    actor: "ariadne",
  });
  assert.equal(broker.ingested[0]?.actor, "ariadne");
  assert.equal(broker.ingested[0]?.threadTs, "100.1");
  assert.equal(broker.diagnostics.length, 0);
});

test("the admitted shared bot mention routes ariadne and fable explicitly", async () => {
  for (const actor of ["ariadne", "fable"] as const) {
    const broker = new FakeBroker();
    const outcome = await handleSlackIngressEvent(
      body(`<@UHIVE> ${actor}: read the thread`, {
        type: "app_mention",
        thread_ts: "100.1",
      }),
      `env-${actor}`,
      "T1",
      policy,
      broker,
    );

    assert.equal(outcome.disposition, "routed");
    assert.equal(outcome.actor, actor);
    assert.equal(broker.ingested[0]?.actor, actor);
    assert.equal(broker.diagnostics.length, 0);
  }
});

test("a configured shared bot mention missing its target or colon is explained", async () => {
  for (const text of [
    "<@UHIVE>",
    "<@UHIVE> ariadne",
    "<@UHIVE> ariadne — missing colon",
    "<@UHIVE> : missing target",
  ]) {
    const broker = new FakeBroker();
    const outcome = await handleSlackIngressEvent(
      body(text, { type: "app_mention", thread_ts: "100.1" }),
      "env-1",
      "T1",
      policy,
      broker,
    );

    assert.equal(outcome.reason, "malformed_explicit_envelope");
    assert.equal(broker.ingested.length, 0);
    assert.equal(broker.diagnostics[0]?.reason, "malformed_explicit_envelope");
    assert.match(broker.diagnostics[0]?.text ?? "", /<@Hive> actor:/);
  }
});

test("unconfigured and non-leading router mentions are inert", async () => {
  for (const text of [
    "<@UOTHER> ariadne: not configured",
    "FYI for later: <@UHIVE> ariadne:",
    "> <@UHIVE> fable: quoted",
  ]) {
    const broker = new FakeBroker();
    const outcome = await handleSlackIngressEvent(body(text), "env-1", "T1", policy, broker);
    assert.equal(outcome.reason, "not_addressed");
    assert.equal(broker.ingested.length, 0);
    assert.equal(broker.diagnostics.length, 0);
  }
});

test("ordinary conversation and a mid-body mention remain inert", async () => {
  for (const text of ["Ari — read this when you can", "FYI for <@UARIADNE> later"]) {
    const broker = new FakeBroker();
    const outcome = await handleSlackIngressEvent(body(text), "env-1", "T1", policy, broker);
    assert.equal(outcome.reason, "not_addressed");
    assert.equal(broker.ingested.length, 0);
    assert.equal(broker.diagnostics.length, 0);
  }
});

test("ordinary admitted conversation fans out to every attached channel listener", async () => {
  const broker = new FakeBroker();
  broker.listeners = ["ariadne", "fable"];
  const outcome = await handleSlackIngressEvent(
    body("The guard landed; carry on with the restack.", { thread_ts: "100.1" }),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.deepEqual(outcome, {
    disposition: "routed",
    reason: "delivery_created",
    eventId: "Ev1",
    channelId: "C1",
    actors: ["ariadne", "fable"],
  });
  assert.deepEqual(broker.ingested.map((event) => event.actor), ["ariadne", "fable"]);
  assert.equal(broker.diagnostics.length, 0);
});

test("channel fanout suppresses the trusted originating app without suppressing peers", async () => {
  const broker = new FakeBroker();
  broker.listeners = ["ariadne", "fable"];
  const originPolicy: AdmissionPolicy = {
    ...policy,
    originAppActors: new Map([["AARI", "ariadne"]]),
  };
  const outcome = await handleSlackIngressEvent(
    body("Ari's update for Fable", { app_id: "AARI", thread_ts: "100.1" }),
    "env-1",
    "T1",
    originPolicy,
    broker,
  );

  assert.deepEqual(outcome, {
    disposition: "routed",
    reason: "delivery_created",
    eventId: "Ev1",
    channelId: "C1",
    actor: "fable",
  });
  assert.deepEqual(broker.ingested.map((event) => event.actor), ["fable"]);
});

test("a channel message emitted by the only attached actor is ignored as self-origin", async () => {
  const broker = new FakeBroker();
  broker.listeners = ["ariadne"];
  const originPolicy: AdmissionPolicy = {
    ...policy,
    originAppActors: new Map([["AARI", "ariadne"]]),
  };
  const outcome = await handleSlackIngressEvent(
    body("Ari's own status", { app_id: "AARI" }),
    "env-1",
    "T1",
    originPolicy,
    broker,
  );

  assert.equal(outcome.reason, "self_origin");
  assert.equal(broker.ingested.length, 0);
});

test("attached listeners make malformed legacy wake syntax ordinary channel traffic", async () => {
  const broker = new FakeBroker();
  broker.listeners = ["ariadne", "fable"];
  const outcome = await handleSlackIngressEvent(
    body("WAKE: | this grammar should no longer be required"),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.equal(outcome.disposition, "routed");
  assert.deepEqual(outcome.actors, ["ariadne", "fable"]);
  assert.equal(broker.diagnostics.length, 0);
});

test("an explicit address remains a single-recipient override in an attached channel", async () => {
  const broker = new FakeBroker();
  broker.listeners = ["ariadne", "fable"];
  const outcome = await handleSlackIngressEvent(
    body("NEXT fable — private handoff"),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.equal(outcome.actor, "fable");
  assert.equal(outcome.actors, undefined);
  assert.deepEqual(broker.ingested.map((event) => event.actor), ["fable"]);
});

test("an admitted malformed explicit wake gets an operator-visible Slack diagnostic", async () => {
  const broker = new FakeBroker();
  const outcome = await handleSlackIngressEvent(
    body("WAKE: | missing actor", { thread_ts: "100.1" }),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.equal(outcome.reason, "malformed_explicit_envelope");
  assert.equal(broker.ingested.length, 0);
  assert.equal(broker.diagnostics[0]?.threadTs, "100.1");
  assert.equal(broker.diagnostics[0]?.reason, "malformed_explicit_envelope");
  assert.match(broker.diagnostics[0]?.text ?? "", /No agent was dispatched/);
});

test("an addressed actor without a subscription is persisted and explained in Slack", async () => {
  const broker = new FakeBroker();
  broker.result = { created: true, deliveryId: null };
  const outcome = await handleSlackIngressEvent(
    body("WAKE: reviewer | please inspect"),
    "env-1",
    "T1",
    policy,
    broker,
  );

	assert.equal(outcome.disposition, "unroutable");
  assert.equal(outcome.reason, "no_active_subscription");
  assert.equal(broker.ingested[0]?.actor, "reviewer");
	assert.equal(broker.diagnostics.length, 0);
});

test("non-admitted senders receive no routing information", async () => {
  const broker = new FakeBroker();
  const outcome = await handleSlackIngressEvent(
    body("WAKE: ariadne", { user: "UOUTSIDER" }),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.equal(outcome.reason, "not_admitted");
  assert.equal(broker.ingested.length, 0);
  assert.equal(broker.diagnostics.length, 0);
});

test("app identity wins when Slack supplies both bot user and app identifiers", async () => {
  const broker = new FakeBroker();
  const appOnlyPolicy: AdmissionPolicy = {
    ...policy,
    userIds: new Set(),
  };
  const outcome = await handleSlackIngressEvent(
    body("WAKE: ariadne", { user: "UBOTUSER", app_id: "A1", bot_id: "B1" }),
    "env-1",
    "T1",
    appOnlyPolicy,
    broker,
  );

  assert.equal(outcome.disposition, "routed");
  assert.equal(broker.ingested[0]?.senderKind, "app");
  assert.equal(broker.ingested[0]?.senderId, "A1");
});

test("human identity wins when a connector adds app_id without bot_id", async () => {
  const broker = new FakeBroker();
  const outcome = await handleSlackIngressEvent(
    body("WAKE: ariadne", { user: "U1", app_id: "ACONNECTOR" }),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.equal(outcome.disposition, "routed");
  assert.equal(broker.ingested[0]?.senderKind, "user");
  assert.equal(broker.ingested[0]?.senderId, "U1");
});

test("an event cannot borrow the configured workspace identity", async () => {
  const broker = new FakeBroker();
  const hostile = body("WAKE: ariadne");
  hostile.team_id = "TOTHER";
  const outcome = await handleSlackIngressEvent(hostile, "env-1", "T1", policy, broker);

  assert.equal(outcome.reason, "workspace_mismatch");
  assert.equal(broker.ingested.length, 0);
  assert.equal(broker.diagnostics.length, 0);
});

test("Slack retries remain idempotent and do not produce a false failure diagnostic", async () => {
  const broker = new FakeBroker();
  broker.result = { created: false, deliveryId: null };
  const outcome = await handleSlackIngressEvent(
    body("NEXT ariadne"),
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.equal(outcome.disposition, "duplicate");
  assert.equal(outcome.reason, "duplicate_event");
  assert.equal(broker.diagnostics.length, 0);
});

test("a correlated Hive reply cannot recursively wake an actor", async () => {
  const broker = new FakeBroker();
  broker.listeners = ["ariadne", "fable"];
  const reply = body("WAKE: ariadne | text emitted by an agent", {
    app_id: "A1",
    metadata: {
      event_type: "hive_delivery_reply",
      event_payload: { delivery_id: "42" },
    },
  });
  delete (reply.event as { user?: string }).user;
  const outcome = await handleSlackIngressEvent(
    reply,
    "env-1",
    "T1",
    policy,
    broker,
  );

  assert.deepEqual(outcome, {
    disposition: "ignored",
    reason: "hive_reply",
    eventId: "Ev1",
    channelId: "C1",
  });
  assert.equal(broker.ingested.length, 0);
  assert.equal(broker.diagnostics.length, 0);
});

test("Socket Mode acknowledges only after durable ingress succeeds", async () => {
	let acknowledged = false;
	const broker = new FakeBroker();
	broker.ingest = () => { throw new Error("forced durable failure"); };
	await assert.rejects(
		() => processSlackSocketRequest({
			body: body("WAKE: ariadne"),
			envelope_id: "env-1",
			ack: async () => { acknowledged = true; },
		}, "T1", policy, broker),
		/forced durable failure/,
	);
	assert.equal(acknowledged, false);

	await processSlackSocketRequest({
		body: body("WAKE: ariadne"),
		envelope_id: "env-2",
		ack: async () => { acknowledged = true; },
	}, "T1", policy, new FakeBroker());
	assert.equal(acknowledged, true);
});

test("an assistant completion prefix prevents recursive delivery even without Slack metadata", async () => {
	const broker = new FakeBroker();
	broker.listeners = ["ariadne", "fable"];
	const echoed = body("Hive: ariadne completed delivery 9.\n\nWAKE: ariadne | recurse", {
		user: "UBOTUSER",
		app_id: "A1",
		bot_id: "B1",
	});
	const outcome = await handleSlackIngressEvent(echoed, "env-loop", "T1", policy, broker);
	assert.equal(outcome.reason, "hive_reply");
	assert.equal(broker.ingested.length, 0);
});

test("Slack post errors distinguish proven retry, permanent rejection, and uncertainty", () => {
	const rate = classifySlackPostError({ code: ErrorCode.RateLimitedError, retryAfter: 2 });
	assert.equal(rate.outcome, "definite_retryable");
	assert.equal(rate.retryAfterMs, 2_000);
	const permanent = classifySlackPostError({
		code: ErrorCode.PlatformError,
		data: { error: "channel_not_found" },
	});
	assert.equal(permanent.outcome, "definite_dead");
	const internal = classifySlackPostError({
		code: ErrorCode.PlatformError,
		data: { error: "internal_error" },
	});
	assert.equal(internal.outcome, "uncertain");
	assert.equal(classifySlackPostError({ code: ErrorCode.RequestError }).outcome, "uncertain");
});

test("outbox reconciliation requires nonce and Hive's authenticated author", () => {
	const expected = { outbox_key: "completion:42", outbox_nonce: "unguessable-nonce" };
	const spoof = {
		ts: "101.1",
		bot_id: "BOTHER",
		metadata: { event_type: "hive_delivery_reply", event_payload: expected },
	};
	assert.equal(findCorrelatedHiveReply([spoof], expected, { botId: "BHIVE", userId: "UHIVE" }), null);
	const own = { ...spoof, ts: "101.2", bot_id: "BHIVE" };
	assert.equal(findCorrelatedHiveReply([spoof, own], expected, { botId: "BHIVE", userId: "UHIVE" }), "101.2");
	assert.equal(findCorrelatedHiveReply([
		{ ...own, metadata: { ...own.metadata, event_payload: { ...expected, outbox_nonce: "wrong" } } },
	], expected, { botId: "BHIVE", userId: "UHIVE" }), null);
});

test("Slack transport disables unfurls, requests metadata, and refreshes failed identity lookup", async () => {
	const postCalls: Array<Record<string, unknown>> = [];
	const replyCalls: Array<Record<string, unknown>> = [];
	let authCalls = 0;
	const metadata = { outbox_key: "completion:1", outbox_nonce: "nonce-1" };
	const web: SlackWebApi = {
		chat: {
			async postMessage(input) { postCalls.push(input); return { ts: "101.1" }; },
		},
		conversations: {
			async replies(input) {
				replyCalls.push(input);
				return {
					messages: [{
						ts: "101.1",
						bot_id: "BHIVE",
						metadata: { event_type: "hive_delivery_reply", event_payload: metadata },
					}],
				};
			},
		},
		auth: {
			async test() {
				authCalls += 1;
				if (authCalls === 1) throw new Error("temporary auth lookup failure");
				return { bot_id: "BHIVE", user_id: "UHIVE" };
			},
		},
	};
	const transport = new SlackWebTransport("xoxb-test", web);
	await transport.reply("C1", "100.1", "attacker URL https://evil.invalid/sentinel", metadata);
	assert.equal(postCalls[0]?.unfurl_links, false);
	assert.equal(postCalls[0]?.unfurl_media, false);
	await assert.rejects(() => transport.findReply("C1", "100.1", metadata), /temporary auth lookup failure/);
	assert.equal(await transport.findReply("C1", "100.1", metadata), "101.1");
	assert.equal(authCalls, 2);
	assert.equal(replyCalls[0]?.include_all_metadata, true);
});

test("a periodic Slack capability recheck keeps last-known-ready until it succeeds or fails", async () => {
	let historyCalls = 0;
	let releaseHistory!: () => void;
	const heldHistory = new Promise<void>((resolve) => {
		releaseHistory = resolve;
	});
	const web: SlackWebApi = {
		chat: { async postMessage() { return { ts: "101.1" }; } },
		conversations: {
			async replies() { return { messages: [] }; },
			async history() {
				historyCalls += 1;
				if (historyCalls === 2) await heldHistory;
				return {};
			},
		},
		auth: { async test() { return { bot_id: "BHIVE", user_id: "UHIVE" }; } },
	};
	const transport = new SlackWebTransport("xoxb-test", web);
	await transport.preflight(["C1"]);
	assert.equal(transport.botReadiness().bot, "ready");

	const recheck = transport.preflight(["C1"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(transport.botReadiness().bot, "ready");
	releaseHistory();
	await recheck;
	assert.equal(transport.botReadiness().bot, "ready");
});

test("Slack replay fails closed at message, byte, cursor, and page bounds", async () => {
	const oversizedCount = new SlackWebTransport("xoxb-test", webWithReplies(async () => ({
		messages: Array.from({ length: 401 }, (_, index) => ({ ts: String(index) })),
	})));
	await assert.rejects(() => oversizedCount.replay("C1", "100.1"), /slack_replay_limit_exceeded/);

	const oversizedBytes = new SlackWebTransport("xoxb-test", webWithReplies(async () => ({
		messages: [{ text: "x".repeat(140_000) }, { text: "y".repeat(140_000) }],
	})));
	await assert.rejects(() => oversizedBytes.replay("C1", "100.1"), /slack_replay_limit_exceeded/);

	let repeatedCalls = 0;
	const repeatedCursor = new SlackWebTransport("xoxb-test", webWithReplies(async () => {
		repeatedCalls += 1;
		return { messages: [], response_metadata: { next_cursor: "same" } };
	}));
	await assert.rejects(() => repeatedCursor.replay("C1", "100.1"), /slack_replay_cursor_repeated/);
	assert.equal(repeatedCalls, 2);

	let pages = 0;
	const endless = new SlackWebTransport("xoxb-test", webWithReplies(async () => {
		pages += 1;
		return { messages: [], response_metadata: { next_cursor: `cursor-${pages}` } };
	}));
	await assert.rejects(() => endless.replay("C1", "100.1"), /slack_replay_page_limit_exceeded/);
	assert.equal(pages, 20);
});

test("Slack reconciliation is streaming and bounded even across unique empty cursors", async () => {
	let pages = 0;
	const transport = new SlackWebTransport("xoxb-test", webWithReplies(async () => {
		pages += 1;
		return { messages: [], response_metadata: { next_cursor: `cursor-${pages}` } };
	}));
	await assert.rejects(
		() => transport.findReply("C1", "100.1", { outbox_key: "completion:1", outbox_nonce: "nonce" }),
		/slack_reconciliation_page_limit_exceeded/,
	);
	assert.equal(pages, 20);
	assert.deepEqual(slackWebClientOptions(), {
		retryConfig: { retries: 0 },
		rejectRateLimitedCalls: true,
		timeout: 8_000,
	});
});

function webWithReplies(
	replies: SlackWebApi["conversations"]["replies"],
): SlackWebApi {
	return {
		chat: { async postMessage() { return { ts: "101.1" }; } },
		conversations: { replies },
		auth: { async test() { return { bot_id: "BHIVE", user_id: "UHIVE" }; } },
	};
}
