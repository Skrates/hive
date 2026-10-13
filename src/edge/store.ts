import Database from "better-sqlite3";
import { canonicalActor, type Delivery } from "../domain.js";
import type { AttestationAbsence, AttestationRead } from "./attestation.js";

/** What a delivery row records about the seat attestation it ran under. */
export interface AttestationBinding {
  attestationId: string | null;
  doctrineCommit: string | null;
  absence: AttestationAbsence | null;
}

/**
 * An attestation whose actor disagrees with the delivery's keeps its id and
 * commit — that is exactly the evidence a misbound seat leaves — and carries
 * the mismatch as its absence reason. The edge records; it does not refuse.
 * Refusing on identity drift is ruling B1, sequenced after this surface by D1.
 */
export function bindingFor(read: AttestationRead, actor: string): AttestationBinding {
  if (!read.ok) return { attestationId: null, doctrineCommit: null, absence: read.absence };
  const { attestationId, doctrineCommit } = read.attestation;
  return {
    attestationId,
    doctrineCommit,
    // Both sides canonical: the broker migrates stored actor keys to their
    // canonical form (aa28fb3), while a pinned profile's attestation may still
    // spell the actor the way it was enrolled. Identity is the actor, not the
    // bytes of its spelling.
    absence: canonicalActor(read.attestation.actor) === canonicalActor(actor) ? null : "attestation_actor_mismatch",
  };
}

/** How long a bind's retained evidence can recover its committed receipt. */
export const BIND_INTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface AttentionHandleRecord {
  handleHash: string;
  brokerUuid: string;
  sourceId: string;
  provenance: string;
  actor: string;
  projectId: string;
  workId: string;
  revokedAt?: string | null;
}

export type LocalDispatchStatus =
  | "received"
  | "dispatching"
  | "dispatched"
  | "processed"
  | "undeliverable"
  | "released";

interface LocalRow {
  delivery_id: number;
  generation: number;
  status: LocalDispatchStatus;
  provider_receipt: string | null;
  /** The seat attestation this wake ran under; null with `attestation_absence` set. */
  attestation_id: string | null;
  doctrine_commit: string | null;
  attestation_absence: string | null;
  /**
   * Prior attempts' bindings and receipts, oldest first. The current attempt
   * lives in the columns above; this array is only the ones a redelivery
   * replaced. Null until the first redelivery.
   */
  attestation_history: string | null;
  delivery_json: string;
  updated_at: string;
}

/**
 * Columns added after the ledger shipped. `CREATE TABLE IF NOT EXISTS` is a
 * no-op on an existing table, so an edge upgraded in place would keep the old
 * shape forever and every attestation write would fail at runtime. Each column
 * is added exactly once, guarded by the live column list.
 */
const LEDGER_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["attestation_id", "TEXT"],
  ["doctrine_commit", "TEXT"],
  ["attestation_absence", "TEXT"],
  ["attestation_history", "TEXT"],
];

export class EdgeStore {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_deliveries (
        delivery_id INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        provider_receipt TEXT,
        attestation_id TEXT,
        doctrine_commit TEXT,
        attestation_absence TEXT,
        attestation_history TEXT,
        delivery_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const present = new Set(
      (this.db.pragma("table_info(local_deliveries)") as Array<{ name: string }>).map((column) => column.name),
    );
    for (const [name, type] of LEDGER_COLUMNS) {
      if (!present.has(name)) this.db.exec(`ALTER TABLE local_deliveries ADD COLUMN ${name} ${type}`);
    }
    // ADR-0004: local attention source handles. Only a hash of each handle is kept, bound to
    // the broker that issued its source; this table owns no queue state. A revoked handle's
    // identity is retained so an already-committed receipt can still be recovered.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attention_source_handles (
        handle_hash TEXT PRIMARY KEY,
        broker_uuid TEXT NOT NULL,
        source_id TEXT NOT NULL,
        provenance TEXT NOT NULL,
        actor TEXT NOT NULL,
        project_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS attention_source_handles_source ON attention_source_handles(source_id);
      CREATE TABLE IF NOT EXISTS attention_bind_intents (
        command_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (command_id, evidence_json)
      );
    `);
  }

  close(): void { this.db.close(); }

  putAttentionHandle(record: AttentionHandleRecord): void {
    this.db.prepare(`
      INSERT INTO attention_source_handles(handle_hash, broker_uuid, source_id, provenance, actor, project_id, work_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.handleHash, record.brokerUuid, record.sourceId, record.provenance, record.actor, record.projectId, record.workId, new Date().toISOString());
  }

