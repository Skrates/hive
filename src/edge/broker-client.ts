import type { Delivery, DeliveryResultInput, ReplaySnapshot, SubscriptionInput } from "../domain.js";

export class BrokerClient {
  constructor(
    private readonly baseUrl: string,
    readonly edgeId: string,
    private readonly token: string,
  ) {}

  async claim(after: number, waitMs = 25_000): Promise<Delivery | null> {
    const response = await this.request(`/v1/deliveries?after=${after}&wait_ms=${waitMs}`, { method: "GET" });
    if (response.status === 204) return null;
    return this.json<Delivery>(response);
  }

  accept(delivery: Delivery): Promise<Delivery> {
    return this.transition(delivery, "accept");
  }

  beginDispatch(delivery: Delivery): Promise<Delivery> {
    return this.transition(delivery, "dispatch");
  }

  markDispatched(delivery: Delivery): Promise<Delivery> {
    return this.transition(delivery, "dispatched");
  }

  async finish(delivery: Delivery, result: DeliveryResultInput): Promise<Delivery> {
    const response = await this.request(`/v1/deliveries/${delivery.id}/result`, {
      method: "POST",
      body: JSON.stringify(result),
    });
    return this.json<Delivery>(response);
  }

  async reply(delivery: Delivery, text: string): Promise<string> {
    const response = await this.request(`/v1/deliveries/${delivery.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ generation: requiredGeneration(delivery), text }),
    });
    return (await this.json<{ ts: string }>(response)).ts;
  }

  async replay(delivery: Delivery): Promise<ReplaySnapshot> {
    const params = new URLSearchParams({
      channel_id: delivery.event.channelId,
      thread_ts: delivery.event.threadTs,
    });
    const response = await this.request(`/v1/replay?${params}`, { method: "GET" });
    return this.json<ReplaySnapshot>(response);
  }

  async createEdge(adminToken: string, edgeId: string): Promise<{ edgeId: string; token: string }> {
    const response = await fetch(`${this.baseUrl}/v1/admin/edges`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ edgeId }),
    });
    return this.json(response);
  }

  async upsertSubscription(adminToken: string, input: SubscriptionInput): Promise<SubscriptionInput> {
    const response = await fetch(`${this.baseUrl}/v1/admin/subscriptions/${encodeURIComponent(input.actor)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return this.json(response);
  }

  private async transition(delivery: Delivery, action: string): Promise<Delivery> {
    const response = await this.request(`/v1/deliveries/${delivery.id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ generation: requiredGeneration(delivery) }),
    });
    return this.json<Delivery>(response);
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
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

function requiredGeneration(delivery: Delivery): number {
  if (delivery.leaseGeneration === null) throw new Error(`delivery ${delivery.id} has no lease generation`);
  return delivery.leaseGeneration;
}
