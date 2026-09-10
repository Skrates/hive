import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { StaleLeaseError, type BrokerStore } from "../broker/store.js";
import {
  validateCommand,
  validatePolicy,
  type Action,
  type Policy,
  type Principal,
  type Receipt,
  type ReviewKey,
  type ReviewState,
} from "./contract.js";
import { parseReviewKey } from "./key.js";
import type { ApplyInput } from "./store.js";

/**
 * The review surface of the broker's HTTP API (design §5.A1–A2, §7 ingress, §9).
 *
 * Custody only *names* the principal; the reducer decides (§4). Every route here
 * therefore does exactly three things: authenticate the caller, name the principal
 * from what the caller could not have forged, and hand the act to the store.
 */

/**
 * The slice of `ReviewStore` (module map §3) these routes use. Structural, so
 * the real store satisfies it unchanged and a test can hand in a fake.
 */
export interface ReviewStorePort {
  apply(key: ReviewKey, input: ApplyInput): Receipt;
  read(key: ReviewKey): ReviewState | null;
  findByDisplay(display: string): ReviewKey | null;
  putPolicy(repositoryId: number, policy: Policy): void;
  readonly operators: {
    /** Returns the raw token exactly once; the store keeps only its hash. */
    create(operatorId: string): string;
    /** The operator id the token proves, or null. */
    verify(token: string): string | null;
  };
}

/** §7: the adapter builder's `handleWebhook`, already bound to the store and secret. */
export type WebhookHandler = (input: { rawBody: Buffer; headers: IncomingHttpHeaders }) =>
  { status: 200 | 401 | 400; outcome: string };

export interface ReviewHttpDeps {
  store: ReviewStorePort;
  /** Delivery custody: `assertLease` is the fence, `getDelivery` the attribution (§5.A1). */
  broker: BrokerStore;
  /** Null ⇒ `POST /v1/github/webhook` is 404 (no `HIVE_GITHUB_WEBHOOK_SECRET`). */
  webhook: WebhookHandler | null;
  adminToken: string;
  /** The reconcile scheduler's wake; null in M0 ⇒ `POST …/reconcile` is 503. */
  reconcile: ((key: ReviewKey) => void) | null;
}

/** Bodies carry reviewkit reports; four times the ordinary broker cap. */
const MAX_BODY_BYTES = 4_000_000;

const REVIEW_PATH = /^\/v1\/review\/([^/]+)(?:\/(acts|reconcile))?$/;
const POLICY_PATH = /^\/v1\/admin\/review-policies\/(\d+)$/;

/**
 * Handle one request if it belongs to the review surface. Returns false for any
 * other path so the caller's own routing continues.
 */
