import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import { AttentionTransportError, defaultAttentionTransport, exitCodeFor, registerAttentionCommands, type AttentionTransport, type HttpAnswer } from "./cli.js";
import { packet } from "./fixtures.js";

interface Run { out: string[]; err: string[]; code: number; calls: Array<{ kind: string; path: string; body: unknown; journalled: boolean }>; edgeHealthProbes: number }

function runCli(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; answer?: (path: string, body: unknown) => HttpAnswer | Promise<HttpAnswer>; home?: string; edgeUp?: boolean } = {},
): Promise<Run> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "hive-cli-home-"));
  const env: NodeJS.ProcessEnv = { HIVE_HOME: home, HIVE_BROKER_URL: "http://broker.invalid", HIVE_ADMIN_TOKEN: "t".repeat(40), ...options.env };
  const run: Run = { out: [], err: [], code: 0, calls: [], edgeHealthProbes: 0 };
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
    async edgeHealth() { run.edgeHealthProbes += 1; return options.edgeUp ?? true; },
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

test("a receipt body that stalls after the broker's headers is the same unknown outcome as no answer", async () => {
  const home = mkdtempSync(join(tmpdir(), "hive-cli-home-"));
  const bodies: string[] = [];
  const read = async (request: IncomingMessage): Promise<string> => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    return text;
  };
  const server = createServer((request, response) => {
    void read(request).then((text) => {
      bodies.push(text);
      if (bodies.length === 1) {
        // Committed: the headers and half a receipt leave, then the connection stalls.
        response.writeHead(201, { "content-type": "application/json", "content-length": "4096" });
        response.write('{"schema_version":1,"result":"can');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(receipt("cancel", "cancelled", { replayed: true })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env: NodeJS.ProcessEnv = { HIVE_HOME: home, HIVE_BROKER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, HIVE_ADMIN_TOKEN: "t".repeat(40) };
  const cli = async (argv: string[]) => {
    const run = { out: [] as string[], err: [] as string[], code: 0 };
    const program = new Command().exitOverride();
    registerAttentionCommands(program, defaultAttentionTransport(env, 300), env, {
      out: (text) => run.out.push(text), err: (text) => run.err.push(text), exit: (code) => { run.code = code; }, now: () => new Date(),
    });
    await program.parseAsync(["node", "hive", "attention", ...argv]);
    return run;
  };
  try {
    const first = await cli(["cancel", "7", "--expected-revision", "2", "--reason", "obsolete", "--json"]);
    assert.equal(first.code, 6);
    const commandId = (JSON.parse(bodies[0]!) as { command_id: string }).command_id;
    assert.equal(JSON.parse(first.out[0]!).command_id, commandId, "the envelope names the original command id");
    assert.match(first.err[0]!, new RegExp(`hive attention receipt ${commandId}`, "u"));
    assert.ok(existsSync(join(home, "attention", "requests", `${commandId}.json`)), "the saved request survives");

    const retry = await cli(["retry-command", commandId]);
    assert.equal(retry.code, 0);
    assert.equal(bodies[1], bodies[0], "the retry resends the saved bytes");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("doctor is unhealthy when the edge is down, and healthy for an intentionally disabled broker", async () => {
  const capabilities = () => ({
    status: 200,
    body: { broker_uuid: "00000000-0000-4000-8000-000000000000", enabled: false, schema_version: 1, store_schema_version: 1, return_modes: ["pinned_session", "actor_context", "none"], disabled_note: "HIVE_ATTENTION_ENABLED=false" },
  });
  const edgeDown = await runCli(["doctor", "--json"], { answer: capabilities, edgeUp: false });
  assert.equal(edgeDown.code, 7);
  const down = JSON.parse(edgeDown.out[0]!) as { healthy: boolean; edge: { reachable: boolean } };
  assert.equal(down.healthy, false);
  assert.equal(down.edge.reachable, false);

  // A source file whose handle this edge no longer knows is unusable, whatever the broker says.
  const dir = mkdtempSync(join(tmpdir(), "hive-cli-doctor-"));
  const sourcePath = join(dir, "source.json");
  writeFileSync(sourcePath, JSON.stringify({
    schema_version: 1, broker_uuid: "00000000-0000-4000-8000-000000000000", edge_id: "edge-a", source_id: `src_${"c".repeat(32)}`,
    handle: `ahs_${"C".repeat(43)}`, actor: "fable", project_id: "p", work_id: "w", return_mode: "actor_context", provenance: "dispatch",
  }));
  const reset = await runCli(["doctor", "--json", "--source-file", sourcePath], {
    edgeUp: true,
    answer: (path) => path === "/attention/read" ? { status: 403, body: { error: "unknown_source_handle", detail: "x" } } : capabilities(),
  });
  assert.equal(reset.code, 7);
  assert.deepEqual(reset.calls.find((call) => (call.body as { op?: string } | undefined)?.op === "source_handle")!.body, { op: "source_handle", handle: `ahs_${"C".repeat(43)}` });
  assert.equal((JSON.parse(reset.out[0]!) as { source: { valid: boolean } }).source.valid, false);

  // The edge talks to another broker than the operator shell: a split deployment is unhealthy.
  const split = await runCli(["doctor", "--json"], {
    edgeUp: true,
    answer: (path) => path === "/attention/read"
      ? { status: 200, body: { ...capabilities().body, broker_uuid: "11111111-1111-4111-8111-111111111111" } }
      : capabilities(),
  });
  assert.equal(split.code, 7);
  assert.equal((JSON.parse(split.out[0]!) as { edge: { broker_matches: boolean } }).edge.broker_matches, false);

  const preEnable = await runCli(["doctor", "--json"], { answer: capabilities, edgeUp: true });
  assert.equal(preEnable.code, 0);
  const ready = JSON.parse(preEnable.out[0]!) as { healthy: boolean; broker: { enabled: boolean } };
  assert.equal(ready.healthy, true);
  assert.equal(ready.broker.enabled, false, "disabled is reported, not treated as broken");
});

test("doctor --operator-host drops the edge prerequisite but requires the operator credential", async () => {
  const capabilities = () => ({
    status: 200,
    body: { broker_uuid: "00000000-0000-4000-8000-000000000000", enabled: true, schema_version: 1, store_schema_version: 1, return_modes: ["pinned_session", "actor_context", "none"], disabled_note: null },
  });

  // An operator shell with no edge: healthy, and the edge is never consulted.
  const operatorHost = await runCli(["doctor", "--json", "--operator-host"], { edgeUp: false, answer: capabilities });
  assert.equal(operatorHost.code, 0);
  const report = JSON.parse(operatorHost.out[0]!) as { healthy: boolean; edge: Record<string, unknown>; broker: { reachable: boolean } };
  assert.equal(report.healthy, true);
  assert.deepEqual(report.edge, { applicable: false, reason: "operator_host" });
  assert.equal(report.broker.reachable, true);
  assert.equal(operatorHost.edgeHealthProbes, 0);
  assert.deepEqual(operatorHost.calls.map((call) => `${call.kind} ${call.path}`), ["operator GET /v1/attention/capabilities"]);

  // The broker is still a prerequisite on an operator host.
  const brokerDown = await runCli(["doctor", "--json", "--operator-host"], {
    edgeUp: false,
    answer: () => { throw new AttentionTransportError("connection refused"); },
  });
  assert.equal(brokerDown.code, 7);
  assert.equal((JSON.parse(brokerDown.out[0]!) as { healthy: boolean }).healthy, false);

  // A source file is validated through the edge, which an operator host does not have.
  const withSource = await runCli(["doctor", "--json", "--operator-host", "--source-file", "/nonexistent/source.json"], { edgeUp: false, answer: capabilities });
  assert.equal(withSource.code, 2);
  assert.equal(withSource.calls.length, 0);

  // Without the operator credential this is not an operator host.
  const noCredential = await runCli(["doctor", "--json", "--operator-host"], { env: { HIVE_ADMIN_TOKEN: "" }, edgeUp: false, answer: capabilities });
  assert.equal(noCredential.code, 3);
  assert.equal(noCredential.calls.length, 0);
  const inAgent = await runCli(["doctor", "--json", "--operator-host"], { env: { HIVE_DELIVERY_TOKEN: "d" }, edgeUp: false, answer: capabilities });
  assert.equal(inAgent.code, 3);

  // The default is unchanged: the same shell without the flag still needs its edge.
  const seatDefault = await runCli(["doctor", "--json"], { edgeUp: false, answer: capabilities });
  assert.equal(seatDefault.code, 7);
  assert.equal((JSON.parse(seatDefault.out[0]!) as { edge: { reachable: boolean } }).edge.reachable, false);
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

  // The broker committed but the source file cannot be written: the command id is the way back.
  const raced = join(dir, "raced.json");
  const lost = await runCli(["bind", "--project", "p", "--work", "w", "--return", "actor-context", "--out", raced, "--json"], {
    env: { HIVE_DELIVERY_TOKEN: "turn-token" },
    answer: () => {
      writeFileSync(raced, "someone else's file");
      return { status: 201, body: { receipt: receipt("source_bind", "source_bound", { source: { source_id: sourceFile.source_id, actor: "fable", project_id: "p", work_id: "w", return_mode: "actor_context", provenance: "dispatch" } }), source_file: sourceFile } };
    },
  });
  assert.equal(lost.code, 6);
  const lostId = (lost.calls[0]!.body as { command_id: string }).command_id;
  assert.equal(JSON.parse(lost.out[0]!).command_id, lostId);
  assert.match(lost.err[0]!, new RegExp(`--command-id ${lostId}`, "u"));
  assert.equal(readFileSync(raced, "utf8"), "someone else's file", "never overwritten");

  // After the turn: a command id alone is no proof for a seat; the operator recovers by id.
  const commandId = randomUUID();
  const seatOnly = await runCli(["bind", "--project", "p", "--work", "w", "--return", "actor-context", "--out", join(dir, "seat.json"), "--command-id", commandId]);
  assert.equal(seatOnly.code, 3);
  assert.equal(seatOnly.calls.length, 0);
  const recovered = await runCli(["bind", "--operator", "--project", "p", "--work", "w", "--return", "actor-context", "--out", join(dir, "recovered.json"), "--command-id", commandId], {
    answer: () => ({ status: 201, body: { receipt: receipt("source_bind", "source_bound", { replayed: true, source: { source_id: sourceFile.source_id, actor: "fable", project_id: "p", work_id: "w", return_mode: "actor_context", provenance: "dispatch" } }), source_file: sourceFile } }),
  });
  assert.equal(recovered.code, 0);
  assert.deepEqual(recovered.calls[0]!.body, {
    command_id: commandId, project_id: "p", work_id: "w", return_mode: "actor_context", thread: null, mode: "recover", operator_token: "t".repeat(40),
  });
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
  const home = mkdtempSync(join(tmpdir(), "hive-cli-home-"));
  const sent = await runCli(["summon", "--source-file", sourcePath, "--file", envelopePath, "--json"], { home, answer: () => ({ status: 201, body: receipt("summon", "created") }) });
  assert.equal(sent.code, 0);
  assert.deepEqual(sent.calls[0]!.body, { handle: `ahs_${"B".repeat(43)}`, command: envelope });

  // The same saved envelope retries freely; a changed one under the same command id is refused
  // before anything is sent, so retry-command can always reconcile what was committed.
  const retried = await runCli(["summon", "--source-file", sourcePath, "--file", envelopePath, "--json"], { home, answer: () => ({ status: 201, body: receipt("summon", "existing") }) });
  assert.equal(retried.code, 0);
  writeFileSync(envelopePath, JSON.stringify({ ...envelope, payload: packet({ title: "A different ask" }) }));
  const changed = await runCli(["summon", "--source-file", sourcePath, "--file", envelopePath, "--json"], { home });
  assert.equal(changed.code, 5);
  assert.equal(changed.calls.length, 0);
  assert.equal(JSON.parse(changed.out[0]!).error, "command_id_conflict");

  // The source file is replaced under the same path: neither summon nor retry-command sends.
  writeFileSync(envelopePath, JSON.stringify(envelope));
  writeFileSync(sourcePath, JSON.stringify({ ...JSON.parse(readFileSync(sourcePath, "utf8")) as object, handle: `ahs_${"D".repeat(43)}` }));
  const rebound = await runCli(["summon", "--source-file", sourcePath, "--file", envelopePath, "--json"], { home });
  assert.equal(rebound.code, 5);
  assert.equal(rebound.calls.length, 0);
  const retried2 = await runCli(["retry-command", envelope.command_id, "--json"], { home });
  assert.equal(retried2.code, 5);
  assert.equal(retried2.calls.length, 0);
  assert.equal(JSON.parse(retried2.out[0]!).error, "source_changed");
});
