import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Command } from "commander";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Receipt, ReviewState } from "./contract.js";
import { registerReviewCommands, resolveCustody, type ReviewActBody, type ReviewTransport } from "./cli.js";
import { REVIEW_STORE_GENERATION, ReviewStore, type ReviewStoreDeps } from "./store.js";
import { policy as POLICY_FIXTURE } from "./fixtures.js";
import { ULID_PATTERN } from "./ulid.js";

const STATE = { revision: 4, subject: { key: `${"a".repeat(40)}:main` } } as unknown as ReviewState;

function applied(body: ReviewActBody): Receipt {
  return {
    review_id: "rev_1",
    act_id: body.act_id,
    outcome: { applied: true, revision_before: body.expected_revision, revision_after: body.expected_revision + 1, batch_id: `bat_${body.act_id}`, effects: [] },
  };
}

/** Records every call; nothing leaves the process. */
function fakeTransport(answer: (body: ReviewActBody) => Receipt = applied) {
  const calls: Array<{ via: string; key: string; token?: string; body?: ReviewActBody }> = [];
  const transport: ReviewTransport = {
    async edgeRead(key) { calls.push({ via: "edgeRead", key }); return STATE; },
    async edgeReconcile(key) { calls.push({ via: "edgeReconcile", key }); return { accepted: true }; },
    async edgeAct(key, token, body) {
      calls.push({ via: "edgeAct", key, token, body });
      const receipt = answer(body);
      return { status: "refused" in receipt.outcome ? 409 : 200, receipt };
    },
    async operatorRead(key, token) { calls.push({ via: "operatorRead", key, token }); return STATE; },
    async operatorAct(key, token, body) {
      calls.push({ via: "operatorAct", key, token, body });
      const receipt = answer(body);
      return { status: "refused" in receipt.outcome ? 409 : 200, receipt };
    },
    async adminPutPolicy() { throw new Error("not used"); },
    async adminCreateOperator() { throw new Error("not used"); },
  };
  return { transport, calls };
}

/** A fresh Command per invocation: commander keeps parsed options on the command between parses. */
function cli(env: NodeJS.ProcessEnv, transport: ReviewTransport) {
  const stdout: string[] = [];
  const run = async (...args: string[]): Promise<string[]> => {
    const program = new Command().name("hive").exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerReviewCommands(program, transport, env, text => { stdout.push(`${text}\n`); });
    await program.parseAsync(["review", ...args], { from: "user" });
    return stdout;
  };
  return { run, stdout };
}

