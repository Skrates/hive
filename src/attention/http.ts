import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { BrokerStore } from "../broker/store.js";
import { bearerToken, constantTimeEqual, writeJsonResponse } from "../http.js";
import { MAX_ATTENTION_COMMAND_BYTES } from "./contract.js";
import type { AttentionCaller, AttentionService } from "./service.js";
import { AttentionRefusal } from "./store.js";

/**
 * The attention surface of the broker's HTTP API (ADR-0004 §7). Mounted before the generic
 * edge gate, as the review surface is: it authenticates its own callers.
 *
 * Read scope: queue, item and event reads are the private-workspace view shared by every
 * authenticated edge and the operator (ADR-0004 §7), with another edge's source session, cwd
 * and delivery redacted; a committed receipt is readable only by its
 * issuing edge or the operator; a source only by its own edge or the operator; the source list
 * only by the operator.
 *
 * - An operator presents the existing flat admin credential (`Authorization: Bearer`).
 * - An edge presents its machine credential (`Bearer` + `x-hive-edge`). A seat mutation also
 *   names the source the edge resolved from a local handle (`x-hive-attention-source`) and the
 *   broker that handle was issued by (`x-hive-broker-uuid`); an operator enrollment through
 *   the edge carries the operator credential in `x-hive-operator-token`. A body never names a
 *   principal.
 */
export interface AttentionHttpDeps {
  service: AttentionService;
  broker: BrokerStore;
  adminToken: string;
  log: (line: string) => void;
}

const ITEM_PATH = /^\/v1\/attention\/items\/(\d+)(\/events)?$/;
const COMMAND_PATH = /^\/v1\/attention\/commands\/([0-9a-f-]{36})$/;
const SOURCE_PATH = /^\/v1\/attention\/sources\/(src_[0-9a-f]{32})$/;
const GUARD_PATH = /^\/v1\/attention\/returns\/([0-9a-f-]{36})\/guard$/;

/** Returns false for any non-attention path so the caller's own routing continues. */
export async function routeAttention(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: AttentionHttpDeps,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/v1/attention/")) return false;
  try {
    await dispatch(request, response, url, deps);
  } catch (error) {
    reply(response, error, deps.log);
  }
  return true;
}

async function dispatch(request: IncomingMessage, response: ServerResponse, url: URL, deps: AttentionHttpDeps): Promise<void> {
  const method = request.method ?? "GET";
  const path = url.pathname;
  const caller = authenticate(request, deps);
  if (caller === null) {
    json(response, 401, { error: "unauthorized", detail: "edge credential or operator credential required" });
    return;
  }
  const { service } = deps;

  if (method === "GET" && path === "/v1/attention/capabilities") return json(response, 200, service.capabilities());

  if (path === "/v1/attention/commands" && method === "POST") {
    const body = await readBoundedJson(request);
    const sourceHeader = header(request, "x-hive-attention-source");
    const edgeCaller: AttentionCaller = caller.kind === "edge" ? { ...caller, sourceId: sourceHeader } : caller;
    const outcome = service.command(edgeCaller, body, header(request, "x-hive-broker-uuid"));
    return json(response, outcome.status, outcome.receipt);
  }

  if (path === "/v1/attention/sources") {
    if (method === "POST") {
      const recoverOnly = header(request, "x-hive-attention-recover") === "committed";
      const outcome = await service.bind(caller, await readBoundedJson(request), { recoverOnly });
      return json(response, outcome.status, outcome.receipt);
    }
    if (method === "GET") {
      requireOperator(caller);
      return json(response, 200, service.sources());
    }
  }

  const source = SOURCE_PATH.exec(path);
  if (source?.[1] && method === "GET") return json(response, 200, service.source(source[1], caller));

  if (method === "GET" && path === "/v1/attention/queue") {
    const limit = url.searchParams.get("limit");
    const parsedLimit = limit === null ? null : Number(limit);
    if (parsedLimit !== null && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)) {
      throw new AttentionRefusal(400, "invalid_limit", "limit is an integer from 1 to 100");
    }
    return json(response, 200, service.queue(url.searchParams.get("human"), url.searchParams.get("state"), url.searchParams.get("after"), parsedLimit, caller));
  }

  const item = ITEM_PATH.exec(path);
  if (item?.[1] && method === "GET") {
    const itemId = Number(item[1]);
    return json(response, 200, item[2] ? service.events(itemId, caller) : service.item(itemId, caller));
  }

  const command = COMMAND_PATH.exec(path);
  if (command?.[1] && method === "GET") return json(response, 200, service.receipt(command[1], caller));

  const guard = GUARD_PATH.exec(path);
  if (guard?.[1] && method === "GET") {
    const generation = Number(url.searchParams.get("generation"));
    const deliveryId = Number(url.searchParams.get("delivery_id"));
    const leaseGeneration = Number(url.searchParams.get("lease_generation"));
    if ([generation, deliveryId, leaseGeneration].some((value) => !Number.isInteger(value) || value < 1)) {
      throw new AttentionRefusal(400, "invalid_guard_query", "generation, delivery_id and lease_generation are positive integers");
    }
    return json(response, 200, service.returnGuard(caller, guard[1], generation, deliveryId, leaseGeneration));
  }

  json(response, 404, { error: "not_found" });
}

