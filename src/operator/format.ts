import type {
	BrokerOperatorStatus,
	DeliveryOperatorSummary,
	DeliveryStatus,
	SlackOutboxState,
	SlackOutboxOperatorSummary,
} from "../domain.js";

const STATUS_ORDER: DeliveryStatus[] = [
	"pending",
	"claimed",
	"accepted_local",
	"dispatching",
	"dispatched",
	"processed",
	"undeliverable",
	"ambiguous",
	"dead_letter",
];
const OUTBOX_ORDER: SlackOutboxState[] = ["pending", "sending", "sent", "ambiguous", "dead"];

export function formatOperatorStatus(status: BrokerOperatorStatus): string {
	const slackState = status.slack.ready ? "READY" : "ATTENTION";
	const lines = [
		`Hive status ${status.generatedAt}`,
		`Slack ${slackState} · socket ${status.slack.socket} · bot ${status.slack.bot}`,
		"",
		"Edges",
	];
	if (status.edges.length === 0) lines.push("  - none registered");
	for (const edge of status.edges) {
		const state = !edge.enabled ? "DISABLED" : edge.connected ? "READY" : "STALE";
		const seen = edge.lastSeenAt ? relativeAge(edge.lastSeenAt, status.generatedAt) : "never seen";
		lines.push(`  ${state.padEnd(8)} ${edge.edgeId} · ${seen}`);
	}

	lines.push("", "Actors");
	if (status.actors.length === 0) lines.push("  - no matching subscriptions");
	for (const actor of status.actors) {
		const sub = actor.subscription;
		const state = actor.warnings.length === 0 ? "READY" : "ATTENTION";
		lines.push(`  ${state.padEnd(9)} ${sub.actor} · ${sub.provider}/${sub.providerSurface} ${sub.providerVersion}`);
		lines.push(`            session ${sub.sessionId ?? "unbound"}`);
		lines.push(`            binding ${sub.bindingMode} · ${sub.bindingSource} · revision ${sub.bindingRevision}`);
		lines.push(
			`            home ${sub.homeEdge} · workspace ${sub.workspace} · wake ${sub.wakePolicy}`,
		);
		lines.push(`            permission ${sub.permissionProfile}`);
		if (actor.livePresence) {
			const live = actor.livePresence;
			const state = live.ownerLoaded ? "connected" : `unavailable (${live.reason ?? "owner_not_loaded"})`;
			lines.push(
				`            live ${state} via ${live.transport} · ${relativeAge(live.updatedAt, status.generatedAt)}`,
			);
		} else {
			lines.push("            live not observed");
		}
		if (actor.lease) {
			const leaseState = actor.lease.active ? "active" : "expired";
			lines.push(
				`            lease ${leaseState} on ${actor.lease.edgeId} generation ${actor.lease.generation}`,
			);
		}
		for (const warning of actor.warnings) lines.push(`            ! ${warning}`);
	}

	lines.push("", `Deliveries  ${formatCounts(status.deliveryCounts)}`);
	lines.push(`Slack outbox  ${formatOutboxCounts(status.outboxCounts)}`);
	if (status.outboxCounts.ambiguous > 0 || status.outboxCounts.dead > 0) {
		lines.push(
			`ATTENTION   Slack outbox requires reconciliation (ambiguous=${status.outboxCounts.ambiguous} · dead=${status.outboxCounts.dead})`,
		);
	}
	if (status.recentDeliveries.length > 0) {
		lines.push("", "Recent");
		for (const delivery of status.recentDeliveries.slice(0, 10)) {
			lines.push(formatDeliveryLine(delivery));
		}
	}
	const actionableOutbox = status.recentOutbox.filter((item) => item.state === "ambiguous" || item.state === "dead");
	if (actionableOutbox.length > 0) {
		lines.push("", "Slack outbox requiring attention");
		for (const item of actionableOutbox) {
			lines.push(
				`  #${item.id} ${item.state} · ${item.kind} · delivery ${item.deliveryId ?? "n/a"}`
				+ ` · channel ${item.channelId} · thread ${item.threadTs} · attempts ${item.attempts}`
				+ `${item.errorCode ? ` · ${item.errorCode}` : ""}`,
			);
		}
	}
	if (status.recentIngressDiagnostics.length > 0) {
		lines.push("", "Ignored or unroutable ingress");
		for (const diagnostic of status.recentIngressDiagnostics.slice(0, 10)) {
			lines.push(
				`  #${diagnostic.id} ${diagnostic.reason} · channel ${diagnostic.channelId} · thread ${diagnostic.threadTs}`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function formatOperatorDeliveries(deliveries: DeliveryOperatorSummary[]): string {
	if (deliveries.length === 0) return "No matching deliveries.\n";
	return `${deliveries.map(formatDeliveryLine).join("\n")}\n`;
}

export function formatOperatorOutbox(items: SlackOutboxOperatorSummary[]): string {
	if (items.length === 0) return "No matching Slack outbox rows.\n";
	return `${items.map((item) =>
		`  #${item.id} ${item.state.padEnd(9)} ${item.kind} · delivery ${item.deliveryId ?? "n/a"}`
		+ ` · channel ${item.channelId} · thread ${item.threadTs} · attempts ${item.attempts}`
		+ `${item.errorCode ? ` · ${item.errorCode}` : ""}`).join("\n")}\n`;
}

function formatCounts(counts: Record<DeliveryStatus, number>): string {
	const values = STATUS_ORDER.filter((status) => counts[status] > 0)
		.map((status) => `${status}=${counts[status]}`);
	return values.length > 0 ? values.join(" · ") : "none";
}

function formatOutboxCounts(counts: Record<SlackOutboxState, number>): string {
	const values = OUTBOX_ORDER.filter((state) => counts[state] > 0)
		.map((state) => `${state}=${counts[state]}`);
	return values.length > 0 ? values.join(" · ") : "none";
}

function formatDeliveryLine(delivery: DeliveryOperatorSummary): string {
	const reason = delivery.reasons[0]?.code ? ` · ${delivery.reasons[0].code}` : "";
	const retry = delivery.availableAt ? ` · retry ${delivery.availableAt}` : "";
	const binding = ` · session ${delivery.binding.sessionId ?? "unbound"} rev ${delivery.binding.revision}`;
	const spawned = delivery.spawnedSessionId ? ` · spawned ${delivery.spawnedSessionId} on ${delivery.spawnedOnEdge}` : "";
	return `  #${delivery.id} ${delivery.status.padEnd(13)} ${delivery.actor} · attempts ${delivery.attempts}`
		+ `${binding}${spawned}${retry}${reason}`;
}

function relativeAge(value: string, reference: string): string {
	const milliseconds = Math.max(0, new Date(reference).getTime() - new Date(value).getTime());
	if (milliseconds < 1_000) return "seen now";
	if (milliseconds < 60_000) return `seen ${Math.floor(milliseconds / 1_000)}s ago`;
	if (milliseconds < 3_600_000) return `seen ${Math.floor(milliseconds / 60_000)}m ago`;
	return `seen ${Math.floor(milliseconds / 3_600_000)}h ago`;
}
