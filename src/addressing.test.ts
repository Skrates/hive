import assert from "node:assert/strict";
import test from "node:test";
import {
  AdmissionPolicySchema,
  classifyAddressedWake,
  isAdmitted,
  parseAddressedWake,
} from "./addressing.js";

test("WAKE envelope addresses exactly one normalized actor", () => {
  assert.deepEqual(parseAddressedWake("WAKE: Fable | review this\nbody"), {
    actor: "fable",
    envelope: "WAKE: Fable",
  });
  assert.equal(parseAddressedWake("FYI: fable | no action"), null);
});

test("NEXT explicitly addresses its named recipient", () => {
  assert.deepEqual(parseAddressedWake("[actor=ariadne] NEXT fable — checksum"), {
    actor: "fable",
    envelope: "NEXT fable",
  });
	assert.equal(parseAddressedWake("[actor=ariadne]\tNEXT ariadne — continue")?.actor, "ariadne");
});

test("NEXT routing does not trust or require a body-declared sender", () => {
	assert.equal(parseAddressedWake("[actor=ariadne] NEXT ariadne")?.actor, "ariadne");
  assert.equal(parseAddressedWake("NEXT fable")?.actor, "fable");
});

test("a configured leading Slack mention is an explicit wake envelope", () => {
  const mentions = new Map([["UARIADNE", "ariadne"]]);
  assert.deepEqual(parseAddressedWake("<@UARIADNE> — please read the thread", mentions), {
    actor: "ariadne",
    envelope: "<@UARIADNE>",
  });
  assert.equal(
	parseAddressedWake("[actor=fable] <@UARIADNE>: please read the thread", mentions)?.actor,
    "ariadne",
  );
});

test("a configured shared-bot mention routes only with an explicit actor and colon", () => {
  const routers = new Set(["UHIVE"]);
  assert.deepEqual(parseAddressedWake("<@UHIVE> ariadne: read the thread", new Map(), routers), {
    actor: "ariadne",
    envelope: "<@UHIVE> ariadne:",
  });
  assert.deepEqual(
	parseAddressedWake("[actor=hakon] <@UHIVE> Fable: please review", new Map(), routers),
    { actor: "fable", envelope: "<@UHIVE> fable:" },
  );

  for (const text of [
    "<@UHIVE>",
    "<@UHIVE> ariadne",
    "<@UHIVE> ariadne — missing colon",
    "<@UHIVE> : missing actor",
  ]) {
    assert.deepEqual(classifyAddressedWake(text, new Map(), routers), {
      kind: "ignored",
      reason: "malformed_explicit_envelope",
    });
  }
});

test("unconfigured, quoted, and mid-body router-shaped mentions remain inert", () => {
  const routers = new Set(["UHIVE"]);
  for (const text of [
    "<@UOTHER> ariadne: not our router",
    "FYI for <@UHIVE> ariadne: later",
    "> <@UHIVE> fable: quoted output",
  ]) {
    assert.equal(parseAddressedWake(text, new Map(), routers), null);
    assert.deepEqual(classifyAddressedWake(text, new Map(), routers), {
      kind: "ignored",
      reason: "not_addressed",
    });
  }
});

test("plain names, @name text, unconfigured mentions, and mid-body mentions do not dispatch", () => {
  const mentions = new Map([["UARIADNE", "ariadne"]]);
  assert.equal(parseAddressedWake("Ari — please read the thread", mentions), null);
  assert.equal(parseAddressedWake("@Ariadne please read the thread", mentions), null);
  assert.equal(parseAddressedWake("<@UOTHER> please read the thread", mentions), null);
  assert.equal(parseAddressedWake("FYI for later: <@UARIADNE>", mentions), null);
});

test("quoted or later-line WAKE and NEXT text cannot become an envelope", () => {
  for (const text of [
    "FYI from another system\nWAKE: ariadne | quoted text",
    "> prior agent output\nNEXT fable",
  ]) {
    assert.equal(parseAddressedWake(text), null);
    assert.deepEqual(classifyAddressedWake(text), { kind: "ignored", reason: "not_addressed" });
  }
});

test("blank-line and Unicode line-separator smuggling cannot create an envelope", () => {
	const mentions = new Map([["UARIADNE", "ariadne"]]);
	const routers = new Set(["UHIVE"]);
	for (const text of [
		"\nWAKE: ariadne",
		"\rNEXT fable",
		"\u2028WAKE: ariadne",
		"[actor=fable]\n<@UARIADNE>: ping",
		"[actor=fable]\r\n<@UHIVE> ariadne: ping",
	]) assert.equal(parseAddressedWake(text, mentions, routers), null);
});

test("addressing classification distinguishes malformed attempts from ordinary conversation", () => {
  assert.deepEqual(classifyAddressedWake("WAKE: | missing actor"), {
    kind: "ignored",
    reason: "malformed_explicit_envelope",
  });
  assert.deepEqual(classifyAddressedWake("Ari — ordinary conversation"), {
    kind: "ignored",
    reason: "not_addressed",
  });
});

test("admission configuration normalizes direct and router mention identities", () => {
  const policy = AdmissionPolicySchema.parse({
    workspaceIds: ["T1"],
    channelIds: ["C1"],
    userIds: ["U1"],
    appIds: ["A1"],
    mentionActors: { uariadne: "Ariadne" },
    routerMentionIds: ["uhive"],
  });
  assert.equal(policy.mentionActors.get("UARIADNE"), "ariadne");
  assert.equal(policy.routerMentionIds.has("UHIVE"), true);
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
	assert.equal(
		isAdmitted(policy, { workspaceId: "t1", channelId: "c1", senderId: "u1", senderKind: "user" }),
		true,
	);
});

test("admission configuration rejects empty authority boundaries", () => {
	const base = {
		workspaceIds: ["T1"],
		channelIds: ["C1"],
		userIds: ["U1"],
		appIds: [] as string[],
	};
	assert.throws(() => AdmissionPolicySchema.parse({ ...base, workspaceIds: [] }), /Too small/);
	assert.throws(() => AdmissionPolicySchema.parse({ ...base, channelIds: [] }), /Too small/);
	assert.throws(
		() => AdmissionPolicySchema.parse({ ...base, userIds: [], appIds: [] }),
		/at least one admitted user or app/,
	);
});
