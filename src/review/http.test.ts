import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { BrokerHttpServer } from "../broker/http.js";
import { BrokerService, type SlackTransport } from "../broker/service.js";
import { BrokerStore } from "../broker/store.js";
import { SubscriptionInputSchema, type ReplaySnapshot, type SubscriptionInput } from "../domain.js";
import type { Action, Policy, Principal, Receipt, ReviewKey, ReviewState } from "./contract.js";
import type { ReviewApplyInput, ReviewHttpDeps, ReviewStorePort } from "./http.js";

const slack: SlackTransport = {
  async replay(): Promise<ReplaySnapshot> { throw new Error("not used"); },
  async reply(): Promise<string> { throw new Error("not used"); },
  async react(): Promise<void> { throw new Error("not used"); },
};

const ADMIN_TOKEN = "admin-token-for-tests-only-" + "x".repeat(8);
const KEY: ReviewKey = { repository_id: 42, pr_number: 7 };
const DISPLAY = "Skrates/hive#7";
const CLASSIFY: Action = { kind: "ClassifyFinding", finding_id: "fnd_05", priority: "P3" };

/**
 * A ReviewStore-shaped fake (module map §3): records every apply, refuses on a
 * revision mismatch the way the reducer's B1 would, knows one review by display.
 */
function fakeStore(revision = 3) {
  const applied: Array<{ key: ReviewKey; input: ReviewApplyInput }> = [];
  const policies: Array<{ repositoryId: number; policy: Policy }> = [];
  const operators = new Map<string, string>();
  const state = { id: "rev_1", key: KEY, display: DISPLAY, revision } as unknown as ReviewState;
  const store: ReviewStorePort = {
    apply(key, input) {
      applied.push({ key, input });
      if (input.expectedRevision !== revision) {
        return {
          review_id: "rev_1",
          act_id: input.actId,
          outcome: { refused: true, code: "stale_revision", detail: `expected ${input.expectedRevision}, at ${revision}`, current_revision: revision, state },
        };
      }
      return {
        review_id: "rev_1",
        act_id: input.actId,
        outcome: { applied: true, revision_before: revision, revision_after: revision + 1, batch_id: `bat_${input.actId}`, effects: [] },
      };
    },
    read(key) {
      return key.repository_id === KEY.repository_id && key.pr_number === KEY.pr_number ? state : null;
    },
    findByDisplay(display) {
      return display === DISPLAY ? KEY : null;
    },
    putPolicy(repositoryId, policy) {
      policies.push({ repositoryId, policy });
    },
    operators: {
      create(operatorId) {
        const token = `fake-operator-token-${operatorId}`;
        operators.set(token, operatorId);
        return token;
      },
      verify(token) {
        return operators.get(token) ?? null;
      },
    },
  };
  return { store, applied, policies, state };
}

interface Answer { status: number; body: string; json(): unknown }

async function fixture(t: test.TestContext, overrides: Partial<ReviewHttpDeps> = {}) {
  const broker = new BrokerStore(":memory:");
  t.after(() => broker.close());
  const edgeToken = broker.createEdge("dev");
  const fake = fakeStore();
  const reconciled: ReviewKey[] = [];
  const webhooks: Array<{ rawBody: string; signature: string | undefined }> = [];
  const deps: ReviewHttpDeps = {
    store: fake.store,
    broker,
    adminToken: ADMIN_TOKEN,
    reconcile: (key) => { reconciled.push(key); },
    webhook: ({ rawBody, headers }) => {
      const signature = headers["x-hub-signature-256"];
      webhooks.push({ rawBody: rawBody.toString("utf8"), signature: typeof signature === "string" ? signature : undefined });
      return signature === "sha256=good" ? { status: 200, outcome: "accepted" } : { status: 401, outcome: "hmac_rejected" };
    },
    ...overrides,
  };
  const server = new BrokerHttpServer(new BrokerService(broker, slack), { host: "127.0.0.1", port: 0, adminToken: ADMIN_TOKEN, review: deps });
  const { port } = await server.start();
  t.after(() => server.stop());

  // One delivery claimed by edge `dev` for actor ariadne: the seat whose turn is running.
  const base: SubscriptionInput = SubscriptionInputSchema.parse({
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "0.144.0",
    sessionId: "thread-1",
    homeEdge: "dev",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "dev", cwd: "/srv/hive", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: "/home/user/.codex-hive",
  });
  broker.upsertSubscription(base);
  broker.ingestEvent({
    eventId: "Ev1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "100.1",
    messageTs: "100.2",
    senderId: "U1",
    senderKind: "user",
    actor: "ariadne",
    text: "WAKE: ariadne | review",
    raw: {},
    receivedAt: "2026-09-06T00:00:00.000Z",
  });
  const delivery = broker.claimNext("dev", 0)!;
  const custody = { delivery_id: delivery.id, generation: delivery.leaseGeneration! };

  const call = (method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: body === undefined ? headers : { ...headers, "content-length": Buffer.byteLength(body) },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: text, json: () => JSON.parse(text) as unknown });
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(body);
    });
  const edgeHeaders = { "x-hive-edge": "dev", authorization: `Bearer ${edgeToken}`, "content-type": "application/json" };
  const actsPath = `/v1/review/${encodeURIComponent(DISPLAY)}/acts`;
  const act = (body: unknown, headers: Record<string, string> = edgeHeaders): Promise<Answer> =>
    call("POST", actsPath, headers, JSON.stringify(body));
  return { broker, edgeToken, edgeHeaders, fake, call, act, actsPath, custody, delivery, reconciled, webhooks };
}