  attentionHandle(handleHash: string): AttentionHandleRecord | null {
    const row = this.db.prepare("SELECT * FROM attention_source_handles WHERE handle_hash=?").get(handleHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      handleHash: String(row.handle_hash),
      brokerUuid: String(row.broker_uuid),
      sourceId: String(row.source_id),
      provenance: String(row.provenance),
      actor: String(row.actor),
      projectId: String(row.project_id),
      workId: String(row.work_id),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    };
  }

  /**
   * The evidence this edge resolved for a bind, retained under its command id BEFORE the bind
   * is sent: the dispatch token or live registration it came from ends with the turn, and a
   * retry after a lost response or an edge restart must present byte-identical evidence for
   * the broker to replay the committed receipt. Retained for {@link BIND_INTENT_RETENTION_MS}.
   */
  recordAttentionBindIntent(commandId: string, evidenceJson: string): void {
    const now = new Date();
    this.db.prepare("DELETE FROM attention_bind_intents WHERE recorded_at < ?")
      .run(new Date(now.getTime() - BIND_INTENT_RETENTION_MS).toISOString());
    this.db.prepare(`
      INSERT INTO attention_bind_intents(command_id, evidence_json, recorded_at) VALUES (?, ?, ?)
      ON CONFLICT(command_id, evidence_json) DO UPDATE SET recorded_at=excluded.recorded_at
    `).run(commandId, evidenceJson, now.toISOString());
  }

  /** Every evidence variant sent under a command id, newest first. */
  attentionBindIntents(commandId: string): string[] {
    return (this.db.prepare("SELECT evidence_json FROM attention_bind_intents WHERE command_id=? ORDER BY recorded_at DESC, rowid DESC")
      .all(commandId) as Array<{ evidence_json: string }>).map((row) => row.evidence_json);
  }

  /** The broker refused a write because the source was revoked: remember it, keep the identity. */
  markAttentionSourceRevoked(sourceId: string): void {
    this.db.prepare("UPDATE attention_source_handles SET revoked_at=COALESCE(revoked_at, ?) WHERE source_id=?")
      .run(new Date().toISOString(), sourceId);
  }

  /**
   * Record a claimed delivery, bound to the attestation of the seat profile it
   * will execute under (KRA-1077). The binding is written with the claim, not
   * after the turn: a wake whose outcome is traced later must resolve to the
   * artifacts that were installed when it *started*, and a reinstall mid-turn
   * must not be able to rewrite that answer.
   */
  /**
   * Re-point the current attempt's attestation at what the provider start
   * actually read. The capture→use window closes from both ends: claim-time
   * capture (receive) plus this provider-start re-read — an installer that
   * replaces the profile between the two no longer leaves the row naming
   * artifacts the turn never used. Same-generation, pre-terminal only: a
   * terminal or re-claimed row keeps its own story.
   */
  rebind(deliveryId: number, generation: number, binding: AttestationBinding): void {
    this.db.prepare(`
      UPDATE local_deliveries
      SET attestation_id=?, doctrine_commit=?, attestation_absence=?, updated_at=?
      WHERE delivery_id=? AND generation=? AND status IN ('received', 'dispatching')
    `).run(
      binding.attestationId,
      binding.doctrineCommit,
      binding.absence,
      new Date().toISOString(),
      deliveryId,
      generation,
    );
  }

