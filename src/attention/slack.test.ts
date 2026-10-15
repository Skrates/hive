import assert from "node:assert/strict";
import test from "node:test";
import type { ItemView } from "./contract.js";
import { act, harness, liveSource, next, summon, type Harness } from "./fixtures.js";
import { bootAttentionRuntime } from "./runtime.js";
import { AttentionService } from "./service.js";
import {
  AttentionSlackFrontEnd,
  cardBlocks,
  cardText,
  webClientSlackApi,
  homeView,
  decisionModal,
  derivedCommandId,
  type AttentionSlackApi,
  type SlackView,
} from "./slack.js";

const HUMAN = "U0HAKON01";

class FakeSlack implements AttentionSlackApi {
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  private ts = 1000;
  failPost = false;
  failHome = 0;
  async openDm(userId: string) { this.calls.push({ op: "openDm", args: [userId] }); return "D0HAKON"; }
  async post(channel: string, text: string, blocks: unknown[]) {
    this.calls.push({ op: "post", args: [channel, text, blocks] });
    if (this.failPost) throw Object.assign(new Error("slack down"), { code: "slack_webapi_request_error" });
    this.ts += 1;
    return `${this.ts}.000100`;
  }
  async update(channel: string, ts: string, text: string, blocks: unknown[]) { this.calls.push({ op: "update", args: [channel, ts, text, blocks] }); }
  async publishHome(userId: string, view: SlackView) {
    this.calls.push({ op: "publishHome", args: [userId, view] });
    if (this.failHome > 0) { this.failHome -= 1; throw new Error("views.publish failed"); }
  }
  async openModal(triggerId: string, view: SlackView) { this.calls.push({ op: "openModal", args: [triggerId, view] }); }
  ops(): string[] { return this.calls.map((call) => call.op); }
  clear(): void { this.calls.length = 0; }
}

function frontEnd(h: Harness, user = HUMAN, slack = new FakeSlack()) {
  const service = new AttentionService(h.store, h.broker, async () => {});
  return { slack, front: new AttentionSlackFrontEnd(h.store, service, slack, user, h.clock) };
}

/** Every text object that carries seat-written strings must be plain_text (S-6). */
function mrkdwnTexts(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (record.type === "mrkdwn" && typeof record.text === "string") found.push(record.text);
      Object.values(record).forEach(walk);
    }
  };
  walk(value);
  return found;
}

function blockAction(actionId: string, value: string, actionTs = "1792080000.000001", user = HUMAN) {
  return { type: "block_actions", user: { id: user }, trigger_id: "trig-1", actions: [{ action_id: actionId, value, action_ts: actionTs }] };
}

function submission(view: SlackView, values: Record<string, unknown>, user = HUMAN) {
  const state: Record<string, Record<string, unknown>> = {};
  for (const [block, value] of Object.entries(values)) state[block] = { value };
  return { type: "view_submission", user: { id: user }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: state } } };
}

test("S-6 seat text renders only as plain_text; Hive's own labels are the only mrkdwn", () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source, { title: "<!channel> *bold* \u001b[2J", requested_action: "<https://evil|click> me", context: "_x_", unblocks: "`y`" }).item!;
  const view = h.store.item(item.item_id)!;
  const blocks = cardBlocks(view, h.clock.now());
  const seatStrings = ["<!channel>", "<https://evil|click>", "_x_", "`y`", "\u001b"];
  for (const text of mrkdwnTexts(blocks)) {
    for (const seat of seatStrings) assert.ok(!text.includes(seat), `mrkdwn must not carry seat text: ${text}`);
  }
  const serialized = JSON.stringify(blocks);
  assert.ok(serialized.includes("<!channel> *bold*"), "seat text is shown, verbatim, as plain text");
  assert.ok(!serialized.includes("\\u001b[2J"), "control characters are made inert");
  for (const text of mrkdwnTexts(decisionModal(view))) assert.ok(!text.includes("<!channel>"));
  h.close();
});

test("S-1/S-3 a queued card offers Take next first and Answer this one; a closed item has no buttons", () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source).item!;
  const actions = (view: ItemView) => cardBlocks(view, h.clock.now()).find((block) => block.type === "actions") as { elements: Array<{ action_id: string; style?: string }> } | undefined;
  const queued = actions(h.store.item(item.item_id)!)!;
  assert.deepEqual(queued.elements.map((element) => element.action_id), ["atn_take_next", "atn_answer_this"]);
  assert.equal(queued.elements[0]!.style, "primary");
  const taken = next(h.store);
  assert.deepEqual(actions(h.store.item(item.item_id)!)!.elements.map((element) => element.action_id), ["atn_take_next", "atn_decide"]);
  act(h.store, { kind: "operator" }, "cancel", { item_id: item.item_id, expected_revision: taken.item!.revision, reason: "moot", select_next: false });
  assert.equal(actions(h.store.item(item.item_id)!), undefined);
  h.close();
});

