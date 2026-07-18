import Database from "better-sqlite3";
import type { Delivery } from "../domain.js";

export type LocalDispatchStatus =
  | "received"
  | "dispatching"
  | "dispatched"
  | "processed"
  | "undeliverable"
  | "ambiguous"
  | "dead_letter";

interface LocalRow {
  delivery_id: number;
  generation: number;
  status: LocalDispatchStatus;
  provider_receipt: string | null;
	spawned_session_id: string | null;
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
		spawned_session_id TEXT,
        delivery_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
	const columns = this.db.pragma("table_info(local_deliveries)") as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "spawned_session_id")) {
		this.db.exec("ALTER TABLE local_deliveries ADD COLUMN spawned_session_id TEXT");
	}
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
		spawned_session_id=NULL,
        delivery_json=excluded.delivery_json,
        updated_at=excluded.updated_at
      WHERE excluded.generation > local_deliveries.generation
    `).run(delivery.id, generation, JSON.stringify(delivery), now);
    return this.get(delivery.id)!;
  }

	setStatus(
		deliveryId: number,
		generation: number,
		status: LocalDispatchStatus,
		receipt: string | null = null,
		spawnedSessionId: string | null = null,
	): LocalRow {
    const result = this.db.prepare(`
	  UPDATE local_deliveries
	  SET status=?, provider_receipt=?, spawned_session_id=?, updated_at=?
      WHERE delivery_id=? AND generation=?
	`).run(status, receipt, spawnedSessionId, new Date().toISOString(), deliveryId, generation);
    if (result.changes !== 1) throw new Error(`local delivery ${deliveryId} generation mismatch`);
    return this.get(deliveryId)!;
  }

  get(deliveryId: number): LocalRow | null {
    return this.db.prepare("SELECT * FROM local_deliveries WHERE delivery_id=?").get(deliveryId) as LocalRow | undefined ?? null;
  }

	listAmbiguousAfterRestart(limit = 100): LocalRow[] {
	const boundedLimit = Math.min(Math.max(limit, 1), 500);
	return this.db.prepare(`
		SELECT * FROM local_deliveries
		WHERE status IN ('dispatching', 'dispatched') ORDER BY delivery_id LIMIT ?
	`).all(boundedLimit) as LocalRow[];
  }

  delivery(deliveryId: number): Delivery | null {
    const row = this.get(deliveryId);
    return row ? JSON.parse(row.delivery_json) as Delivery : null;
  }
}
