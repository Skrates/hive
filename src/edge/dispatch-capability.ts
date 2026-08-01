import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../time.js";
import { systemClock } from "../time.js";

const CAPABILITY_BYTES = 32;
const CAPABILITY_LENGTH = 43;
const MAX_MINT_ATTEMPTS = 16;

export const INVALID_DISPATCH_CAPABILITY = "invalid_dispatch_capability" as const;

export interface DispatchCapabilityBinding {
  deliveryId: number;
  generation: number;
  providerAttempt: number;
}

export interface MintedDispatchCapability {
  capability: string;
  expiresAt: number;
}

export type DispatchCapabilityTokenSource = () => Uint8Array;

export interface DispatchCapabilityRegistryOptions {
  clock?: Clock;
  tokenSource?: DispatchCapabilityTokenSource;
}

interface StoredDispatchCapability {
  readonly binding: Readonly<DispatchCapabilityBinding>;
  readonly leaseKey: string;
  expiresAt: number;
  active: boolean;
}

/**
 * The only externally observable failure for an invalid ACK capability.
 *
 * The deliberately context-free message prevents callers from distinguishing an
 * unknown bearer from an expired, revoked, consumed, or incorrectly bound one.
 */
export class DispatchCapabilityError extends Error {
  readonly code = INVALID_DISPATCH_CAPABILITY;

  constructor() {
    super(INVALID_DISPATCH_CAPABILITY);
    this.name = "DispatchCapabilityError";
  }
}

/**
 * In-memory verifier for delivery-scoped, single-use provider ACK capabilities.
 *
 * Bearers are returned only from mint(). The registry keys entries by a SHA-256
 * digest and retains only non-secret binding metadata and expiry.
 */
export class DispatchCapabilityRegistry {
  private readonly entries = new Map<string, StoredDispatchCapability>();
  private readonly clock: Clock;
  private readonly tokenSource: DispatchCapabilityTokenSource;

  constructor(options: DispatchCapabilityRegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.tokenSource = options.tokenSource ?? (() => randomBytes(CAPABILITY_BYTES));
  }

  mint(binding: DispatchCapabilityBinding, ttlMs: number, leaseKey: string): MintedDispatchCapability {
    assertBinding(binding);
    if (!leaseKey) throw new Error("invalid_dispatch_capability_lease_key");
    const now = this.now();
    this.pruneExpiredAt(now);
    const expiresAt = expiryFrom(now, ttlMs);

    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
      const capability = encodeCapability(this.tokenSource());
      const digest = digestCapability(capability);
      if (this.entries.has(digest)) continue;

      this.entries.set(digest, {
        binding: Object.freeze({ ...binding }),
        leaseKey,
        expiresAt,
        active: false,
      });
      return { capability, expiresAt };
    }

    throw new Error("dispatch_capability_mint_failed");
  }

  /** Reset expiry to the newly renewed lease horizon; an expired bearer cannot be revived. */
  renewWithLease(capability: string, binding: DispatchCapabilityBinding, ttlMs: number): number {
    const now = this.now();
    this.pruneExpiredAt(now);
    const entry = this.requireValid(capability, binding, now);
    entry.expiresAt = expiryFrom(now, ttlMs);
    return entry.expiresAt;
  }

  /** Make a minted bearer usable only after broker-side dispatched state is durable. */
  activate(capability: string, binding: DispatchCapabilityBinding): void {
    const now = this.now();
    this.pruneExpiredAt(now);
    this.requireValid(capability, binding, now).active = true;
  }

  /** Atomically invalidate a bearer after verifying its exact dispatch binding. */
  consume(capability: string, binding: DispatchCapabilityBinding): void {
    const now = this.now();
    this.pruneExpiredAt(now);
    const digest = digestPresentedCapability(capability);
    const entry = this.requireValidDigest(digest, binding, now);
    if (!entry.active) throw new DispatchCapabilityError();
    this.entries.delete(digest);
  }

  /** Idempotently revoke a bearer without revealing whether it was present. */
  revoke(capability: string): void {
    if (!isCapabilityEncoding(capability)) return;
    this.entries.delete(digestCapability(capability));
  }

  /** Extend every outstanding capability governed by the same shared actor lease. */
  renewLeaseScope(leaseKey: string, generation: number, ttlMs: number): number {
    if (!leaseKey || !isPositiveInteger(generation)) {
      throw new Error("invalid_dispatch_capability_lease_scope");
    }
    const now = this.now();
    this.pruneExpiredAt(now);
    const expiresAt = expiryFrom(now, ttlMs);
    let renewed = 0;
    for (const entry of this.entries.values()) {
      if (entry.leaseKey === leaseKey && entry.binding.generation === generation) {
        entry.expiresAt = expiresAt;
        renewed += 1;
      }
    }
    return renewed;
  }

  pruneExpired(): number {
    return this.pruneExpiredAt(this.now());
  }

  private requireValid(
    capability: string,
    binding: DispatchCapabilityBinding,
    now: number,
  ): StoredDispatchCapability {
    return this.requireValidDigest(digestPresentedCapability(capability), binding, now);
  }

  private requireValidDigest(
    digest: string,
    binding: DispatchCapabilityBinding,
    now: number,
  ): StoredDispatchCapability {
    const entry = this.entries.get(digest);
    if (!entry) throw new DispatchCapabilityError();
    if (entry.expiresAt <= now) {
      this.entries.delete(digest);
      throw new DispatchCapabilityError();
    }
    if (!sameBinding(entry.binding, binding)) throw new DispatchCapabilityError();
    return entry;
  }

  private now(): number {
    const value = this.clock.now().getTime();
    if (!Number.isFinite(value)) throw new Error("invalid_dispatch_capability_clock");
    return value;
  }

  private pruneExpiredAt(now: number): number {
    let pruned = 0;
    for (const [digest, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(digest);
        pruned += 1;
      }
    }
    return pruned;
  }
}

function digestPresentedCapability(capability: string): string {
  if (!isCapabilityEncoding(capability)) throw new DispatchCapabilityError();
  return digestCapability(capability);
}

function digestCapability(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

function encodeCapability(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== CAPABILITY_BYTES) {
    throw new Error("invalid_dispatch_capability_token_source");
  }
  return Buffer.from(bytes).toString("base64url");
}

function isCapabilityEncoding(value: unknown): value is string {
  return typeof value === "string"
    && value.length === CAPABILITY_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function assertBinding(binding: DispatchCapabilityBinding): void {
  if (!isPositiveInteger(binding.deliveryId)
    || !isPositiveInteger(binding.generation)
    || !isPositiveInteger(binding.providerAttempt)) {
    throw new Error("invalid_dispatch_capability_binding");
  }
}

function sameBinding(
  left: Readonly<DispatchCapabilityBinding>,
  right: DispatchCapabilityBinding,
): boolean {
  return left.deliveryId === right.deliveryId
    && left.generation === right.generation
    && left.providerAttempt === right.providerAttempt;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function expiryFrom(now: number, ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now + ttlMs)) {
    throw new Error("invalid_dispatch_capability_ttl");
  }
  return now + ttlMs;
}
