import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureEdgeStateDirs } from "./bootstrap.js";

test("ensureEdgeStateDirs creates the DB parent, socket parent, and ingress dir", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // A brand-new ~/.hive-style tree: none of these parents exist yet.
  const home = join(root, "home", ".hive");
  const paths = {
    dbPath: join(home, "state", "hive-edge.sqlite"),
    socketPath: join(home, "run", "edge.sock"),
    ingressDir: join(home, "ingress"),
  };
  assert.equal(existsSync(home), false);

  ensureEdgeStateDirs(paths);

  assert.ok(statSync(join(home, "state")).isDirectory());
  assert.ok(statSync(join(home, "run")).isDirectory());
  assert.ok(statSync(paths.ingressDir).isDirectory());

  // The DB now opens where it previously crashed with "directory does not exist".
  const db = new Database(paths.dbPath);
  db.close();
  assert.ok(existsSync(paths.dbPath));

  // Idempotent: a second call over the now-existing tree is a no-op, not a throw.
  assert.doesNotThrow(() => ensureEdgeStateDirs(paths));
});
