/**
 * GitHub ingress (design §7 "Ingress").
 *
 * `POST /v1/github/webhook` authenticates by HMAC (`X-Hub-Signature-256`) and does exactly
 * one thing after that: it persists the delivery to `github_inbox` and acknowledges. No
 * classification, no `ObservePR`, no reconcile happens here — everything after the ack is
 * the reconciler's (§7 "Reconciliation"), which is what makes a delayed or out-of-order
 * delivery harmless (F-14, §11 #4).
 *
 * Three ids stay distinct (§7): `github_inbox.delivery_id` is the notification; the
 * reconciler's `act_id`s are `obs:<run>` / `src:<record_key>:<version>` and never the
 * delivery id.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../../time.js";
import { iso, systemClock } from "../../time.js";
import type { InboxDelivery } from "../store.js";
import { noReviewTelemetry, type ReviewTelemetry } from "../telemetry.js";

/**
 * The slice of the store this handler touches: `inbox.put` returns `false` on a duplicate
 * `delivery_id` (§7 persist-before-ack). Structural so a test can hand in a fake; the
 * real `ReviewStore` satisfies it.
 */
export interface InboxStore {
  readonly inbox: {
    put(delivery: InboxDelivery): boolean;
  };
}

export type WebhookOutcome = "accepted" | "duplicate" | "hmac_rejected" | "malformed";

export interface WebhookInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface WebhookResult {
  status: 200 | 401 | 400;
  outcome: WebhookOutcome;
}

const SIGNATURE_PREFIX = "sha256=";

/**
 * `X-Hub-Signature-256` check. The hex digest is compared with `timingSafeEqual` so a
 * forged header cannot learn the secret byte by byte; a missing, mis-prefixed or
 * wrong-length header is simply false (nothing to compare against).
 */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const presented = header.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(presented)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(presented, "hex");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

function header(headers: WebhookInput["headers"], name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = direct ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Where the PR lives in each subscribed event's payload (§7 "Identity"): `pull_request`,
 * `pull_request_review`, `pull_request_review_comment` carry `pull_request.number`;
 * `issue_comment` carries `issue.number` and marks a PR by `issue.pull_request`. Anything
 * else (`installation_repositories`, `ping`) has no PR and is stored with nulls.
 */
function locatePullRequest(payload: Record<string, unknown>): { repositoryId: number | null; prNumber: number | null } {
  const repository = isRecord(payload.repository) ? positiveInteger(payload.repository.id) : null;
  const pullRequest = isRecord(payload.pull_request) ? positiveInteger(payload.pull_request.number) : null;
  if (pullRequest !== null) return { repositoryId: repository, prNumber: pullRequest };
  const issue = isRecord(payload.issue) && isRecord(payload.issue.pull_request) ? positiveInteger(payload.issue.number) : null;
  return { repositoryId: repository, prNumber: issue };
}

/**
 * §7: verify, persist, ack — nothing else. Order matters: a bad signature (401) and a
 * malformed body (400) are both refused before anything is persisted, and a duplicate
 * `delivery_id` is acknowledged 200 without a second row (`inbox.put` is the dedupe).
 */
export function handleWebhook(
  store: InboxStore,
  secret: string,
  input: WebhookInput,
  clock: Clock = systemClock,
  telemetry: ReviewTelemetry = noReviewTelemetry,
): WebhookResult {
  return telemetry.sync("review.ingress", {}, span => {
    const result = admitWebhook(store, secret, input, clock);
    span.setAttributes({ outcome: result.outcome, http_status: result.status });
    return result;
  });
}

function admitWebhook(store: InboxStore, secret: string, input: WebhookInput, clock: Clock): WebhookResult {
  if (!verifySignature(secret, input.rawBody, header(input.headers, "x-hub-signature-256"))) {
    return { status: 401, outcome: "hmac_rejected" };
  }
  const deliveryId = header(input.headers, "x-github-delivery");
  const event = header(input.headers, "x-github-event");
  if (deliveryId === undefined || deliveryId === "" || event === undefined || event === "") {
    return { status: 400, outcome: "malformed" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return { status: 400, outcome: "malformed" };
  }
  if (!isRecord(payload)) return { status: 400, outcome: "malformed" };
  const { repositoryId, prNumber } = locatePullRequest(payload);
  const fresh = store.inbox.put({ deliveryId, event, repositoryId, prNumber, payload, receivedAt: iso(clock) });
  return { status: 200, outcome: fresh ? "accepted" : "duplicate" };
}
