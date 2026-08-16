import assert from "node:assert/strict";
import test from "node:test";
import {
  configureObservability,
  type DeliverySpanAttributes,
  injectTraceHeaders,
  observabilityEnabled,
  parseTraceparent,
  peekDeliveryTraceparent,
  rememberDeliveryTraceparent,
  forgetDeliveryTraceparent,
  resetObservabilityForTests,
  sanitizeAttributes,
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
