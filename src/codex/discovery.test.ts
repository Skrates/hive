import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexThreadCatalog } from "./discovery.js";

test("catalog selects only the latest exact-cwd primary user thread", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hive-catalog-"));
  const path = join(directory, "state.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, archived INTEGER NOT NULL,
      source TEXT NOT NULL, thread_source TEXT, agent_role TEXT,
      updated_at_ms INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO threads(id,cwd,archived,source,thread_source,agent_role,updated_at_ms,recency_at_ms)
    VALUES(?,?,?,?,?,?,?,?)
  `);
  insert.run("wrong-cwd", "/work/other", 0, "vscode", "user", null, 500, 500);
  insert.run("archived", "/work/hive", 1, "vscode", "user", null, 600, 600);
  insert.run("subagent", "/work/hive", 0, '{"subagent":{}}', "subagent", null, 700, 700);
  insert.run("spawn-child", "/work/hive", 0, "vscode", "user", null, 800, 800);
  db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)").run("primary-old", "spawn-child", "open");
  insert.run("primary-old", "/work/hive", 0, "vscode", "user", null, 100, 100);
  insert.run("primary-new", "/work/hive", 0, "vscode", "user", null, 400, 400);
  db.close();
  await chmod(path, 0o600);
  const catalog = new CodexThreadCatalog(path);
  t.after(() => {
    catalog.close();
    return rm(directory, { recursive: true, force: true });
  });

  assert.deepEqual(catalog.latestPrimaryUserThread("/work/hive"), {
    sessionId: "primary-new",
    cwd: "/work/hive",
    updatedAtMs: 400,
    threadSource: "user",
    parentThreadId: null,
  });
  assert.deepEqual(catalog.primaryUserThread("primary-old", "/work/hive"), {
    sessionId: "primary-old",
    cwd: "/work/hive",
    updatedAtMs: 100,
    threadSource: "user",
    parentThreadId: null,
  });
  assert.equal(catalog.primaryUserThread("primary-old", "/work/other"), null);
  assert.equal(catalog.primaryUserThread("archived", "/work/hive"), null);
  assert.equal(catalog.primaryUserThread("spawn-child", "/work/hive"), null);
  assert.equal(catalog.latestPrimaryUserThread("/work/missing"), null);
});
