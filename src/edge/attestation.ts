import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The record `weave-doctrine`'s installer persists into a seat's profile dir.
 * Only the fields the edge binds a wake to are modelled here; the rest of the
 * envelope (artifact hashes, skill names, env key names) is `weave doctor`'s
 * business, not the bus's.
 */
export const ATTESTATION_FILENAME = ".weave-attestation.json";
const ATTESTATION_SCHEMA = "weave.attestation/1";

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
  let raw: string;
  try {
    raw = readFileSync(join(accountProfile, ATTESTATION_FILENAME), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, absence: code === "ENOENT" ? "no_attestation_file" : "attestation_unreadable" };
  }
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
  return { ok: true, attestation: { attestationId, doctrineCommit, actor } };
}