export async function routeReview(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: ReviewHttpDeps,
): Promise<boolean> {
  const method = request.method ?? "GET";
  const path = url.pathname;

  if (path === "/v1/github/webhook") {
    if (method !== "POST" || deps.webhook === null) return notFound(response);
    // §7: HMAC over the raw bytes is the authentication, so the body is handed
    // over untouched — parsing it first would forge a canonical form the
    // signature was never computed over.
    const rawBody = await readBody(request, response);
    if (rawBody === null) return true;
    const verdict = deps.webhook({ rawBody, headers: request.headers });
    return json(response, verdict.status, { outcome: verdict.outcome });
  }

  const policy = POLICY_PATH.exec(path);
  if (policy?.[1]) {
    if (method !== "PUT") return notFound(response);
    if (!requireAdmin(request, response, deps.adminToken)) return true;
    const body = await readJson(request, response);
    if (body === null) return true;
    const validated = validatePolicy(body);
    if (!validated.ok) return json(response, 400, { error: validated.code, detail: validated.detail });
    const repositoryId = Number(policy[1]);
    deps.store.putPolicy(repositoryId, validated.value);
    return json(response, 200, { repository_id: repositoryId, version: validated.value.version });
  }

  if (path === "/v1/admin/operators") {
    if (method !== "POST") return notFound(response);
    if (!requireAdmin(request, response, deps.adminToken)) return true;
    const body = await readJson(request, response);
    if (body === null) return true;
    const operatorId = body.operator_id;
    if (typeof operatorId !== "string" || !/^[a-z0-9-]+$/.test(operatorId)) {
      return json(response, 400, { error: "bad_request", detail: "operator_id must match ^[a-z0-9-]+$" });
    }
    // §5.A2: the raw token leaves the broker exactly once, in this response.
    return json(response, 201, { operator_id: operatorId, token: deps.store.operators.create(operatorId) });
  }

  const review = REVIEW_PATH.exec(path);
  if (!review?.[1]) return false;
  const keyText = decodeURIComponent(review[1]);
  const parsedKey = parseReviewKey(keyText);
  if (parsedKey === null) return json(response, 400, { error: "bad_request", detail: `not a review key: ${keyText}` });
  const verb = review[2] ?? null;

  if (verb === null) {
    if (method !== "GET") return notFound(response);
    const caller = authenticate(request, deps);
    if (caller.kind === "anonymous") return unauthorized(response, caller.detail);
    const key = resolveKey(parsedKey, deps.store);
    const state = key === null ? null : deps.store.read(key);
    if (state === null) return notFound(response);
    return json(response, 200, state);
  }

  if (verb === "reconcile") {
    if (method !== "POST") return notFound(response);
    const caller = authenticate(request, deps);
    if (caller.kind === "anonymous") return unauthorized(response, caller.detail);
    const key = resolveKey(parsedKey, deps.store);
    if (key === null) return notFound(response);
    if (deps.reconcile === null) {
      return json(response, 503, { error: "reconcile_unavailable", detail: "no reconcile scheduler is wired on this broker" });
    }
    deps.reconcile(key);
    return json(response, 202, { accepted: true, key });
  }

  // verb === "acts"
  if (method !== "POST") return notFound(response);
  const caller = authenticate(request, deps);
  if (caller.kind === "anonymous") return unauthorized(response, caller.detail);
  const body = await readJson(request, response);
  if (body === null) return true;
  // §5.A1: the body never names the actor. A client that tries is wrong about
  // the protocol, and silently dropping the field would hide that from it.
  if ("actor" in body || "principal" in body) {
    return json(response, 400, { error: "bad_request", detail: "the body never names the actor; custody names it (§5.A1)" });
  }
  if (caller.kind === "operator" && "custody" in body) {
    return json(response, 400, { error: "bad_request", detail: "an operator act cannot carry seat custody" });
  }
  const actId = body.act_id;
  if (typeof actId !== "string" || actId.length === 0) return json(response, 400, { error: "bad_request", detail: "missing act_id" });
  const expectedRevision = body.expected_revision;
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) {
    // §5.B1: a seat or operator act carries the revision it read; only an
    // adapter act may carry null, and adapter acts never arrive over HTTP.
    return json(response, 400, { error: "bad_request", detail: "expected_revision must be an integer ≥ 0" });
  }
  const principal = caller.kind === "operator"
    ? { kind: "operator", id: caller.id } satisfies Principal
    : seatPrincipal(body.custody, caller.edgeId, deps.broker);
  if ("error" in principal) return json(response, principal.status, { error: principal.error, detail: principal.detail });
  // §E2: shape is proven before the reducer sees the act; the refusal is `malformed`.
  const validated = validateCommand({ act_id: actId, action: body.action, principal, expected_revision: expectedRevision });
  if (!validated.ok) return json(response, 400, { error: validated.code, detail: validated.detail });
  const key = resolveKey(parsedKey, deps.store);
  if (key === null) return notFound(response);
  const receipt = deps.store.apply(key, {
    actId,
    principal,
    expectedRevision: Number(expectedRevision),
    action: validated.value.action,
  });
  return json(response, "refused" in receipt.outcome ? 409 : 200, receipt);
}

type Caller =
  | { kind: "edge"; edgeId: string }
  | { kind: "operator"; id: string }
  | { kind: "anonymous"; detail: string };

/**
 * Who is calling: this edge (machine credential + `x-hive-edge`, as every seat
 * act) or an operator (`Authorization: Operator <token>`, §5.A2). The schemes
 * differ so an operator token can never be mistaken for an edge credential.
 */
