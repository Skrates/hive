import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as logfire from "@pydantic/logfire-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Subscription } from "./domain.js";
import { GrokProvider } from "./edge/providers.js";
import {
  configureObservability,
  type DeliverySpanAttributes,
  injectTraceHeaders,
  installObservabilitySdkForTests,
  observabilityEnabled,
  parseTraceparent,
  peekDeliveryTraceparent,
  rememberDeliveryTraceparent,
  forgetDeliveryTraceparent,
  resetObservabilityForTests,
  runInTraceContext,
  sanitizeAttributes,
  STRING_ATTRIBUTE_LIMITS,
  shutdownObservability,
  withSpan,
} from "./observability.js";

test("configure is a no-op when LOGFIRE_TOKEN is unset", async (t) => {
  const previous = process.env.LOGFIRE_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.LOGFIRE_TOKEN;
    else process.env.LOGFIRE_TOKEN = previous;
    resetObservabilityForTests();
  });
  delete process.env.LOGFIRE_TOKEN;
  resetObservabilityForTests();

  assert.equal(await configureObservability("hive-test"), false);
  assert.equal(observabilityEnabled(), false);

  let ran = false;
  const result = await withSpan("hive.test.unset", { delivery_id: 1 }, async () => {
    ran = true;
    return "ok";
  });
  assert.equal(ran, true);
  assert.equal(result, "ok");

  const headers: Record<string, string> = { authorization: "Bearer test-token" };
  injectTraceHeaders(headers);
  assert.deepEqual(headers, { authorization: "Bearer test-token" });
});

test("configure is a no-op when LOGFIRE_TOKEN is blank", async (t) => {
  const previous = process.env.LOGFIRE_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.LOGFIRE_TOKEN;
    else process.env.LOGFIRE_TOKEN = previous;
    resetObservabilityForTests();
  });
  process.env.LOGFIRE_TOKEN = "   ";
  resetObservabilityForTests();

  assert.equal(await configureObservability("hive-test"), false);
  assert.equal(observabilityEnabled(), false);
});

test("delivery traceparent memory is keyed by delivery id", () => {
  resetObservabilityForTests();
  const parent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
  rememberDeliveryTraceparent(7, parent);
  assert.equal(peekDeliveryTraceparent(7), parent);
  assert.equal(peekDeliveryTraceparent(8), undefined);
  forgetDeliveryTraceparent(7);
  assert.equal(peekDeliveryTraceparent(7), undefined);
});

test("delivery memory retains tracestate and inject recovers both W3C fields", (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());
  const parent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  const tracestate = "congo=t61rcWkgMzE";
  rememberDeliveryTraceparent(3, parent, tracestate);
  logfire.configure({
    serviceName: "hive-test-tracestate",
    sendToLogfire: false,
    console: false,
  });
  installObservabilitySdkForTests(logfire);

  const headers: Record<string, string> = {};
  runInTraceContext({ traceparent: parent, tracestate }, () => {
    injectTraceHeaders(headers);
  });
  assert.equal(headers.traceparent, parent);
  assert.equal(headers.tracestate, tracestate);
});

