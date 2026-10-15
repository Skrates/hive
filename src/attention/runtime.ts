/**
 * Composition of Hive Attention inside the broker (ADR-0004 §9), on the broker's own SQLite
 * handle — no second connection, service or queue. Mirrors `bootReviewRuntime` without
 * importing any review policy.
 */
import type { BrokerStore } from "../broker/store.js";
import type { Clock } from "../time.js";
import type { AttentionHttpDeps } from "./http.js";
import { AttentionReturnPublisher } from "./returns.js";
import { AttentionService } from "./service.js";
import { AttentionSlackFrontEnd, type AttentionSlackApi } from "./slack.js";
import { AttentionStore } from "./store.js";

export interface AttentionRuntimeEnv {
  /** Default false for the first release. */
  HIVE_ATTENTION_ENABLED?: string | undefined;
  /** A queue identity, not a person-profile lookup. */
  HIVE_ATTENTION_HUMAN_ID?: string | undefined;
  /** Amendment 1: the human's Slack user id. Unset, the Slack front end is off. */
  HIVE_ATTENTION_SLACK_USER_ID?: string | undefined;
}

export interface AttentionRuntimeInput {
  broker: BrokerStore;
  clock: Clock;
  adminToken: string;
  env: AttentionRuntimeEnv;
  validateThread: (channelId: string, threadTs: string) => Promise<void>;
  log: (line: string) => void;
  /** The bot's Slack surface for the front end; absent (tests, CLI-only) means no front end. */
  slackApi?: AttentionSlackApi;
}

export interface AttentionRuntime {
  store: AttentionStore;
  service: AttentionService;
  publisher: AttentionReturnPublisher;
  http: AttentionHttpDeps;
  /** Amendment 1: present only when attention is enabled and the human's Slack user is configured. */
  slack: AttentionSlackFrontEnd | null;
}

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,30}$/;

export class AttentionRuntimeConfigError extends Error {}

const HUMAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export function attentionEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new AttentionRuntimeConfigError(`HIVE_ATTENTION_ENABLED must be true/false (or 1/0), got ${JSON.stringify(value)}`);
}

export function bootAttentionRuntime(input: AttentionRuntimeInput): AttentionRuntime {
  const enabled = attentionEnabled(input.env.HIVE_ATTENTION_ENABLED);
  const humanId = input.env.HIVE_ATTENTION_HUMAN_ID || "hakon";
  if (!HUMAN_ID.test(humanId)) throw new AttentionRuntimeConfigError(`HIVE_ATTENTION_HUMAN_ID ${JSON.stringify(humanId)} is not a queue identity`);
  // ADR-0004 A-4: the human is not an actor — never leased, never in WAKE: everyone.
  if (enabled && input.broker.getSubscription(humanId) !== null) {
    throw new AttentionRuntimeConfigError(`HIVE_ATTENTION_HUMAN_ID ${humanId} is also an enrolled actor; the queue's human must not be a Hive actor`);
  }
  const store = new AttentionStore({ broker: input.broker, clock: input.clock, humanId, enabled });
  const service = new AttentionService(store, input.broker, input.validateThread);
  const publisher = new AttentionReturnPublisher(store, input.broker, input.clock, input.log);
  input.log(enabled
    ? `[attention] enabled for ${humanId}: mutations accepted, return publication on the housekeeping tick`
    : "[attention] disabled (HIVE_ATTENTION_ENABLED): reads only; no mutations and no return publication");
  const slackUser = input.env.HIVE_ATTENTION_SLACK_USER_ID || null;
  if (slackUser !== null && !SLACK_USER_ID.test(slackUser)) {
    throw new AttentionRuntimeConfigError(`HIVE_ATTENTION_SLACK_USER_ID ${JSON.stringify(slackUser)} is not a Slack user id`);
  }
  const slack = enabled && slackUser !== null && input.slackApi
    ? new AttentionSlackFrontEnd(store, service, input.slackApi, slackUser, input.clock, input.log)
    : null;
  if (enabled) {
    input.log(slack
      ? `[attention] Slack front end on for ${slackUser}: one DM card per summons, Home tab queue, decision modal`
      : "[attention] Slack front end off (HIVE_ATTENTION_SLACK_USER_ID unset): CLI only");
  }
  return { store, service, publisher, slack, http: { service, broker: input.broker, adminToken: input.adminToken, log: input.log } };
}
