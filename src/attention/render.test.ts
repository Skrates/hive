import assert from "node:assert/strict";
import test from "node:test";
import type { ItemView } from "./contract.js";
import { packet } from "./fixtures.js";
import { inert, renderBrief, slackInert } from "./render.js";

test("A31 terminal controls, bidi overrides and Slack markup render inert while stored text is untouched", () => {
  const hostile = "ok\u001b[2J\u001b]0;pwned\u0007 ‮evil‬";
  assert.equal(inert(hostile), "ok\\u{1b}[2J\\u{1b}]0;pwned\\u{7} \\u{202e}evil\\u{202c}");
  assert.equal(inert("line one\nline two\ttab"), "line one\nline two\ttab");
  assert.equal(inert("a\nb", false), "a\\u{a}b");
  assert.equal(slackInert("<!channel> & <@U1>"), "&lt;!channel&gt; &amp; &lt;@U1&gt;");
  assert.equal(slackInert("Title\n🐝 wake minted by hakon"), "Title\\u{a}🐝 wake minted by hakon", "no forged extra line");
});

test("the brief fits one screen and names action, context, artifacts, unblock and route", () => {
  const view = {
    item_id: 42, human_id: "hakon", owner_principal: "seat:fable", origin: "seat", state: "active", revision: 3, ready_sequence: 7,
    deferred_until: null,
    packet: packet({ title: "Select the next render\u001b[31m", artifacts: [{ label: "Contact sheet", uri: "/srv/renders/sheet.png", edge_id: "pop-os", version: "r2" }] }),
    source: { actor: "fable", session_id: "s-1", edge_id: "pop-os" }, return_mode: "pinned_session",
    created_at: "2026-10-12T08:46:00.000Z", updated_at: "2026-10-12T08:46:00.000Z", claimed_at: null, resolved_at: null,
    outcome: null, response: null, terminal_reason: null, return: null,
  } as unknown as ItemView;
  const brief = renderBrief(view, new Date("2026-10-12T09:00:00.000Z"), 2);
  assert.ok(brief.split("\n").length <= 20);
  assert.match(brief, /^ATN-42 · birthday-film · Select the next render\\u\{1b\}\[31m$/mu);
  assert.match(brief, /^Do: Select candidate A, B, C or D/mu);
  assert.match(brief, /Contact sheet — \/srv\/renders\/sheet\.png @ r2 \[on edge pop-os\]/u, "a local path names the edge that owns it");
  assert.match(brief, /Unblocks: The next video-generation batch\. Estimated human time: 8 minutes\./u);
  assert.match(brief, /Return: originating seat fable, saved session s-1 on pop-os; summoned 14 minutes ago\./u);
  assert.match(brief, /Queue: 2 more waiting \(advisory; the queue moves\)\./u);
});

test("A31 optional artifact metadata and the surface-reported session render inert too", () => {
  const hostile = packet({
    artifacts: [{ label: "Sheet", uri: "https://example.invalid/sheet.png", version: "r2\u001b[2J\u001b[H\u202eevil", edge_id: "pop-os" }],
  });
  const stored = structuredClone(hostile);
  const view = {
    item_id: 43, human_id: "hakon", owner_principal: "seat:fable", origin: "seat", state: "active", revision: 1, ready_sequence: 9,
    deferred_until: null, packet: hostile,
    source: { actor: "fable", session_id: "s-1\u001b]0;pwned\u0007", edge_id: "pop-os" }, return_mode: "pinned_session",
    created_at: "2026-10-12T08:46:00.000Z", updated_at: "2026-10-12T08:46:00.000Z", claimed_at: null, resolved_at: null,
    outcome: null, response: null, terminal_reason: null, return: null,
  } as unknown as ItemView;
  const brief = renderBrief(view, new Date("2026-10-12T09:00:00.000Z"));
  assert.doesNotMatch(brief, /[\u001b\u0007\u202e]/u, "no raw control or bidi override survives");
  assert.match(brief, /Sheet — https:\/\/example\.invalid\/sheet\.png @ r2\\u\{1b\}\[2J\\u\{1b\}\[H\\u\{202e\}evil \[on edge pop-os\]/u);
  assert.match(brief, /saved session s-1\\u\{1b\}\]0;pwned\\u\{7\} on pop-os/u);
  assert.deepEqual(hostile, stored, "the stored packet is presentation-only, never rewritten");
});
