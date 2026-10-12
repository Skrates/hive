import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import { AttentionTransportError, exitCodeFor, registerAttentionCommands, type AttentionTransport, type HttpAnswer } from "./cli.js";
import { packet } from "./fixtures.js";

interface Run { out: string[]; err: string[]; code: number; calls: Array<{ kind: string; path: string; body: unknown; journalled: boolean }> }

function runCli(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; answer?: (path: string, body: unknown) => HttpAnswer | Promise<HttpAnswer>; home?: string } = {},
): Promise<Run> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "hive-cli-home-"));
  const env: NodeJS.ProcessEnv = { HIVE_HOME: home, HIVE_BROKER_URL: "http://broker.invalid", HIVE_ADMIN_TOKEN: "t".repeat(40), ...options.env };
  const run: Run = { out: [], err: [], code: 0, calls: [] };
  const journalled = (body: unknown): boolean => {
    const id = (body as { command_id?: string; command?: { command_id?: string } })?.command_id
      ?? (body as { command?: { command_id?: string } })?.command?.command_id;
    return id !== undefined && existsSync(join(home, "attention", "requests", `${id}.json`));
  };
  const answer = options.answer ?? (() => ({ status: 200, body: receipt("next", "empty") }));
  const transport: AttentionTransport = {
    async operator(method, path, body) {
      run.calls.push({ kind: `operator ${method}`, path, body, journalled: journalled(body) });
      return answer(path, body);
    },
    async edge(path, body) {
      run.calls.push({ kind: "edge", path, body, journalled: journalled(body) });
      return answer(path, body);
    },
    async edgeHealth() { return true; },
  };
  const program = new Command().exitOverride();
  registerAttentionCommands(program, transport, env, {
    out: (text) => run.out.push(text),
    err: (text) => run.err.push(text),
    exit: (code) => { run.code = code; },
    now: () => new Date("2026-10-12T09:00:00.000Z"),
  });
  return program.parseAsync(["node", "hive", "attention", ...argv]).then(() => run);
}

function receipt(action: string, result: string, extra: Record<string, unknown> = {}) {
  return {
    schema_version: 1, broker_uuid: "00000000-0000-4000-8000-000000000000", command_id: randomUUID(), action, result, replayed: false,
    as_of: "2026-10-12T09:00:00.000Z", item: null, active_item: null, return_effect: null,
    selection: action === "next" ? { selection_reason: "empty", item: null, brief: null, eligible_count: 0, deferred_count: 0, next_deferred_at: null } : null,
    source: null, ...extra,
  };
}

test("§6 HTTP classes map to the specified exit codes", () => {
  assert.deepEqual([200, 201, 400, 413, 422, 401, 403, 404, 409, 429, 503, 500, 502].map(exitCodeFor), [0, 0, 2, 2, 2, 3, 3, 4, 5, 6, 6, 7, 7]);
});

test("a human mutation is journalled 0600 before any I/O and prints exactly one JSON object", async () => {
  const run = await runCli(["resolve", "42", "--expected-revision", "3", "--outcome", "selected", "--response", "Use candidate C.", "--next", "--json"],
    { answer: () => ({ status: 200, body: receipt("resolve", "resolved") }) });
  assert.equal(run.code, 0);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0]!.path, "/v1/attention/commands");
  assert.equal(run.calls[0]!.journalled, true, "the request file existed before the request left");
  const envelope = run.calls[0]!.body as { command_id: string; payload: Record<string, unknown> };
  assert.deepEqual(envelope.payload, { item_id: 42, expected_revision: 3, outcome: "selected", response: "Use candidate C.", select_next: true });
  assert.equal(run.out.length, 1);
  assert.equal(JSON.parse(run.out[0]!).result, "resolved");
  assert.deepEqual(run.err, []);
});

test("a stale decision exits 5 and shows the current revision; JSON mode carries the error envelope", async () => {
  const run = await runCli(["resolve", "42", "--expected-revision", "3", "--outcome", "selected", "--response", "x", "--json"], {
    answer: () => ({ status: 409, body: { error: "revision_conflict", detail: "expected revision 3, item is at 4", current: { item_id: 42, revision: 4, state: "active" } } }),
  });
  assert.equal(run.code, 5);
  assert.equal(JSON.parse(run.out[0]!).error, "revision_conflict");
  assert.match(run.err[0]!, /current revision 4, active/u);
});

