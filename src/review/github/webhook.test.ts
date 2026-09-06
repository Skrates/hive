import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { Clock } from "../../time.js";
import { handleWebhook, verifySignature, type InboxDelivery, type InboxStore } from "./webhook.js";

// Obviously fake: a test secret, never a real webhook secret.
const SECRET = "test-webhook-secret-not-real";
const clock: Clock = { now: () => new Date("2026-09-06T12:00:00.000Z") };

function sign(secret: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

class FakeInbox implements InboxStore {
  readonly rows: InboxDelivery[] = [];
  readonly inbox = {
    put: (delivery: InboxDelivery): boolean => {
      if (this.rows.some((row) => row.deliveryId === delivery.deliveryId)) return false;
      this.rows.push(delivery);
      return true;
    },
  };
}

function request(body: unknown, overrides: Record<string, string | undefined> = {}, secret = SECRET) {
  const rawBody = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const headers: Record<string, string | undefined> = {
    "x-hub-signature-256": sign(secret, rawBody),
    "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "x-github-event": "pull_request",
    ...overrides,
  };
  return { headers, rawBody };
}

const pullRequestEvent = { action: "synchronize", repository: { id: 1054, full_name: "Skrates/hive" }, pull_request: { number: 66 } };

test("verifySignature: accepts the HMAC of the raw body and rejects everything else", () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(SECRET, body, sign(SECRET, body)), true);
  assert.equal(verifySignature(SECRET, body, sign("another-fake-secret", body)), false, "wrong secret");
  assert.equal(verifySignature(SECRET, Buffer.from('{"a":2}'), sign(SECRET, body)), false, "body changed after signing");
  assert.equal(verifySignature(SECRET, body, undefined), false, "missing header");
  assert.equal(verifySignature(SECRET, body, sign(SECRET, body).replace("sha256=", "sha1=")), false, "wrong algorithm prefix");
  assert.equal(verifySignature(SECRET, body, "sha256=abc"), false, "wrong digest length");
  assert.equal(verifySignature(SECRET, body, "sha256=" + "zz".repeat(32)), false, "non-hex digest");
});

test("§7 ingress: a signed delivery is persisted to the inbox and acknowledged 200", () => {
  const store = new FakeInbox();
  const result = handleWebhook(store, SECRET, request(pullRequestEvent), clock);
  assert.deepEqual(result, { status: 200, outcome: "accepted" });
  assert.equal(store.rows.length, 1);
  const row = store.rows[0];
  assert.ok(row !== undefined);
  assert.equal(row.deliveryId, "72d3162e-cc78-11e3-81ab-4c9367dc0958");
  assert.equal(row.event, "pull_request");
  assert.equal(row.repositoryId, 1054);
  assert.equal(row.prNumber, 66);
  assert.equal(row.receivedAt, "2026-09-06T12:00:00.000Z");
  assert.deepEqual(row.payload, pullRequestEvent);
});

test("§7: a bad HMAC is 401 and nothing is persisted", () => {
  const store = new FakeInbox();
  const result = handleWebhook(store, SECRET, request(pullRequestEvent, {}, "forged-fake-secret"), clock);
  assert.deepEqual(result, { status: 401, outcome: "hmac_rejected" });
  assert.equal(store.rows.length, 0);
  const missing = handleWebhook(store, SECRET, request(pullRequestEvent, { "x-hub-signature-256": undefined }), clock);
  assert.deepEqual(missing, { status: 401, outcome: "hmac_rejected" });
  assert.equal(store.rows.length, 0);
});

test("§7: a malformed delivery is 400 and nothing is persisted", () => {
  const store = new FakeInbox();
  assert.deepEqual(handleWebhook(store, SECRET, request("{not json"), clock), { status: 400, outcome: "malformed" });
  assert.deepEqual(handleWebhook(store, SECRET, request("[1,2]"), clock), { status: 400, outcome: "malformed" });
  assert.deepEqual(handleWebhook(store, SECRET, request(pullRequestEvent, { "x-github-delivery": undefined }), clock), { status: 400, outcome: "malformed" });
  assert.deepEqual(handleWebhook(store, SECRET, request(pullRequestEvent, { "x-github-event": undefined }), clock), { status: 400, outcome: "malformed" });
  assert.equal(store.rows.length, 0);
});

test("§7: a duplicate delivery id is acknowledged 200 as duplicate with one inbox row", () => {
  const store = new FakeInbox();
  assert.equal(handleWebhook(store, SECRET, request(pullRequestEvent), clock).outcome, "accepted");
  const again = handleWebhook(store, SECRET, request({ ...pullRequestEvent, action: "opened" }), clock);
  assert.deepEqual(again, { status: 200, outcome: "duplicate" });
  assert.equal(store.rows.length, 1);
});

test("§7 subscribed events: issue_comment on a PR names the PR; events without a PR persist with nulls", () => {
  const store = new FakeInbox();
  const comment = { action: "created", repository: { id: 1054 }, issue: { number: 66, pull_request: { url: "https://api.github.com/repos/Skrates/hive/pulls/66" } }, comment: { id: 5560110170 } };
  handleWebhook(store, SECRET, request(comment, { "x-github-event": "issue_comment", "x-github-delivery": "d-1" }), clock);
  const plainIssue = { action: "created", repository: { id: 1054 }, issue: { number: 12 }, comment: { id: 1 } };
  handleWebhook(store, SECRET, request(plainIssue, { "x-github-event": "issue_comment", "x-github-delivery": "d-2" }), clock);
  const installation = { action: "added", installation: { id: 7 }, repositories_added: [{ id: 1054 }] };
  handleWebhook(store, SECRET, request(installation, { "x-github-event": "installation_repositories", "x-github-delivery": "d-3" }), clock);
  assert.deepEqual(store.rows.map((row) => [row.deliveryId, row.repositoryId, row.prNumber]), [
    ["d-1", 1054, 66],
    ["d-2", 1054, null],
    ["d-3", null, null],
  ]);
});

test("headers are matched case-insensitively and array-valued headers use their first value", () => {
  const store = new FakeInbox();
  const rawBody = Buffer.from(JSON.stringify(pullRequestEvent));
  const headers: Record<string, string | string[] | undefined> = {
    "X-Hub-Signature-256": sign(SECRET, rawBody),
    "X-GitHub-Delivery": ["d-upper"],
    "X-GitHub-Event": "pull_request",
  };
  assert.deepEqual(handleWebhook(store, SECRET, { headers, rawBody }, clock), { status: 200, outcome: "accepted" });
  assert.equal(store.rows[0]?.deliveryId, "d-upper");
});
