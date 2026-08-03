import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBrokerHandle,
  formatEdgeHandle,
  InvalidHiveHandleError,
  parseBrokerHandle,
  parseEdgeHandle,
} from "./handles.js";
import {
  BROKER_HANDLE_DEFINITIONS,
  EDGE_HANDLE_DEFINITIONS,
  type HiveBrokerHandleKind,
  type HiveEdgeHandleKind,
} from "./handles.js";

const BROKER_UUID = "01234567-89ab-4cde-8f01-23456789abcd";

interface BrokerCase {
  kind: HiveBrokerHandleKind;
  values?: Readonly<Record<string, string | number>>;
  suffix: string;
}

const brokerCases: readonly BrokerCase[] = [
  { kind: "event", values: { eventId: "Ev-1" }, suffix: "events/Ev-1" },
  { kind: "deliveries", values: { cursor: "cursor:2" }, suffix: "deliveries?cursor=cursor%3A2" },
  { kind: "delivery", values: { deliveryId: 1 }, suffix: "deliveries/1" },
  { kind: "deliveryTransitions", values: { deliveryId: 1 }, suffix: "deliveries/1/transitions" },
  { kind: "deliveryReplay", values: { deliveryId: 1 }, suffix: "deliveries/1/replay" },
  { kind: "outbox", values: { cursor: "outbox:2" }, suffix: "outbox?cursor=outbox%3A2" },
  { kind: "outboxItem", values: { outboxId: "outbox-1" }, suffix: "outbox/outbox-1" },
  { kind: "subscriptions", suffix: "subscriptions" },
  { kind: "subscription", values: { actor: "colonel ariadne" }, suffix: "subscriptions/colonel%20ariadne" },
  { kind: "edges", values: { cursor: "edge:2" }, suffix: "edges?cursor=edge%3A2" },
  { kind: "edge", values: { edgeId: "mac.local" }, suffix: "edges/mac.local" },
  { kind: "provider", values: { edgeId: "mac", provider: "claude" }, suffix: "providers/mac/claude" },
  { kind: "workspace", values: { workspaceId: "workspace-1" }, suffix: "workspaces/workspace-1" },
  { kind: "reasonCodes", suffix: "reason-codes" },
];

interface EdgeCase {
  kind: HiveEdgeHandleKind;
  values: Readonly<Record<string, string | number>>;
  suffix: string;
}

const edgeCases: readonly EdgeCase[] = [
  { kind: "localProvider", values: { provider: "claude", providerSessionRef: "session:opaque" }, suffix: "providers/claude/session%3Aopaque" },
];

test("all canonical broker handle templates format and parse byte-identically", () => {
  assert.deepEqual(
    new Set(brokerCases.map((specimen) => specimen.kind)),
    new Set(BROKER_HANDLE_DEFINITIONS.map((definition) => definition.kind)),
  );
  assert.equal(brokerCases.length, BROKER_HANDLE_DEFINITIONS.length);
  for (const specimen of brokerCases) {
    const uri = formatBrokerHandle(BROKER_UUID, specimen.kind, specimen.values);
    assert.equal(uri, `hive://${BROKER_UUID}/v1/${specimen.suffix}`, specimen.kind);
    const parsed = parseBrokerHandle(uri, BROKER_UUID);
    assert.equal(parsed.kind, specimen.kind);
    assert.equal(formatBrokerHandle(BROKER_UUID, parsed.kind, parsed.values), uri);
  }
});

test("all canonical edge-local handle templates format and parse byte-identically", () => {
  assert.deepEqual(
    new Set(edgeCases.map((specimen) => specimen.kind)),
    new Set(EDGE_HANDLE_DEFINITIONS.map((definition) => definition.kind)),
  );
  assert.equal(edgeCases.length, EDGE_HANDLE_DEFINITIONS.length);
  for (const specimen of edgeCases) {
    const uri = formatEdgeHandle(specimen.kind, specimen.values);
    assert.equal(uri, `hive://edge/v1/${specimen.suffix}`, specimen.kind);
    const parsed = parseEdgeHandle(uri);
    assert.equal(parsed.kind, specimen.kind);
    assert.equal(formatEdgeHandle(parsed.kind, parsed.values), uri);
  }
});

