import assert from "node:assert/strict";
import test from "node:test";
import { BrokerStore } from "../broker/store.js";
import { BrokerService, type SlackTransport } from "../broker/service.js";
import { BrokerHttpServer } from "../broker/http.js";
import { SubscriptionInputSchema } from "../domain.js";
import { probeProfile } from "./profile-probe.js";

test("health ingest binds edge, actor, provider and profile; rejects extra secret fields", async t => {
  const store = new BrokerStore(":memory:");
  const owner = store.createEdge("owner");
  const other = store.createEdge("other");
  store.upsertSubscription(SubscriptionInputSchema.parse({ actor: "seat", provider: "claude", providerSurface: "claude-code",
    providerVersion: "test", homeEdge: "owner", workspace: "work", edgeWorkspaces: [{ edgeId: "owner", cwd: "/work" }],
    wakePolicy: "spawn", permissionProfile: "workspace-write", accountProfile: "/missing-health-test-profile" }));
  const slack: SlackTransport = { async replay() { throw Error("unused"); }, async reply() { throw Error("unused"); }, async react() {} };
  const server = new BrokerHttpServer(new BrokerService(store, slack), { host: "127.0.0.1", port: 0, adminToken: "x".repeat(32) });
  const { port } = await server.start();
  t.after(async () => { await server.stop(); store.close(); });
  const report = await probeProfile("seat", "/missing-health-test-profile", "claude");
  async function send(edge: string, token: string, body: unknown) {
    return fetch(`http://127.0.0.1:${port}/v1/health`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "x-hive-edge": edge, "content-type": "application/json",
    }, body: JSON.stringify(body) });
  }
  assert.equal((await send("owner", owner, report)).status, 200);
  assert.equal((await send("other", other, report)).status, 403);
  assert.equal((await send("owner", owner, { ...report, accountProfile: "/another-profile" })).status, 403);
  assert.equal((await send("owner", owner, { ...report, provider: "codex" })).status, 403);
  assert.equal((await send("owner", owner, { ...report, secret: "do-not-store" })).status, 400);
  assert.equal((await send("owner", "wrong", report)).status, 401);
  const stored = store.db.prepare("SELECT report_json FROM profile_health").get() as { report_json: string };
  assert.deepEqual(JSON.parse(stored.report_json), report);
  assert.equal(store.deleteSubscription("seat"), true);
  assert.equal((store.db.prepare("SELECT count(*) AS n FROM profile_health").get() as { n: number }).n, 0);
});