function authenticate(request: IncomingMessage, deps: ReviewHttpDeps): Caller {
  const header = request.headers.authorization ?? "";
  if (header.startsWith("Operator ")) {
    const id = deps.store.operators.verify(header.slice("Operator ".length));
    return id === null ? { kind: "anonymous", detail: "unknown operator token" } : { kind: "operator", id };
  }
  const edgeId = request.headers["x-hive-edge"];
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (typeof edgeId !== "string" || token === null || !deps.broker.authenticateEdge(edgeId, token)) {
    return { kind: "anonymous", detail: "edge credential or operator token required" };
  }
  return { kind: "edge", edgeId };
}

/**
 * §5.A1: delivery custody. The edge names the delivery it is running and the
 * lease generation it holds; the broker proves custody with the one primitive
 * every delivery act passes through (`assertLease`) and reads the actor from
 * that ledger row — the same derivation `mintSeatWake` uses. For session custody
 * the authenticated edge resolves its live token and this boundary proves actor enrollment.
 */
function seatPrincipal(
  custody: unknown,
  edgeId: string,
  broker: BrokerStore,
): Principal | { error: string; detail: string; status: 400 | 401 } {
  if (!custody || typeof custody !== "object") {
    return { status: 400, error: "bad_request", detail: "missing custody" };
  }
  const record = custody as Record<string, unknown>;
  if ("session_id" in record) {
    // The authenticated edge resolved a live registration token. The broker also proves
    // that this actor is assigned to that edge; an edge cannot speak for another's seat.
    if (typeof record.session_id !== "string" || !record.session_id
      || typeof record.actor !== "string" || "delivery_id" in record || "generation" in record) {
      return { status: 400, error: "bad_request", detail: "session custody needs one session_id and its edge-resolved actor" };
    }
    const subscription = broker.getActiveSubscription(record.actor);
    if (!subscription?.edgeWorkspaces.some(workspace => workspace.edgeId === edgeId)) {
      return { status: 401, error: "unauthorized", detail: "session actor has no live subscription assigned to this edge" };
    }
    return { kind: "seat", actor: record.actor, custody: { session_id: record.session_id } };
  }
  const deliveryId = record.delivery_id;
  const generation = record.generation;
  if (!Number.isInteger(deliveryId) || Number(deliveryId) < 1 || !Number.isInteger(generation) || Number(generation) < 1) {
    return { status: 400, error: "bad_request", detail: "custody needs delivery_id and generation" };
  }
  try {
    broker.assertLease(Number(deliveryId), edgeId, Number(generation));
    const actor = broker.getDelivery(Number(deliveryId)).actor;
    return { kind: "seat", actor, custody: { delivery_id: Number(deliveryId) } };
  } catch (error) {
    if (error instanceof StaleLeaseError) {
      return { status: 401, error: "unauthorized", detail: `delivery ${String(deliveryId)} is not held by this edge at that generation` };
    }
    // An unknown delivery id proves nothing either.
    return { status: 401, error: "unauthorized", detail: `delivery ${String(deliveryId)} is not in the ledger` };
  }
}

function resolveKey(parsed: NonNullable<ReturnType<typeof parseReviewKey>>, store: ReviewStorePort): ReviewKey | null {
  return parsed.kind === "key" ? parsed.key : store.findByDisplay(parsed.display);
}

function requireAdmin(request: IncomingMessage, response: ServerResponse, adminToken: string): boolean {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (token === null || !constantTimeEqual(token, adminToken)) {
    unauthorized(response, "admin token required");
    return false;
  }
  return true;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > MAX_BODY_BYTES) {
      json(response, 413, { error: "payload_too_large" });
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(request, response);
  if (raw === null) return null;
  try {
    const value = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("not an object");
    return value as Record<string, unknown>;
  } catch {
    json(response, 400, { error: "invalid_json" });
    return null;
  }
}

function unauthorized(response: ServerResponse, detail: string): true {
  return json(response, 401, { error: "unauthorized", detail });
}

function notFound(response: ServerResponse): true {
  return json(response, 404, { error: "not_found" });
}

function json(response: ServerResponse, status: number, value: unknown): true {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
  return true;
}