test("broker handles reject noncanonical, cross-realm, credential-bearing, and traversal forms", () => {
  const invalid = [
    `HIVE://${BROKER_UUID}/v1/deliveries/1`,
    `hive://${BROKER_UUID.toUpperCase()}/v1/deliveries/1`,
    "hive://11234567-89ab-4cde-8f01-23456789abcd/v1/deliveries/1",
    "hive://not-a-uuid/v1/deliveries/1",
    `hive://user@${BROKER_UUID}/v1/deliveries/1`,
    `hive://${BROKER_UUID}:443/v1/deliveries/1`,
    `hive://${BROKER_UUID}/v1/deliveries/1#fragment`,
    `hive://${BROKER_UUID}/v1/deliveries//1`,
    `hive://${BROKER_UUID}/v1/deliveries/1/`,
    `hive://${BROKER_UUID}/v1/events/.`,
    `hive://${BROKER_UUID}/v1/events/%2E`,
    `hive://${BROKER_UUID}/v1/events/%2e%2e`,
    `hive://${BROKER_UUID}/v1/events/%2F`,
    `hive://${BROKER_UUID}/v1/events/%5C`,
    `hive://${BROKER_UUID}/v1/events/%252F`,
    `hive://${BROKER_UUID}/v1/events/%3a`,
    `hive://${BROKER_UUID}/v1/events/%09`,
    `hive://${BROKER_UUID}/v1/events/%0A`,
    `hive://${BROKER_UUID}/v1/events/%0D`,
    `hive://${BROKER_UUID}/v1/events/%7F`,
    `hive://${BROKER_UUID}/v1/events/%E2%80%8B`,
    `hive://${BROKER_UUID}/v1/events/%E2%80%AE`,
    `hive://${BROKER_UUID}/v1/events/ariadne-á`,
    `hive://${BROKER_UUID}/v1/deliveries?cursor=next+page`,
    `hive://${BROKER_UUID}/v1/deliveries?cursor=one&cursor=two`,
    `hive://${BROKER_UUID}/v1/deliveries?token=secret`,
    `hive://${BROKER_UUID}/v1/deliveries?capability=secret`,
    `hive://${BROKER_UUID}/v1/deliveries/1?cursor=two`,
    `hive://${BROKER_UUID}/v1/deliveries?cursor=`,
    `hive://${BROKER_UUID}/v1/unknown/item`,
  ];
  for (const uri of invalid) {
    assert.throws(() => parseBrokerHandle(uri, BROKER_UUID), InvalidHiveHandleError, uri);
  }
});

test("positive integer coordinates reject zero, signs, leading zeroes, fractions, exponents, and overflow", () => {
  const invalid = ["0", "-1", "+1", "01", "1.0", "1e1", "9007199254740992"];
  for (const value of invalid) {
    assert.throws(
      () => parseBrokerHandle(`hive://${BROKER_UUID}/v1/deliveries/${value}`, BROKER_UUID),
      InvalidHiveHandleError,
      value,
    );
  }
  assert.throws(
    () => formatBrokerHandle(BROKER_UUID, "delivery", { deliveryId: Number.MAX_SAFE_INTEGER + 1 }),
    InvalidHiveHandleError,
  );
});

test("superseded handle families are no longer parseable (ADR-0003)", () => {
  const superseded = [
    `hive://${BROKER_UUID}/v1/deliveries/1/evidence`,
    `hive://${BROKER_UUID}/v1/dispatches/1/2/3`,
    `hive://${BROKER_UUID}/v1/reconciliation/pending`,
    `hive://${BROKER_UUID}/v1/reconciliation/integrity-alerts`,
    `hive://${BROKER_UUID}/v1/edges/mac/credential-lineages/lineage-1`,
    `hive://${BROKER_UUID}/v1/edges/mac/pending`,
  ];
  for (const uri of superseded) {
    assert.throws(() => parseBrokerHandle(uri, BROKER_UUID), InvalidHiveHandleError, uri);
  }
  assert.throws(() => parseEdgeHandle("hive://edge/v1/bindings/binding-1?epoch=2&revision=3"), InvalidHiveHandleError);
});

test("broker and edge-local authorities cannot cross parser boundaries", () => {
  assert.throws(() => parseBrokerHandle("hive://edge/v1/providers/claude/session", BROKER_UUID), InvalidHiveHandleError);
  assert.throws(
    () => parseEdgeHandle(`hive://${BROKER_UUID}/v1/providers/mac/claude`),
    InvalidHiveHandleError,
  );
});

test("handle parsers and formatters bound size and normalize URI encoding failures", () => {
  assert.throws(
    () => parseBrokerHandle(
      `hive://${BROKER_UUID}/v1/events/${"a".repeat(8_192)}`,
      BROKER_UUID,
    ),
    InvalidHiveHandleError,
  );
  assert.throws(
    () => formatBrokerHandle(BROKER_UUID, "event", { eventId: "a".repeat(1_025) }),
    InvalidHiveHandleError,
  );
  assert.throws(
    () => formatBrokerHandle(BROKER_UUID, "event", { eventId: "\ud800" }),
    InvalidHiveHandleError,
  );
  assert.throws(
    () => parseBrokerHandle(1 as unknown as string, BROKER_UUID),
    InvalidHiveHandleError,
  );
  assert.throws(
    () => formatBrokerHandle(BROKER_UUID, "event", null as unknown as Record<string, string>),
    InvalidHiveHandleError,
  );
});
