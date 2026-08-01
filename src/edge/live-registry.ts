import { randomUUID } from "node:crypto";
import type { Provider } from "../domain.js";

export interface LiveIngressRegistration {
  readonly actor: string;
  readonly provider: Provider;
  readonly callbackUrl: string;
  readonly sessionId: string | null;
  readonly surfaceVersion: string;
}

export interface LiveIngressFence {
  readonly bindingId: string;
  readonly bindingRevision: number;
}

export interface LiveIngress extends LiveIngressRegistration, LiveIngressFence {
  readonly expiresAt: number;
}

export type LiveIngressRegistryErrorCode =
  | "live_binding_active"
  | "live_binding_unavailable"
  | "live_binding_stale"
  | "live_binding_invalid_ttl"
  | "live_binding_id_unavailable";

export class LiveIngressRegistryError extends Error {
  constructor(readonly code: LiveIngressRegistryErrorCode) {
    super(code);
    this.name = "LiveIngressRegistryError";
  }
}

export interface LiveIngressRegistryDependencies {
  now?: () => number;
  createBindingId?: () => string;
}

export class LiveIngressRegistry {
  private readonly entries = new Map<string, LiveIngress>();
  private readonly activeBindings = new Set<string>();
  private readonly highWaterRevisions = new Map<string, number>();
  private readonly now: () => number;
  private readonly createBindingId: () => string;

  constructor(dependencies: LiveIngressRegistryDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.createBindingId = dependencies.createBindingId ?? randomUUID;
  }

  register(input: LiveIngressRegistration, ttlMs: number): LiveIngress {
    validateTtl(ttlMs);
    const bindingKey = key(input.actor, input.provider);
    const now = this.now();
    const current = this.current(bindingKey, now);
    if (current) {
      if (this.activeBindings.has(bindingKey)) {
        throw new LiveIngressRegistryError("live_binding_active");
      }
      if (!sameRegistration(current, input)) {
        throw new LiveIngressRegistryError("live_binding_stale");
      }

      // A lost initial response must not mint a second epoch. Until the exact
      // fence is renewed this entry is still pending and invisible to dispatch,
      // so returning the same coordinate is both idempotent and fail-closed.
      const retried: LiveIngress = Object.freeze({
        ...current,
        expiresAt: now + ttlMs,
      });
      this.entries.set(bindingKey, retried);
      return retried;
    }

    const bindingId = this.createBindingId();
    if (typeof bindingId !== "string" || bindingId.length === 0) {
      throw new LiveIngressRegistryError("live_binding_id_unavailable");
    }
    const bindingRevision = this.nextRevision(bindingKey);
    const entry: LiveIngress = Object.freeze({
      ...input,
      bindingId,
      bindingRevision,
      expiresAt: now + ttlMs,
    });
    this.entries.set(bindingKey, entry);
    // Registration is a two-step handshake. The surface must first receive the
    // edge-issued fence and then confirm it through an exact renewal before the
    // binding becomes eligible for dispatch.
    this.activeBindings.delete(bindingKey);
    this.highWaterRevisions.set(bindingKey, bindingRevision);
    return entry;
  }

  renew(input: LiveIngressRegistration, fence: LiveIngressFence, ttlMs: number): LiveIngress {
    validateTtl(ttlMs);
    const bindingKey = key(input.actor, input.provider);
    const now = this.now();
    const current = this.current(bindingKey, now);
    if (!current) throw new LiveIngressRegistryError("live_binding_unavailable");
    if (
      current.bindingId !== fence.bindingId
      || current.bindingRevision !== fence.bindingRevision
      || !sameRegistration(current, input)
    ) {
      throw new LiveIngressRegistryError("live_binding_stale");
    }

    const entry: LiveIngress = Object.freeze({
      ...input,
      bindingId: current.bindingId,
      // Revision identifies the binding epoch, not an individual TTL refresh.
      // Keeping it stable across renewal avoids a window where the edge has
      // advanced the revision but the surface has not received the response yet.
      bindingRevision: current.bindingRevision,
      expiresAt: now + ttlMs,
    });
    this.entries.set(bindingKey, entry);
    this.activeBindings.add(bindingKey);
    return entry;
  }

  get(actor: string, provider: Provider): LiveIngress | null {
    const bindingKey = key(actor, provider);
    const entry = this.current(bindingKey, this.now());
    return entry && this.activeBindings.has(bindingKey) ? entry : null;
  }

  private current(bindingKey: string, now: number): LiveIngress | null {
    const entry = this.entries.get(bindingKey);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(bindingKey);
      this.activeBindings.delete(bindingKey);
      return null;
    }
    return entry;
  }

  private nextRevision(bindingKey: string): number {
    return (this.highWaterRevisions.get(bindingKey) ?? 0) + 1;
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new LiveIngressRegistryError("live_binding_invalid_ttl");
  }
}

function key(actor: string, provider: Provider): string {
  return `${actor}:${provider}`;
}

function sameRegistration(left: LiveIngressRegistration, right: LiveIngressRegistration): boolean {
  return left.actor === right.actor
    && left.provider === right.provider
    && left.callbackUrl === right.callbackUrl
    && left.sessionId === right.sessionId
    && left.surfaceVersion === right.surfaceVersion;
}
