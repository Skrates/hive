import Database from "better-sqlite3";
import type { Delivery } from "../domain.js";

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
  delivery_json: string;
  updated_at: string;
}

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
        delivery_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  receive(delivery: Delivery, generation: number): LocalRow {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO local_deliveries(delivery_id, generation, status, delivery_json, updated_at)
      VALUES (?, ?, 'received', ?, ?)
      ON CONFLICT(delivery_id) DO UPDATE SET
        generation=excluded.generation,
        status='received',
        provider_receipt=NULL,
        delivery_json=excluded.delivery_json,
        updated_at=excluded.updated_at
      WHERE excluded.generation > local_deliveries.generation
         OR (
           excluded.generation = local_deliveries.generation
           AND CAST(json_extract(excluded.delivery_json, '$.attempts') AS INTEGER)
             > CAST(json_extract(local_deliveries.delivery_json, '$.attempts') AS INTEGER)
         )
    `).run(delivery.id, generation, JSON.stringify(delivery), now);
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
