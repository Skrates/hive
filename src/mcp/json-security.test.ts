import assert from "node:assert/strict";
import test from "node:test";
import {
  JsonSecurityError,
  parseUniqueMemberJson,
} from "./json-security.js";

test("unique-member JSON parsing preserves every valid JSON value form", () => {
  const serialized = ` {
    "string": "quote: \\" and slash: \\\\",
    "number": -1.25e+2,
    "boolean": true,
    "nothing": null,
    "array": [false, 0, {"nested": "value"}],
    "\\u0065scaped-key": "accepted"
  } `;
  assert.deepEqual(parseUniqueMemberJson(serialized), {
    string: 'quote: " and slash: \\',
    number: -125,
    boolean: true,
    nothing: null,
    array: [false, 0, { nested: "value" }],
    "escaped-key": "accepted",
  });
});

test("unique-member JSON parsing rejects decoded duplicate names at every depth", () => {
  for (const serialized of [
    '{"member":1,"member":2}',
    '{"outer":{"member":1,"\\u006dember":2}}',
    '[{"member":1,"member":2}]',
  ]) {
    assert.throws(
      () => parseUniqueMemberJson(serialized),
      JsonSecurityError,
    );
  }
});

test("unique-member JSON parsing does not recurse on deeply nested valid input", () => {
  const depth = 6_500;
  const serialized = "[".repeat(depth) + "0" + "]".repeat(depth);
  assert.doesNotThrow(() => parseUniqueMemberJson(serialized));
});