function tokenFile(t: test.TestContext, mode: number): string {
  const root = mkdtempSync(join(tmpdir(), "hive-review-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "operator.token");
  writeFileSync(path, "fake-operator-token-for-tests\n");
  chmodSync(path, mode);
  return path;
}

test("§5.A2: --as-operator is refused before any request while a seat token is in the environment", async (t) => {
  const { transport, calls } = fakeTransport();
  const file = tokenFile(t, 0o600);
  for (const variable of ["HIVE_DELIVERY_TOKEN", "HIVE_DELIVERY_ID", "HIVE_SESSION_TOKEN", "HIVE_SESSION_TOKEN_FILE", "HIVE_ACTOR"]) {
    const { run } = cli({ [variable]: "seat-token", HIVE_OPERATOR_TOKEN_FILE: file }, transport);
    await assert.rejects(
      run("grant-rounds", "Skrates/hive#7", "2", "--reason", "one more burn", "--expect", "4", "--as-operator"),
      (error: Error) => error.message.includes("refusing --as-operator") && error.message.includes(variable),
    );
  }
  assert.deepEqual(calls, [], "nothing left the machine");
  // The pure check says the same thing without a Command around it.
  assert.throws(() => resolveCustody({ HIVE_DELIVERY_TOKEN: "x" }, true), /refusing --as-operator/);
});

test("§5.A2: the operator token file must be owner-only, is read for the write, and is never echoed", async (t) => {
  const wide = tokenFile(t, 0o644);
  const { transport, calls } = fakeTransport();
  const { run: runWide } = cli({ HIVE_OPERATOR_TOKEN_FILE: wide }, transport);
  await assert.rejects(
    runWide("grant-rounds", "Skrates/hive#7", "2", "--reason", "one more burn", "--expect", "4", "--as-operator"),
    /mode 0644 is readable beyond its owner/,
  );
  assert.equal(calls.length, 0);

  const owned = tokenFile(t, 0o600);
  const { run, stdout } = cli({ HIVE_OPERATOR_TOKEN_FILE: owned }, transport);
  await run("grant-rounds", "Skrates/hive#7", "2", "--reason", "one more burn", "--expect", "4", "--as-operator");
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.via, "operatorAct");
  assert.equal(call.token, "fake-operator-token-for-tests");
  assert.deepEqual(call.body!.action, { kind: "GrantRounds", n: 2, reason: "one more burn" });
  assert.equal(call.body!.expected_revision, 4);
  assert.match(call.body!.act_id, ULID_PATTERN, "every write mints a client ULID (§5.B2)");
  assert.ok(stdout.join("").includes("applied"));
  assert.ok(!stdout.join("").includes("fake-operator-token"), "the token is never printed");
  assert.throws(() => resolveCustody({}, true), /HIVE_OPERATOR_TOKEN_FILE/);
});

test("operator-only verbs refuse without --as-operator; a seat write needs delivery or session custody", async () => {
  const { transport, calls } = fakeTransport();
  const { run } = cli({ HIVE_DELIVERY_TOKEN: "turn-token" }, transport);
  for (const verb of [
    ["grant-rounds", "2", "--reason", "r"],
    ["rule", "fnd_1", "--resolution", "ship it", "--evidence", "e"],
    ["availability", "codex", "--unavailable", "--reason", "quota", "--evidence", "e"],
    ["adopt-policy", "2"],
  ]) {
    await assert.rejects(run(verb[0]!, "42:7", ...verb.slice(1), "--expect", "4"), /operator act/);
  }
  assert.equal(calls.length, 0);

  const { run: runCold } = cli({}, transport);
  await assert.rejects(runCold("classify", "42:7", "fnd_05", "P3", "--expect", "4"), /no custody/);
  const { run: runSession } = cli({ HIVE_SESSION_TOKEN: "s" }, transport);
  await runSession("classify", "42:7", "fnd_05", "P3", "--expect", "4");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.via, "edgeAct");
  assert.equal(calls[0]!.token, "s");
});

test("--expect is mandatory on every write and must be a revision", async () => {
  const { transport, calls } = fakeTransport();
  const { run } = cli({ HIVE_DELIVERY_TOKEN: "turn-token" }, transport);
  await assert.rejects(run("classify", "42:7", "fnd_05", "P3"), /--expect/);
  await assert.rejects(run("release", "42:7", "hold_1", "--reason", "done"), /--expect/);
  await assert.rejects(run("classify", "42:7", "fnd_05", "P3", "--expect", "three"), /--expect must be the revision/);
  assert.deepEqual(calls, []);
});

test("a seat write presents the turn's token to the edge with a contract-shaped action; both key forms are accepted, others refused", async () => {
  const { transport, calls } = fakeTransport();
  const { run } = cli({ HIVE_DELIVERY_TOKEN: "turn-token" }, transport);
  await run("resolve", "Skrates/hive#7", "fnd_05", "fixed", "--evidence", "tests pass", "--commit", "a".repeat(40), "--commit", "b".repeat(40), "--expect", "4");
  await run("classify", "42:7", "fnd_05", "P1", "--expect", "4");
  await run("hold", "42:7", "--kind", "human-gate", "--reason", "Hákon decides", "--release-on", "subject-change", "--expect", "4");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.via, "edgeAct");
  assert.equal(calls[0]!.token, "turn-token");
  assert.equal(calls[0]!.key, "Skrates/hive#7");
  assert.deepEqual(calls[0]!.body!.action, {
    kind: "ResolveFinding",
    finding_id: "fnd_05",
    resolution: { kind: "fixed", evidence: "tests pass", commits: ["a".repeat(40), "b".repeat(40)] },
  });
  assert.equal(calls[1]!.key, "42:7");
  assert.deepEqual(calls[1]!.body!.action, { kind: "ClassifyFinding", finding_id: "fnd_05", priority: "P1" });
  assert.deepEqual(calls[2]!.body!.action, {
    kind: "Hold",
    hold: { kind: "human_gate", reason: "Hákon decides", release_on: "subject_change", blocks: { readiness: true, summons: false } },
  });
  assert.notEqual(calls[0]!.body!.act_id, calls[1]!.body!.act_id);

  await assert.rejects(run("classify", "hive#7", "fnd_05", "P1", "--expect", "4"), /not a review key/);
  await assert.rejects(run("read", "42"), /not a review key/);
  assert.equal(calls.length, 3);
});

