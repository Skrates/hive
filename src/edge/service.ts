import {
  frameUntrustedSlack,
  type Delivery,
  type Provider,
  type Reason,
  type SubscriptionBinding,
} from "../domain.js";
import { BrokerClient, type PreProviderReleaseReason } from "./broker-client.js";
import { completionReceipt } from "../broker/egress.js";
import { LiveIngressRegistry, type LiveIngress } from "./live-registry.js";
import type { ProviderAdapter, ProviderDispatch } from "./providers.js";
import { EdgeStore } from "./store.js";

export class EdgeService {
  private after = 0;
  private running = false;
	private brokerReady = false;
	private brokerReadinessUpdatedAt = new Date(0).toISOString();

  constructor(
    readonly broker: BrokerClient,
    readonly store: EdgeStore,
    readonly live: LiveIngressRegistry,
    adapters: ProviderAdapter[],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  private readonly adapters: Map<Provider, ProviderAdapter>;

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("edge service already running");
    this.running = true;
    try {
	  if (!this.brokerReady) await this.preflight(signal);
      while (!signal?.aborted) {
		try {
			  const recovery = await this.recoverLocalDispatches(20, signal);
			  if (recovery.pending > 0) {
				this.setBrokerReady(false);
				await abortableDelay(100, signal ?? new AbortController().signal);
				continue;
			  }
			  const worked = await this.processOne(25_000, signal);
		  this.setBrokerReady(true);
		  if (!worked) await abortableDelay(100, signal ?? new AbortController().signal);
			} catch (error) {
			  if (signal?.aborted) break;
			  this.setBrokerReady(false);
		  console.error("hive edge poll failed", safeEdgeErrorCode(error));
		  const retryDelayMs = this.store.listAmbiguousAfterRestart(1).length > 0 ? 100 : 500;
		  if (!signal?.aborted) {
			await abortableDelay(retryDelayMs, signal ?? new AbortController().signal);
		  }
		}
      }
    } finally {
      this.running = false;
    }
  }

	async preflight(signal?: AbortSignal): Promise<void> {
		try {
			await this.broker.probe(signal);
			this.setBrokerReady(true);
		} catch (error) {
			this.setBrokerReady(false);
			throw error;
		}
	}

	readiness() {
		return {
			ok: this.running && this.brokerReady,
			running: this.running,
			brokerAuthenticated: this.brokerReady,
			updatedAt: this.brokerReadinessUpdatedAt,
		};
	}

	async recoverInterruptedDispatches(limit = 100, signal?: AbortSignal): Promise<number> {
	  return (await this.recoverLocalDispatches(limit, signal)).recovered;
	}

	private async recoverLocalDispatches(
	  limit: number,
	  signal?: AbortSignal,
	): Promise<{ recovered: number; pending: number }> {
    let recovered = 0;
	let pending = 0;
	for (const local of this.store.listAmbiguousAfterRestart(limit)) {
	  if (signal?.aborted) break;
      const delivery = this.store.delivery(local.delivery_id);
      if (!delivery) continue;
      try {
		const recoveryBudgetMs = Math.max(
		  1,
		  Math.min(
			500,
			Math.floor(delivery.subscription.leaseTtlMs / 4),
			deliveryDeadlineAt(delivery) - Date.now(),
		  ),
		);
		await withOperationDeadline(
		  (operationSignal) => this.broker.finish(delivery, {
			generation: local.generation,
			status: "ambiguous",
			reasons: [{
			  code: "edge_restarted_during_dispatch",
			  detail: "local edge lost broker control after provider dispatch began",
			}],
			providerReceipt: local.provider_receipt,
			spawnedSessionId: local.spawned_session_id,
		  }, operationSignal),
		  signal,
		  recoveryBudgetMs,
		  new DeliveryControlError(
			"orphan_recovery_timeout",
			"orphan-session recovery did not complete within its lease-safe budget",
		  ),
		);
		this.store.setStatus(
		  local.delivery_id,
		  local.generation,
		  "ambiguous",
		  local.provider_receipt,
		  local.spawned_session_id,
        );
        recovered += 1;
	  } catch (error) {
		if (isPreDispatchFence(error)) {
		  // The broker already owns the terminal outcome; stop retrying this obsolete local fence.
		  this.store.setStatus(
			local.delivery_id,
			local.generation,
			"ambiguous",
			local.provider_receipt,
			local.spawned_session_id,
		  );
		} else if (!signal?.aborted) {
		  pending += 1;
		}
      }
    }
	return { recovered, pending };
  }