test("GET /v1/review/:key answers the edge and an operator, refuses anonymous callers, and resolves both key forms", async (t) => {
  const { call, edgeHeaders, fake } = await fixture(t);
  const anonymous = await call("GET", `/v1/review/${encodeURIComponent(DISPLAY)}`, {});
  assert.equal(anonymous.status, 401);

  const byDisplay = await call("GET", `/v1/review/${encodeURIComponent(DISPLAY)}`, edgeHeaders);
  assert.equal(byDisplay.status, 200);
  assert.equal((byDisplay.json() as ReviewState).revision, 3);

  const byKey = await call("GET", "/v1/review/42:7", edgeHeaders);
  assert.equal(byKey.status, 200);

  const unknown = await call("GET", "/v1/review/42:8", edgeHeaders);
  assert.equal(unknown.status, 404);
  const unknownDisplay = await call("GET", `/v1/review/${encodeURIComponent("Skrates/hive#99")}`, edgeHeaders);
  assert.equal(unknownDisplay.status, 404);
  const garbage = await call("GET", "/v1/review/not-a-key", edgeHeaders);
  assert.equal(garbage.status, 400);

  const token = fake.store.operators.create("hakon");
  const asOperator = await call("GET", "/v1/review/42:7", { authorization: `Operator ${token}` });
  assert.equal(asOperator.status, 200);
  const wrongOperator = await call("GET", "/v1/review/42:7", { authorization: "Operator not-a-token" });
  assert.equal(wrongOperator.status, 401);
});

test("POST acts: no credential ⇒ 401; delivery custody ⇒ the ledger's actor under the same lease fence the wake path uses", async (t) => {
  const { act, fake, custody, edgeToken, edgeHeaders, broker, delivery } = await fixture(t);
  const body = { act_id: "01J000000000000000000000AA", expected_revision: 3, action: CLASSIFY, custody };

  const anonymous = await act(body, { "content-type": "application/json" });
  assert.equal(anonymous.status, 401);
  const wrongEdgeToken = await act(body, { ...edgeHeaders, authorization: "Bearer wrong" });
  assert.equal(wrongEdgeToken.status, 401);
  assert.equal(fake.applied.length, 0);

  const applied = await act(body);
  assert.equal(applied.status, 200, applied.body);
  const receipt = applied.json() as Receipt;
  assert.equal(receipt.act_id, body.act_id);
  assert.ok("applied" in receipt.outcome);
  const principal = fake.applied[0]!.input.principal;
  assert.deepEqual(principal, { kind: "seat", actor: "ariadne", custody: { delivery_id: delivery.id } } satisfies Principal);
  assert.equal(fake.applied[0]!.input.expectedRevision, 3);
  assert.deepEqual(fake.applied[0]!.key, KEY);

  // Custody is missing or names a delivery that is not held: nothing reaches the store.
  const noCustody = await act({ act_id: "a2", expected_revision: 3, action: CLASSIFY });
  assert.equal(noCustody.status, 400);
  const staleGeneration = await act({ ...body, custody: { ...custody, generation: custody.generation + 1 } });
  assert.equal(staleGeneration.status, 401);
  assert.equal((staleGeneration.json() as { error: string }).error, "unauthorized");
  const unknownDelivery = await act({ ...body, custody: { delivery_id: 999, generation: 1 } });
  assert.equal(unknownDelivery.status, 401);

  // Another authenticated edge does not hold this delivery (the mint path's `source_not_held`).
  const otherToken = broker.createEdge("other");
  const stolen = await act(body, { ...edgeHeaders, "x-hive-edge": "other", authorization: `Bearer ${otherToken}` });
  assert.equal(stolen.status, 401);

  // Session custody is recognised only to be declared deferred (M2).
  const session = await act({ ...body, custody: { session_token: "s" } });
  assert.equal(session.status, 401);
  assert.match((session.json() as { detail: string }).detail, /M2/);
  assert.equal(fake.applied.length, 1);
  void edgeToken;
});