test("a malformed act is refused before sending, with the contract's own detail", async () => {
  const { transport, calls } = fakeTransport();
  const { run } = cli({ HIVE_DELIVERY_TOKEN: "turn-token" }, transport);
  await assert.rejects(run("classify", "42:7", "fnd_05", "P9", "--expect", "4"), /malformed/);
  await assert.rejects(run("resolve", "42:7", "fnd_05", "fixed", "--evidence", "e", "--expect", "4"), /at least one --commit/);
  await assert.rejects(run("resolve", "42:7", "fnd_05", "follow-up", "--evidence", "e", "--expect", "4"), /--ticket/);
  await assert.rejects(run("resolve", "42:7", "fnd_05", "owner-decision", "--evidence", "e", "--expect", "4"), /hive review rule/);
  assert.deepEqual(calls, []);
});

test("a refusal exits non-zero naming the code, the detail and the current revision", async () => {
  const { transport } = fakeTransport((body) => ({
    review_id: "rev_1",
    act_id: body.act_id,
    outcome: { refused: true, code: "stale_revision", detail: "expected 4, at 6", current_revision: 6, state: STATE },
  }));
  const { run } = cli({ HIVE_DELIVERY_TOKEN: "turn-token" }, transport);
  await assert.rejects(
    run("classify", "42:7", "fnd_05", "P1", "--expect", "4"),
    (error: Error) => /refused stale_revision: expected 4, at 6 \(current revision 6/.test(error.message),
  );
});

test("answer reads the report file, binds the current subject when none is given, and takes exactly one arm", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hive-review-answer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, "report.json");
  writeFileSync(report, JSON.stringify({ not: "validated here" }));
  const { transport, calls } = fakeTransport();
  const { run } = cli({ HIVE_DELIVERY_TOKEN: "turn-token" }, transport);
  // The report is shape-checked locally: an arbitrary object is malformed before any send.
  await assert.rejects(run("answer", "42:7", "--request", "req_1", "--report", report, "--expect", "4"), /malformed/);
  assert.deepEqual(calls.map((call) => call.via), ["edgeRead"], "the subject came from a read; nothing was sent");
  await assert.rejects(run("answer", "42:7", "--request", "req_1", "--expect", "4"), /exactly one of --report/);

  const testimony = join(root, "testimony.json");
  writeFileSync(testimony, JSON.stringify({ cause: null, deliverable: { comment_id: 12 }, scars: [] }));
  await run("answer", "42:7", "--request", "req_1", "--testimony", testimony, "--subject", `${"c".repeat(40)}:main`, "--expect", "4");
  const sent = calls.at(-1)!;
  assert.equal(sent.via, "edgeAct");
  assert.deepEqual(sent.body!.action, {
    kind: "Answer",
    request_id: "req_1",
    subject_key: `${"c".repeat(40)}:main`,
    submission: { arm: "testimony", testimony: { cause: null, deliverable: { comment_id: 12 }, scars: [] } },
  });
});

