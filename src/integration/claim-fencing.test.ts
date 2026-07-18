import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokerHttpServer } from "../broker/http.js";
import { BrokerService, type SlackTransport } from "../broker/service.js";
import { BrokerStore } from "../broker/store.js";
import type { ReplaySnapshot } from "../domain.js";
import { BrokerClient } from "../edge/broker-client.js";
import { LiveIngressRegistry } from "../edge/live-registry.js";
import { ClaudeProvider } from "../edge/providers.js";
import { EdgeService } from "../edge/service.js";
import { EdgeStore } from "../edge/store.js";

const silentSlack: SlackTransport = {
  async replay(channelId: string, threadTs: string): Promise<ReplaySnapshot> {
    return { channelId, threadTs, fetchedAt: new Date().toISOString(), cursor: null, messages: [] };
  },
  async reply(): Promise<string> { return "reply"; },
};

test("two pollers sharing one edge identity cannot concurrently claim the same actor", async (t) => {
  const store = new BrokerStore(":memory:");
  const edgeToken = store.createEdge("mac");
  const foreignToken = store.createEdge("linux");
  store.upsertSubscription({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "test",
    sessionId: "thread-1",
    homeEdge: "mac",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "mac", cwd: process.cwd(), worktree: null }],
    wakePolicy: "live_only",
    permissionProfile: "read-only",
    leaseTtlMs: 30_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    expiresAt: null,
  });
  store.ingestEvent({
    eventId: "Ev-dual-poller",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | test",
    raw: { type: "message" },
    receivedAt: new Date().toISOString(),
  });
  const server = new BrokerHttpServer(new BrokerService(store, silentSlack), {
    host: "127.0.0.1",
    port: 0,
    adminToken: "admin-token-that-is-at-least-thirty-two-characters",
  });
  const address = await server.start();
  t.after(async () => {
    await server.stop();
    store.close();
  });
  const url = `http://${address.host}:${address.port}`;
  const pollerA = new BrokerClient(url, "mac", edgeToken);
  const pollerB = new BrokerClient(url, "mac", edgeToken);

  const claims = await Promise.all([pollerA.claim(0, 0), pollerB.claim(0, 0)]);

  assert.equal(claims.filter((claim) => claim !== null).length, 1);
  const claimed = claims.find((claim) => claim !== null)!;
  assert.equal(claimed.id, 1);
  assert.equal(store.getDelivery(1).attempts, 1);
  const foreign = new BrokerClient(url, "linux", foreignToken);
  await assert.rejects(() => foreign.replay(claimed), /broker 409/);
  await assert.rejects(
    () => pollerA.replay({ ...claimed, leaseGeneration: claimed.leaseGeneration! + 1 }),
    /broker 409/,
  );
  const replay = await pollerA.replay(claimed);
  assert.equal(replay.channelId, "C1");
  assert.equal(replay.threadTs, "100.1");
});

test("an absolute delivery deadline terminates a never-exiting child and releases the actor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hive-hung-provider-"));
  const command = join(directory, "never-exits.js");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) { console.log('test (Claude Code)'); process.exit(0); }",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n"), { mode: 0o700 });
  await chmod(command, 0o700);
  const previousCommand = process.env.HIVE_CLAUDE_COMMAND;
  process.env.HIVE_CLAUDE_COMMAND = command;

  const store = new BrokerStore(":memory:");
  const edgeStore = new EdgeStore(":memory:");
  const edgeToken = store.createEdge("mac");
  store.upsertSubscription({
    actor: "fable",
    provider: "claude",
    providerSurface: "claude-cli",
    providerVersion: "test",
    sessionId: "session-1",
    homeEdge: "mac",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "mac", cwd: process.cwd(), worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 300,
    homeGraceMs: 0,
    spawnRateLimit: 2,
    expiresAt: null,
  });
  store.ingestEvent({
    eventId: "Ev-hung-1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "200.1",
    messageTs: "200.2",
    senderId: "U1",
    senderKind: "user",
    actor: "fable",
    text: "WAKE: fable | test deadline",
    raw: { type: "message" },
    receivedAt: new Date().toISOString(),
  });
  const server = new BrokerHttpServer(new BrokerService(store, silentSlack), {
    host: "127.0.0.1",
    port: 0,
    adminToken: "admin-token-that-is-at-least-thirty-two-characters",
  });
  const address = await server.start();
  const edge = new EdgeService(
    new BrokerClient(`http://${address.host}:${address.port}`, "mac", edgeToken),
    edgeStore,
    new LiveIngressRegistry(),
    [new ClaudeProvider("local-token-that-is-at-least-thirty-two-characters")],
  );
  t.after(async () => {
    await server.stop();
    edgeStore.close();
    store.close();
    if (previousCommand === undefined) delete process.env.HIVE_CLAUDE_COMMAND;
    else process.env.HIVE_CLAUDE_COMMAND = previousCommand;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await rm(directory, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  assert.equal(await edge.processOne(), true);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(store.getDelivery(1).status, "ambiguous");
  assert.equal(store.getDelivery(1).reasons[0]?.code, "delivery_deadline_exceeded");

  store.ingestEvent({
    eventId: "Ev-hung-2",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "201.1",
    messageTs: "201.2",
    senderId: "U1",
    senderKind: "user",
    actor: "fable",
    text: "WAKE: fable | next delivery",
    raw: { type: "message" },
    receivedAt: new Date().toISOString(),
  });
	assert.equal(store.claimNext("mac", 99), null);
	store.reconcile(1, "processed", "local child was terminated and its transcript was inspected");
	assert.equal(store.claimNext("mac", 99)?.id, 2);
});
