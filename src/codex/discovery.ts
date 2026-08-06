import Database from "better-sqlite3";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Row {
  id: string;
  cwd: string;
  updated_at_ms: number;
  thread_source: string;
}

export interface DiscoveredCodexThread {
  sessionId: string;
  cwd: string;
  updatedAtMs: number;
  threadSource: "user";
  parentThreadId: null;
}

export class CodexThreadCatalog {
  private readonly db: Database.Database;

  constructor(
    readonly path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "state_5.sqlite"),
  ) {
    assertPrivateDatabase(path);
    this.db = new Database(path, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  latestPrimaryUserThread(cwd: string): DiscoveredCodexThread | null {
    const row = this.db.prepare(`
      SELECT t.id, t.cwd, t.updated_at_ms, t.thread_source
      FROM threads t
      WHERE t.archived=0
        AND t.cwd=?
        AND t.thread_source='user'
        AND (t.agent_role IS NULL OR t.agent_role='')
        AND t.source NOT LIKE '%"subagent"%'
        AND NOT EXISTS (
          SELECT 1 FROM thread_spawn_edges edge WHERE edge.child_thread_id=t.id
        )
      ORDER BY t.recency_at_ms DESC, t.updated_at_ms DESC, t.id DESC
      LIMIT 1
    `).get(cwd) as Row | undefined;
    return discoveredThread(row);
  }

  primaryUserThread(sessionId: string, cwd: string): DiscoveredCodexThread | null {
    const row = this.db.prepare(`
      SELECT t.id, t.cwd, t.updated_at_ms, t.thread_source
      FROM threads t
      WHERE t.id=?
        AND t.archived=0
        AND t.cwd=?
        AND t.thread_source='user'
        AND (t.agent_role IS NULL OR t.agent_role='')
        AND t.source NOT LIKE '%"subagent"%'
        AND NOT EXISTS (
          SELECT 1 FROM thread_spawn_edges edge WHERE edge.child_thread_id=t.id
        )
      LIMIT 1
    `).get(sessionId, cwd) as Row | undefined;
    return discoveredThread(row);
  }
}

function discoveredThread(row: Row | undefined): DiscoveredCodexThread | null {
  if (!row || row.thread_source !== "user") return null;
  return {
    sessionId: row.id,
    cwd: row.cwd,
    updatedAtMs: Number(row.updated_at_ms),
    threadSource: "user",
    parentThreadId: null,
  };
}

function assertPrivateDatabase(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Cannot verify Codex state database ownership");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error("Codex state database is not securely owned");
  }
}

