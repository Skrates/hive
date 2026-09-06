import assert from "node:assert/strict";
import test from "node:test";
import { formatReviewKey, parseReviewKey } from "./key.js";

test("§3.1: the internal form is repository id + PR number; the display form is owner/repo#n", () => {
  assert.deepEqual(parseReviewKey("42:7"), { kind: "key", key: { repository_id: 42, pr_number: 7 } });
  assert.deepEqual(parseReviewKey("Skrates/hive#7"), { kind: "display", display: "Skrates/hive#7" });
  assert.deepEqual(parseReviewKey("sokrates-is/weave.doctrine#123"), { kind: "display", display: "sokrates-is/weave.doctrine#123" });
  assert.equal(formatReviewKey({ repository_id: 42, pr_number: 7 }), "42:7");
  assert.deepEqual(parseReviewKey(formatReviewKey({ repository_id: 1, pr_number: 2 })), { kind: "key", key: { repository_id: 1, pr_number: 2 } });
});

test("anything else is not a key", () => {
  for (const text of ["", "42", "42:0", "0:7", "hive#7", "Skrates/hive", "Skrates/hive#0", "Skrates/hive#7/acts", "a/b#c", "-x/y#1", "42:7:1"]) {
    assert.equal(parseReviewKey(text), null, text);
  }
});