test("POST acts: an operator token names an operator principal; a wrong token is 401", async (t) => {
  const { act, fake } = await fixture(t);
  const token = fake.store.operators.create("hakon");
  const body = { act_id: "01J000000000000000000000AB", expected_revision: 3, action: { kind: "GrantRounds", n: 2, reason: "one more burn" } };
  const applied = await act(body, { authorization: `Operator ${token}`, "content-type": "application/json" });
  assert.equal(applied.status, 200, applied.body);
  assert.deepEqual(fake.applied[0]!.input.principal, { kind: "operator", id: "hakon" } satisfies Principal);

  const wrong = await act(body, { authorization: "Operator nope", "content-type": "application/json" });
  assert.equal(wrong.status, 401);
  assert.equal(fake.applied.length, 1);
});

test("POST acts: a body that names an actor is refused; a malformed action is 400 malformed; a stale revision is 409 with the Receipt", async (t) => {
  const { act, call, edgeHeaders, fake, custody } = await fixture(t);
  const base = { act_id: "01J000000000000000000000AC", expected_revision: 3, action: CLASSIFY, custody };

  const namesActor = await act({ ...base, actor: "gnomon" });
  assert.equal(namesActor.status, 400);
  assert.match((namesActor.json() as { detail: string }).detail, /never names the actor/);
  const namesPrincipal = await act({ ...base, principal: { kind: "operator", id: "hakon" } });
  assert.equal(namesPrincipal.status, 400);

  const malformed = await act({ ...base, action: { kind: "ClassifyFinding", finding_id: "fnd_05", priority: "unknown" } });
  assert.equal(malformed.status, 400);
  assert.equal((malformed.json() as { error: string }).error, "malformed");
  const unknownKind = await act({ ...base, action: { kind: "Nope" } });
  assert.equal(unknownKind.status, 400);
  const noActId = await act({ ...base, act_id: "" });
  assert.equal(noActId.status, 400);
  const noExpect = await act({ ...base, expected_revision: null });
  assert.equal(noExpect.status, 400);
  assert.equal(fake.applied.length, 0);

  const stale = await act({ ...base, expected_revision: 2 });
  assert.equal(stale.status, 409);
  const receipt = stale.json() as Receipt;
  assert.ok("refused" in receipt.outcome);
  if ("refused" in receipt.outcome) {
    assert.equal(receipt.outcome.code, "stale_revision");
    assert.equal(receipt.outcome.current_revision, 3);
  }

  // A numeric key passes through to the store, which answers for an unknown
  // Review itself (no_such_target); a display the store cannot resolve is 404.
  const numeric = await call("POST", "/v1/review/42:8/acts", edgeHeaders, JSON.stringify(base));
  assert.equal(numeric.status, 200);
  assert.equal(fake.applied.length, 2);
  const display = await call("POST", `/v1/review/${encodeURIComponent("Skrates/hive#99")}/acts`, edgeHeaders, JSON.stringify(base));
  assert.equal(display.status, 404);
  assert.equal(fake.applied.length, 2);
});

