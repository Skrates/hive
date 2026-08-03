import assert from "node:assert/strict";
import test from "node:test";

import { BoundedBodyReadError, readBoundedBody } from "./bounded-body.js";

test("bounded body rejects a zero-length microtask stream at the monotonic deadline", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array());
    },
    cancel() {
      cancelled = true;
    },
  });

  const started = performance.now();
  await assert.rejects(
    () => readBoundedBody(source, 1, 25),
    (error: unknown) =>
      error instanceof BoundedBodyReadError
      && error.message === "mcp_body_read_timeout",
  );
  assert.ok(performance.now() - started < 500, "deadline must not depend on timer task fairness");
  assert.equal(cancelled, true);
});

test("bounded body accepts the exact byte limit and rejects the next non-empty byte", async () => {
  const exact = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1));
      controller.enqueue(new Uint8Array());
      controller.enqueue(Uint8Array.of(2, 3));
      controller.close();
    },
  });
  assert.deepEqual(await readBoundedBody(exact, 3, 100), Uint8Array.of(1, 2, 3));

  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2, 3));
      controller.enqueue(Uint8Array.of(4));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    () => readBoundedBody(oversized, 3, 100),
    (error: unknown) =>
      error instanceof BoundedBodyReadError
      && error.message === "mcp_body_too_large",
  );
  assert.equal(cancelled, true);
});
