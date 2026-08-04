import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface EdgeStatePaths {
  /** Path to the edge SQLite database (better-sqlite3 opens this). */
  dbPath: string;
  /** Path to the edge control UDS socket. */
  socketPath: string;
  /** Root directory for per-actor ingress inboxes. */
  ingressDir: string;
}

/**
 * better-sqlite3 refuses to create a database whose parent directory does not
 * exist ("Cannot open database because the directory does not exist"), and the
 * control socket has the same requirement. On a fresh machine `~/.hive/` and its
 * subtree do not exist yet, so the edge crashed on boot. Create the parent dirs
 * of the DB and the control socket, and the ingress dir itself, before anything
 * opens them. Recursive mkdir is idempotent — an existing tree is a no-op.
 */
export function ensureEdgeStateDirs(paths: EdgeStatePaths): void {
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  mkdirSync(dirname(paths.socketPath), { recursive: true });
  mkdirSync(paths.ingressDir, { recursive: true });
}
