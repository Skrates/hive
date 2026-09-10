import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokerStore } from "../broker/store.js";
import { systemClock } from "../time.js";
import { SecretFileError } from "./secret-file.js";
import { bootReviewRuntime, ReviewRuntimeConfigError, type ReviewRuntimeEnv } from "./runtime.js";
import { policy, review } from "./fixtures.js";

const ADMIN = "admin-token-that-is-long-enough-for-the-schema";
const FAKE_SECRET = "obviously-fake-webhook-secret";
const FAKE_PEM = "-----BEGIN FAKE KEY-----\nnot-a-real-key\n-----END FAKE KEY-----";

function scratch(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hive-review-runtime-"));
}

function secretFile(dir: string, name: string, body: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
}

function boot(env: ReviewRuntimeEnv, lines: string[] = []) {
  const broker = new BrokerStore(":memory:");
  const runtime = bootReviewRuntime({ broker, clock: systemClock, adminToken: ADMIN, env, log: (line) => lines.push(line) });
  return { broker, runtime, lines };
}

function tables(broker: BrokerStore): string[] {
  return (broker.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

test("effect exhaustion and its failure notice commit together in the broker outbox", () => {
  const { broker, runtime } = boot({});
  const initial = review();
  runtime.store.putPolicy(initial.key.repository_id, policy());
  runtime.store.apply(initial.key, {
    actId: "obs:failure-notice", expectedRevision: null, display: initial.display,
    principal: { kind: "adapter", source: "github", reconcile_run: "failure-notice", event_login: "weave-review[bot]" },
    action: { kind: "ObservePR", lifecycle: initial.lifecycle, draft: initial.draft, subject: initial.subject, observed: initial.observed, exemption: null },
  });
  const effect = broker.db.prepare("SELECT effect_id, review_id FROM review_effects WHERE target LIKE 'board:%'").get() as { effect_id: string; review_id: string };
  runtime.store.projections.recordSlackThread(effect.review_id, "C0123ABCD", "1700.1");
  broker.db.prepare("UPDATE review_effects SET status='claimed', attempts=49 WHERE effect_id=?").run(effect.effect_id);
  broker.db.exec("CREATE TRIGGER refuse_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
  assert.throws(() => runtime.store.effects.markFailed(effect.effect_id, new Date().toISOString()), /outbox unavailable/u);
  assert.deepEqual(broker.db.prepare("SELECT status, attempts FROM review_effects WHERE effect_id=?").get(effect.effect_id), { status: "claimed", attempts: 49 }, "failure cannot commit without the notice");
  broker.db.exec("DROP TRIGGER refuse_notice");
  runtime.store.effects.markFailed(effect.effect_id, new Date().toISOString());
  runtime.store.effects.markFailed(effect.effect_id, new Date().toISOString());
  assert.deepEqual(broker.db.prepare("SELECT status, attempts, next_attempt_at FROM review_effects WHERE effect_id=?").get(effect.effect_id), { status: "failed", attempts: 50, next_attempt_at: null });
  const notices = broker.db.prepare("SELECT channel_id, thread_ts, text FROM outbox").all() as Array<{ channel_id: string; thread_ts: string; text: string }>;
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.channel_id, "C0123ABCD");
  assert.equal(notices[0]!.thread_ts, "1700.1");
  assert.match(notices[0]!.text, /failed after 50 attempts/u);
  assert.ok(notices[0]!.text.includes(effect.effect_id));
  broker.close();
});

// Module map §8 / task brief: no App yet ⇒ the broker boots with the adapter disabled and says so once.
test("without GitHub configuration the runtime boots the store and publisher, disables the adapter, and logs it once", async () => {
  const { broker, runtime, lines } = boot({});
  assert.equal(runtime.github, null);
  assert.equal(runtime.scheduler, null);
  assert.equal(runtime.http.webhook, null, "webhook ingress is 404 without a secret");
  assert.equal(runtime.http.reconcile, null, "reconcile is 503 without the scheduler");
  assert.equal(runtime.http.adminToken, ADMIN);
  assert.equal(runtime.http.store, runtime.store);
  assert.equal(runtime.http.broker, broker);
  assert.equal(lines.length, 2, "one line per unconfigured adapter");
  assert.match(lines[0] ?? "", /Logfire export disabled/u);
  assert.match(lines[1] ?? "", /GitHub adapter disabled/u);
  assert.match(lines[1] ?? "", /not set/u);

  // The store lives in the broker's own database (§9.3 tables beside the broker's).
  const names = tables(broker);
  for (const expected of ["reviews", "review_batches", "review_attempts", "review_effects", "github_inbox", "source_records", "review_policies", "operators"]) {
    assert.ok(names.includes(expected), `${expected} exists in the broker db`);
  }
  assert.ok(names.includes("outbox"), "the broker's own tables are untouched");

  // start/stop are no-ops and the publisher drains nothing on an empty store.
  runtime.start();
  assert.equal(await runtime.publisher.drainOnce(), 0);
  await runtime.stop();
  broker.close();
});

// §7 tier-2 secrets / AGENTS.md: a named file that is absent is a hard boot failure, never a
// silent downgrade to "adapter disabled" — a path typo must not boot a deaf broker.
test("names set but a file absent ⇒ boot refused naming the variable and the path; never a disabled adapter", () => {
  const dir = scratch();
  try {
    const env: ReviewRuntimeEnv = {
      HIVE_GITHUB_WEBHOOK_SECRET_FILE: join(dir, "webhook.secret"),
      HIVE_GITHUB_APP_ID: "12345",
      HIVE_GITHUB_APP_KEY_FILE: secretFile(dir, "app.pem", FAKE_PEM),
      HIVE_GITHUB_SUMMON_TOKEN_FILE: secretFile(dir, "summon.token", "fake-user-token"),
    };
    assert.throws(() => boot(env), (error: unknown) => {
      assert.ok(error instanceof ReviewRuntimeConfigError);
      assert.match(error.message, /HIVE_GITHUB_WEBHOOK_SECRET_FILE/u);
      assert.match(error.message, /webhook\.secret/u);
      assert.match(error.message, /does not exist/u);
      return true;
    });
    assert.throws(
      () => boot({ ...env, HIVE_GITHUB_WEBHOOK_SECRET_FILE: secretFile(dir, "webhook.secret", FAKE_SECRET), HIVE_GITHUB_APP_KEY_FILE: join(dir, "missing.pem") }),
      /HIVE_GITHUB_APP_KEY_FILE[^\n]*missing\.pem/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial configuration is a boot failure, not a half-adapter", () => {
  assert.throws(() => boot({ HIVE_GITHUB_APP_ID: "12345" }), ReviewRuntimeConfigError);
  assert.throws(
    () => boot({ HIVE_GITHUB_WEBHOOK_SECRET_FILE: "/nonexistent/webhook.secret", HIVE_GITHUB_APP_KEY_FILE: "/nonexistent/app.pem" }),
    /HIVE_GITHUB_APP_ID/u,
  );
});

test("Logfire needs an explicit project region with its token; no token boots without export", async () => {
  assert.throws(() => boot({ HIVE_REVIEW_LOGFIRE_TOKEN: "fake-never-exported" }), /HIVE_REVIEW_LOGFIRE_REGION/u);
  const { broker, runtime, lines } = boot({ HIVE_REVIEW_LOGFIRE_REGION: "eu" });
  assert.ok(lines.some(line => line.includes("Logfire export disabled")));
  await runtime.housekeeping();
  await runtime.stop();
  broker.close();
});

test("a housekeeping tick never waits for a persistent reconciliation lane", async t => {
  const dir = scratch();
  const { broker, runtime } = boot({
    HIVE_GITHUB_WEBHOOK_SECRET_FILE: secretFile(dir, "webhook.secret", FAKE_SECRET),
    HIVE_GITHUB_APP_ID: "12345",
    HIVE_GITHUB_APP_KEY_FILE: secretFile(dir, "app.pem", FAKE_PEM),
    HIVE_GITHUB_SUMMON_TOKEN_FILE: secretFile(dir, "summon.token", "fake-token"),
  });
  t.after(async () => { await runtime.stop(); broker.close(); rmSync(dir, { recursive: true, force: true }); });
  const stalled = new Promise<void>(() => {});
  runtime.scheduler!.housekeeping = () => stalled;
  const ticks = Array.from({ length: 20 }, () => runtime.housekeeping());
  let timeout: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      Promise.all(ticks).then(() => "completed"),
      new Promise<string>(resolve => { timeout = setTimeout(() => resolve("retained"), 100); }),
    ]);
    assert.equal(outcome, "completed", "periodic ticks must not retain waiters on the stalled lane");
  } finally { if (timeout) clearTimeout(timeout); }
});

test("a secret file readable beyond its owner is refused at boot (never a bare env var, never a warning)", () => {
  const dir = scratch();
  try {
    const env: ReviewRuntimeEnv = {
      HIVE_GITHUB_WEBHOOK_SECRET_FILE: secretFile(dir, "webhook.secret", FAKE_SECRET, 0o644),
      HIVE_GITHUB_APP_ID: "12345",
      HIVE_GITHUB_APP_KEY_FILE: secretFile(dir, "app.pem", FAKE_PEM),
      HIVE_GITHUB_SUMMON_TOKEN_FILE: secretFile(dir, "summon.token", "fake-user-token"),
    };
    assert.throws(() => boot(env), SecretFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with owner-only secret files the adapter is enabled: HMAC ingress persists to the inbox and reconcile wakes the scheduler", () => {
  const dir = scratch();
  try {
    const { runtime, lines, broker } = boot({
      HIVE_GITHUB_WEBHOOK_SECRET_FILE: secretFile(dir, "webhook.secret", FAKE_SECRET),
      HIVE_GITHUB_APP_ID: "12345",
      HIVE_GITHUB_APP_KEY_FILE: secretFile(dir, "app.pem", FAKE_PEM),
      HIVE_GITHUB_SUMMON_TOKEN_FILE: secretFile(dir, "summon.token", "fake-user-token"),
    });
    assert.deepEqual(runtime.github, { appId: "12345" });
    assert.ok(runtime.scheduler !== null);
    assert.ok(runtime.http.reconcile !== null);
    assert.equal(lines.length, 2);
    assert.match(lines[1] ?? "", /enabled as App 12345/u);
    assert.doesNotMatch(lines.join("\n"), new RegExp(FAKE_SECRET, "u"), "the secret is never logged");

    const webhook = runtime.http.webhook;
    assert.ok(webhook !== null);
    const rawBody = Buffer.from(JSON.stringify({ action: "synchronize", repository: { id: 1054 }, pull_request: { number: 66 } }));
    const headers = {
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "x-github-event": "pull_request",
    };
    const forged = webhook({ rawBody, headers: { ...headers, "x-hub-signature-256": "sha256=" + "00".repeat(32) } });
    assert.deepEqual(forged, { status: 401, outcome: "hmac_rejected" });
    const signature = "sha256=" + createHmac("sha256", FAKE_SECRET).update(rawBody).digest("hex");
    const accepted = webhook({ rawBody, headers: { ...headers, "x-hub-signature-256": signature } });
    assert.deepEqual(accepted, { status: 200, outcome: "accepted" });
    assert.equal(runtime.store.inbox.unreconciled().length, 1, "persisted before ack (§7)");
    broker.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