test("S-1/S-7 one post per summons, later changes update the same card, and a Slack outage is retried", async () => {
  const h = harness();
  const { slack, front } = frontEnd(h);
  const source = liveSource(h.store);
  slack.failPost = true;
  const item = summon(h.store, source).item!;
  assert.equal(await front.drainOnce(), 0, "Slack down: nothing recorded, the command already stood");
  slack.failPost = false;
  slack.clear();
  assert.equal(await front.drainOnce(), 1);
  assert.deepEqual(slack.ops(), ["post", "publishHome"], "the DM channel opened during the outage is reused");
  slack.clear();
  assert.equal(await front.drainOnce(), 0, "an up-to-date card is not touched");
  assert.deepEqual(slack.ops(), []);
  act(h.store, source, "amend", { item_id: item.item_id, expected_revision: 1, fields: { title: "A sharper title" } });
  await front.drainOnce();
  assert.deepEqual(slack.ops(), ["update", "publishHome"], "an amendment re-renders in place and never notifies again");
  assert.match(String(slack.calls[0]!.args[2]), /A sharper title/u);
  h.close();
});

test("S-4 only the configured human's interactions act; anyone else changes nothing", async () => {
  const h = harness();
  const { slack, front } = frontEnd(h);
  const item = summon(h.store, liveSource(h.store)).item!;
  const result = await front.interactive(blockAction("atn_take_next", "next", "1.1", "U0STRANGER"));
  assert.equal(result.after, undefined);
  assert.equal(h.store.item(item.item_id)!.state, "queued");
  assert.deepEqual(slack.ops(), []);
  h.close();
});

