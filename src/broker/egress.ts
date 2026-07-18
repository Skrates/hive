import type { Subscription } from "../domain.js";

export const MAX_SLACK_EGRESS_BYTES = 2_800;

export function completionReceipt(actorValue: string, deliveryId: number): string {
	const actor = actorValue.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "actor";
	return `Hive: ${actor} completed delivery ${deliveryId}.`;
}

export function selectCompletionText(
	subscription: Subscription,
	channelId: string,
	deliveryId: number,
	providerReceipt: string | null,
): string {
	const fallback = completionReceipt(subscription.actor, deliveryId);
	if (subscription.egressPolicy !== "assistant_text"
		|| !subscription.egressChannelIds.includes(channelId)
		|| providerReceipt === null) return fallback;
	const candidate = extractAssistantText(providerReceipt)?.trim();
	if (!candidate) return fallback;
	return capUtf8Bytes(`${fallback}\n\n${escapeSlack(candidate)}`, MAX_SLACK_EGRESS_BYTES);
}

export function extractAssistantText(receipt: string): string | null {
	const parsed = parseJson(receipt);
	const direct = assistantTextFromValue(parsed);
	if (direct) return direct;
	const lines = receipt.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const candidate = assistantTextFromValue(parseJson(lines[index] ?? ""));
		if (candidate) return candidate;
	}
	return null;
}

export function escapeSlack(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function capUtf8Bytes(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	const suffix = "…";
	const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix));
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const size = Buffer.byteLength(character);
		if (bytes + size > contentLimit) break;
		result += character;
		bytes += size;
	}
	return `${result}${suffix}`;
}

function assistantTextFromValue(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (value.type === "result"
		&& value.subtype === "success"
		&& value.is_error === false
		&& typeof value.result === "string") return value.result;
	if ((value.type === "item.completed" || value.type === "item_completed") && isRecord(value.item)
		&& (value.item.type === "agent_message" || value.item.type === "agentMessage")
		&& typeof value.item.text === "string") return value.item.text;
	return null;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
