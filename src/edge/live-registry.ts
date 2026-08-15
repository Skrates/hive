import type { AttestationRead } from "./attestation.js";
import type { Provider } from "../domain.js";

/**
 * ADR-0003 R-4: a live surface announces "I can receive injections for this
 * actor at this owner-only socket" and keeps that claim fresh with periodic
 * re-registration. There is no binding fence, no revision epoch, and no
 * two-step confirmation — the socket lives on the same machine under the same
 * user, and a stale registration merely makes one delivery attempt fail and
 * retry through the ordinary R-3 lane.
 */
export interface LiveIngressRegistration {
  readonly actor: string;
  readonly provider: Provider;
  readonly socketPath: string;
  readonly sessionId: string | null;
  readonly surfaceVersion: string;
  /**
   * Attestation of the home this surface actually loaded — Desktop state
   * home for a foreground Codex attachment, the pinned profile otherwise.
   * Captured by the surface so the edge does not bind a split-state
   * delivery to artifacts the turn never used.
   */
  readonly runtimeAttestation?: AttestationRead;
}

export interface LiveIngress extends LiveIngressRegistration {
  readonly expiresAt: number;
}

export class LiveIngressRegistryError extends Error {
  constructor(readonly code: "live_binding_invalid_ttl") {
    super(code);
    this.name = "LiveIngressRegistryError";
  }
}

export class LiveIngressRegistry {
  private readonly entries = new Map<string, LiveIngress>();
  private readonly now: () => number;

  constructor(dependencies: { now?: () => number } = {}) {
    this.now = dependencies.now ?? Date.now;
  }

  register(input: LiveIngressRegistration, ttlMs: number): LiveIngress {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new LiveIngressRegistryError("live_binding_invalid_ttl");
    }
    const entry: LiveIngress = Object.freeze({ ...input, expiresAt: this.now() + ttlMs });
    this.entries.set(key(input.actor, input.provider), entry);
    return entry;
  }

  get(actor: string, provider: Provider): LiveIngress | null {
    const bindingKey = key(actor, provider);
    const entry = this.entries.get(bindingKey);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(bindingKey);
      return null;
    }
    return entry;
  }

  /**
   * A surface that knows it is going away withdraws its claim immediately —
   * a terminal Claude Stop must not leave a heartbeat promising a boundary
   * that will never come. Idempotent: deregistering an absent binding is fine.
   */
  deregister(actor: string, provider: Provider): void {
    this.entries.delete(key(actor, provider));
  }
}

function key(actor: string, provider: Provider): string {
  return `${actor}:${provider}`;
}
