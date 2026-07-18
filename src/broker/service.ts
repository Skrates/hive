import type {
	BindingUpdate,
	Delivery,
	DeliveryResultInput,
	DeliveryStatus,
	EgressPolicyUpdate,
	OutboxReconciliation,
	SlackOutboxState,
	SlackReadiness,
	LivePresenceInput,
	AutoBindingUpdate,
	ReplaySnapshot,
	SlackEventInput,
	SubscriptionInput,
} from "../domain.js";
import { BrokerStore, type SlackOutboxClaim } from "./store.js";

export interface SlackTransport {
  replay(channelId: string, threadTs: string): Promise<ReplaySnapshot>;
  reply(channelId: string, threadTs: string, text: string, metadata?: Record<string, string>): Promise<string>;
	findReply?(
		channelId: string,
		threadTs: string,
		metadata: Record<string, string>,
	): Promise<string | null>;
}

export class SlackSendError extends Error {
	constructor(
		readonly outcome: "definite_retryable" | "definite_dead" | "uncertain",
		readonly code: string,
		readonly retryAfterMs = 0,
	) {
		super(code);
		this.name = "SlackSendError";
	}
}

export class BrokerService {
	private drainingOutbox: Promise<number> | null = null;
	private outboxTimer: NodeJS.Timeout | null = null;
	private slackReadinessSource: () => SlackReadiness = () => ({
		ready: false,
		socket: "disconnected",
		bot: "unchecked",
		updatedAt: new Date(0).toISOString(),
	});

  constructor(
    readonly store: BrokerStore,
    private readonly slack: SlackTransport,
	private readonly outboxAttemptTimeoutMs = 10_000,
  ) {}

  createEdge(edgeId: string): string {
    return this.store.createEdge(edgeId);
  }

  upsertSubscription(input: SubscriptionInput) {
    return this.store.upsertSubscription(input);
  }

	updateBinding(actor: string, update: BindingUpdate) {
		return this.store.updateBinding(actor, update);
	}

	setBindingMode(actor: string, mode: "auto" | "pinned") {
		return this.store.setBindingMode(actor, mode);
	}

	setEgressPolicy(actor: string, update: EgressPolicyUpdate) {
		return this.store.setEgressPolicy(actor, update);
	}

	setSlackReadinessSource(source: () => SlackReadiness): void {
		this.slackReadinessSource = source;
	}

	readiness(): SlackReadiness {
		return this.slackReadinessSource();
	}

	operatorStatus(staleAfterMs: number, actor?: string) {
		this.store.sweepExpiredDeliveries();
		return { ...this.store.operatorStatus(staleAfterMs, actor), slack: this.readiness() };
	}

	operatorDeliveries(filters: { actor?: string; status?: DeliveryStatus; limit?: number }) {
		return this.store.listDeliveryOperatorSummaries(filters);
	}

	operatorOutbox(filters: { state?: SlackOutboxState; limit?: number }) {
		return this.store.listOutboxOperatorSummaries(filters);
	}

	operatorReconcileOutbox(outboxId: number, input: OutboxReconciliation) {
		const result = this.store.reconcileOutboxForOperator(outboxId, input);
		if (input.disposition === "retry") this.kickOutbox();
		return result;
	}

	operatorOutboxAudit(outboxId: number) {
		return this.store.listOutboxReconciliationAudit(outboxId);
	}

	subscriptionBindingForEdge(actor: string, edgeId: string) {
		return this.store.subscriptionBindingForHomeEdge(actor, edgeId);
	}

	autoBindingTargetForEdge(actor: string, edgeId: string) {
		return this.store.autoBindingTargetForHomeEdge(actor, edgeId);
	}

	autoBindForEdge(actor: string, edgeId: string, input: AutoBindingUpdate) {
		return this.store.autoBindForHomeEdge(actor, edgeId, input);
	}

	reportLivePresence(edgeId: string, input: LivePresenceInput) {
		return this.store.reportLivePresence(edgeId, input);
	}

  ingest(event: SlackEventInput, initialSnapshot: unknown | null = null) {
	const result = this.store.ingestEvent(event, initialSnapshot);
	this.kickOutbox();
	return result;
  }

	diagnoseIngress(
		eventId: string,
    channelId: string,
    threadTs: string,
    reason: string,
    text: string,
	) {
		const result = this.store.recordIngressDiagnostic(eventId, channelId, threadTs, reason, text);
		this.kickOutbox();
		return result;
  }

