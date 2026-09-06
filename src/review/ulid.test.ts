import assert from "node:assert/strict";
import test from "node:test";
import { ULID_PATTERN, ulid } from "./ulid.js";

test("§5.B2: a ULID is 26 Crockford characters, time-ordered, and unique across mints", () => {
  const earlier = ulid(1_700_000_000_000);
  const later = ulid(1_700_000_000_001);
  assert.match(earlier, ULID_PATTERN);
  assert.match(later, ULID_PATTERN);
  assert.ok(earlier < later, "lexical order follows mint time");
  assert.equal(earlier.slice(0, 10), ulid(1_700_000_000_000).slice(0, 10), "the time prefix is a function of the time alone");
  const minted = new Set(Array.from({ length: 1_000 }, () => ulid()));
  assert.equal(minted.size, 1_000);
});

test("the random tail is exactly the 80 bits given", () => {
  assert.equal(ulid(0, Buffer.alloc(10)), "0".repeat(26));
  assert.equal(ulid(0, Buffer.alloc(10, 0xff)), "0".repeat(10) + "Z".repeat(16));
  assert.throws(() => ulid(0, Buffer.alloc(9)), /10 random bytes/);
  assert.throws(() => ulid(-1), /time out of range/);
});