function authenticate(request: IncomingMessage, deps: AttentionHttpDeps): AttentionCaller | null {
  const token = bearerToken(request);
  if (token === null) return null;
  const edgeId = header(request, "x-hive-edge");
  if (edgeId !== null) {
    if (!deps.broker.authenticateEdge(edgeId, token)) return null;
    const operatorToken = header(request, "x-hive-operator-token");
    // A presented operator credential that does not verify is refused, never downgraded to a
    // plain edge caller: the request asked for operator authority and did not prove it.
    if (operatorToken !== null && !constantTimeEqual(operatorToken, deps.adminToken)) {
      throw new AttentionRefusal(403, "operator_credential_invalid", "the operator credential relayed by the edge does not verify");
    }
    return { kind: "edge", edgeId, operator: operatorToken !== null, sourceId: null };
  }
  return constantTimeEqual(token, deps.adminToken) ? { kind: "operator" } : null;
}

function requireOperator(caller: AttentionCaller): void {
  if (caller.kind !== "operator") throw new AttentionRefusal(403, "operator_required", "this read is an operator surface");
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

class BodyTooLarge extends Error {}
class InvalidJson extends Error {}

/** Refuses past the attention command bound before buffering beyond it. */
async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ATTENTION_COMMAND_BYTES) {
    // Discard without buffering, so the connection survives to carry the 413.
    request.resume();
    throw new BodyTooLarge();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length <= MAX_ATTENTION_COMMAND_BYTES) chunks.push(value);
  }
  if (length > MAX_ATTENTION_COMMAND_BYTES) throw new BodyTooLarge();
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new InvalidJson();
  }
}

/**
 * Typed failures: a refusal carries its own status; SQLite contention is a retryable 503; an
 * unexpected defect is a typed 500 — never the broker's broad legacy bad-request fallback.
 */
function reply(response: ServerResponse, error: unknown, log: (line: string) => void): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof AttentionRefusal) {
    json(response, error.status, { error: error.code, detail: error.message, ...(error.current ? { current: error.current } : {}) });
    return;
  }
  if (error instanceof BodyTooLarge) {
    json(response, 413, { error: "payload_too_large", detail: `an attention command is at most ${MAX_ATTENTION_COMMAND_BYTES} bytes` });
    return;
  }
  if (error instanceof InvalidJson) {
    json(response, 400, { error: "invalid_json" });
    return;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    json(response, 503, { error: "database_busy", detail: "the attention store is busy; retry the same command id" });
    return;
  }
  log(`[attention] unexpected handler failure: ${error instanceof Error ? error.message : String(error)}`);
  json(response, 500, { error: "attention_internal_error", detail: "unexpected attention failure; the command may be retried with the same id" });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  writeJsonResponse(response, status, value);
}
