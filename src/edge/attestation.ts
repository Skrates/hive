import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
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
  | "attestation_actor_mismatch";

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
export function readWakeAttestation(accountProfile: string): AttestationRead {
  const opened = openAttestationFile(join(accountProfile, ATTESTATION_FILENAME));
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
  | { ok: false; absence: Exclude<AttestationAbsence, "attestation_actor_mismatch"> };

export function attestationWire(read: AttestationRead): AttestationWire {
  if (read.ok) {
    return {
      ok: true,
      attestationId: read.attestation.attestationId,
      doctrineCommit: read.attestation.doctrineCommit,
      actor: read.attestation.actor,
    };
  }
  // Actor mismatch is computed at bind time against the delivery, never sent
  // by a surface as a claimed absence.
  if (read.absence === "attestation_actor_mismatch") {
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
 * Open-and-read that cannot stall the edge loop. `dispatchClaimed` calls this
 * before its first `await`, so a FIFO or device left at the attestation path
 * would otherwise block every co-tenant delivery on this edge. Non-blocking
 * open + `fstat` + a bounded read turns those into `attestation_unreadable`.
 */
function openAttestationFile(path: string): { ok: true; raw: string } | { ok: false; absence: AttestationAbsence } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, absence: code === "ENOENT" ? "no_attestation_file" : "attestation_unreadable" };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 0 || info.size > MAX_ATTESTATION_BYTES) {
      return { ok: false, absence: "attestation_unreadable" };
    }
    const buf = Buffer.alloc(info.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n < 0 || n > MAX_ATTESTATION_BYTES) {
      return { ok: false, absence: "attestation_unreadable" };
    }
    return { ok: true, raw: buf.subarray(0, n).toString("utf8") };
  } catch {
    return { ok: false, absence: "attestation_unreadable" };
  } finally {
    closeSync(fd);
  }
}

