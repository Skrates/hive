import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";
import {
  MAX_ATTENTION_COMMAND_BYTES,
  validateSourceBindCommand,
  type Receipt,
  type SourceEvidence,
  type SourceFile,
} from "../attention/contract.js";
import { ProviderSchema, canonicalActor, type Provider } from "../domain.js";
import type { EdgeService } from "./service.js";

/**
 * The edge half of Hive Attention (ADR-0004 §7–§8), served on the owner-only control socket.
 *
 * - `bind` resolves a source from what this edge itself observed — a running dispatch token,
 *   an exact live registration, or an explicit operator enrollment with local cwd evidence —
 *   enrolls it with the broker, and only then issues a local random handle. A retry recovers
 *   a committed bind from the evidence retained when it was first sent. The handle is
 *   stored hashed, bound to the issuing broker, and never leaves this machine except in the
 *   owner-only source file the CLI writes.
 * - `act` resolves a handle to its source and forwards the seat's command under this edge's
 *   machine credential, relaying the broker's status and body unchanged.
 * - `read` is a closed set of typed reads, not an URL proxy.
 *
 * Filesystem ownership of the socket is the local authentication; this is the single-Unix-
 * user private-workspace boundary and claims nothing beyond it.
 */
export interface RelayAnswer {
  status: number;
  body: unknown;
}

const HANDLE_PREFIX = "ahs_";

export function hashHandle(handle: string): string {
  return createHash("sha256").update(handle).digest("hex");
}

export async function attentionBind(edge: EdgeService, body: Record<string, unknown>): Promise<RelayAnswer> {
  const operatorToken = typeof body.operator_token === "string" && body.operator_token.length > 0 ? body.operator_token : null;
  if (body.mode === "operator" && operatorToken === null) return refuse(403, "operator_required", "an operator binding presents the operator credential");
  const headers: Record<string, string> = operatorToken === null ? {} : { "x-hive-operator-token": operatorToken };

  // A retry of a bind this edge already sent is recovered first, from the evidence it retained
  // when it sent it: the dispatch or registration behind that evidence may have ended since (a
  // lost response, a finished turn, an edge restart), and the broker answers an exact replay
  // before any liveness check. Recovery can only find a committed receipt — the broker refuses
  // to enroll anything from it — so a bind that never committed falls through to fresh evidence.
  // A command id is not a secret, so it never suffices: the retry presents the original
  // requester's own proof (the same dispatch token, the same still-registered live session) or
  // the operator credential, exactly as a peer on this socket could not.
  if (body.mode === "recover" && operatorToken === null) {
    return refuse(403, "operator_required", "recovering a bind by command id alone needs the operator credential");
  }
  const proof = operatorToken !== null ? null : requesterProof(edge, body);
  if (typeof body.command_id === "string" && proof !== undefined) {
    let conflict: RelayAnswer | null = null;
    for (const retained of edge.store.attentionBindIntents(body.command_id, proof)) {
      const validated = validateSourceBindCommand(bindCommand(body, JSON.parse(retained) as SourceEvidence));
      if (!validated.ok) return refuse(422, validated.code, validated.detail);
      const answer = await relay(edge, "POST", "/v1/attention/sources", validated.value, { ...headers, "x-hive-attention-recover": "committed" });
      if (answer.status === 200 || answer.status === 201) return issueHandle(edge, answer);
      const error = errorCode(answer);
      if (error === "bind_not_committed") break;
      // Committed with other content: another retained variant may be the committed one.
      if (error === "command_id_conflict") {
        conflict = answer;
        continue;
      }
      return answer;
    }
    if (conflict !== null) return conflict;
  }
  if (body.mode === "recover") {
    return refuse(404, "bind_not_committed", "this edge holds no committed binding under that command id; bind again with fresh evidence");
  }

  const evidence = resolveEvidence(edge, body);
  if ("status" in evidence) return evidence;
  const validated = validateSourceBindCommand(bindCommand(body, evidence));
  if (!validated.ok) return refuse(422, validated.code, validated.detail);
  // Retained before it is sent: the response — or this process — may not survive the request.
  edge.store.recordAttentionBindIntent(validated.value.command_id, requesterProof(edge, body) ?? "operator", JSON.stringify(validated.value.payload.evidence));
  const answer = await relay(edge, "POST", "/v1/attention/sources", validated.value, headers);
  if (answer.status !== 200 && answer.status !== 201) return answer;
  return issueHandle(edge, answer);
}

/**
 * A digest of what this requester presents that a peer on the socket cannot: the dispatch
 * token it was handed (an expired one still proves it was that turn), or an exact live session
 * this edge still has registered. Undefined when it presents neither — no retained evidence is
 * then usable. Never the token itself.
 */
