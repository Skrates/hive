import type {
	AttachmentUpdate,
	BindingUpdate,
	BrokerOperatorStatus,
	DeliveryOperatorSummary,
	DeliveryStatus,
	ChannelListenerUpdate,
	EgressPolicyUpdate,
	OutboxReconciliation,
	OutboxReconciliationAudit,
	SlackOutboxOperatorSummary,
	SlackOutboxState,
	Subscription,
} from "../domain.js";

export class OperatorClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string, private readonly adminToken: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	async status(options: { actor?: string; staleAfterMs?: number } = {}): Promise<BrokerOperatorStatus> {
		const params = new URLSearchParams();
		if (options.actor) params.set("actor", options.actor);
		if (options.staleAfterMs !== undefined) params.set("stale_after_ms", String(options.staleAfterMs));
		return this.get(`/v1/admin/status${params.size > 0 ? `?${params}` : ""}`);
	}

	deliveries(options: {
		actor?: string;
		status?: DeliveryStatus;
		limit?: number;
	} = {}): Promise<DeliveryOperatorSummary[]> {
		const params = new URLSearchParams();
		if (options.actor) params.set("actor", options.actor);
		if (options.status) params.set("status", options.status);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		return this.get(`/v1/admin/deliveries${params.size > 0 ? `?${params}` : ""}`);
	}

	outbox(options: { state?: SlackOutboxState; limit?: number } = {}): Promise<SlackOutboxOperatorSummary[]> {
		const params = new URLSearchParams();
		if (options.state) params.set("state", options.state);
		if (options.limit !== undefined) params.set("limit", String(options.limit));
		return this.get(`/v1/admin/outbox${params.size > 0 ? `?${params}` : ""}`);
	}

	bind(actor: string, update: BindingUpdate): Promise<Subscription> {
		return this.request(`/v1/admin/subscriptions/${encodeURIComponent(actor)}/binding`, {
			method: "PATCH",
			body: JSON.stringify(update),
		});
	}

	attach(actor: string, update: AttachmentUpdate): Promise<Subscription> {
		return this.request(`/v1/admin/subscriptions/${encodeURIComponent(actor)}/attachment`, {
			method: "PUT",
			body: JSON.stringify(update),
		});
	}

	setChannelListener(actor: string, update: ChannelListenerUpdate): Promise<Subscription> {
		return this.request(`/v1/admin/subscriptions/${encodeURIComponent(actor)}/listener`, {
			method: "PATCH",
			body: JSON.stringify(update),
		});
	}

	setBindingMode(actor: string, mode: "auto" | "pinned"): Promise<Subscription> {
		return this.request(`/v1/admin/subscriptions/${encodeURIComponent(actor)}/binding-mode`, {
			method: "PATCH",
			body: JSON.stringify({ mode }),
		});
	}

	setEgressPolicy(actor: string, update: EgressPolicyUpdate): Promise<Subscription> {
		return this.request(`/v1/admin/subscriptions/${encodeURIComponent(actor)}/egress`, {
			method: "PATCH",
			body: JSON.stringify(update),
		});
	}

	reconcile(
		deliveryId: number,
		disposition: "processed" | "requeue",
		detail: string,
	): Promise<DeliveryOperatorSummary> {
		return this.request(`/v1/admin/deliveries/${deliveryId}/reconcile`, {
			method: "POST",
			body: JSON.stringify({ disposition, detail }),
		});
	}

	reconcileOutbox(outboxId: number, input: OutboxReconciliation): Promise<SlackOutboxOperatorSummary> {
		return this.request(`/v1/admin/outbox/${outboxId}/reconcile`, {
			method: "POST",
			body: JSON.stringify(input),
		});
	}

	outboxAudit(outboxId: number): Promise<OutboxReconciliationAudit[]> {
		return this.get(`/v1/admin/outbox/${outboxId}/audit`);
	}

	private get<T>(path: string): Promise<T> {
		return this.request(path, { method: "GET" });
	}

	private async request<T>(path: string, init: RequestInit): Promise<T> {
		const signal = init.signal
			? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
			: AbortSignal.timeout(10_000);
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			signal,
			headers: {
				authorization: `Bearer ${this.adminToken}`,
				...(init.body ? { "content-type": "application/json" } : {}),
			},
		});
		if (!response.ok) throw new Error(`broker ${response.status}: ${await response.text()}`);
		return await response.json() as T;
	}
}
