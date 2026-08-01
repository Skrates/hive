import assert from "node:assert/strict";
import test from "node:test";
import type { AdmissionPolicy } from "../addressing.js";
import type { SlackEventInput, SubscriptionInput } from "../domain.js";
import { BrokerService, type SlackTransport } from "./service.js";
import {
  handleSlackEnvelope,
  MISSING_SLACK_EVENT_ID_DIAGNOSTIC,
  type SlackEnvelopeHandlerInput,
} from "./slack.js";
import { BrokerStore } from "./store.js";

const WORKSPACE_ID = "T1";

const policy: AdmissionPolicy = {
  workspaceIds: new Set([WORKSPACE_ID]),
  channelIds: new Set(["C1"]),
  userIds: new Set(["U1"]),
  appIds: new Set(),
};

const slack: SlackTransport = {
  async replay() {
    throw new Error("not used");
  },
  async reply() {
    throw new Error("not used");
  },
};

function subscription(): SubscriptionInput {
  return {
    actor: "ariadne",
    provider: "codex",
    providerSurface: "app-server",
    providerVersion: "test",
    sessionId: "thread-1",
    homeEdge: "edge-1",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "edge-1", cwd: "/work/hive", worktree: null }],
    wakePolicy: "live_only",
    permissionProfile: "full-access",
    leaseTtlMs: 1_000,
    deliveryTtlMs: 5_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    expiresAt: null,
  };
}

function body(eventId: string | undefined, envelopeId: string) {
  return {
    ...(eventId === undefined ? {} : { event_id: eventId }),
    envelope_id: envelopeId,
    event: {
      type: "message",
      channel: "C1",
      text: "WAKE: ariadne | durable ingest test",
      ts: "100.2",
      thread_ts: "100.1",
      user: "U1",
    },
  };
}

function fixture() {
  const store = new BrokerStore(":memory:");
  store.createEdge("edge-1");
  store.upsertSubscription(subscription());
  return { store, broker: new BrokerService(store, slack) };
}

test("crash after commit before ACK makes fresh-envelope redelivery harmless", async () => {
  const { store, broker } = fixture();
  let firstAckAttempts = 0;
  const first: SlackEnvelopeHandlerInput = {
    body: body("Ev-durable", "env-attempt-1"),
    async ack() {
      firstAckAttempts += 1;
    },
  };

  await assert.rejects(
    handleSlackEnvelope(first, {
      workspaceId: WORKSPACE_ID,
      policy,
      broker: {
        ingest(event) {
          broker.ingest(event);
          throw new Error("injected crash after commit before ACK");
        },
      },
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    }),
    /injected crash after commit before ACK/,
  );
  assert.equal(firstAckAttempts, 0);
  assert.equal(
    Number((store.db.prepare("SELECT count(*) AS count FROM slack_events").get() as { count: number }).count),
    1,
  );
  assert.equal(store.listDeliveries().length, 1);

  let redeliveryAcks = 0;
  await handleSlackEnvelope({
    body: body("Ev-durable", "env-attempt-2"),
    async ack() {
      redeliveryAcks += 1;
    },
  }, {
    workspaceId: WORKSPACE_ID,
    policy,
    broker,
    now: () => new Date("2026-08-01T00:00:01.000Z"),
  });

  assert.equal(redeliveryAcks, 1);
  assert.equal(
    Number((store.db.prepare("SELECT count(*) AS count FROM slack_events").get() as { count: number }).count),
    1,
  );
  assert.equal(store.listDeliveries().length, 1);
  assert.equal(store.getDelivery(1).eventId, "Ev-durable");
  store.close();
});

test("missing event_id refuses envelope identity fallback, logs safely, then ACKs", async () => {
  const actions: string[] = [];
  let ingested: SlackEventInput | null = null;

  await handleSlackEnvelope({
    body: body(undefined, "env-must-not-be-identity"),
    async ack() {
      actions.push("ack");
    },
  }, {
    workspaceId: WORKSPACE_ID,
    policy,
    broker: {
      ingest(event) {
        ingested = event;
      },
    },
    logDiagnostic(message) {
      actions.push(`log:${message}`);
    },
  });

  assert.equal(ingested, null);
  assert.deepEqual(actions, [
    `log:${MISSING_SLACK_EVENT_ID_DIAGNOSTIC}`,
    "ack",
  ]);
  assert.equal(actions.join("\n").includes("env-must-not-be-identity"), false);
});

test("ingest failure leaves the envelope unacknowledged for Slack redelivery", async () => {
  let acked = false;

  await assert.rejects(
    handleSlackEnvelope({
      body: body("Ev-ingest-fails", "env-attempt-1"),
      async ack() {
        acked = true;
      },
    }, {
      workspaceId: WORKSPACE_ID,
      policy,
      broker: {
        ingest() {
          throw new Error("injected ingest failure");
        },
      },
    }),
    /injected ingest failure/,
  );

  assert.equal(acked, false);
});

test("malformed untrusted message fields are refused and acknowledged without ingestion", async () => {
  let acked = false;
  let ingested = false;
  await handleSlackEnvelope({
    body: {
      ...body("Ev-malformed", "env-malformed"),
      event: {
        type: "message",
        channel: "C1",
        ts: "100.2",
        user: "U1",
        text: { secret: "must-not-be-interpreted" },
      },
    },
    async ack() { acked = true; },
  }, {
    workspaceId: WORKSPACE_ID,
    policy,
    broker: { ingest() { ingested = true; } },
  });

  assert.equal(acked, true);
  assert.equal(ingested, false);
});
