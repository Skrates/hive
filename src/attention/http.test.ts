import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokerHttpServer } from "../broker/http.js";
import { BrokerService, type SlackTransport } from "../broker/service.js";
import { BrokerClient } from "../edge/broker-client.js";
import { EdgeControlServer } from "../edge/control.js";
import { LiveIngressRegistry } from "../edge/live-registry.js";
import type { HeadlessDispatch, ProviderAdapter } from "../edge/providers.js";
import { EdgeService } from "../edge/service.js";
import { EdgeStore } from "../edge/store.js";
import { udsRequest, udsRequestJson } from "../local/uds.js";
import type { Receipt, SourceFile } from "./contract.js";
import { harness, packet, seat, THREAD } from "./fixtures.js";
import { bootAttentionRuntime } from "./runtime.js";

const ADMIN = "a".repeat(40);

const slack: SlackTransport = {
  replay: async (channelId, threadTs) => ({ channelId, threadTs, fetchedAt: new Date().toISOString(), cursor: null, messages: [] }),
  reply: async () => `${Date.now() / 1000}`,
  react: async () => {},
};

async function stack(options: { attention?: boolean } = {}) {
  const h = harness({ seats: [seat("fable", { edgeWorkspaces: [{ edgeId: "edge-a", cwd: tmpdir(), worktree: null }] })] });
  const edgeToken = h.broker.createEdge("edge-a");
  const runtime = bootAttentionRuntime({
    broker: h.broker, clock: h.clock, adminToken: ADMIN, env: { HIVE_ATTENTION_ENABLED: "true" },
    validateThread: async () => {}, log: () => {},
  });
  const service = new BrokerService(h.broker, slack);
  const server = new BrokerHttpServer(service, { host: "127.0.0.1", port: 0, adminToken: ADMIN, review: null, attention: options.attention === false ? null : runtime.http });
  const { port } = await server.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  return { h, runtime, service, server, baseUrl, edgeToken };
}

async function call(baseUrl: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const operator = { authorization: `Bearer ${ADMIN}` };

test("the broker surface authenticates its own callers and refuses malformed or oversized commands", async () => {
  const { h, server, baseUrl, edgeToken } = await stack();
  const edge = { authorization: `Bearer ${edgeToken}`, "x-hive-edge": "edge-a" };
  try {
    assert.equal((await call(baseUrl, "GET", "/v1/attention/capabilities", {})).status, 401);
    assert.equal((await call(baseUrl, "GET", "/v1/attention/capabilities", { authorization: "Bearer wrong" })).status, 401);
    const caps = await call(baseUrl, "GET", "/v1/attention/capabilities", edge);
    assert.equal(caps.status, 200);
    assert.equal(caps.body.enabled, true);
    assert.equal(caps.body.broker_uuid, h.broker.brokerUuid);

    const next = { schema_version: 1, command_id: randomUUID(), action: "next", payload: { human_id: "hakon", item_id: null } };
    assert.equal((await call(baseUrl, "POST", "/v1/attention/commands", edge, next)).body.error, "source_required", "the edge socket alone cannot act for the human");
    const empty = await call(baseUrl, "POST", "/v1/attention/commands", operator, next);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.result, "empty");

    const unknownField = await call(baseUrl, "POST", "/v1/attention/commands", operator, { ...next, command_id: randomUUID(), principal: "operator" });
    assert.equal(unknownField.status, 422);
    assert.equal(unknownField.body.error, "schema_rejected");
    assert.equal((await call(baseUrl, "POST", "/v1/attention/commands", operator, "{not json")).status, 400);
    const huge = { schema_version: 1, command_id: randomUUID(), action: "add", payload: { packet: { ...packet(), context: "x".repeat(70_000) }, return_source_id: null } };
    assert.equal((await call(baseUrl, "POST", "/v1/attention/commands", operator, huge)).status, 413);

    const seatCall = await call(baseUrl, "POST", "/v1/attention/commands",
      { ...edge, "x-hive-attention-source": `src_${"0".repeat(32)}`, "x-hive-broker-uuid": randomUUID() },
      { schema_version: 1, command_id: randomUUID(), action: "summon", payload: packet() });
    assert.equal(seatCall.status, 409);
    assert.equal(seatCall.body.error, "broker_mismatch", "a handle issued by another broker never writes here");

    assert.equal((await call(baseUrl, "GET", "/v1/attention/sources", edge)).status, 403);
    const bound = h.store.bindSource({ edgeId: "edge-a", operator: true }, {
      schema_version: 1, command_id: randomUUID(), action: "source_bind",
      payload: { project_id: "p", work_id: "w", return_mode: "none", thread: null,
        evidence: { kind: "operator_binding", actor: "fable", session_id: null, session_verified: "none", cwd: "/work" } },
    }).receipt.source!;
    assert.equal((await call(baseUrl, "GET", `/v1/attention/sources/${bound.source_id}`, edge)).status, 200, "an edge reads its own source");
    const otherToken = h.broker.createEdge("edge-z");
    assert.equal((await call(baseUrl, "GET", `/v1/attention/sources/${bound.source_id}`, { authorization: `Bearer ${otherToken}`, "x-hive-edge": "edge-z" })).status, 404,
      "another edge's source answers as unknown");
    assert.equal((await call(baseUrl, "GET", `/v1/attention/sources/${bound.source_id}`, operator)).status, 200);
    assert.equal((await call(baseUrl, "GET", "/v1/attention/sources", operator)).status, 200);
    assert.equal((await call(baseUrl, "GET", "/v1/attention/items/99", operator)).status, 404);
    assert.equal((await call(baseUrl, "GET", `/v1/attention/commands/${randomUUID()}`, edge)).status, 404);
  } finally {
    await server.stop();
    h.close();
  }
});

