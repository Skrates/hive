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
 *   enrolls it with the broker, and only then issues a local random handle. The handle is
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
  const mode = body.mode;
  const commandId = body.command_id;
  const operatorToken = typeof body.operator_token === "string" && body.operator_token.length > 0 ? body.operator_token : null;
  let evidence: SourceEvidence;
  if (mode === "dispatch") {
    const token = typeof body.token === "string" ? body.token : "";
    const dispatch = edge.dispatchEvidence(token);
    if (!dispatch) {
      return refuse(403, "unknown_dispatch_token",
        "no running dispatch on this edge holds that token — bind while the turn runs; a live session binds with --actor/--session");
    }
    evidence = {
      kind: "dispatch",
      source_delivery_id: dispatch.deliveryId,
      generation: dispatch.generation,
      route: dispatch.route,
      session_id: dispatch.sessionId,
      cwd: dispatch.cwd,
    };
  } else if (mode === "live") {
    const actor = typeof body.actor === "string" ? canonicalActor(body.actor) : "";
    const sessionId = typeof body.session_id === "string" ? body.session_id : "";
    const providers: Provider[] = body.provider === undefined || body.provider === null
      ? ["codex", "claude"]
      : [ProviderSchema.parse(body.provider)];
    const entries = providers.map((provider) => edge.live.getExact(actor, provider, sessionId)).filter((entry) => entry !== null);
    if (entries.length !== 1) {
      return refuse(404, "live_session_not_registered",
        `no single unexpired live registration for ${actor} session ${sessionId} on this edge; the operator can enroll it with --operator`);
    }
    const entry = entries[0]!;
    evidence = {
      kind: "live_registration",
      actor,
      provider: entry.provider,
      session_id: sessionId,
      cwd: entry.cwd,
      surface_version: entry.surfaceVersion,
    };
  } else if (mode === "operator") {
    if (operatorToken === null) return refuse(403, "operator_required", "an operator binding presents the operator credential");
    const actor = typeof body.actor === "string" ? canonicalActor(body.actor) : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!isAbsolute(cwd) || !isDirectory(cwd)) {
      return refuse(422, "cwd_not_local", `${cwd || "(none)"} is not an existing absolute directory on this edge; run the binding on the source edge`);
    }
    const sessionId = typeof body.session_id === "string" && body.session_id.length > 0 ? body.session_id : null;
    const verified = sessionId !== null
      && (edge.live.getExact(actor, "codex", sessionId) !== null || edge.live.getExact(actor, "claude", sessionId) !== null);
    evidence = { kind: "operator_binding", actor, session_id: sessionId, session_verified: verified ? "live_registry" : "none", cwd };
  } else {
    return refuse(400, "invalid_bind_mode", "mode is dispatch, live or operator");
  }

  const command = {
    schema_version: 1,
    command_id: commandId,
    action: "source_bind",
    payload: {
      project_id: body.project_id,
      work_id: body.work_id,
      return_mode: body.return_mode,
      thread: body.thread ?? null,
      evidence,
    },
  };
  const validated = validateSourceBindCommand(command);
  if (!validated.ok) return refuse(422, validated.code, validated.detail);
  const answer = await relay(edge, "POST", "/v1/attention/sources", validated.value, operatorToken === null ? {} : { "x-hive-operator-token": operatorToken });
  if (answer.status !== 200 && answer.status !== 201) return answer;
  const receipt = answer.body as Receipt;
  const source = receipt.source;
  if (source === null) return refuse(502, "broker_relay_failed", "the broker committed a binding without a source view");
  // The handle is minted only after the broker committed the source. A replayed bind (lost
  // response) yields a fresh handle for the same source; every earlier handle stays valid.
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
  if (answer.status === 403 && (answer.body as { error?: unknown }).error === "source_revoked") {
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
