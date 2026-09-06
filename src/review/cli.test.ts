import assert from "node:assert/strict";
import { Command } from "commander";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Receipt, ReviewState } from "./contract.js";
import { registerReviewCommands, resolveCustody, type ReviewActBody, type ReviewTransport } from "./cli.js";
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
    registerReviewCommands(program, transport, env);
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await program.parseAsync(["review", ...args], { from: "user" });
    } finally {
      process.stdout.write = original;
    }
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
  for (const variable of ["HIVE_DELIVERY_TOKEN", "HIVE_SESSION_TOKEN"]) {
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

test("operator-only verbs refuse without --as-operator; a seat write needs a delivery token; session custody is deferred", async () => {
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
  assert.deepEqual(calls, []);

  const { run: runCold } = cli({}, transport);
  await assert.rejects(runCold("classify", "42:7", "fnd_05", "P3", "--expect", "4"), /no custody/);
  const { run: runSession } = cli({ HIVE_SESSION_TOKEN: "s" }, transport);
  await assert.rejects(runSession("classify", "42:7", "fnd_05", "P3", "--expect", "4"), /not implemented yet \(M2\)/);
  assert.deepEqual(calls, []);
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