	async processOne(waitMs = 0, signal?: AbortSignal): Promise<boolean> {
	const delivery = await this.broker.claim(this.after, waitMs, signal);
    if (!delivery) return false;
    this.after = Math.max(this.after, delivery.id);
	const deadlineAt = deliveryDeadlineAt(delivery);
    const generation = requiredGeneration(delivery);
    const existing = this.store.receive(delivery, generation);
    if (["dispatched", "processed"].includes(existing.status)) return true;

	let current: Delivery = delivery;
	let framed: string;
	try {
	  current = await this.broker.accept(delivery, signal);
	  const replay = await this.replayForDelivery(current, deadlineAt, signal);
	  framed = frameUntrustedSlack(current, replay);
	  current = await this.broker.beginDispatch(current, signal);
		} catch (error) {
		  if (isPreDispatchFence(error) || hasSafeBrokerCode(error, "delivery_authority_expired")) {
			this.after = Math.min(this.after, delivery.id - 1);
			return true;
		  }
		  await this.releaseBeforeProvider(current, error, deadlineAt);
		  return true;
		}

	let providerStarted = false;
	let observedSpawnedSessionId: string | null = null;
	try {
		      await this.withLeaseHeartbeat(current, deadlineAt, signal, async (operationSignal) => {
				const prepared = await this.prepareDispatch(current, framed, operationSignal);
				await this.broker.renew(current, operationSignal);
				this.store.setStatus(current.id, generation, "dispatching");
				providerStarted = true;
	        const dispatch = await prepared.invoke();
			if (prepared.kind === "spawn") observedSpawnedSessionId = dispatch.sessionId;
	        this.store.setStatus(
			  current.id,
			  generation,
			  "dispatched",
			  dispatch.receipt,
			  observedSpawnedSessionId,
			);
	        current = await this.broker.markDispatched(current, operationSignal);
	        if (dispatch.processed) {
			  const spawnSessionUnconfirmed = prepared.kind === "spawn" && dispatch.sessionId === null;
	          await this.broker.finish(
            current,
	            {
				generation,
				status: spawnSessionUnconfirmed ? "ambiguous" : "processed",
				reasons: spawnSessionUnconfirmed ? [{
					code: "spawn_session_unconfirmed",
					detail: "spawn completed without one unambiguous structured session identifier",
				}] : [],
				providerReceipt: dispatch.receipt,
				spawnedSessionId: prepared.kind === "spawn" ? dispatch.sessionId : null,
			  },
	            operationSignal,
          );
		  this.store.setStatus(
			current.id,
			generation,
			spawnSessionUnconfirmed ? "ambiguous" : "processed",
			dispatch.receipt,
			observedSpawnedSessionId,
		  );
        }
      });
	      return true;
	    } catch (error) {
		if (!providerStarted) {
		  await this.releaseBeforeProvider(current, error, deadlineAt);
		  return true;
		}
		const reason = classifyDispatchError(error, true);
	      await this.broker.finish(current, {
		generation,
		status: "ambiguous",
		reasons: [reason],
		providerReceipt: null,
		spawnedSessionId: observedSpawnedSessionId,
	  });
	  this.store.setStatus(current.id, generation, "ambiguous", null, observedSpawnedSessionId);
      return true;
    }
  }

	private async replayForDelivery(delivery: Delivery, deadlineAt: number, signal?: AbortSignal) {
			const budget = Math.min(8_000, deadlineAt - Date.now());
		if (budget <= 0) throw new PreDispatchError("slack_replay_timeout");
		try {
			return await withOperationDeadline(
				(operationSignal) => this.broker.replay(delivery, operationSignal),
				signal,
				budget,
				new PreDispatchError("slack_replay_timeout"),
			);
		} catch (error) {
			if (signal?.aborted) throw abortReason(signal, "edge shutdown aborted Slack replay");
			if (error instanceof PreDispatchError) throw error;
			if (hasSafeBrokerCode(error, "slack_replay_limit_exceeded")) {
				throw new PreDispatchError("slack_replay_limit_exceeded");
			}
			throw new PreDispatchError("slack_replay_unavailable");
		}
	}