  receive(delivery: Delivery, generation: number, binding: AttestationBinding): LocalRow {
    const now = new Date().toISOString();
    const history = historyAfterReceive(this.get(delivery.id), generation, delivery.attempts);
    this.db.prepare(`
      INSERT INTO local_deliveries(
        delivery_id, generation, status, attestation_id, doctrine_commit, attestation_absence, attestation_history, delivery_json, updated_at
      )
      VALUES (?, ?, 'received', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(delivery_id) DO UPDATE SET
        generation=excluded.generation,
        status='received',
        provider_receipt=NULL,
        attestation_id=excluded.attestation_id,
        doctrine_commit=excluded.doctrine_commit,
        attestation_absence=excluded.attestation_absence,
        attestation_history=excluded.attestation_history,
        delivery_json=excluded.delivery_json,
        updated_at=excluded.updated_at
      WHERE excluded.generation > local_deliveries.generation
         OR (
           excluded.generation = local_deliveries.generation
           AND CAST(json_extract(excluded.delivery_json, '$.attempts') AS INTEGER)
             > CAST(json_extract(local_deliveries.delivery_json, '$.attempts') AS INTEGER)
         )
    `).run(
      delivery.id,
      generation,
      binding.attestationId,
      binding.doctrineCommit,
      binding.absence,
      history,
      JSON.stringify(delivery),
      now,
    );
    return this.get(delivery.id)!;
  }

  setStatus(deliveryId: number, generation: number, status: LocalDispatchStatus, receipt: string | null = null): LocalRow {
    const result = this.db.prepare(`
      UPDATE local_deliveries SET status=?, provider_receipt=?, updated_at=?
      WHERE delivery_id=? AND generation=?
    `).run(status, receipt, new Date().toISOString(), deliveryId, generation);
    if (result.changes !== 1) throw new Error(`local delivery ${deliveryId} generation mismatch`);
    return this.get(deliveryId)!;
  }

  get(deliveryId: number): LocalRow | null {
    return this.db.prepare("SELECT * FROM local_deliveries WHERE delivery_id=?").get(deliveryId) as LocalRow | undefined ?? null;
  }

  /** Deliveries an edge crash left mid-dispatch; ADR-0003 R-3 requeues them via broker release. */
  listInterruptedDispatches(): LocalRow[] {
    return this.db.prepare("SELECT * FROM local_deliveries WHERE status='dispatching' ORDER BY delivery_id").all() as LocalRow[];
  }

  delivery(deliveryId: number): Delivery | null {
    const row = this.get(deliveryId);
    return row ? JSON.parse(row.delivery_json) as Delivery : null;
  }
}

interface AttestationAttemptRecord {
  attempt: number;
  attestationId: string | null;
  doctrineCommit: string | null;
  absence: string | null;
  receipt: string | null;
}

function attemptOf(row: LocalRow): number {
  try {
    const parsed = JSON.parse(row.delivery_json) as { attempts?: unknown };
    return typeof parsed.attempts === "number" ? parsed.attempts : 0;
  } catch {
    return 0;
  }
}

function parseHistory(raw: string | null): AttestationAttemptRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as AttestationAttemptRecord[] : [];
  } catch {
    return [];
  }
}

/**
 * At-least-once delivery may have produced effects under the previous
 * attempt's attestation. The current columns rebind to the new claim; the
 * replaced attempt is appended so the earlier self-identifying try stays
 * traceable.
 */
function historyAfterReceive(existing: LocalRow | null, generation: number, nextAttempts: number): string | null {
  if (!existing) return null;
  const advances = generation > existing.generation
    || (generation === existing.generation && nextAttempts > attemptOf(existing));
  if (!advances) return existing.attestation_history;
  const prior = parseHistory(existing.attestation_history);
  prior.push({
    attempt: attemptOf(existing),
    attestationId: existing.attestation_id,
    doctrineCommit: existing.doctrine_commit,
    absence: existing.attestation_absence,
    receipt: existing.provider_receipt,
  });
  return JSON.stringify(prior);
}
