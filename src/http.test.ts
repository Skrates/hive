import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { formatHttpErrorEnvelope, parseHttpErrorEnvelope, writeJsonResponse } from "./http.js";

test("JSON responses set a byte-accurate content length", () => {
  let status = 0;
  let headers: Record<string, number | string> | undefined;
  let body = "";
  const response = {
    writeHead(code: number, values?: Record<string, number | string>) {
      status = code;
      headers = values;
      return this;
    },
    end(value?: string) {
      body = value ?? "";
      return this;
    },
  } as unknown as ServerResponse;

  writeJsonResponse(response, 201, { greeting: "hæ" });

  assert.equal(status, 201);
  assert.deepEqual(headers, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  assert.equal(body, '{"greeting":"hæ"}');
});

test("HTTP error envelopes parse, normalize, and format once", () => {
  const withDetail = parseHttpErrorEnvelope('{"error":"unroutable_actor","detail":"no live seat","extra":true}');
  assert.deepEqual(withDetail, { error: "unroutable_actor", detail: "no live seat" });
  assert.equal(formatHttpErrorEnvelope(withDetail!), "unroutable_actor — no live seat");

  const withoutStringDetail = parseHttpErrorEnvelope('{"error":"invalid_json","detail":7}');
  assert.deepEqual(withoutStringDetail, { error: "invalid_json" });
  assert.equal(formatHttpErrorEnvelope(withoutStringDetail!), "invalid_json");
  assert.equal(parseHttpErrorEnvelope('{"detail":"missing code"}'), null);
  assert.equal(parseHttpErrorEnvelope("not json"), null);
});
