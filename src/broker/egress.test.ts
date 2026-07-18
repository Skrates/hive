import assert from "node:assert/strict";
import test from "node:test";
import type { Subscription } from "../domain.js";
import {
	MAX_SLACK_EGRESS_BYTES,
	capUtf8Bytes,
	completionReceipt,
	escapeSlack,
	extractAssistantText,
	selectCompletionText,
} from "./egress.js";

function subscription(overrides: Partial<Subscription> = {}): Subscription {
	return {
		actor: "ariadne",
		provider: "codex",
		providerSurface: "desktop-ipc",
		providerVersion: "test",
		sessionId: "thread-1",
		homeEdge: "mac",
		workspace: "hive",
		edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
		wakePolicy: "live_only",
		permissionProfile: "read-only",
		leaseTtlMs: 30_000,
		deliveryTtlMs: 300_000,
		homeGraceMs: 0,
		spawnRateLimit: 1,
		expiresAt: null,
		updatedAt: "2026-07-18T00:00:00.000Z",
		bindingMode: "auto",
		bindingSource: "edge-discovery",
		bindingRevision: 2,
		egressPolicy: "receipt_only",
		egressChannelIds: [],
		...overrides,
	};
}

test("receipt-only egress never renders hostile provider prose", () => {
	const hostile = JSON.stringify({ type: "result", result: "<!channel> secret=" + "x".repeat(1_000_000) });
	assert.equal(
		selectCompletionText(subscription(), "C12345678", 42, hostile),
		completionReceipt("ariadne", 42),
	);
});

test("assistant text requires the exact admin allowlisted channel and is inert and bounded", () => {
	const enabled = subscription({ egressPolicy: "assistant_text", egressChannelIds: ["C12345678"] });
	const hostile = JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: `<@U12345678> & <!channel> ${"🧶".repeat(2_000)}`,
	});
	assert.equal(selectCompletionText(enabled, "C87654321", 7, hostile), completionReceipt("ariadne", 7));
	const selected = selectCompletionText(enabled, "C12345678", 7, hostile);
	assert.match(selected, /^Hive: ariadne completed delivery 7\.\n\n&lt;@U12345678&gt; &amp; &lt;!channel&gt;/);
	assert.ok(Buffer.byteLength(selected) <= MAX_SLACK_EGRESS_BYTES);
	assert.equal(selected.endsWith("…"), true);
});

test("only recognized final assistant result shapes are extracted", () => {
	assert.equal(extractAssistantText(JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "final",
	})), "final");
	assert.equal(extractAssistantText(JSON.stringify({ type: "result", result: "not-final" })), null);
	assert.equal(extractAssistantText(JSON.stringify({
		type: "result",
		subtype: "error",
		is_error: true,
		result: "failed",
	})), null);
	assert.equal(extractAssistantText([
		JSON.stringify({ type: "item.started", item: { type: "agent_message", text: "partial" } }),
		JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
	].join("\n")), "done");
	assert.equal(extractAssistantText("tool trace and arbitrary stdout"), null);
	assert.equal(escapeSlack("<x>&"), "&lt;x&gt;&amp;");
	assert.ok(Buffer.byteLength(capUtf8Bytes("🧶".repeat(10), 10)) <= 10);
});