function requesterProof(edge: EdgeService, body: Record<string, unknown>): string | undefined {
  if (body.mode === "dispatch" && typeof body.token === "string" && body.token.length > 0) {
    return `dispatch:${createHash("sha256").update(body.token).digest("hex")}`;
  }
  if (body.mode === "live" && typeof body.actor === "string" && typeof body.session_id === "string") {
    const actor = canonicalActor(body.actor);
    if (exactLiveEntry(edge, actor, body.session_id, body.provider) === null) return undefined;
    return `live:${createHash("sha256").update(`${actor}\0${body.session_id}`).digest("hex")}`;
  }
  return undefined;
}

/** The evidence this edge itself observes for a fresh bind, or the refusal when it observes none. */
function resolveEvidence(edge: EdgeService, body: Record<string, unknown>): SourceEvidence | RelayAnswer {
  const mode = body.mode;
  if (mode === "dispatch") {
    const token = typeof body.token === "string" ? body.token : "";
    const dispatch = edge.dispatchEvidence(token);
    if (!dispatch) {
      return refuse(403, "unknown_dispatch_token",
        "no running dispatch on this edge holds that token — bind while the turn runs; a live session binds with --actor/--session");
    }
    return {
      kind: "dispatch",
      source_delivery_id: dispatch.deliveryId,
      generation: dispatch.generation,
      route: dispatch.route,
      session_id: dispatch.sessionId,
      cwd: dispatch.cwd,
    };
  }
  if (mode === "live") {
    const actor = typeof body.actor === "string" ? canonicalActor(body.actor) : "";
    const sessionId = typeof body.session_id === "string" ? body.session_id : "";
    const entry = exactLiveEntry(edge, actor, sessionId, body.provider);
    if (entry === null) {
      return refuse(404, "live_session_not_registered",
        `no single unexpired live registration for ${actor} session ${sessionId} on this edge; the operator can enroll it with --operator`);
    }
    return {
      kind: "live_registration",
      actor,
      provider: entry.provider,
      session_id: sessionId,
      cwd: entry.cwd,
      surface_version: entry.surfaceVersion,
    };
  }
  if (mode === "operator") {
    const actor = typeof body.actor === "string" ? canonicalActor(body.actor) : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!isAbsolute(cwd) || !isDirectory(cwd)) {
      return refuse(422, "cwd_not_local", `${cwd || "(none)"} is not an existing absolute directory on this edge; run the binding on the source edge`);
    }
    const sessionId = typeof body.session_id === "string" && body.session_id.length > 0 ? body.session_id : null;
    // The provider whose live registry verified the session is evidence too: the broker
    // accepts it only when it is the provider the actor is enrolled on.
    const entry = sessionId === null ? null : exactLiveEntry(edge, actor, sessionId, null);
    return entry === null
      ? { kind: "operator_binding", actor, session_id: sessionId, session_verified: "none", provider: null, cwd }
      : { kind: "operator_binding", actor, session_id: sessionId, session_verified: "live_registry", provider: entry.provider, cwd };
  }
  return refuse(400, "invalid_bind_mode", "mode is dispatch, live, operator or recover");
}

/** The single unexpired live registration for exactly this actor and session, or null. */
function exactLiveEntry(edge: EdgeService, actor: string, sessionId: string, provider: unknown) {
  const providers: Provider[] = provider === undefined || provider === null ? ["codex", "claude"] : [ProviderSchema.parse(provider)];
  const entries = providers.map((candidate) => edge.live.getExact(actor, candidate, sessionId)).filter((entry) => entry !== null);
  return entries.length === 1 ? entries[0]! : null;
}

function bindCommand(body: Record<string, unknown>, evidence: SourceEvidence): unknown {
  return {
    schema_version: 1,
    command_id: body.command_id,
    action: "source_bind",
    payload: {
      project_id: body.project_id,
      work_id: body.work_id,
      return_mode: body.return_mode,
      thread: body.thread ?? null,
      evidence,
    },
  };
}

/**
 * The handle is minted only after the broker committed the source. A replayed or recovered
 * bind yields a fresh handle for the same source; every earlier handle stays valid.
 */
function issueHandle(edge: EdgeService, answer: RelayAnswer): RelayAnswer {
  const receipt = answer.body as Receipt;
  const source = receipt.source;
  if (source === null) return refuse(502, "broker_relay_failed", "the broker committed a binding without a source view");
  const handle = `${HANDLE_PREFIX}${randomBytes(32).toString("base64url")}`;
  edge.store.putAttentionHandle({
    handleHash: hashHandle(handle),
    brokerUuid: receipt.broker_uuid,
    sourceId: source.source_id,
    provenance: source.provenance,
    actor: source.actor,
    projectId: source.project_id,
    workId: source.work_id,
  });
  const sourceFile: SourceFile = {
    schema_version: 1,
    broker_uuid: receipt.broker_uuid,
    edge_id: edge.broker.edgeId,
    source_id: source.source_id,
    handle,
    actor: source.actor,
    project_id: source.project_id,
    work_id: source.work_id,
    return_mode: source.return_mode,
    provenance: source.provenance,
  };
  return { status: answer.status, body: { receipt, source_file: sourceFile } };
}

