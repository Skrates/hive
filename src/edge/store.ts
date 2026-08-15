import Database from "better-sqlite3";
import type { Delivery } from "../domain.js";
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
    absence: read.attestation.actor === actor ? null : "attestation_actor_mismatch",
  };
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
  }

  close(): void { this.db.close(); }

  /**
   * Record a claimed delivery, bound to the attestation of the seat profile it
   * will execute under (KRA-1077). The binding is written with the claim, not
   * after the turn: a wake whose outcome is traced later must resolve to the
   * artifacts that were installed when it *started*, and a reinstall mid-turn
   * must not be able to rewrite that answer.
   */
  receive(delivery: Delivery, generation: number, binding: AttestationBinding): LocalRow {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO local_deliveries(
        delivery_id, generation, status, attestation_id, doctrine_commit, attestation_absence, delivery_json, updated_at
      )
      VALUES (?, ?, 'received', ?, ?, ?, ?, ?)
      ON CONFLICT(delivery_id) DO UPDATE SET
        generation=excluded.generation,
        status='received',
        provider_receipt=NULL,
        attestation_id=excluded.attestation_id,
        doctrine_commit=excluded.doctrine_commit,
        attestation_absence=excluded.attestation_absence,
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