test("an older broker without the attention surface answers 404 to an edge, never a fallback", async () => {
  const { h, server, baseUrl, edgeToken } = await stack({ attention: false });
  try {
    const answer = await call(baseUrl, "GET", "/v1/attention/capabilities", { authorization: `Bearer ${edgeToken}`, "x-hive-edge": "edge-a" });
    assert.equal(answer.status, 404);
  } finally {
    await server.stop();
    h.close();
  }
});

test("A17/A20/A36 a headless turn binds and summons through its edge; the human's response returns to the seat", async () => {
  const { h, runtime, service, server, baseUrl, edgeToken } = await stack();
  const root = mkdtempSync(join(tmpdir(), "hive-attention-e2e-"));
  const socketPath = join(root, "edge.sock");
  const edgeDb = join(root, "edge.sqlite");
  const client = new BrokerClient(baseUrl, "edge-a", edgeToken);
  let edgeStore = new EdgeStore(edgeDb);
  const turns: Array<{ framed: string; context: HeadlessDispatch }> = [];
  let sourceFile: SourceFile | null = null;
  let summonReceipt: Receipt | null = null;
  const adapter: ProviderAdapter = {
    provider: "claude",
    async deliverLive() { throw new Error("no live surface in this test"); },
    async resume() { throw new Error("no session to resume"); },
    async spawn(_subscription, _cwd, framed, context) {
      turns.push({ framed, context });
      if (turns.length === 1) {
        // Inside the running turn: bind while the dispatch token is valid, then ring the bell.
        const bound = await udsRequestJson<{ receipt: Receipt; source_file: SourceFile }>(socketPath, "POST", "/attention/bind", {
          mode: "dispatch", token: context.token, command_id: randomUUID(), project_id: "birthday-film",
          work_id: "parents-likeness-round-2", return_mode: "actor_context", thread: null,
        });
        sourceFile = bound.source_file;
        // A caller can never name an actor or delivery to establish attribution.
        const spoof = await udsRequest(socketPath, "POST", "/attention/act", {
          handle: sourceFile.handle,
          command: { schema_version: 1, command_id: randomUUID(), action: "summon", actor: "ariadne", payload: packet() },
        });
        assert.equal(spoof.status, 422);
        summonReceipt = await udsRequestJson<Receipt>(socketPath, "POST", "/attention/act", {
          handle: sourceFile.handle,
          command: { schema_version: 1, command_id: randomUUID(), action: "summon", payload: packet() },
        });
      }
      return { receipt: "{}", outcome: turns.length === 1 ? "Summoned the human for render selection." : "Rendering candidate C.", processed: true };
    },
  };
  let edge = new EdgeService(client, edgeStore, new LiveIngressRegistry(), [adapter]);
  let control = new EdgeControlServer(edge, { socketPath });
  await control.start();
  try {
    service.ingest({
      eventId: "EvWake", workspaceId: "T1", channelId: THREAD.channel_id, threadTs: THREAD.thread_ts, messageTs: "1760259601.000200",
      senderId: "U1", senderKind: "user", actor: "fable", text: "WAKE: fable render round 2", raw: {}, receivedAt: h.clock.now().toISOString(),
    });
    assert.equal(await edge.processOne(), true);
    assert.ok(sourceFile && summonReceipt);
    const file = sourceFile as SourceFile;
    const rung = summonReceipt as Receipt;
    assert.equal(rung.result, "created");
    assert.equal(file.actor, "fable");
    assert.equal(file.broker_uuid, h.broker.brokerUuid);
    assert.equal(h.broker.getDelivery(1).status, "processed", "the summons did not hold the turn open");
    const stored = edgeStore.db.prepare("SELECT handle_hash FROM attention_source_handles").all() as Array<{ handle_hash: string }>;
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0]!.handle_hash, file.handle, "only the hash is stored");

    // The edge restarts; the persisted handle still resolves (A20).
    await control.stop();
    edgeStore.close();
    edgeStore = new EdgeStore(edgeDb);
    edge = new EdgeService(client, edgeStore, new LiveIngressRegistry(), [adapter]);
    control = new EdgeControlServer(edge, { socketPath });
    await control.start();
    const amended = await udsRequestJson<Receipt>(socketPath, "POST", "/attention/act", {
      handle: file.handle,
      command: { schema_version: 1, command_id: randomUUID(), action: "amend", payload: { item_id: rung.item!.item_id, expected_revision: 1, fields: { estimate_minutes: 6 } } },
    });
    assert.equal(amended.item!.revision, 2);
    const forged = await udsRequest(socketPath, "POST", "/attention/act", { handle: "ahs_" + "A".repeat(43), command: {} });
    assert.equal(forged.status, 403);

    // The human takes it and resolves with --next.
    const taken = await call(baseUrl, "POST", "/v1/attention/commands", operator,
      { schema_version: 1, command_id: randomUUID(), action: "next", payload: { human_id: "hakon", item_id: null } });
    assert.equal(taken.body.result, "claimed");
    assert.match(String((taken.body.selection as { brief: string }).brief), /Do: Select candidate A, B, C or D/u);
    const resolved = await call(baseUrl, "POST", "/v1/attention/commands", operator, {
      schema_version: 1, command_id: randomUUID(), action: "resolve",
      payload: { item_id: rung.item!.item_id, expected_revision: 3, outcome: "selected", response: "Use candidate C; retain the current lighting.", select_next: true },
    });
    assert.equal(resolved.status, 200);
    assert.equal((resolved.body.selection as { selection_reason: string }).selection_reason, "empty");

    await runtime.publisher.drainOnce();
    assert.equal(await edge.processOne(), true, "the protocol-1 edge claims the continuation");
    assert.equal(turns.length, 2);
    assert.match(turns[1]!.framed, /Message from hive-attention/u);
    assert.match(turns[1]!.framed, /Human response \(verbatim\):\n<<<\nUse candidate C; retain the current lighting\.\n>>>/u);
    assert.match(turns[1]!.framed, /context restored/u);
    await runtime.publisher.drainOnce();
    const shown = await udsRequestJson<{ return: { phase: string; transport_status: string } }>(socketPath, "POST", "/attention/read", { op: "item", item_id: rung.item!.item_id });
    assert.equal(shown.return.phase, "processed");
    assert.equal(shown.return.transport_status, "processed");
  } finally {
    await control.stop();
    edgeStore.close();
    await server.stop();
    h.close();
  }
});
