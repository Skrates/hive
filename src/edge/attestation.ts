import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * The record `weave-doctrine`'s installer persists into a seat's profile dir.
 * Only the fields the edge binds a wake to are modelled here; the rest of the
 * envelope (artifact hashes, skill names, env key names) is `weave doctor`'s
 * business, not the bus's.
 */
export const ATTESTATION_FILENAME = ".weave-attestation.json";
const ATTESTATION_SCHEMA = "weave.attestation/1";
/** Honest records are a few kilobytes of hashes. Anything larger is malformed. */
export const MAX_ATTESTATION_BYTES = 65_536;

/**
 * Why a delivery has no attestation reference. An absent or unreadable record
 * is never silently rendered as "unattested but fine": the reason is stored
 * beside the delivery so a later reader can tell a seat installed before
 * attestation existed from one whose profile was tampered with.
 */
export type AttestationAbsence =
  | "no_attestation_file"
  | "attestation_unreadable"
  | "attestation_unknown_schema"
  | "attestation_incomplete"
  | "attestation_actor_mismatch"
  | "attestation_ambiguous"
  | "attestation_unreported";

/**
 * Absences the edge computes about a read, never ones a profile can claim:
 * the actor mismatch is decided against the delivery, and the ambiguity is
 * decided against a second report for the same live session.
 */
type EdgeComputedAbsence =
  | "attestation_actor_mismatch"
  | "attestation_ambiguous"
  | "attestation_unreported";

export interface WakeAttestation {
  attestationId: string;
  doctrineCommit: string;
  actor: string;
}

export type AttestationRead =
  | { ok: true; attestation: WakeAttestation }
  | { ok: false; absence: AttestationAbsence };

/**
 * Read the attestation a seat's profile claims, for binding to a delivery.
 *
 * The edge deliberately does NOT re-derive the content address. Verification
 * lives in exactly one implementation — `weave doctor`, which rehashes the
 * record and refuses one whose id does not match its own bytes. Re-deriving it
 * here would mean maintaining a second canonical-JSON encoder in another
 * language, and two encoders that disagree by one escape sequence would reject
 * every honest wake. What the edge stores is therefore what the profile
 * *claims*, bound immutably to the delivery; whether the claim is true is the
 * doctor's verdict, on the same id.
 */
export async function readWakeAttestation(accountProfile: string): Promise<AttestationRead> {
  const opened = await openAttestationFile(join(accountProfile, ATTESTATION_FILENAME));
  if (!opened.ok) return opened;
  const raw = opened.raw;
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, absence: "attestation_unreadable" };
  }
  if (typeof record !== "object" || record === null) {
    return { ok: false, absence: "attestation_unreadable" };
  }
  const fields = record as Record<string, unknown>;
  if (fields.schema !== ATTESTATION_SCHEMA) {
    return { ok: false, absence: "attestation_unknown_schema" };
  }
  const doctrine = fields.doctrine as Record<string, unknown> | undefined;
  const attestationId = fields.attestation_id;
  const doctrineCommit = doctrine?.commit;
  const actor = fields.actor;
  if (typeof attestationId !== "string" || typeof doctrineCommit !== "string" || typeof actor !== "string") {
    return { ok: false, absence: "attestation_incomplete" };
  }
  // Empty strings are the tampered/partially-installed shape parseAttestationWire
  // refuses. One strictness on both sides of the wire: the reader names the
  // absence here, so the strict parser can never turn a bad profile into a
  // refused wake ("it does not refuse" is the PR's own guarantee).
  if (attestationId.length === 0 || doctrineCommit.length === 0 || actor.length === 0) {
    return { ok: false, absence: "attestation_incomplete" };
  }
  return { ok: true, attestation: { attestationId, doctrineCommit, actor } };
}

/** Flattened wire form a live surface puts on `/live/register`. */
export type AttestationWire =
  | { ok: true; attestationId: string; doctrineCommit: string; actor: string }
  | { ok: false; absence: Exclude<AttestationAbsence, EdgeComputedAbsence> };

export function attestationWire(read: AttestationRead): AttestationWire {
  if (read.ok) {
    return {
      ok: true,
      attestationId: read.attestation.attestationId,
      doctrineCommit: read.attestation.doctrineCommit,
      actor: read.attestation.actor,
    };
  }
  // The edge-computed absences are decided here, against the delivery and
  // against the session's own earlier report; a surface can never claim one.
  if (
    read.absence === "attestation_actor_mismatch"
    || read.absence === "attestation_ambiguous"
    || read.absence === "attestation_unreported"
  ) {
    return { ok: false, absence: "attestation_unreadable" };
  }
  return { ok: false, absence: read.absence };
}

export function parseAttestationWire(value: unknown): AttestationRead | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid attestation");
  const rec = value as Record<string, unknown>;
  if (rec.ok === true) {
    const { attestationId, doctrineCommit, actor } = rec;
    if (typeof attestationId !== "string" || typeof doctrineCommit !== "string" || typeof actor !== "string") {
      throw new Error("invalid attestation");
    }
    if (attestationId.length === 0 || doctrineCommit.length === 0 || actor.length === 0) {
      throw new Error("invalid attestation");
    }
    return { ok: true, attestation: { attestationId, doctrineCommit, actor } };
  }
  if (rec.ok === false) {
    const absence = rec.absence;
    if (
      absence !== "no_attestation_file"
      && absence !== "attestation_unreadable"
      && absence !== "attestation_unknown_schema"
      && absence !== "attestation_incomplete"
    ) {
      throw new Error("invalid attestation");
    }
    return { ok: false, absence };
  }
  throw new Error("invalid attestation");
}

/**
 * Open-and-read that cannot stall the edge loop, in either of the two ways the
 * founding finding named — "blocks **or** throws".
 *
 * `O_NONBLOCK` answers only the second half: it bounds a FIFO or device left at
 * the attestation path, turning it into `attestation_unreadable`. It has no
 * bounding effect on a *regular* file, so on a stalled network mount the open
 * itself parks in uninterruptible sleep — and `providers.ts` documents
 * home-as-profile on a network volume as a first-party shape, not a corner. A
 * synchronous read there froze every co-tenant claim and every lease heartbeat
 * on this edge, because Node is single-threaded.
 *
 * `fs/promises` moves the syscalls onto the libuv threadpool, so a stalled
 * mount costs a threadpool slot instead of the event loop: other actors' claims
 * and the lease heartbeats keep running. Both guards are kept — the threadpool
 * bounds the regular-file stall, `O_NONBLOCK` still bounds FIFOs and devices.
 */
async function openAttestationFile(
  path: string,
): Promise<{ ok: true; raw: string } | { ok: false; absence: AttestationAbsence }> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, absence: code === "ENOENT" ? "no_attestation_file" : "attestation_unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 0 || info.size > MAX_ATTESTATION_BYTES) {
      return { ok: false, absence: "attestation_unreadable" };
    }
    const buf = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead < 0 || bytesRead > MAX_ATTESTATION_BYTES) {
      return { ok: false, absence: "attestation_unreadable" };
    }
    return { ok: true, raw: buf.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return { ok: false, absence: "attestation_unreadable" };
  } finally {
    // A close error (network-backed profile, I/O fault) raised from finally
    // would override the read's verdict with an exception; the bytes (or the
    // named absence) are already decided by the time close runs.
    try {
      await handle.close();
    } catch {
      /* the verdict stands */
    }
  }
}