test("the operator credential is refused inside an agent's execution environment", async () => {
  const run = await runCli(["next"], { env: { HIVE_DELIVERY_TOKEN: "turn-token" } });
  assert.equal(run.code, 3);
  assert.equal(run.calls.length, 0);
  assert.match(run.err[0]!, /agent's execution environment/u);
});

test("a timeout is an unknown outcome with a reconciliation command, and retry-command resends identical bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "hive-cli-home-"));
  const first = await runCli(["cancel", "7", "--expected-revision", "2", "--reason", "obsolete"], {
    home, answer: () => { throw new AttentionTransportError("timed out"); },
  });
  assert.equal(first.code, 6);
  const commandId = (first.calls[0]!.body as { command_id: string }).command_id;
  assert.match(first.err[0]!, new RegExp(`hive attention receipt ${commandId}`, "u"));
  const journal = join(home, "attention", "requests", `${commandId}.json`);
  assert.equal(statSync(journal).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(journal, "utf8"), /tttttttt/u, "the admin token is never journalled");

  const retry = await runCli(["retry-command", commandId], { home, answer: () => ({ status: 200, body: receipt("cancel", "cancelled", { replayed: true }) }) });
  assert.equal(retry.code, 0);
  assert.deepEqual(retry.calls[0]!.body, first.calls[0]!.body);
  assert.match(retry.out[0]!, /replayed/u);
});

test("bind refuses to guess identity, writes the source file owner-only, and never overwrites one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-cli-bind-"));
  const out = join(dir, "nested", "attention-source.json");
  const none = await runCli(["bind", "--project", "p", "--work", "w", "--return", "actor-context", "--out", out]);
  assert.equal(none.code, 3);
  assert.match(none.err[0]!, /Identity is never guessed/u);

  const sourceFile = {
    schema_version: 1, broker_uuid: "00000000-0000-4000-8000-000000000000", edge_id: "edge-a", source_id: `src_${"c".repeat(32)}`,
    handle: `ahs_${"A".repeat(43)}`, actor: "fable", project_id: "p", work_id: "w", return_mode: "actor_context", provenance: "dispatch",
  };
  const bound = await runCli(["bind", "--project", "p", "--work", "w", "--return", "actor-context", "--out", out], {
    env: { HIVE_DELIVERY_TOKEN: "turn-token" },
    answer: () => ({ status: 201, body: { receipt: receipt("source_bind", "source_bound", { source: { source_id: sourceFile.source_id, actor: "fable", project_id: "p", work_id: "w", return_mode: "actor_context", provenance: "dispatch" } }), source_file: sourceFile } }),
  });
  assert.equal(bound.code, 0);
  assert.equal(bound.calls[0]!.path, "/attention/bind");
  assert.equal((bound.calls[0]!.body as { mode: string; token: string }).mode, "dispatch");
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), sourceFile);
  assert.doesNotMatch(bound.out.join("\n"), /ahs_/u, "the handle is never printed");

  const again = await runCli(["bind", "--project", "p", "--work", "w", "--return", "actor-context", "--out", out], { env: { HIVE_DELIVERY_TOKEN: "turn-token" } });
  assert.equal(again.code, 2);
  assert.equal(again.calls.length, 0);
});

test("summon takes a complete saved envelope through the edge with the source handle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-cli-summon-"));
  const sourcePath = join(dir, "source.json");
  writeFileSync(sourcePath, JSON.stringify({
    schema_version: 1, broker_uuid: "00000000-0000-4000-8000-000000000000", edge_id: "edge-a", source_id: `src_${"c".repeat(32)}`,
    handle: `ahs_${"B".repeat(43)}`, actor: "fable", project_id: "birthday-film", work_id: "parents-likeness-round-2", return_mode: "actor_context", provenance: "dispatch",
  }));
  const bare = join(dir, "packet.json");
  writeFileSync(bare, JSON.stringify(packet()));
  const refused = await runCli(["summon", "--source-file", sourcePath, "--file", bare]);
  assert.equal(refused.code, 2);
  const envelopePath = join(dir, "summon.json");
  const envelope = { schema_version: 1, command_id: randomUUID(), action: "summon", payload: packet() };
  writeFileSync(envelopePath, JSON.stringify(envelope));
  const sent = await runCli(["summon", "--source-file", sourcePath, "--file", envelopePath, "--json"], { answer: () => ({ status: 201, body: receipt("summon", "created") }) });
  assert.equal(sent.code, 0);
  assert.deepEqual(sent.calls[0]!.body, { handle: `ahs_${"B".repeat(43)}`, command: envelope });
});