function errorCode(answer: RelayAnswer): unknown {
  return answer.body !== null && typeof answer.body === "object" ? (answer.body as { error?: unknown }).error : undefined;
}

export async function attentionAct(edge: EdgeService, body: Record<string, unknown>): Promise<RelayAnswer> {
  const handle = typeof body.handle === "string" ? body.handle : "";
  const record = handle.startsWith(HANDLE_PREFIX) ? edge.store.attentionHandle(hashHandle(handle)) : null;
  if (record === null) {
    return refuse(403, "unknown_source_handle", "this edge issued no such attention source handle; bind again on the edge that runs the work");
  }
  const command = body.command;
  if (!command || typeof command !== "object" || Array.isArray(command)) return refuse(400, "missing_command", "act carries one command envelope");
  if (Buffer.byteLength(JSON.stringify(command)) > MAX_ATTENTION_COMMAND_BYTES) {
    return refuse(413, "payload_too_large", `an attention command is at most ${MAX_ATTENTION_COMMAND_BYTES} bytes`);
  }
  // The source id comes from this edge's own table, never from the caller; the broker uuid
  // the handle was issued by rides along, so a handle can never write to another broker.
  const answer = await relay(edge, "POST", "/v1/attention/commands", command, {
    "x-hive-attention-source": record.sourceId,
    "x-hive-broker-uuid": record.brokerUuid,
  });
  if (answer.status === 403 && errorCode(answer) === "source_revoked") {
    edge.store.markAttentionSourceRevoked(record.sourceId);
  }
  return answer;
}

const READS: Record<string, (args: Record<string, unknown>) => string | null> = {
  capabilities: () => "/v1/attention/capabilities",
  queue: (args) => {
    const query = new URLSearchParams();
    for (const key of ["human", "state", "after", "limit"]) {
      const value = args[key];
      if (typeof value === "string" || typeof value === "number") query.set(key, String(value));
    }
    const text = query.toString();
    return `/v1/attention/queue${text ? `?${text}` : ""}`;
  },
  item: (args) => positive(args.item_id) ? `/v1/attention/items/${String(args.item_id)}` : null,
  events: (args) => positive(args.item_id) ? `/v1/attention/items/${String(args.item_id)}/events` : null,
  command: (args) => typeof args.command_id === "string" && /^[0-9a-f-]{36}$/.test(args.command_id)
    ? `/v1/attention/commands/${args.command_id}` : null,
  source: (args) => typeof args.source_id === "string" && /^src_[0-9a-f]{32}$/.test(args.source_id)
    ? `/v1/attention/sources/${args.source_id}` : null,
  return_guard: (args) => typeof args.resolution_command_id === "string" && /^[0-9a-f-]{36}$/.test(args.resolution_command_id)
    && positive(args.generation) && positive(args.delivery_id)
    ? `/v1/attention/returns/${args.resolution_command_id}/guard?generation=${String(args.generation)}&delivery_id=${String(args.delivery_id)}`
    : null,
};

export async function attentionRead(edge: EdgeService, body: Record<string, unknown>): Promise<RelayAnswer> {
  const op = typeof body.op === "string" ? body.op : "";
  const route = READS[op];
  if (!route) return refuse(400, "unknown_read_op", `read ops: ${Object.keys(READS).join(", ")}`);
  const path = route(body);
  if (path === null) return refuse(400, "invalid_read_arguments", `invalid arguments for ${op}`);
  return relay(edge, "GET", path);
}

async function relay(edge: EdgeService, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<RelayAnswer> {
  let answer: { status: number; body: string };
  try {
    answer = await edge.broker.attention(method, path, { ...(body === undefined ? {} : { body }), headers });
  } catch (error) {
    // A timeout or transport failure proves nothing about commit; the caller reconciles
    // with the command id it already holds.
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return refuse(503, timeout ? "broker_timeout" : "broker_unreachable",
      timeout ? "the broker did not answer within 10s; the command may or may not have committed" : "the broker could not be reached");
  }
  try {
    return { status: answer.status, body: JSON.parse(answer.body) as unknown };
  } catch {
    return { status: 502, body: { error: "broker_relay_failed", detail: answer.body.slice(0, 500) } };
  }
}

function refuse(status: number, error: string, detail: string): RelayAnswer {
  return { status, body: { error, detail } };
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