	private async releaseBeforeProvider(
		delivery: Delivery,
		error: unknown,
		deadlineAt: number,
	): Promise<void> {
		const reason = classifyPreProviderError(error);
		const generation = requiredGeneration(delivery);
		while (Date.now() < deadlineAt) {
			const remainingMs = deadlineAt - Date.now();
			const attemptMs = Math.min(1_000, remainingMs);
			try {
				const released = await withOperationDeadline(
					(attemptSignal) => this.broker.releasePreProvider(delivery, reason, attemptSignal),
					undefined,
					attemptMs,
					new DeliveryControlError(
						"pre_provider_release_timeout",
						"pre-provider release attempt timed out",
					),
				);
				const localStatus = releasedPreProviderStatus(released);
				if (localStatus !== null) {
					this.store.setStatus(delivery.id, generation, localStatus);
					this.after = Math.min(this.after, delivery.id - 1);
					return;
				}
			} catch (releaseError) {
				if (isDefinitePreProviderFence(releaseError)) {
					this.store.setStatus(delivery.id, generation, "received");
					this.after = Math.min(this.after, delivery.id - 1);
					return;
				}
			}
			const delayMs = Math.min(100, deadlineAt - Date.now());
			if (delayMs > 0) await delay(delayMs);
		}
		// No provider was invoked. Leave the local row replayable while broker lease expiry owns recovery.
		this.store.setStatus(delivery.id, generation, "received");
		this.after = Math.min(this.after, delivery.id - 1);
	}

