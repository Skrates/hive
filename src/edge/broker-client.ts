import type {
	Delivery,
	DeliveryResultInput,
	LivePresence,
	LivePresenceInput,
	ReplaySnapshot,
	SubscriptionBinding,
	AutoBindingTarget,
	AutoBindingUpdate,
	SubscriptionInput,
} from "../domain.js";

export class BrokerClient {
  constructor(
    private readonly baseUrl: string,
    readonly edgeId: string,
    private readonly token: string,
  ) {}

	async claim(after: number, waitMs = 25_000, signal?: AbortSignal): Promise<Delivery | null> {
	const response = await this.request(
		`/v1/deliveries?after=${after}&wait_ms=${waitMs}`,
		{ method: "GET", ...(signal ? { signal } : {}) },
		Math.min(Math.max(waitMs, 0), 30_000) + 5_000,
	);
    if (response.status === 204) return null;
    return this.json<Delivery>(response);
  }

	async probe(signal?: AbortSignal): Promise<void> {
		const response = await this.request("/v1/edge/health", { method: "GET", ...(signal ? { signal } : {}) });
		await this.json<{ ok: true }>(response);
	}

  accept(delivery: Delivery, signal?: AbortSignal): Promise<Delivery> {
    return this.transition(delivery, "accept", signal);
  }

  beginDispatch(delivery: Delivery, signal?: AbortSignal): Promise<Delivery> {
    return this.transition(delivery, "dispatch", signal);
  }

  markDispatched(delivery: Delivery, signal?: AbortSignal): Promise<Delivery> {
    return this.transition(delivery, "dispatched", signal);
  }

	  renew(delivery: Delivery, signal?: AbortSignal): Promise<Delivery> {
    return this.transition(delivery, "renew", signal);
	  }

	releasePreProvider(
		delivery: Delivery,
		reason: PreProviderReleaseReason,
		signal?: AbortSignal,
	): Promise<Delivery> {
		return this.request(`/v1/deliveries/${delivery.id}/release-pre-provider`, {
			method: "POST",
			body: JSON.stringify({ generation: requiredGeneration(delivery), reason }),
			...(signal ? { signal } : {}),
		}).then((response) => this.json<Delivery>(response));
	}

  async reserveSpawn(delivery: Delivery, signal?: AbortSignal): Promise<boolean> {
    const response = await this.request(`/v1/deliveries/${delivery.id}/reserve-spawn`, {
      method: "POST",
      body: JSON.stringify({ generation: requiredGeneration(delivery) }),
      ...(signal ? { signal } : {}),
    });
    return (await this.json<{ reserved: boolean }>(response)).reserved;
  }

  async finish(delivery: Delivery, result: DeliveryResultInput, signal?: AbortSignal): Promise<Delivery> {
    const response = await this.request(`/v1/deliveries/${delivery.id}/result`, {
      method: "POST",
      body: JSON.stringify(result),
      ...(signal ? { signal } : {}),
    });
    return this.json<Delivery>(response);
  }

  async reply(delivery: Delivery, text: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(`/v1/deliveries/${delivery.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ generation: requiredGeneration(delivery), text }),
      ...(signal ? { signal } : {}),
    });
    return (await this.json<{ ts: string }>(response)).ts;
  }

	  async replay(delivery: Delivery, signal?: AbortSignal): Promise<ReplaySnapshot> {
    const generation = requiredGeneration(delivery);
    const response = await this.request(`/v1/deliveries/${delivery.id}/replay?generation=${generation}`, {
	      method: "GET",
		  ...(signal ? { signal } : {}),
    });
    return this.json<ReplaySnapshot>(response);
  }

	subscriptionBinding(actor: string, signal?: AbortSignal): Promise<SubscriptionBinding> {
		return this.request(`/v1/subscriptions/${encodeURIComponent(actor)}`, {
			method: "GET",
			...(signal ? { signal } : {}),
		})
			.then((response) => this.json<SubscriptionBinding>(response));
	}

	autoBindingTarget(actor: string): Promise<AutoBindingTarget> {
		return this.request(`/v1/subscriptions/${encodeURIComponent(actor)}/auto-binding`, { method: "GET" })
			.then((response) => this.json<AutoBindingTarget>(response));
	}

	autoBind(actor: string, update: AutoBindingUpdate): Promise<SubscriptionBinding> {
		return this.request(`/v1/subscriptions/${encodeURIComponent(actor)}/auto-binding`, {
			method: "PATCH",
			body: JSON.stringify(update),
		}).then((response) => this.json<SubscriptionBinding>(response));
	}

	reportLivePresence(input: LivePresenceInput): Promise<LivePresence> {
		return this.request("/v1/live-presence", {
			method: "POST",
			body: JSON.stringify(input),
		}).then((response) => this.json<LivePresence>(response));
	}

  async createEdge(adminToken: string, edgeId: string): Promise<{ edgeId: string; token: string }> {
    const response = await fetch(`${this.baseUrl}/v1/admin/edges`, {
      method: "POST",
	  signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ edgeId }),
    });
    return this.json(response);
  }

  async upsertSubscription(adminToken: string, input: SubscriptionInput): Promise<SubscriptionInput> {
    const response = await fetch(`${this.baseUrl}/v1/admin/subscriptions/${encodeURIComponent(input.actor)}`, {
      method: "PUT",
	  signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return this.json(response);
  }

  private async transition(delivery: Delivery, action: string, signal?: AbortSignal): Promise<Delivery> {
    const response = await this.request(`/v1/deliveries/${delivery.id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ generation: requiredGeneration(delivery) }),
      ...(signal ? { signal } : {}),
    });
    return this.json<Delivery>(response);
  }

	private request(path: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
	  signal,
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-hive-edge": this.edgeId,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`broker ${response.status}: ${body}`);
    }
    return await response.json() as T;
  }
}

export type PreProviderReleaseReason =
	| "slack_replay_unavailable"
	| "slack_replay_limit_exceeded"
	| "slack_replay_timeout"
	| "pre_provider_control_failed"
	| "live_binding_changed"
	| "provider_adapter_missing"
	| "provider_surface_unsupported"
	| "live_ingress_unavailable"
	| "workspace_not_mapped"
	| "resume_target_missing"
	| "spawn_rate_limited"
	| "subscription_expired";

function requiredGeneration(delivery: Delivery): number {
  if (delivery.leaseGeneration === null) throw new Error(`delivery ${delivery.id} has no lease generation`);
  return delivery.leaseGeneration;
}