test("parseTraceparent accepts W3C and rejects zeros and junk", () => {
  const ok = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
  assert.deepEqual(parseTraceparent(ok), {
    traceId: "ab".repeat(16),
    spanId: "cd".repeat(8),
    flags: 1,
  });
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${"cd".repeat(8)}-01`), undefined);
  assert.equal(parseTraceparent("not-a-traceparent"), undefined);
  assert.equal(parseTraceparent(""), undefined);
});

test("sanitizeAttributes keeps the allow-list and drops body-shaped keys", () => {
  const sanitized = sanitizeAttributes({
    delivery_id: 3,
    actor: "talos",
    channel_id: "C1",
    thread_ts: "100.1",
    dedupe_key: "Ev1",
    event_type: "wake",
    outcome: "processed",
    dispatch_mode: "spawn",
  });
  assert.deepEqual(sanitized, {
    delivery_id: 3,
    actor: "talos",
    channel_id: "C1",
    thread_ts: "100.1",
    dedupe_key: "Ev1",
    event_type: "wake",
    outcome: "processed",
    dispatch_mode: "spawn",
  });
  const sneaky = sanitizeAttributes({
    delivery_id: 1,
    text: "WAKE: talos | secret instruction",
    token: "xoxb-should-never-land",
  } as DeliverySpanAttributes & Record<string, string | number>);
  assert.deepEqual(sneaky, { delivery_id: 1 });
  assert.equal("text" in sneaky, false);
  assert.equal("token" in sneaky, false);
});

test("sanitizeAttributes truncates allowlisted strings to field-specific limits", () => {
  const actor = "a".repeat(STRING_ATTRIBUTE_LIMITS.actor! + 40);
  const dedupe = "Ev" + "x".repeat(STRING_ATTRIBUTE_LIMITS.dedupe_key! + 20);
  const sanitized = sanitizeAttributes({
    delivery_id: 9,
    actor,
    dedupe_key: dedupe,
    channel_id: "C1",
  });
  assert.equal(sanitized.delivery_id, 9);
  assert.equal(typeof sanitized.actor, "string");
  assert.equal((sanitized.actor as string).length, STRING_ATTRIBUTE_LIMITS.actor);
  assert.equal((sanitized.dedupe_key as string).length, STRING_ATTRIBUTE_LIMITS.dedupe_key);
  assert.equal(sanitized.channel_id, "C1");
});

test("shutdownObservability clears its cap timer when the SDK flush finishes first", async (t) => {
  resetObservabilityForTests();
  t.after(() => resetObservabilityForTests());
  let shutdowns = 0;
  installObservabilitySdkForTests({
    configure() { return undefined as never; },
    span() { throw new Error("unused"); },
    async shutdown() {
      shutdowns += 1;
    },
  } as unknown as typeof logfire);

  const started = Date.now();
  await shutdownObservability();
  const elapsed = Date.now() - started;
  assert.equal(shutdowns, 1);
  assert.ok(elapsed < 1_500, `flush must not wait out the 2s cap after it resolves (${elapsed}ms)`);
});

test("a failing provider's stderr does not appear on the recorded deliver span", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hive-span-stderr-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "failing-provider");
  const secret = "SECRET_SPAN_STDERR WAKE: talos | xoxb-not-a-real-token";
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${secret}' >&2\nexit 3\n`, { mode: 0o755 });
  chmodSync(script, 0o755);

  const previousCommand = process.env.HIVE_GROK_COMMAND;
  t.after(() => {
    if (previousCommand === undefined) delete process.env.HIVE_GROK_COMMAND;
    else process.env.HIVE_GROK_COMMAND = previousCommand;
    resetObservabilityForTests();
  });
  process.env.HIVE_GROK_COMMAND = script;
  resetObservabilityForTests();

  const exporter = new InMemorySpanExporter();
  logfire.configure({
    serviceName: "hive-test",
    sendToLogfire: false,
    console: false,
    additionalSpanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  installObservabilitySdkForTests(logfire);

  const subscription: Subscription = {
    actor: "talos",
    provider: "grok",
    providerSurface: "cli",
    providerVersion: "test",
    sessionId: null,
    homeEdge: "edge-1",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "edge-1", cwd: directory, worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "read-only",
    accountProfile: directory,
    leaseTtlMs: 1_000,
    deliveryTtlMs: 5_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    maxAttempts: 5,
    expiresAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };

  await assert.rejects(
    () => withSpan("hive.edge.deliver", { dispatch_mode: "spawn", actor: "talos" }, () =>
      new GrokProvider().spawn(subscription, directory, "framed wake must stay off the span"),
    ),
  );

  const recorded = JSON.stringify(exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    status: span.status,
  })));
  assert.match(recorded, /exited 3/);
  assert.match(recorded, /stderr_bytes=/);
  assert.doesNotMatch(recorded, /SECRET_SPAN_STDERR/);
  assert.doesNotMatch(recorded, /xoxb-/);
  assert.doesNotMatch(recorded, /framed wake must stay off the span/);
});