  private async withLeaseHeartbeat<T>(
    delivery: Delivery,
	deadlineAt: number,
	parentSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
	    const remainingMs = deadlineAt - Date.now();
	    if (remainingMs <= 0) throw new DeliveryControlError(
		"delivery_deadline_exceeded",
		"delivery exceeded its absolute deadline",
	);
	    const intervalMs = Math.max(25, Math.floor(delivery.subscription.leaseTtlMs / 3));
	    const controller = new AbortController();
	const onParentAbort = () => {
		if (parentSignal) controller.abort(abortReason(parentSignal, "edge shutdown aborted delivery"));
	};
	if (parentSignal?.aborted) onParentAbort();
	else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const deadlineTimer = setTimeout(
	      () => controller.abort(new DeliveryControlError(
		"delivery_deadline_exceeded",
		"delivery exceeded its absolute deadline",
	  )),
      remainingMs,
    );
		let leaseExpiresAt = 0;
		const renew = async (): Promise<void> => {
			const startedAt = Date.now();
			const maximum = leaseExpiresAt === 0
				? Math.min(deadlineAt, startedAt + Math.max(100, delivery.subscription.leaseTtlMs / 2))
				: Math.min(deadlineAt, leaseExpiresAt - leaseSafetyMargin(delivery.subscription.leaseTtlMs));
			const budget = maximum - Date.now();
			if (budget <= 0) throw new DeliveryControlError(
				"lease_renewal_failed",
				"actor lease could not be renewed safely before expiry",
			);
			await withAbortDeadline(
				(signal) => this.broker.renew(delivery, signal),
				controller.signal,
				budget,
			);
			// The broker renews after this request began, so this is a conservative lower bound.
			leaseExpiresAt = startedAt + delivery.subscription.leaseTtlMs;
		};
		let heartbeat: Promise<void> | null = null;
	try {
		await renew();
		heartbeat = (async () => {
			while (!controller.signal.aborted) {
				await abortableDelay(intervalMs, controller.signal);
				if (!controller.signal.aborted) await renew();
			}
		})().catch((error: unknown) => {
			if (!controller.signal.aborted) controller.abort(error instanceof DeliveryControlError
				? error
				: new DeliveryControlError("lease_renewal_failed", "actor lease renewal failed"));
		});
	    const aborted = rejectedOnAbort(controller.signal, "delivery operation aborted");
		      return await Promise.race([operation(controller.signal), aborted]);
		    } finally {
		      clearTimeout(deadlineTimer);
		controller.abort(new DeliveryControlError("operation_complete", "delivery operation completed"));
		if (heartbeat) await heartbeat;
		parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  async acknowledge(delivery: Delivery, text: string): Promise<void> {
    const generation = requiredGeneration(delivery);
    await this.broker.finish(delivery, { generation, status: "processed", reasons: [], providerReceipt: text });
    this.store.setStatus(delivery.id, generation, "processed", text);
  }


  async acknowledgeById(deliveryId: number, text: string): Promise<void> {
    const delivery = this.store.delivery(deliveryId);
    if (!delivery) throw new Error(`local delivery ${deliveryId} not found`);
    await this.acknowledge(delivery, text);
  }

  async liveTarget(actor: string, provider: Provider, signal?: AbortSignal): Promise<SubscriptionBinding> {
    const binding = await this.broker.subscriptionBinding(actor, signal);
    if (binding.provider !== provider) throw new Error("provider_binding_mismatch");
    return binding;
  }

  autoBindingTarget(actor: string) {
    return this.broker.autoBindingTarget(actor);
  }

  autoBind(actor: string, update: Parameters<BrokerClient["autoBind"]>[1]) {
    return this.broker.autoBind(actor, update);
  }

  async registerLive(input: Omit<LiveIngress, "expiresAt">, ttlMs: number): Promise<LiveIngress> {
    const binding = await this.liveTarget(input.actor, input.provider);
    if (binding.sessionId !== input.sessionId
      || binding.bindingRevision !== input.bindingRevision
      || binding.providerSurface !== input.providerSurface
      || binding.providerVersion !== input.surfaceVersion) {
      throw new Error("live_binding_mismatch");
    }
    return this.live.register(input, ttlMs);
  }

  reportLivePresence(input: Parameters<BrokerClient["reportLivePresence"]>[0]) {
    return this.broker.reportLivePresence(input);
  }

  private async prepareDispatch(
    delivery: Delivery,
    framed: string,
    signal: AbortSignal,
  ): Promise<PreparedDispatch> {
    const subscription = delivery.subscription;
	    let currentBinding: SubscriptionBinding;
		    try {
		      currentBinding = await this.liveTarget(delivery.actor, subscription.provider, signal);
		    } catch (error) {
		      if (signal.aborted) throw abortReason(signal, "edge shutdown aborted dispatch preparation");
		      throw new PreDispatchError("live_binding_changed");
		    }
    if (currentBinding.sessionId !== subscription.sessionId
      || currentBinding.bindingRevision !== subscription.bindingRevision
      || currentBinding.providerSurface !== subscription.providerSurface
	      || currentBinding.providerVersion !== subscription.providerVersion) {
	      throw new PreDispatchError("live_binding_changed");
	    }
	    const adapter = this.adapters.get(subscription.provider);
	    if (!adapter) throw new PreDispatchError("provider_adapter_missing");
	    const live = this.live.get(delivery.actor, subscription.provider, subscription);
	    if (live) return {
		  kind: "live",
		  invoke: () => adapter.deliverLive(live, delivery, framed, signal),
	    };
	    const surfaceOwnership = providerSurfaceOwnership(subscription.providerSurface);
	    if (surfaceOwnership === "live") throw new PreDispatchError("live_ingress_unavailable");
	    if (surfaceOwnership === "unsupported") throw new PreDispatchError("provider_surface_unsupported");
	    if (subscription.wakePolicy === "live_only") throw new PreDispatchError("live_ingress_unavailable");

	    const workspace = subscription.edgeWorkspaces.find((item) => item.edgeId === this.broker.edgeId);
	    if (!workspace) throw new PreDispatchError("workspace_not_mapped");
	    if (subscription.sessionId && this.broker.edgeId === subscription.homeEdge) {
	      return { kind: "resume", invoke: () => adapter.resume(subscription, workspace.cwd, framed, signal) };
	    }
	    if (subscription.wakePolicy === "resume") throw new PreDispatchError("resume_target_missing");
	    if (!await this.broker.reserveSpawn(delivery, signal)) throw new PreDispatchError("spawn_rate_limited");
	    return { kind: "spawn", invoke: () => adapter.spawn(subscription, workspace.cwd, framed, signal) };
		  }

	private setBrokerReady(ready: boolean): void {
		this.brokerReady = ready;
		this.brokerReadinessUpdatedAt = new Date().toISOString();
	}
}

interface PreparedDispatch {
	kind: "live" | "resume" | "spawn";
	invoke: () => Promise<ProviderDispatch>;
}

const LIVE_PROVIDER_SURFACES = new Set([
	"app-server",
	"app-server-control",
	"claude-channel",
	"codex-app-server",
	"codex-desktop-ipc",
	"desktop-ipc",
	"mcp-channel",
]);

const HEADLESS_PROVIDER_SURFACES = new Set([
	"claude-cli",
	"codex-cli",
	"headless-exec",
]);

function providerSurfaceOwnership(surface: string): "live" | "headless" | "unsupported" {
	if (LIVE_PROVIDER_SURFACES.has(surface)) return "live";
	if (HEADLESS_PROVIDER_SURFACES.has(surface)) return "headless";
	return "unsupported";
}

export function completionAcknowledgement(delivery: Pick<Delivery, "actor" | "id">): string {
	return completionReceipt(delivery.actor, delivery.id);
}

function requiredGeneration(delivery: Delivery): number {
  if (delivery.leaseGeneration === null) throw new Error("delivery has no lease generation");
  return delivery.leaseGeneration;
}

function classifyDispatchError(error: unknown, providerStarted: boolean): Reason {
	if (!providerStarted && error instanceof PreDispatchError) {
		return { code: error.code, detail: error.message };
	}
	if (error instanceof DeliveryControlError) return { code: error.code, detail: error.message };
	return {
		code: "provider_dispatch_unknown",
		detail: providerStarted
			? "provider invocation began but its durable outcome was not confirmed"
			: "dispatch preparation failed without contacting a provider",
	};
}

class PreDispatchError extends Error {
	constructor(readonly code: PreProviderReleaseReason) {
		super(code);
		this.name = "PreDispatchError";
	}
}

class DeliveryControlError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "DeliveryControlError";
	}
}

