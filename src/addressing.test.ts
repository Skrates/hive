import assert from "node:assert/strict";
import test from "node:test";
import { isAdmitted, parseAddressedWake } from "./addressing.js";

test("WAKE envelope addresses exactly one normalized actor", () => {
  assert.deepEqual(parseAddressedWake("WAKE: Fable | review this\nbody"), {
    actor: "fable",
    envelope: "WAKE: Fable",
  });
  assert.equal(parseAddressedWake("FYI: fable | no action"), null);
});

test("NEXT explicitly addresses its named recipient", () => {
  assert.deepEqual(parseAddressedWake("[actor=ariadne]\nNEXT fable — checksum"), {
    actor: "fable",
    envelope: "NEXT fable",
  });
  assert.equal(parseAddressedWake("[actor=ariadne]\nNEXT ariadne — continue")?.actor, "ariadne");
});

test("NEXT routing does not trust or require a body-declared sender", () => {
  assert.equal(parseAddressedWake("[actor=ariadne]\nNEXT ariadne")?.actor, "ariadne");
  assert.equal(parseAddressedWake("NEXT fable")?.actor, "fable");
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