test("POST reconcile wakes the scheduler for the resolved key, and says so when none is wired", async (t) => {
  const { call, edgeHeaders, reconciled } = await fixture(t);
  const accepted = await call("POST", `/v1/review/${encodeURIComponent(DISPLAY)}/reconcile`, edgeHeaders, "{}");
  assert.equal(accepted.status, 202);
  assert.deepEqual(reconciled, [KEY]);
  const anonymous = await call("POST", "/v1/review/42:7/reconcile", {}, "{}");
  assert.equal(anonymous.status, 401);

  const { call: callM0, edgeHeaders: headersM0 } = await fixture(t, { reconcile: null });
  const unavailable = await callM0("POST", "/v1/review/42:7/reconcile", headersM0, "{}");
  assert.equal(unavailable.status, 503);
});

test("POST /v1/github/webhook hands the raw bytes and headers to the adapter; 404 without a secret", async (t) => {
  const { call, webhooks } = await fixture(t);
  const raw = "{\"action\":\"opened\",   \"number\": 7}";
  const accepted = await call("POST", "/v1/github/webhook", { "x-hub-signature-256": "sha256=good", "content-type": "application/json" }, raw);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json(), { outcome: "accepted" });
  assert.equal(webhooks[0]!.rawBody, raw, "the body reaches the HMAC check byte-for-byte, never re-serialized");

  const rejected = await call("POST", "/v1/github/webhook", { "x-hub-signature-256": "sha256=bad" }, raw);
  assert.equal(rejected.status, 401);

  const { call: callNoSecret } = await fixture(t, { webhook: null });
  const off = await callNoSecret("POST", "/v1/github/webhook", { "x-hub-signature-256": "sha256=good" }, raw);
  assert.equal(off.status, 404);
});

test("admin: PUT review-policies validates the Policy; POST operators returns the raw token once", async (t) => {
  const { call, fake } = await fixture(t);
  const admin = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
  const policy: Policy = {
    version: 1,
    rounds_max: 7,
    reviewer_set: ["ariadne", "theoros"],
    substitute_actor: "ariadne",
    burn_actor: "talos",
    retrospective_actor: "theoros",
    closure_by_seat: true,
    routing_by_round: { first: "codex", later: "ariadne" },
    exempt_roots: ["skills/"],
    author_aliases: { "talos-weave": "talos" },
    stall_window_s: 1200,
    transport_bound: 2,
    codex_meter: null,
    slack: { channel_id: "C0123ABCD" },
  };
  const unauthorized = await call("PUT", "/v1/admin/review-policies/42", { "content-type": "application/json" }, JSON.stringify(policy));
  assert.equal(unauthorized.status, 401);
  const stored = await call("PUT", "/v1/admin/review-policies/42", admin, JSON.stringify(policy));
  assert.equal(stored.status, 200, stored.body);
  assert.deepEqual(stored.json(), { repository_id: 42, version: 1 });
  assert.deepEqual(fake.policies, [{ repositoryId: 42, policy }]);
  const malformed = await call("PUT", "/v1/admin/review-policies/42", admin, JSON.stringify({ ...policy, rounds_max: "seven" }));
  assert.equal(malformed.status, 400);
  assert.equal((malformed.json() as { error: string }).error, "malformed");

  const created = await call("POST", "/v1/admin/operators", admin, JSON.stringify({ operator_id: "hakon" }));
  assert.equal(created.status, 201);
  const { operator_id, token } = created.json() as { operator_id: string; token: string };
  assert.equal(operator_id, "hakon");
  assert.equal(fake.store.operators.verify(token), "hakon");
  const badId = await call("POST", "/v1/admin/operators", admin, JSON.stringify({ operator_id: "Hákon" }));
  assert.equal(badId.status, 400);
});

test("a broker with no review surface leaves the paths to the ordinary router", async (t) => {
  const broker = new BrokerStore(":memory:");
  t.after(() => broker.close());
  const server = new BrokerHttpServer(new BrokerService(broker, slack), { host: "127.0.0.1", port: 0, adminToken: ADMIN_TOKEN, review: null });
  const { port } = await server.start();
  t.after(() => server.stop());
  const status = await new Promise<number>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/v1/review/42:7" }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    }).on("error", reject);
  });
  assert.equal(status, 401, "the edge gate answers, not a review route");
});