function leaseSafetyMargin(ttlMs: number): number {
	return Math.max(25, Math.min(1_000, Math.floor(ttlMs / 5)));
}

async function withAbortDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	parent: AbortSignal,
	timeoutMs: number,
): Promise<T> {
	return withOperationDeadline(
		operation,
		parent,
		timeoutMs,
		new DeliveryControlError(
			"lease_renewal_failed",
			"actor lease renewal did not complete before its safety deadline",
		),
	);
}

async function withOperationDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	parent: AbortSignal | undefined,
	timeoutMs: number,
	timeoutReason: Error,
): Promise<T> {
	if (timeoutMs <= 0) throw timeoutReason;
	const controller = new AbortController();
	const onParentAbort = () => {
		if (parent) controller.abort(abortReason(parent, "parent operation aborted"));
	};
	if (parent?.aborted) onParentAbort();
	else parent?.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
	try {
		if (controller.signal.aborted) throw abortReason(controller.signal, "operation aborted");
		return await Promise.race([
			operation(controller.signal),
			rejectedOnAbort(controller.signal, "operation aborted"),
		]);
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", onParentAbort);
	}
}

function rejectedOnAbort(signal: AbortSignal, fallback: string): Promise<never> {
	if (signal.aborted) return Promise.reject(abortReason(signal, fallback));
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(abortReason(signal, fallback)), { once: true });
	});
}

function abortReason(signal: AbortSignal, fallback: string): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function deliveryDeadlineAt(delivery: Delivery): number {
	const configuredDeadline = Date.parse(delivery.createdAt) + delivery.subscription.deliveryTtlMs;
	const reportedDeadline = delivery.remainingTtlMs === undefined
		? Number.POSITIVE_INFINITY
		: Date.now() + Math.max(0, delivery.remainingTtlMs);
	return Number.isFinite(configuredDeadline)
		? Math.min(configuredDeadline, reportedDeadline)
		: reportedDeadline;
}

function releasedPreProviderStatus(
	delivery: Delivery,
): Parameters<EdgeStore["setStatus"]>[2] | null {
	switch (delivery.status) {
		case "pending": return "received";
		case "processed": return "processed";
		case "undeliverable": return "undeliverable";
		case "ambiguous": return "ambiguous";
		case "dead_letter": return "dead_letter";
		default: return null;
	}
}

function isPreDispatchFence(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("\"stale_lease\"") || detail.includes("\"invalid_transition\"");
}

function isDefinitePreProviderFence(error: unknown): boolean {
	return isPreDispatchFence(error) || hasSafeBrokerCode(error, "delivery_authority_expired");
}

function classifyPreProviderError(error: unknown): PreProviderReleaseReason {
	if (error instanceof PreDispatchError) return error.code;
	if (error instanceof DeliveryControlError && error.code === "delivery_deadline_exceeded") {
		return "slack_replay_timeout";
	}
	if (hasSafeBrokerCode(error, "subscription_expired")) return "subscription_expired";
	return "pre_provider_control_failed";
}

function hasSafeBrokerCode(error: unknown, code: string): boolean {
	return error instanceof Error && error.message.includes(`\"${code}\"`);
}

function safeEdgeErrorCode(error: unknown): string {
	if (isPreDispatchFence(error)) return "pre_dispatch_fence";
	if (error instanceof Error && error.name === "AbortError") return "broker_request_aborted";
	return "broker_unavailable";
}