test("S-3 Take next claims FIFO and opens its modal; a redelivered press replays instead of acting twice", async () => {
  const h = harness();
  const { slack, front } = frontEnd(h);
  const source = liveSource(h.store);
  const first = summon(h.store, source, { intervention_key: "a" }).item!;
  const second = summon(h.store, source, { intervention_key: "b" }).item!;
  const press = blockAction("atn_answer_this", String(second.item_id), "1792080000.000002");
  const result = await front.interactive(press);
  await result.after!();
  assert.equal(h.store.item(second.item_id)!.state, "active", "an explicit pick claims that item");
  assert.equal(h.store.item(first.item_id)!.state, "queued");
  const opened = slack.calls.find((call) => call.op === "openModal")!;
  assert.equal((opened.args[1] as SlackView).callback_id, "atn_decision");
  assert.equal(JSON.parse(String((opened.args[1] as SlackView).private_metadata)).item_id, second.item_id);
  const before = h.store.events(second.item_id).length;
  await (await front.interactive(press)).after!();
  assert.equal(h.store.events(second.item_id).length, before, "the same press replays its committed next");
  assert.equal(derivedCommandId("x"), derivedCommandId("x"));
  assert.match(derivedCommandId("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  h.close();
});

test("S-5 a modal resolves once, replays on resubmit, and refuses an outdated packet", async () => {
  const h = harness();
  const { front } = frontEnd(h);
  const source = liveSource(h.store);
  const item = summon(h.store, source).item!;
  next(h.store);
  const modal = decisionModal(h.store.item(item.item_id)!);

  const incomplete = await front.interactive(submission(modal, { decision: { selected_option: { value: "resolve" } } }));
  assert.equal(incomplete.ack!.response_action, "errors");
  assert.deepEqual(Object.keys(incomplete.ack!.errors as object).sort(), ["outcome", "response"]);

  const values = {
    decision: { selected_option: { value: "resolve" } },
    outcome: { selected_option: { value: "selected" } },
    response: { value: "Use candidate C." },
    next: { selected_options: [] },
  };
  const done = await front.interactive(submission(modal, values));
  assert.equal(done.ack!.response_action, "clear");
  const resolved = h.store.item(item.item_id)!;
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.response, "Use candidate C.");
  const again = await front.interactive(submission(modal, values));
  assert.equal(again.ack!.response_action, "clear", "a resubmission replays the committed decision");
  assert.equal(h.store.events(item.item_id).filter((event) => event.event_type === "resolved").length, 1);

  // A packet amended after the modal opened: the decision is never applied to the old one.
  const other = summon(h.store, source, { intervention_key: "later" }).item!;
  const taken = next(h.store);
  const stale = decisionModal(h.store.item(other.item_id)!);
  act(h.store, source, "amend", { item_id: other.item_id, expected_revision: taken.item!.revision, fields: { context: "The artifact changed." } });
  const refused = await front.interactive(submission(stale, values));
  assert.equal(refused.ack!.response_action, "update");
  assert.match(JSON.stringify(refused.ack!.view), /This item changed/u);
  assert.equal(h.store.item(other.item_id)!.state, "active");
  h.close();
});

test("S-2 'take next' after a decision turns the modal into the next item's", async () => {
  const h = harness();
  const { front } = frontEnd(h);
  const source = liveSource(h.store);
  const first = summon(h.store, source, { intervention_key: "a" }).item!;
  const second = summon(h.store, source, { intervention_key: "b" }).item!;
  next(h.store);
  const modal = decisionModal(h.store.item(first.item_id)!);
  const result = await front.interactive(submission(modal, {
    decision: { selected_option: { value: "defer" } },
    reason: { value: "Waiting on the render." },
    next: { selected_options: [{ value: "next" }] },
  }));
  assert.equal(result.ack!.response_action, "update");
  assert.equal(JSON.parse(String((result.ack!.view as SlackView).private_metadata)).item_id, second.item_id);
  assert.equal(h.store.item(first.item_id)!.state, "deferred");
  assert.equal(h.store.item(second.item_id)!.state, "active");
  h.close();
});

test("S-8 the front end exists only when attention is enabled and the human's Slack user is configured", () => {
  const h = harness();
  const slackApi = new FakeSlack();
  const boot = (env: Record<string, string>) => bootAttentionRuntime({
    broker: h.broker, clock: h.clock, adminToken: "a".repeat(40), env, validateThread: async () => {}, log: () => {}, slackApi,
  });
  assert.notEqual(boot({ HIVE_ATTENTION_ENABLED: "true", HIVE_ATTENTION_SLACK_USER_ID: HUMAN }).slack, null);
  assert.equal(boot({ HIVE_ATTENTION_ENABLED: "true" }).slack, null);
  assert.equal(boot({ HIVE_ATTENTION_ENABLED: "false", HIVE_ATTENTION_SLACK_USER_ID: HUMAN }).slack, null);
  assert.throws(() => boot({ HIVE_ATTENTION_ENABLED: "true", HIVE_ATTENTION_SLACK_USER_ID: "hakon" }), /not a Slack user id/u);
  h.close();
});

test("S-1 a summons closed before the first sync still gets its one card; older closed items never do", async () => {
  const h = harness();
  const source = liveSource(h.store);
  const old = summon(h.store, source, { intervention_key: "old" }).item!;
  act(h.store, source, "withdraw", { item_id: old.item_id, expected_revision: 1, reason: "moot" });
  h.clock.advance(1000);
  const { slack, front } = frontEnd(h);
  await front.drainOnce();
  assert.deepEqual(slack.ops(), ["publishHome"], "nothing older than the front end is announced after the fact; only the startup Home publication");
  const quick = summon(h.store, source, { intervention_key: "quick" }).item!;
  act(h.store, source, "withdraw", { item_id: quick.item_id, expected_revision: 1, reason: "moot" });
  await front.drainOnce();
  const posted = slack.calls.filter((call) => call.op === "post");
  assert.equal(posted.length, 1);
  assert.equal((posted[0]!.args[2] as Array<{ type: string }>).some((block) => block.type === "actions"), false, "rendered closed, without buttons");
  h.close();
});

test("S-1 the cutoff is activation: a summons created and closed before the first drain still gets its card", async () => {
  const h = harness();
  const source = liveSource(h.store);
  const old = summon(h.store, source, { intervention_key: "old" }).item!;
  act(h.store, source, "withdraw", { item_id: old.item_id, expected_revision: 1, reason: "moot" });
  h.clock.advance(1000);
  const { slack, front } = frontEnd(h); // no drain yet: HTTP could already be taking commands
  h.clock.advance(1000);
  const quick = summon(h.store, source, { intervention_key: "quick" }).item!;
  h.clock.advance(1000);
  act(h.store, source, "withdraw", { item_id: quick.item_id, expected_revision: 1, reason: "moot" });
  h.clock.advance(3000);
  assert.equal(await front.drainOnce(), 1);
  assert.equal(slack.calls.filter((call) => call.op === "post").length, 1, "the window before the first drain is covered; older history is not");
  h.close();
});

test("the Home tab lists a due deferral with what Take next selects, and shows packet deadlines", () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source, { deadline_at: "2026-10-20T12:00:00.000Z" }).item!;
  const taken = next(h.store);
  act(h.store, { kind: "operator" }, "defer", { item_id: item.item_id, expected_revision: taken.item!.revision, reason: "later", until: new Date(h.clock.now().getTime() + 60_000).toISOString(), select_next: false });
  h.clock.advance(120_000);
  const page = h.store.queue("hakon", { states: ["active", "queued", "deferred"] });
  const home = JSON.stringify(homeView(page, h.clock.now()));
  assert.doesNotMatch(home, /nothing waiting/u);
  assert.doesNotMatch(home, /Deferred/u, "a due deferral is eligible, not deferred");
  const view = h.store.item(item.item_id)!;
  assert.match(JSON.stringify(cardBlocks(view, h.clock.now())), /Deadline\* 2026-10-20T12:00:00.000Z/u);
  assert.match(JSON.stringify(decisionModal(view)), /Deadline: 2026-10-20T12:00:00.000Z/u);
  h.close();
});

