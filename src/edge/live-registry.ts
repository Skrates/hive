import type { AttestationRead } from "./attestation.js";
import { canonicalActor, type Provider } from "../domain.js";

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
   *
   * Required, and that is the whole guarantee: an optional field made
   * `undefined` mean both "no prior registration" and "the prior registration
   * said nothing", which is the collapse that let a later report be adopted as
   * a session's start snapshot. A caller with nothing to report names it —
   * `{ ok: false, absence: "attestation_unreported" }`, which the ingress mints
   * at `control.ts`. Required inputs are validated at the seam, never defaulted
   * behind it.
   */
  readonly runtimeAttestation: AttestationRead;
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
    const bindingKey = key(input.actor, input.provider);
    const previous = this.entries.get(bindingKey);
    // A new sessionId, or a lapsed heartbeat, is a different claim entirely and
    // takes whatever the surface just sent. Within one unexpired sessionId the
    // reports are reconciled, not overwritten — see retainedAttestation.
    const held = previous !== undefined
      && previous.expiresAt > this.now()
      && previous.sessionId === input.sessionId
      ? previous.runtimeAttestation
      : undefined;
    const entry: LiveIngress = Object.freeze({
      ...input,
      runtimeAttestation: retainedAttestation(held, input.runtimeAttestation),
      expiresAt: this.now() + ttlMs,
    });
    this.entries.set(bindingKey, entry);
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
  // The broker canonicalizes actor keys (domain.canonicalActor); a live
  // registration arriving through HIVE_ACTOR must land under the same key or
  // a mixed-case enrollment registers a surface no delivery can ever find.
  return `${canonicalActor(actor)}:${provider}`;
}

/**
 * A surface reports what its home holds *at report time* — the Claude hook is
 * a fresh process at every boundary and re-reads `CLAUDE_CONFIG_DIR`, so its
 * report is never proof of what the still-running session loaded. While the
 * reports for one sessionId agree, the first snapshot stands and the delivery
 * keeps an exact id.
 *
 * When they disagree, the edge has no evidence to pick a side: a mid-session
 * reinstall under a still-running process and a crash-then-`--resume` of the
 * same sessionId under new artifacts produce the identical report sequence,
 * and `sessionId` equality is not proof that the loaded runtime survived. So
 * the ambiguity is named rather than resolved — a wrong attestation id is
 * worse than a named absence, and naming it still dispatches the wake (the
 * edge records; it does not refuse). The absence is sticky by construction: a
 * later agreeing report cannot restore knowledge that was never held.
 */
function retainedAttestation(
  previous: AttestationRead | undefined,
  reported: AttestationRead,
): AttestationRead {
  // `previous` alone stays optional, and now means exactly one thing: no live
  // registration is held for this key (or its heartbeat lapsed).
  if (previous === undefined) return reported;
  // A surface that reported nothing added no evidence; that is not a
  // disagreement. `attestation_unreported` is how the ingress records "this
  // heartbeat carried no attestation field". It is not interchangeable as the
  // PREVIOUS value: there it means the session's first snapshot was never
  // known, which is exactly why a later id cannot be adopted as that snapshot.
  if (!reported.ok && reported.absence === "attestation_unreported") return previous;
  return namesTheSameArtifacts(previous, reported)
    ? previous
    : { ok: false, absence: "attestation_ambiguous" };
}

/**
 * Do two reports name the same artifacts? The id is a content address over
 * every other field of the record, so it is the whole identity: also comparing
 * the commit and actor would be a fence no honest record can trip, and a record
 * whose id disagrees with its own bytes is `weave doctor`'s to refuse, not the
 * edge's to arbitrate.
 *
 * Two absences never disagree in the sense that matters: neither offers an id,
 * so no guess is on the table and the first — the more specific evidence about
 * this session's start — stands. Ambiguity is reserved for the case where a
 * *recorded id* would otherwise be asserted on no evidence.
 */
function namesTheSameArtifacts(left: AttestationRead, right: AttestationRead): boolean {
  if (left.ok !== right.ok) return false;
  if (left.ok && right.ok) {
    return left.attestation.attestationId === right.attestation.attestationId;
  }
  return true;
}