  async claim(edgeId: string, after: number, waitMs: number): Promise<Delivery | null> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 30_000);
    do {
	  this.store.sweepExpiredDeliveries();
      const delivery = this.store.claimNext(edgeId, after);
      if (delivery) return delivery;
      if (Date.now() >= deadline) return null;
      await delay(Math.min(250, deadline - Date.now()));
    } while (true);
  }

  accept(deliveryId: number, edgeId: string, generation: number): Delivery {
	const delivery = this.store.transition(deliveryId, edgeId, generation, "claimed", "accepted_local");
	if (delivery.status !== "accepted_local") {
	  this.kickOutbox();
	  throw new Error("delivery_authority_expired");
	}
	return delivery;
  }

  beginDispatch(deliveryId: number, edgeId: string, generation: number): Delivery {
	const delivery = this.store.transition(deliveryId, edgeId, generation, "accepted_local", "dispatching");
	if (delivery.status !== "dispatching") {
	  this.kickOutbox();
	  throw new Error("delivery_authority_expired");
	}
	return delivery;
  }

  markDispatched(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.transition(deliveryId, edgeId, generation, "dispatching", "dispatched");
  }

  renew(deliveryId: number, edgeId: string, generation: number): Delivery {
    return this.store.renewDeliveryLease(deliveryId, edgeId, generation);
  }

	releasePreProvider(deliveryId: number, edgeId: string, generation: number, reason: { code: string; detail: string }) {
		return this.store.releasePreProvider(deliveryId, edgeId, generation, reason);
	}

  reserveSpawn(deliveryId: number, edgeId: string, generation: number): boolean {
    return this.store.reserveSpawn(deliveryId, edgeId, generation);
  }

  reconcile(deliveryId: number, disposition: "processed" | "requeue", detail: string): Delivery {
    return this.store.reconcile(deliveryId, disposition, detail);
  }

	operatorReconcile(deliveryId: number, disposition: "processed" | "requeue", detail: string) {
		const result = this.store.reconcileForOperator(deliveryId, disposition, detail);
		this.kickOutbox();
		return result;
	}

  finish(deliveryId: number, edgeId: string, result: DeliveryResultInput): Delivery {
	const delivery = this.store.finish(
		deliveryId,
		edgeId,
		result.generation,
		result.status,
		result.reasons,
		result.providerReceipt,
		result.spawnedSessionId ?? null,
	);
	this.kickOutbox();
	return delivery;
  }

  replay(deliveryId: number, edgeId: string, generation: number): Promise<ReplaySnapshot> {
    this.store.assertLease(deliveryId, edgeId, generation);
    const delivery = this.store.getDelivery(deliveryId);
    return this.slack.replay(delivery.event.channelId, delivery.event.threadTs);
  }

  reply(deliveryId: number, edgeId: string, generation: number, _text: string): string {
    this.store.assertLease(deliveryId, edgeId, generation);
	// Rolling-deploy compatibility: old edges may still call /reply before /result. Slack egress is
	// selected and durably enqueued only by the terminal /result transaction.
	return "deferred";
  }

	startOutbox(intervalMs = 2_000): void {
		if (this.outboxTimer) return;
		this.store.sweepExpiredDeliveries();
		this.kickOutbox();
		this.outboxTimer = setInterval(() => {
			this.store.sweepExpiredDeliveries();
			this.kickOutbox();
		}, intervalMs);
		this.outboxTimer.unref();
	}

	async stopOutbox(): Promise<void> {
		if (this.outboxTimer) clearInterval(this.outboxTimer);
		this.outboxTimer = null;
		// Flush any kick already queued in a microtask, then wait for the bounded in-flight Slack call
		// before the caller closes the SQLite store.
		await Promise.resolve();
		if (this.drainingOutbox) await this.drainingOutbox.catch(() => undefined);
	}

	kickOutbox(): void {
		queueMicrotask(() => {
			void this.drainOutbox().catch((error: unknown) => {
				console.error("hive Slack outbox drain failed", safeErrorCode(error));
			});
		});
	}

	drainOutbox(limit = 100): Promise<number> {
		if (this.drainingOutbox) return this.drainingOutbox;
		this.drainingOutbox = this.drainOutboxExclusive(limit).finally(() => {
			this.drainingOutbox = null;
		});
		return this.drainingOutbox;
	}

	private async drainOutboxExclusive(limit: number): Promise<number> {
		let handled = 0;
		while (handled < limit) {
			const claim = this.store.claimOutbox();
			if (!claim) break;
			handled += 1;
			if (claim.recovery) {
				await this.reconcileOutboxClaim(claim);
				continue;
			}
			try {
				const slackTs = await withTimeout(
					this.slack.reply(claim.channelId, claim.threadTs, claim.text, claim.metadata),
					this.outboxAttemptTimeoutMs,
				);
				this.store.completeOutbox(claim.id, claim.claimToken, "sent", { slackTs });
			} catch (error) {
				if (error instanceof SlackSendError && error.outcome === "definite_retryable") {
					this.store.retryOutbox(claim.id, claim.claimToken, error.code, error.retryAfterMs);
					continue;
				}
				if (error instanceof SlackSendError && error.outcome === "definite_dead") {
					this.store.completeOutbox(claim.id, claim.claimToken, "dead", { errorCode: error.code });
					continue;
				}
				await this.reconcileOutboxClaim(claim);
			}
		}
		return handled;
	}

	private async reconcileOutboxClaim(claim: SlackOutboxClaim): Promise<void> {
		let slackTs: string | null = null;
		try {
			if (this.slack.findReply) {
				slackTs = await withTimeout(
					this.slack.findReply(claim.channelId, claim.threadTs, claim.metadata),
					this.outboxAttemptTimeoutMs,
				);
			}
		} catch {
			// An uncertain post may never be retried blindly. Lack of reconciliation proof is terminally
			// visible as ambiguous so an operator can inspect Slack without risking a duplicate.
		}
		if (slackTs) this.store.completeOutbox(claim.id, claim.claimToken, "sent", { slackTs });
		else this.store.completeOutbox(claim.id, claim.claimToken, "ambiguous", {
			errorCode: "slack_outbox_send_uncertain",
		});
	}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("slack_timeout")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function safeErrorCode(error: unknown): string {
	if (error instanceof Error && error.message === "slack_timeout") return "slack_timeout";
	return "slack_outbox_failure";
}