test("S-2 the response reaches the seat verbatim, whitespace included", async () => {
  const h = harness();
  const { front } = frontEnd(h);
  const item = summon(h.store, liveSource(h.store)).item!;
  next(h.store);
  const modal = decisionModal(h.store.item(item.item_id)!);
  const response = "  keep this indentation:\n    return 1\n";
  await front.interactive(submission(modal, {
    decision: { selected_option: { value: "resolve" } }, outcome: { selected_option: { value: "answered" } }, response: { value: response },
  }));
  assert.equal(h.store.item(item.item_id)!.response, response);
  h.close();
});

test("S-7 a failed Home publication is retried on the next pass even with no card change", async () => {
  const h = harness();
  const { slack, front } = frontEnd(h);
  summon(h.store, liveSource(h.store));
  slack.failHome = 1;
  await front.drainOnce();
  slack.clear();
  await front.drainOnce();
  assert.deepEqual(slack.ops(), ["publishHome"]);
  slack.clear();
  await front.drainOnce();
  assert.deepEqual(slack.ops(), [], "once published, nothing repeats");
  h.close();
});

test("S-4 a changed Slack human gets the cards; the former account stops receiving updates", async () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source).item!;
  const before = frontEnd(h);
  await before.front.drainOnce();
  const after = frontEnd(h, "U0NEWHUMAN");
  await after.front.drainOnce();
  assert.deepEqual(after.slack.ops(), ["openDm", "post", "publishHome"]);
  assert.equal(after.slack.calls[0]!.args[0], "U0NEWHUMAN");
  act(h.store, source, "amend", { item_id: item.item_id, expected_revision: 1, fields: { title: "Retitled" } });
  before.slack.clear();
  await after.front.drainOnce();
  assert.equal(after.slack.ops()[after.slack.ops().length - 2], "update");
  assert.deepEqual(before.slack.ops(), [], "the former account's card is no longer touched");
  h.close();
});

test("S-7 time alone makes Home stale: a deferral that comes due is published without any write", async () => {
  const h = harness();
  const { slack, front } = frontEnd(h);
  const item = summon(h.store, liveSource(h.store)).item!;
  const taken = next(h.store);
  act(h.store, { kind: "operator" }, "defer", { item_id: item.item_id, expected_revision: taken.item!.revision, reason: "later", until: new Date(h.clock.now().getTime() + 60_000).toISOString(), select_next: false });
  await front.drainOnce();
  assert.match(JSON.stringify(slack.calls.filter((c) => c.op === "publishHome").at(-1)!.args[1]), /nothing waiting/u);
  slack.clear();
  await front.drainOnce();
  assert.deepEqual(slack.ops(), [], "before it is due nothing repeats");
  h.clock.advance(120_000);
  await front.drainOnce();
  assert.deepEqual(slack.ops(), ["publishHome"]);
  assert.doesNotMatch(JSON.stringify(slack.calls[0]!.args[1]), /nothing waiting/u);
  slack.clear();
  await front.drainOnce();
  assert.deepEqual(slack.ops(), [], "published once");
  h.close();
});

