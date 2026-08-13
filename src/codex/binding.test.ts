import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCodexAttachmentActor,
  CODEX_ATTACHMENT_CONFIRMATION_TIMEOUT_MS,
  createCodexForegroundBinding,
  readCodexForegroundBinding,
  removeCodexForegroundBinding,
  restoreCodexForegroundBinding,
} from "./binding.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./desktop-ipc.js";

test("attachment confirmation outlives initialization, a stale follower, and its replacement", () => {
  assert.ok(CODEX_ATTACHMENT_CONFIRMATION_TIMEOUT_MS > DEFAULT_REQUEST_TIMEOUT_MS * 3);
});

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

test("the attachment actor grammar rejects names that would escape the bindings directory", () => {
  assertCodexAttachmentActor("ariadne");
  assertCodexAttachmentActor("claude-1");
  for (const actor of ["../../.config/foo", "a/b", "/absolute", "..", "Ariadne", "", "everyone"]) {
    assert.throws(() => assertCodexAttachmentActor(actor), /invalid Hive actor/, actor);
  }
});

test("an unconfirmed replacement restores the previous binding without clobbering a newer revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-codex-binding-rollback-"));
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
    INSERT INTO threads VALUES ('task-a', '/work/hive', 0, 'vscode', 'user', NULL, 1, 1);
    INSERT INTO threads VALUES ('task-b', '/work/hive', 0, 'vscode', 'user', NULL, 2, 2);
    INSERT INTO threads VALUES ('task-c', '/work/hive', 0, 'vscode', 'user', NULL, 3, 3);
  `);
  db.close();
  await chmod(database, 0o600);
  const input = { actor: "ariadne", cwd: "/work/hive", stateDatabase: database, bindingFile };
  const previous = await createCodexForegroundBinding({ ...input, sessionId: "task-a" });
  const failed = await createCodexForegroundBinding({ ...input, sessionId: "task-b" });

  assert.equal(await restoreCodexForegroundBinding(bindingFile, failed.revision, previous), true);
  assert.deepEqual(await readCodexForegroundBinding(bindingFile), previous);

  const newer = await createCodexForegroundBinding({ ...input, sessionId: "task-c" });
  assert.equal(await restoreCodexForegroundBinding(bindingFile, failed.revision, previous), false);
  assert.deepEqual(await readCodexForegroundBinding(bindingFile), newer);
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
