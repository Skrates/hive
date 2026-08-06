import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCodexForegroundBinding,
  readCodexForegroundBinding,
  removeCodexForegroundBinding,
} from "./binding.js";

test("attachment is exact-cwd, primary-task verified, atomic, and owner-only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-codex-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, "state.sqlite");
  const bindingFile = join(root, "bindings", "ariadne.json");
  const db = new Database(database);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, archived INTEGER NOT NULL,
      source TEXT NOT NULL, thread_source TEXT, agent_role TEXT,
      updated_at_ms INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL
    );
    INSERT INTO threads VALUES ('foreground', '/work/hive', 0, 'vscode', 'user', NULL, 1, 1);
  `);
  db.close();
  await chmod(database, 0o600);

  const binding = await createCodexForegroundBinding({
    actor: "ariadne",
    sessionId: "foreground",
    cwd: "/work/hive",
    stateDatabase: database,
    bindingFile,
  });
  assert.equal(binding.actor, "ariadne");
  assert.equal(binding.sessionId, "foreground");
  assert.equal((await stat(bindingFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readCodexForegroundBinding(bindingFile), binding);
  assert.match(await readFile(bindingFile, "utf8"), /"revision"/);

  await removeCodexForegroundBinding(bindingFile);
  assert.equal(await readCodexForegroundBinding(bindingFile), null);
});

test("attachment rejects the wrong cwd and spawned child tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-codex-binding-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, "state.sqlite");
  const db = new Database(database);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, archived INTEGER NOT NULL,
      source TEXT NOT NULL, thread_source TEXT, agent_role TEXT,
      updated_at_ms INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL
    );
    INSERT INTO threads VALUES ('child', '/work/hive', 0, 'vscode', 'user', NULL, 1, 1);
    INSERT INTO thread_spawn_edges VALUES ('parent', 'child', 'open');
  `);
  db.close();
  await chmod(database, 0o600);
  const base = { actor: "ariadne", stateDatabase: database, bindingFile: join(root, "binding.json") };
  await assert.rejects(
    () => createCodexForegroundBinding({ ...base, sessionId: "child", cwd: "/work/hive" }),
    /not an active primary user task/,
  );
  await assert.rejects(
    () => createCodexForegroundBinding({ ...base, sessionId: "child", cwd: "/work/other" }),
    /not an active primary user task/,
  );
});