test("S-6 the notification fallback carries no Slack control characters and the adapter disables parsing", async () => {
  const h = harness();
  const item = summon(h.store, liveSource(h.store), { title: "<@U_TEST> <https://x.test|go> *bold* & more" }).item!;
  const text = cardText(h.store.item(item.item_id)!);
  assert.doesNotMatch(text, /[<>&]/u);
  const sent: Array<Record<string, unknown>> = [];
  const web = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => { sent.push(args); return { ts: "1.1" }; },
      update: async (args: Record<string, unknown>) => { sent.push(args); },
    },
  };
  const api = webClientSlackApi(web as never);
  await api.post("D1", text, []);
  await api.update("D1", "1.1", text, []);
  for (const args of sent) {
    assert.equal(args.parse, "none");
    assert.equal(args.link_names, false);
  }
  assert.equal(sent[0]!.mrkdwn, false);
  h.close();
});

test("S-1 a card whose message is gone for good is retired durably: no replacement post, across mutation and restart; a transient error stays retryable", async () => {
  const h = harness();
  const source = liveSource(h.store);
  const item = summon(h.store, source).item!;
  const slack = new FakeSlack();
  const { front } = frontEnd(h, HUMAN, slack);
  await front.drainOnce();
  let mode: "gone" | "transient" = "transient";
  slack.update = async (channel: string, ts: string, text: string, blocks: unknown[]) => {
    slack.calls.push({ op: "update", args: [channel, ts, text, blocks] });
    throw Object.assign(new Error("x"), mode === "gone" ? { data: { error: "message_not_found" } } : { code: "slack_webapi_request_error" });
  };
  act(h.store, source, "amend", { item_id: item.item_id, expected_revision: 1, fields: { title: "Retitled" } });
  slack.clear();
  await front.drainOnce();
  assert.deepEqual(slack.ops().filter((op) => op === "post"), [], "transient failure keeps the card due, no recovery post");
  slack.clear();
  await front.drainOnce();
  assert.equal(slack.ops().filter((op) => op === "update").length, 1, "and it is retried");
  mode = "gone";
  slack.clear();
  await front.drainOnce();
  assert.deepEqual(slack.ops().filter((op) => op === "post"), [], "S-1: never a replacement notification");
  assert.equal(slack.ops().filter((op) => op === "update").length, 1);
  act(h.store, source, "amend", { item_id: item.item_id, expected_revision: 2, fields: { title: "Retitled again" } });
  const restarted = frontEnd(h, HUMAN, slack);
  slack.clear();
  await front.drainOnce();
  await restarted.front.drainOnce();
  assert.deepEqual(slack.ops().filter((op) => op === "update" || op === "post"), [], "later mutation and restart: no update loop, no post");
  assert.ok(slack.ops().includes("publishHome"), "Home still shows the item");
  h.close();
});

test("S-7 Home is published at startup, so a deferral already in the store is refreshed when it comes due without any write", async () => {
  const h = harness();
  const first = frontEnd(h);
  const item = summon(h.store, liveSource(h.store)).item!;
  const taken = next(h.store);
  act(h.store, { kind: "operator" }, "defer", { item_id: item.item_id, expected_revision: taken.item!.revision, reason: "later", until: new Date(h.clock.now().getTime() + 60_000).toISOString(), select_next: false });
  await first.front.drainOnce();
  const restarted = frontEnd(h); // new process: forgets the next due time; every card row is already current
  await restarted.front.drainOnce();
  assert.deepEqual(restarted.slack.ops(), ["publishHome"], "startup publishes Home once, with no card change");
  restarted.slack.clear();
  await restarted.front.drainOnce();
  assert.deepEqual(restarted.slack.ops(), [], "before it is due nothing repeats");
  h.clock.advance(120_000);
  await restarted.front.drainOnce();
  assert.deepEqual(restarted.slack.ops(), ["publishHome"]);
  assert.doesNotMatch(JSON.stringify(restarted.slack.calls[0]!.args[1]), /nothing waiting/u);
  h.close();
});

test("S-2 required decision fields survive their display budgets in the modal", () => {
  const h = harness();
  const item = summon(h.store, liveSource(h.store), {
    requested_action: "a".repeat(1500), context: "c".repeat(3000), unblocks: "UNBLOCKS-MARK", deadline_at: "2026-10-20T12:00:00.000Z",
  }).item!;
  const modal = JSON.stringify(decisionModal(h.store.item(item.item_id)!));
  assert.match(modal, /Unblocks: UNBLOCKS-MARK/u);
  assert.match(modal, /Deadline: 2026-10-20T12:00:00.000Z/u);
  h.close();
});
