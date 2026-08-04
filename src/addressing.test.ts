import assert from "node:assert/strict";
import test from "node:test";
import { isAdmitted, parseAddressedWake } from "./addressing.js";

test("WAKE envelope addresses exactly one normalized actor", () => {
  assert.deepEqual(parseAddressedWake("WAKE: Fable | review this\nbody"), {
    actors: ["fable"],
    envelope: "WAKE: Fable",
  });
  assert.equal(parseAddressedWake("FYI: fable | no action"), null);
});

test("NEXT explicitly addresses its named recipient", () => {
  assert.deepEqual(parseAddressedWake("[actor=ariadne]\nNEXT fable — checksum"), {
    actors: ["fable"],
    envelope: "NEXT fable",
  });
  assert.deepEqual(parseAddressedWake("[actor=ariadne]\nNEXT ariadne — continue")?.actors, ["ariadne"]);
});

test("NEXT routing does not trust or require a body-declared sender", () => {
  assert.deepEqual(parseAddressedWake("[actor=ariadne]\nNEXT ariadne")?.actors, ["ariadne"]);
  assert.deepEqual(parseAddressedWake("NEXT fable")?.actors, ["fable"]);
});

test("WAKE list addresses every named actor, normalized and de-duplicated in order", () => {
  assert.deepEqual(parseAddressedWake("WAKE: fable, gnomon, ariadne | do the thing"), {
    actors: ["fable", "gnomon", "ariadne"],
    envelope: "WAKE: fable, gnomon, ariadne",
  });
  // Whitespace variants around commas, mixed case, and a repeat all collapse.
  assert.deepEqual(parseAddressedWake("WAKE: Fable,gnomon , FABLE")?.actors, ["fable", "gnomon"]);
  // The list stays on the envelope's first line — a comma cannot reach into body text.
  assert.deepEqual(parseAddressedWake("WAKE: fable | gnomon, ariadne")?.actors, ["fable"]);
});

test("NEXT list form is identical to WAKE", () => {
  assert.deepEqual(parseAddressedWake("NEXT fable, gnomon — carry on")?.actors, ["fable", "gnomon"]);
});

test("`everyone` parses as a single verbatim token — broadcast is a routing decision, not a parse one", () => {
  assert.deepEqual(parseAddressedWake("WAKE: everyone | all hands")?.actors, ["everyone"]);
});

test("a malformed token rejects the whole line — malformed is not an envelope, distinct from unknown", () => {
  // A well-formed-but-unknown name still parses (it dead-letters downstream); a
  // token that fails the grammar after a comma poisons the whole envelope.
  assert.equal(parseAddressedWake("WAKE: fable, 9gnomon"), null);
  assert.equal(parseAddressedWake("WAKE: fable,"), null);
  // Unknown-but-well-formed still resolves — the routing layer decides its fate.
  assert.deepEqual(parseAddressedWake("WAKE: ghost")?.actors, ["ghost"]);
});

test("admission gates workspace, channel, and sender identity", () => {
  const policy = {
    workspaceIds: new Set(["T1"]),
    channelIds: new Set(["C1"]),
    userIds: new Set(["U1"]),
    appIds: new Set(["A1"]),
  };
  assert.equal(
    isAdmitted(policy, { workspaceId: "T1", channelId: "C1", senderId: "U1", senderKind: "user" }),
    true,
  );
  assert.equal(
    isAdmitted(policy, { workspaceId: "T1", channelId: "C1", senderId: "U2", senderKind: "user" }),
    false,
  );
  assert.equal(
    isAdmitted(policy, { workspaceId: "T1", channelId: "C1", senderId: "A1", senderKind: "app" }),
    true,
  );
});