test("§3.2 CLI stores a session token privately, never echoes it, and refuses overwrites", async t => {
  const root = mkdtempSync(join(tmpdir(), "review-session-cli-"));
  const socket = join(root, "edge.sock");
  const file = join(root, "session.token");
  const token = "fake-session-credential";
  const server = createServer((request, response) => {
    assert.equal(request.url, "/review/session");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ available: true, token }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const { run, stdout } = cli({ HIVE_EDGE_SOCKET: socket }, fakeTransport().transport);
  await run("session", "session-1", "--token-file", file);
  assert.equal(readFileSync(file, "utf8"), token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!stdout.join("").includes(token));
  assert.deepEqual(resolveCustody({ HIVE_SESSION_TOKEN_FILE: file }, false), { kind: "session", token });
  await assert.rejects(run("session", "session-1", "--token-file", file), /EEXIST/);
});

test("§9.1 generated operator arguments enforce the contract before transport", async t => {
  const { transport, calls } = fakeTransport();
  const { run } = cli({ HIVE_OPERATOR_TOKEN_FILE: tokenFile(t, 0o600) }, transport);
  for (const args of [
    ["grant-rounds", "42:7", "0", "--reason", "no"],
    ["adopt-policy", "42:7", "1.5"],
    ["availability", "42:7", "codex", "--unavailable", "--reason", "unknown", "--evidence", "e"],
    ["availability", "42:7", "codex", "--unavailable", "--reason", "quota", "--until", "yesterday", "--evidence", "e"],
    ["rule", "42:7", "fnd_1", "--resolution", "", "--evidence", "e"],
  ]) await assert.rejects(run(...args, "--expect", "4", "--as-operator"));
  assert.equal(calls.length, 0);
  await run("adopt-policy", "42:7", "2", "--expect", "4", "--as-operator");
  assert.deepEqual(calls[0]!.body!.action, { kind: "AdoptPolicy", version: 2 });
});

test("read and reconcile need only the edge socket; --as-operator reads through the broker", async (t) => {
  const { transport, calls } = fakeTransport();
  const { run, stdout } = cli({}, transport);
  await run("read", "Skrates/hive#7", "--json");
  assert.equal(calls[0]!.via, "edgeRead");
  assert.equal((JSON.parse(stdout[0]!) as ReviewState).revision, 4);
  await run("reconcile", "42:7");
  assert.equal(calls[1]!.via, "edgeReconcile");

  const { run: runOperator } = cli({ HIVE_OPERATOR_TOKEN_FILE: tokenFile(t, 0o600) }, transport);
  await runOperator("read", "42:7", "--as-operator", "--json");
  assert.equal(calls[2]!.via, "operatorRead");
  assert.equal(calls[2]!.token, "fake-operator-token-for-tests");
});

// §9.3: the operator's answer to a LegacyReviewStoreError. Custody is the operator credential;
// the drop takes the review tables and leaves policy and operator custody standing.
function legacyStore(t: test.TestContext): { path: string; db: Database.Database; operatorToken: string } {
  const root = mkdtempSync(join(tmpdir(), "hive-review-reset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "broker.sqlite");
  const db = new Database(path);
  const store = new ReviewStore(db, {
    decide: (() => { throw new Error("not used"); }) as unknown as ReviewStoreDeps["decide"],
    fold: (() => { throw new Error("not used"); }) as unknown as ReviewStoreDeps["fold"],
    read: (() => { throw new Error("not used"); }) as unknown as ReviewStoreDeps["read"],
    clock: { now: () => new Date("2026-09-06T00:00:00.000Z") },
  });
  const operatorToken = store.operators.create("hakon");
  store.putPolicy(42, POLICY_FIXTURE());
  // Generation-1 rows, written directly: nothing in this build produces these shapes.
  db.exec(`
    DELETE FROM review_store_generation;
    INSERT INTO reviews (review_id, repository_id, pr_number, display, revision, policy_version, state_json, updated_at)
      VALUES ('rev_legacy', 42, 7, 'Owner/repo#7', 1, 1, '{"requests":[{"id":"req_1","status":"unanswerable"}]}', '2026-09-05T00:00:00.000Z');
    INSERT INTO review_effects (effect_id, review_id, revision, kind, target, payload_json, status, attempts)
      VALUES ('eff_legacy', 'rev_legacy', 1, 'refresh', 'board:rev_legacy', NULL, 'pending', 0);
  `);
  db.close();
  return { path, db, operatorToken };
}

function operatorTokenFile(t: test.TestContext, token: string): string {
  const root = mkdtempSync(join(tmpdir(), "hive-review-reset-token-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "operator.token");
  writeFileSync(file, `${token}\n`);
  chmodSync(file, 0o600);
  return file;
}

test("§9.3 reset-store drops the review tables, keeps policies and operators, stamps, and the store boots again", async (t) => {
  const { path, operatorToken } = legacyStore(t);
  const { transport, calls } = fakeTransport();
  const env = { HIVE_OPERATOR_TOKEN_FILE: operatorTokenFile(t, operatorToken) };
  const { run } = cli(env, transport);
  const printed = (await run("reset-store", path, "--confirm", path, "--as-operator")).join("");
  assert.match(printed, /review tables dropped/u);
  assert.match(printed, /review_policies and operators are untouched/u);
  assert.match(printed, /hive review reconcile/u);
  assert.match(printed, /orphan/u, "the operator is told the old board comments are orphaned");
  assert.deepEqual(calls, [], "nothing left the machine: the broker it would talk to is stopped");

  const db = new Database(path);
  assert.equal((db.prepare("SELECT count(*) AS n FROM review_policies").get() as { n: number }).n, 1, "policy rows are configuration, not review state");
  assert.equal((db.prepare("SELECT operator_id FROM operators").get() as { operator_id: string }).operator_id, "hakon", "operator custody survives");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
  for (const dropped of ["reviews", "review_batches", "review_attempts", "review_effects", "github_inbox", "source_records", "review_projection_handles", "review_transport"]) {
    assert.ok(!tables.includes(dropped), `${dropped} dropped`);
  }
  assert.deepEqual(db.prepare("SELECT generation FROM review_store_generation").all(), [{ generation: REVIEW_STORE_GENERATION }]);
  // The refusal is lifted: a store opens over the reset database.
  const deps = {
    decide: (() => { throw new Error("not used"); }) as unknown as ReviewStoreDeps["decide"],
    fold: (() => { throw new Error("not used"); }) as unknown as ReviewStoreDeps["fold"],
    read: (() => { throw new Error("not used"); }) as unknown as ReviewStoreDeps["read"],
    clock: { now: () => new Date("2026-09-06T00:00:00.000Z") },
  };
  assert.doesNotThrow(() => new ReviewStore(db, deps));
  db.close();
});

test("§9.3 reset-store refuses without a matching --confirm, without --as-operator, and on an unknown operator token, and changes nothing", async (t) => {
  const { path, operatorToken } = legacyStore(t);
  const { transport } = fakeTransport();
  const file = operatorTokenFile(t, operatorToken);
  const rows = () => {
    const db = new Database(path);
    const state = {
      reviews: (db.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n,
      effects: (db.prepare("SELECT count(*) AS n FROM review_effects").get() as { n: number }).n,
      stamped: (db.prepare("SELECT count(*) AS n FROM review_store_generation").get() as { n: number }).n,
    };
    db.close();
    return state;
  };
  const before = rows();

  await assert.rejects(
    cli({ HIVE_OPERATOR_TOKEN_FILE: file }, transport).run("reset-store", path, "--confirm", `${path}.typo`, "--as-operator"),
    (error: Error) => error.message.includes("refusing reset-store") && error.message.includes("nothing was touched"),
  );
  await assert.rejects(
    cli({ HIVE_OPERATOR_TOKEN_FILE: file }, transport).run("reset-store", path, "--confirm", path),
    (error: Error) => error.message.includes("operator act"),
  );
  await assert.rejects(
    cli({ HIVE_OPERATOR_TOKEN_FILE: operatorTokenFile(t, "not-a-live-operator-token") }, transport)
      .run("reset-store", path, "--confirm", path, "--as-operator"),
    (error: Error) => error.message.includes("not a live credential"),
  );
  assert.deepEqual(rows(), before, "every refusal left the store exactly as it was");
  assert.deepEqual(before, { reviews: 1, effects: 1, stamped: 0 });
});
