import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveEdgeSocketPath } from "../edge/providers.js";
import { udsRequest, UdsTimeoutError } from "../local/uds.js";
import {
  ATTENTION_SCHEMA_VERSION,
  validateAttentionCommand,
  validateInterventionPacket,
  validatePacketAmendment,
  validateSourceFile,
  type AttentionCommand,
  type Capabilities,
  type EventView,
  type ItemView,
  type QueuePage,
  type Receipt,
  type ResolutionOutcome,
  type ReturnMode,
  type SourceFile,
  type SourceView,
} from "./contract.js";
import { inert, renderBrief, renderQueue, renderReceipt } from "./render.js";

/**
 * `hive attention …` (ADR-0004 §7) — the canonical human and seat surface; `hive-attention`
 * from agent-affordances forwards here verbatim.
 *
 * Human mutations go straight to the broker under the operator credential
 * (`HIVE_BROKER_URL` + `HIVE_ADMIN_TOKEN`), never through the ordinary edge socket. Seat
 * mutations present an owner-only source file to the local edge, which forwards under its
 * machine credential. Every mutation's normalized envelope is journalled under
 * `~/.hive/attention/requests/<command_id>.json` (0600) before any I/O, so `retry-command`
 * resends the exact bytes and a timeout is reconciled rather than guessed.
 *
 * Standard output is the requested rendering or one JSON object; diagnostics go to stderr.
 */

export interface HttpAnswer {
  status: number;
  body: unknown;
}

/** A transport that could not obtain an answer: the outcome of the request is unknown. */
export class AttentionTransportError extends Error {}

export interface AttentionTransport {
  operator(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpAnswer>;
  edge(path: "/attention/bind" | "/attention/act" | "/attention/read", body: unknown): Promise<HttpAnswer>;
  edgeHealth(): Promise<boolean>;
}

export interface AttentionIo {
  out(text: string): void;
  err(text: string): void;
  exit(code: number): void;
  now(): Date;
}

/** §6: HTTP class → CLI exit code. */
export function exitCodeFor(status: number): number {
  if (status >= 200 && status < 300) return 0;
  if (status === 400 || status === 413 || status === 422) return 2;
  if (status === 401 || status === 403) return 3;
  if (status === 404) return 4;
  if (status === 409) return 5;
  if (status === 429 || status === 503) return 6;
  return 7;
}

const EXIT_UNKNOWN_OUTCOME = 6;
const EXIT_USAGE = 2;
const EXIT_AUTH = 3;

class CliFailure extends Error {
  constructor(readonly exitCode: number, message: string, readonly body: unknown = null) {
    super(message);
  }
}

const RETURN_MODES: Record<string, ReturnMode> = {
  "pinned-session": "pinned_session",
  "actor-context": "actor_context",
  none: "none",
};

const OUTCOMES: readonly ResolutionOutcome[] = ["approved", "changes_requested", "answered", "selected", "delegated", "completed"];

interface JournalEntry {
  schema: "hive-attention-request/v1";
  route: "operator" | "seat";
  envelope: AttentionCommand;
  source_file: string | null;
  saved_at: string;
}

function hiveHome(env: NodeJS.ProcessEnv): string {
  return env.HIVE_HOME ?? join(homedir(), ".hive");
}

function journalPath(env: NodeJS.ProcessEnv, commandId: string): string {
  return join(hiveHome(env), "attention", "requests", `${commandId}.json`);
}

function writeOwnerOnly(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

export function defaultAttentionTransport(env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): AttentionTransport {
  const socket = (): string => resolveEdgeSocketPath(env);
  return {
    async operator(method, path, body) {
      const baseUrl = env.HIVE_BROKER_URL;
      const token = env.HIVE_ADMIN_TOKEN;
      if (!baseUrl || !token) throw new CliFailure(EXIT_AUTH, "operator commands need HIVE_BROKER_URL and HIVE_ADMIN_TOKEN");
      // The whole exchange, receipt body included, is one transport boundary: headers can
      // arrive and the body stall or break after the broker committed, which is exactly as
      // unknown an outcome as no answer at all.
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: response.status, body: parseBody(await response.text()) };
      } catch (error) {
        throw new AttentionTransportError(error instanceof Error ? error.message : String(error));
      }
    },
    async edge(path, body) {
      try {
        const answer = await udsRequest(socket(), "POST", path, body, { timeoutMs });
        return { status: answer.status, body: parseBody(answer.body) };
      } catch (error) {
        if (error instanceof UdsTimeoutError) throw new AttentionTransportError(error.message);
        throw new AttentionTransportError(`edge socket ${socket()}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async edgeHealth() {
      try {
        return (await udsRequest(socket(), "GET", "/health", undefined, { timeoutMs })).status === 200;
      } catch {
        return false;
      }
    },
  };
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "unparseable_response", detail: text.slice(0, 500) };
  }
}

const defaultIo: AttentionIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  exit: (code) => { process.exitCode = code; },
  now: () => new Date(),
};

interface JsonOption { json?: boolean }

export function registerAttentionCommands(
  program: Command,
  transport: AttentionTransport = defaultAttentionTransport(),
  env: NodeJS.ProcessEnv = process.env,
  io: AttentionIo = defaultIo,
): void {
  const attention = program.command("attention").description("the human-attention queue (ADR-0004)");

  /** The operator credential never runs inside an agent's execution environment. */
  const assertOperatorContext = (): void => {
    for (const name of ["HIVE_DELIVERY_TOKEN", "HIVE_SESSION_TOKEN"]) {
      if (env[name] !== undefined) {
        throw new CliFailure(EXIT_AUTH, `refusing an operator act: ${name} is present, so this is an agent's execution environment; seats summon, the human decides`);
      }
    }
    if (!env.HIVE_BROKER_URL || !env.HIVE_ADMIN_TOKEN) throw new CliFailure(EXIT_AUTH, "operator commands need HIVE_BROKER_URL and HIVE_ADMIN_TOKEN");
  };
  const operatorAvailable = (): boolean =>
    Boolean(env.HIVE_BROKER_URL && env.HIVE_ADMIN_TOKEN) && env.HIVE_DELIVERY_TOKEN === undefined && env.HIVE_SESSION_TOKEN === undefined;

  const run = <O extends JsonOption>(handler: (options: O) => Promise<void>) => async (options: O): Promise<void> => {
    try {
      await handler(options);
    } catch (error) {
      if (error instanceof CliFailure) {
        if (options.json) io.out(JSON.stringify(error.body ?? { error: "cli_failure", detail: error.message }));
        io.err(error.message);
        io.exit(error.exitCode);
        return;
      }
      throw error;
    }
  };

  /** Render a broker/edge answer, or fail with its mapped exit code. */
  const settle = (answer: HttpAnswer, options: JsonOption, human: (body: unknown) => string): void => {
    const code = exitCodeFor(answer.status);
    if (code !== 0) {
      const envelope = answer.body as { error?: unknown; detail?: unknown; current?: { revision?: number; state?: string } };
      const current = envelope.current ? ` (current revision ${String(envelope.current.revision)}, ${String(envelope.current.state)})` : "";
      throw new CliFailure(code, `${String(envelope.error ?? answer.status)}${envelope.detail ? ` — ${String(envelope.detail)}` : ""}${current}`, answer.body);
    }
    io.out(options.json ? JSON.stringify(answer.body) : human(answer.body));
  };

  /** Journal, then send. A transport failure is an unknown outcome, never a reported failure to commit. */
  const mutate = async (
    route: "operator" | "seat",
    envelope: AttentionCommand,
    options: JsonOption,
    sourceFile: { path: string; file: SourceFile } | null,
    journal = true,
  ): Promise<void> => {
    const validated = validateAttentionCommand(envelope);
    if (!validated.ok) throw new CliFailure(EXIT_USAGE, validated.detail, { error: validated.code, detail: validated.detail });
    if (journal) {
      const entry: JournalEntry = { schema: "hive-attention-request/v1", route, envelope, source_file: sourceFile?.path ?? null, saved_at: io.now().toISOString() };
      writeOwnerOnly(journalPath(env, envelope.command_id), `${JSON.stringify(entry, null, 2)}\n`);
    }
    let answer: HttpAnswer;
    try {
      answer = route === "operator"
        ? await transport.operator("POST", "/v1/attention/commands", envelope)
        : await transport.edge("/attention/act", { handle: sourceFile!.file.handle, command: envelope });
    } catch (error) {
      if (!(error instanceof AttentionTransportError)) throw error;
      throw new CliFailure(EXIT_UNKNOWN_OUTCOME,
        `request ${envelope.command_id} has an unknown outcome (${error.message}); it may have committed. `
        + `Reconcile with \`hive attention receipt ${envelope.command_id}\` or resend the identical request with \`hive attention retry-command ${envelope.command_id}\`.`,
        { error: "outcome_unknown", command_id: envelope.command_id, detail: error.message });
    }
    settle(answer, options, (body) => renderReceipt(body as Receipt, io.now()));
  };

  const operatorCommand = async (action: AttentionCommand["action"], payload: unknown, options: JsonOption): Promise<void> => {
    assertOperatorContext();
    await mutate("operator", { schema_version: ATTENTION_SCHEMA_VERSION, command_id: randomUUID(), action, payload } as AttentionCommand, options, null);
  };

  /** Reads prefer the operator credential when this is the operator's shell, else the edge relay. */
  const read = async (op: string, args: Record<string, unknown>, operatorPath: string): Promise<HttpAnswer> => {
    try {
      return operatorAvailable() ? await transport.operator("GET", operatorPath) : await transport.edge("/attention/read", { op, ...args });
    } catch (error) {
      if (error instanceof AttentionTransportError) throw new CliFailure(EXIT_UNKNOWN_OUTCOME, `read failed: ${error.message}`, { error: "transport_failed", detail: error.message });
      throw error;
    }
  };

  const loadSourceFile = (path: string): { path: string; file: SourceFile } => {
    const absolute = resolve(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new CliFailure(EXIT_USAGE, `cannot read source file ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validated = validateSourceFile(parsed);
    if (!validated.ok) throw new CliFailure(EXIT_USAGE, `${absolute} is not an attention source file: ${validated.detail}`);
    return { path: absolute, file: validated.value };
  };

  const readJsonFile = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
    } catch (error) {
      throw new CliFailure(EXIT_USAGE, `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const positive = (value: string, name: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CliFailure(EXIT_USAGE, `${name} must be a positive integer`);
    return parsed;
  };

  // ───────────────────────────── reads ─────────────────────────────

  attention.command("capabilities")
    .description("what this broker's attention surface supports, and whether it is enabled")
    .option("--json", "one JSON object")
    .action(run(async (options) => {
      const answer = await read("capabilities", {}, "/v1/attention/capabilities");
      settle(answer, options, (body) => {
        const caps = body as Capabilities;
        return [
          `attention schema ${caps.schema_version} (store ${caps.store_schema_version}) on broker ${caps.broker_uuid}`,
          `enabled: ${caps.enabled} · human: ${caps.human_id} · return modes: ${caps.return_modes.join(", ")}`,
          ...(caps.disabled_note ? [caps.disabled_note] : []),
        ].join("\n");
      });
    }));

  attention.command("queue")
    .description("the queue: active item, eligible and deferred items, return health")
    .option("--human <id>", "queue identity (default: the broker's configured human)")
    .option("--state <states>", "comma-separated states, or all (default: active,queued,deferred)")
    .option("--after <cursor>", "continue from a page cursor")
    .option("--limit <n>", "page size, 1-100 (default 25)")
    .option("--json", "one JSON object")
    .action(run(async (options: JsonOption & { human?: string; state?: string; after?: string; limit?: string }) => {
      const query = new URLSearchParams();
      if (options.human) query.set("human", options.human);
      if (options.state) query.set("state", options.state);
      if (options.after) query.set("after", options.after);
      if (options.limit) query.set("limit", options.limit);
      const text = query.toString();
      const answer = await read("queue", {
        ...(options.human ? { human: options.human } : {}),
        ...(options.state ? { state: options.state } : {}),
        ...(options.after ? { after: options.after } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      }, `/v1/attention/queue${text ? `?${text}` : ""}`);
      settle(answer, options, (body) => renderQueue(body as QueuePage, io.now()));
    }));

  attention.command("show")
    .argument("<item-id>")
    .description("one item: its brief, state, response and return phase (reads never claim)")
    .option("--json", "one JSON object")
    .action(async (itemId: string, options: JsonOption) => run(async () => {
      const id = positive(itemId, "item-id");
      const answer = await read("item", { item_id: id }, `/v1/attention/items/${id}`);
      settle(answer, options, (body) => {
        const item = body as ItemView;
        const lines = [renderBrief(item, io.now())];
        if (item.response !== null) lines.push(`Response (${item.outcome ?? "?"}): ${inert(item.response)}`);
        if (item.terminal_reason !== null) lines.push(`Reason: ${inert(item.terminal_reason)}`);
        if (item.return !== null) {
          const ret = item.return;
          lines.push(`Return generation ${ret.generation}: ${ret.phase}${ret.transport_status ? ` (transport ${ret.transport_status})` : ""}${ret.reason ? ` — ${inert(ret.reason)}` : ""} · observed ${ret.observed_at}`);
        }
        return lines.join("\n");
      });
    })(options));

  attention.command("events")
    .argument("<item-id>")
    .description("an item's immutable history")
    .option("--json", "one JSON object")
    .action(async (itemId: string, options: JsonOption) => run(async () => {
      const id = positive(itemId, "item-id");
      const answer = await read("events", { item_id: id }, `/v1/attention/items/${id}/events`);
      settle(answer, options, (body) => (body as EventView[])
        .map((event) => `${event.created_at} #${event.event_id} ${event.event_type}${event.revision === null ? "" : ` r${event.revision}`} by ${event.principal}`)
        .join("\n"));
    })(options));

  attention.command("receipt")
    .argument("<command-id>")
    .description("the committed receipt of a request — reconciliation after a timeout")
    .option("--json", "one JSON object")
    .action(async (commandId: string, options: JsonOption) => run(async () => {
      const answer = await read("command", { command_id: commandId }, `/v1/attention/commands/${commandId}`);
      settle(answer, options, (body) => renderReceipt(body as Receipt, io.now()));
    })(options));

  // ───────────────────────────── human acts ─────────────────────────────

  attention.command("next")
    .description("take the next intervention (a repeated next returns the active one)")
    .option("--human <id>", "queue identity", env.HIVE_ATTENTION_HUMAN_ID ?? "hakon")
    .option("--pick <item-id>", "explicitly select this eligible item instead of FIFO")
    .option("--json", "one JSON object")
    .action(run(async (options: JsonOption & { human: string; pick?: string }) => {
      await operatorCommand("next", { human_id: options.human, item_id: options.pick ? positive(options.pick, "--pick") : null }, options);
    }));

  const packetFile = (path: string): unknown => {
    const packet = readJsonFile(path);
    const validated = validateInterventionPacket(packet);
    if (!validated.ok) throw new CliFailure(EXIT_USAGE, `${path}: ${validated.detail}`, { error: validated.code, detail: validated.detail });
    return validated.value;
  };

  for (const action of ["add", "start"] as const) {
    attention.command(action)
      .description(action === "add" ? "queue human-first work from a packet file" : "record already-begun human work as the active item")
      .requiredOption("--file <packet.json>", "an intervention packet")
      .option("--return-source <source-id>", "an enrolled source the resolution returns to")
      .option("--json", "one JSON object")
      .action(run(async (options: JsonOption & { file: string; returnSource?: string }) => {
        await operatorCommand(action, { packet: packetFile(options.file), return_source_id: options.returnSource ?? null }, options);
      }));
  }

  attention.command("resolve")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the revision you decided on")
    .requiredOption("--outcome <outcome>", OUTCOMES.join(" | "))
    .requiredOption("--response <text>", "exactly what you decided")
    .option("--next", "my part is finished: select the next intervention in the same commit")
    .option("--json", "one JSON object")
    .description("record the decision and its return; release the active slot")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; outcome: string; response: string; next?: boolean }) => run(async () => {
      if (!(OUTCOMES as readonly string[]).includes(options.outcome)) throw new CliFailure(EXIT_USAGE, `--outcome is one of ${OUTCOMES.join(", ")}`);
      await operatorCommand("resolve", {
        item_id: positive(itemId, "item-id"),
        expected_revision: positive(options.expectedRevision, "--expected-revision"),
        outcome: options.outcome,
        response: options.response,
        select_next: options.next === true,
      }, options);
    })(options));

  attention.command("defer")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the revision you decided on")
    .requiredOption("--reason <text>", "why it waits")
    .option("--until <timestamp>", "RFC 3339 instant it becomes ready again (joins the FIFO tail)")
    .option("--indefinite", "hold until explicitly requeued")
    .option("--next", "select the next intervention in the same commit")
    .option("--json", "one JSON object")
    .description("postpone an item without dropping it")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; reason: string; until?: string; indefinite?: boolean; next?: boolean }) => run(async () => {
      if ((options.until === undefined) === (options.indefinite !== true)) {
        throw new CliFailure(EXIT_USAGE, "defer needs exactly one of --until <timestamp> or --indefinite");
      }
      await operatorCommand("defer", {
        item_id: positive(itemId, "item-id"),
        expected_revision: positive(options.expectedRevision, "--expected-revision"),
        reason: options.reason,
        until: options.until ?? null,
        select_next: options.next === true,
      }, options);
    })(options));

  attention.command("requeue")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the revision you decided on")
    .requiredOption("--reason <text>", "why it is ready again")
    .option("--json", "one JSON object")
    .description("return a deferred item to the queue tail")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; reason: string }) => run(async () => {
      await operatorCommand("requeue", {
        item_id: positive(itemId, "item-id"),
        expected_revision: positive(options.expectedRevision, "--expected-revision"),
        reason: options.reason,
      }, options);
    })(options));

  attention.command("cancel")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the revision you decided on")
    .requiredOption("--reason <text>", "why it is cancelled")
    .option("--next", "select the next intervention in the same commit")
    .option("--json", "one JSON object")
    .description("cancel an item; no implementation instruction is sent")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; reason: string; next?: boolean }) => run(async () => {
      await operatorCommand("cancel", {
        item_id: positive(itemId, "item-id"),
        expected_revision: positive(options.expectedRevision, "--expected-revision"),
        reason: options.reason,
        select_next: options.next === true,
      }, options);
    })(options));

  attention.command("retry-return")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the item revision you inspected")
    .requiredOption("--return-generation <n>", "the return generation you inspected")
    .option("--json", "one JSON object")
    .description("retry a blocked or failed return; never resends a processed one")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; returnGeneration: string }) => run(async () => {
      await operatorCommand("retry_return", {
        item_id: positive(itemId, "item-id"),
        expected_revision: positive(options.expectedRevision, "--expected-revision"),
        return_generation: positive(options.returnGeneration, "--return-generation"),
      }, options);
    })(options));

  attention.command("reroute-return")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the item revision you inspected")
    .requiredOption("--return-generation <n>", "the return generation you inspected")
    .requiredOption("--source <source-id>", "an enrolled source to return through instead")
    .requiredOption("--reason <text>", "why the route changes")
    .option("--json", "one JSON object")
    .description("explicitly replace an unminted or terminal return's route")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; returnGeneration: string; source: string; reason: string }) => run(async () => {
      await operatorCommand("reroute_return", {
        item_id: positive(itemId, "item-id"),
        expected_revision: positive(options.expectedRevision, "--expected-revision"),
        return_generation: positive(options.returnGeneration, "--return-generation"),
        source_id: options.source,
        reason: options.reason,
      }, options);
    })(options));

  attention.command("retry-command")
    .argument("<command-id>")
    .option("--json", "one JSON object")
    .description("resend a journalled request byte-for-byte (same command id: replays, never duplicates)")
    .action(async (commandId: string, options: JsonOption) => run(async () => {
      const path = journalPath(env, commandId);
      if (!existsSync(path)) throw new CliFailure(4, `no journalled request ${commandId} at ${path}`);
      const entry = JSON.parse(readFileSync(path, "utf8")) as JournalEntry;
      if (entry.route === "operator") assertOperatorContext();
      const source = entry.route === "seat" ? loadSourceFile(entry.source_file ?? "") : null;
      await mutate(entry.route, entry.envelope, options, source, false);
    })(options));

  // ───────────────────────────── seat acts ─────────────────────────────

  attention.command("summon")
    .requiredOption("--source-file <path>", "the owner-only file `bind` wrote")
    .requiredOption("--file <envelope.json>", "a complete saved summon envelope (reuse it on retry)")
    .option("--json", "one JSON object")
    .description("ring the bell: submit one actionable intervention")
    .action(run(async (options: JsonOption & { sourceFile: string; file: string }) => {
      const source = loadSourceFile(options.sourceFile);
      const envelope = readJsonFile(options.file) as AttentionCommand;
      if ((envelope as { action?: unknown }).action !== "summon") {
        throw new CliFailure(EXIT_USAGE, `${options.file} must be a complete summon envelope {schema_version, command_id, action: "summon", payload}`);
      }
      const journalled = existsSync(journalPath(env, envelope.command_id));
      await mutate("seat", envelope, options, source, !journalled);
    }));

  attention.command("amend")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the revision being amended")
    .requiredOption("--file <fields.json>", "replacement mutable fields")
    .option("--source-file <path>", "as the owning seat (otherwise the operator)")
    .option("--json", "one JSON object")
    .description("replace mutable packet fields; queue position is kept")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; file: string; sourceFile?: string }) => run(async () => {
      const fields = readJsonFile(options.file);
      const validated = validatePacketAmendment(fields);
      if (!validated.ok) throw new CliFailure(EXIT_USAGE, `${options.file}: ${validated.detail}`);
      const envelope = {
        schema_version: ATTENTION_SCHEMA_VERSION, command_id: randomUUID(), action: "amend",
        payload: { item_id: positive(itemId, "item-id"), expected_revision: positive(options.expectedRevision, "--expected-revision"), fields: validated.value },
      } as AttentionCommand;
      if (options.sourceFile) await mutate("seat", envelope, options, loadSourceFile(options.sourceFile));
      else {
        assertOperatorContext();
        await mutate("operator", envelope, options, null);
      }
    })(options));

  attention.command("withdraw")
    .argument("<item-id>")
    .requiredOption("--expected-revision <n>", "the revision being withdrawn")
    .requiredOption("--reason <text>", "why")
    .requiredOption("--source-file <path>", "the owning seat's source file")
    .option("--json", "one JSON object")
    .description("withdraw your own queued or deferred item")
    .action(async (itemId: string, options: JsonOption & { expectedRevision: string; reason: string; sourceFile: string }) => run(async () => {
      await mutate("seat", {
        schema_version: ATTENTION_SCHEMA_VERSION, command_id: randomUUID(), action: "withdraw",
        payload: { item_id: positive(itemId, "item-id"), expected_revision: positive(options.expectedRevision, "--expected-revision"), reason: options.reason },
      } as AttentionCommand, options, loadSourceFile(options.sourceFile));
    })(options));

  attention.command("bind")
    .requiredOption("--project <id>", "project slug the source may summon for")
    .requiredOption("--work <id>", "work identity the source may summon for")
    .requiredOption("--return <mode>", "pinned-session | actor-context | none")
    .requiredOption("--out <path>", "where to write the owner-only source file (never overwritten)")
    .option("--actor <actor>", "live/operator binding: the exact actor")
    .option("--session <id>", "live/operator binding: the exact session the surface announced")
    .option("--session-file <path>", "live binding: the per-session file the surface announced")
    .option("--provider <provider>", "live binding: codex or claude when ambiguous")
    .option("--operator", "explicit operator enrollment on this (source) edge")
    .option("--cwd <path>", "operator binding: the work context directory", process.cwd())
    .option("--command-id <uuid>", "reuse the command id of a bind whose outcome was unknown (a committed bind is recovered with the same source; with --operator alone, recover it by id)")
    .option("--channel <id>", "Slack channel of the return thread")
    .option("--thread <ts>", "Slack thread ts of the return thread")
    .option("--json", "one JSON object")
    .description("enroll this work context as an attention source")
    .action(run(async (options: JsonOption & {
      project: string; work: string; return: string; out: string; actor?: string; session?: string; sessionFile?: string;
      provider?: string; operator?: boolean; cwd: string; channel?: string; thread?: string; commandId?: string;
    }) => {
      const returnMode = RETURN_MODES[options.return];
      if (!returnMode) throw new CliFailure(EXIT_USAGE, "--return is pinned-session, actor-context or none");
      if ((options.channel === undefined) !== (options.thread === undefined)) throw new CliFailure(EXIT_USAGE, "--channel and --thread go together");
      const out = resolve(options.out);
      if (existsSync(out)) throw new CliFailure(EXIT_USAGE, `${out} exists; a source file is never overwritten — choose a per-work path`);
      if (options.commandId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.commandId)) {
        throw new CliFailure(EXIT_USAGE, "--command-id is a lowercase UUID");
      }
      const commandId = options.commandId ?? randomUUID();
      const base = {
        command_id: commandId,
        project_id: options.project,
        work_id: options.work,
        return_mode: returnMode,
        thread: options.channel && options.thread ? { channel_id: options.channel, thread_ts: options.thread } : null,
      };
      let body: Record<string, unknown>;
      if (options.operator && !options.actor && options.commandId !== undefined) {
        // No evidence, only a command id: the operator recovers a bind this edge committed (a
        // seat's, after its turn ended) from the evidence the edge retained when it was sent.
        assertOperatorContext();
        body = { ...base, mode: "recover", operator_token: env.HIVE_ADMIN_TOKEN };
      } else if (options.operator) {
        assertOperatorContext();
        if (!options.actor) throw new CliFailure(EXIT_USAGE, "--operator needs --actor (or --command-id alone to recover a committed bind)");
        body = { ...base, mode: "operator", actor: options.actor, session_id: options.session ?? null, cwd: resolve(options.cwd), operator_token: env.HIVE_ADMIN_TOKEN };
      } else if (options.sessionFile || options.actor || options.session) {
        let actor = options.actor;
        let session = options.session;
        let provider = options.provider;
        if (options.sessionFile) {
          const announced = readJsonFile(options.sessionFile) as { actor?: unknown; session_id?: unknown; provider?: unknown };
          actor = typeof announced.actor === "string" ? announced.actor : actor;
          session = typeof announced.session_id === "string" ? announced.session_id : session;
          provider = typeof announced.provider === "string" ? announced.provider : provider;
        }
        if (!actor || !session) throw new CliFailure(EXIT_USAGE, "a live binding needs the exact --actor and --session (or --session-file) the surface announced");
        body = { ...base, mode: "live", actor, session_id: session, provider: provider ?? null };
      } else if (env.HIVE_DELIVERY_TOKEN) {
        body = { ...base, mode: "dispatch", token: env.HIVE_DELIVERY_TOKEN };
      } else {
        throw new CliFailure(EXIT_AUTH,
          "no source can be resolved: this is neither a running headless turn (HIVE_DELIVERY_TOKEN), nor a live session named by "
          + "--actor/--session or --session-file. Identity is never guessed — ask the operator to run `hive attention bind --operator …` on this edge.");
      }
      let answer: HttpAnswer;
      try {
        answer = await transport.edge("/attention/bind", body);
      } catch (error) {
        if (!(error instanceof AttentionTransportError)) throw error;
        throw new CliFailure(EXIT_UNKNOWN_OUTCOME,
          `bind ${commandId} has an unknown outcome (${error.message}); rerun the same bind with --command-id ${commandId} — `
          + "a committed bind is recovered with the same source, even after its turn ended; without this turn's token, "
          + `the operator recovers it with \`hive attention bind --operator --command-id ${commandId}\``,
          { error: "outcome_unknown", command_id: commandId });
      }
      const code = exitCodeFor(answer.status);
      if (code !== 0) settle(answer, options, () => "");
      const result = answer.body as { receipt: Receipt; source_file: SourceFile };
      try {
        writeOwnerOnly(out, `${JSON.stringify(result.source_file, null, 2)}\n`);
      } catch (error) {
        // The source is committed; only this handle is lost. The command id is the way back.
        throw new CliFailure(EXIT_UNKNOWN_OUTCOME,
          `bind ${commandId} committed source ${result.receipt.source?.source_id ?? "?"} but writing ${out} failed `
          + `(${error instanceof Error ? error.message : String(error)}); rerun the same bind with --command-id ${commandId} `
          + "and a new --out to recover a fresh handle for the same source",
          { error: "source_file_write_failed", command_id: commandId, source_id: result.receipt.source?.source_id ?? null });
      }
      const source = result.receipt.source!;
      io.out(options.json
        ? JSON.stringify({ receipt: result.receipt, source_file: out })
        : `bound ${source.source_id}: ${source.actor} · ${source.project_id}/${source.work_id} · ${source.return_mode} (${source.provenance}); source file ${out}`);
    }));

  const source = attention.command("source").description("attention sources (operator)");
  source.command("show")
    .argument("<source-id>")
    .option("--json", "one JSON object")
    .action(async (sourceId: string, options: JsonOption) => run(async () => {
      const answer = await read("source", { source_id: sourceId }, `/v1/attention/sources/${sourceId}`);
      settle(answer, options, (body) => describeSource(body as SourceView));
    })(options));
  source.command("list")
    .option("--json", "one JSON object")
    .action(run(async (options) => {
      assertOperatorContext();
      const answer = await transport.operator("GET", "/v1/attention/sources").catch((error: unknown) => {
        throw new CliFailure(EXIT_UNKNOWN_OUTCOME, `read failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      settle(answer, options, (body) => (body as SourceView[]).map(describeSource).join("\n") || "(no sources)");
    }));
  source.command("revoke")
    .argument("<source-id>")
    .requiredOption("--reason <text>", "why")
    .option("--json", "one JSON object")
    .description("stop new writes from a source; queued work and its provenance are kept")
    .action(async (sourceId: string, options: JsonOption & { reason: string }) => run(async () => {
      await operatorCommand("source_revoke", { source_id: sourceId, reason: options.reason }, options);
    })(options));

  attention.command("doctor")
    .option("--source-file <path>", "also validate this source binding")
    .option("--json", "one JSON object")
    .description("broker, schema, edge and source binding health — never prints secrets")
    .action(run(async (options: JsonOption & { sourceFile?: string }) => {
      const report: Record<string, unknown> = { cli_schema_version: ATTENTION_SCHEMA_VERSION, checked_at: io.now().toISOString() };
      let healthy = true;
      try {
        const answer = await read("capabilities", {}, "/v1/attention/capabilities");
        if (answer.status === 200) {
          const caps = answer.body as Capabilities;
          report.broker = { reachable: true, broker_uuid: caps.broker_uuid, enabled: caps.enabled, schema_version: caps.schema_version, store_schema_version: caps.store_schema_version, return_modes: caps.return_modes, disabled_note: caps.disabled_note };
          report.cli_compatible = caps.schema_version === ATTENTION_SCHEMA_VERSION;
          healthy &&= caps.schema_version === ATTENTION_SCHEMA_VERSION;
        } else {
          healthy = false;
          report.broker = { reachable: true, supported: answer.status !== 404, status: answer.status, error: answer.body };
        }
      } catch (error) {
        healthy = false;
        report.broker = { reachable: false, detail: error instanceof Error ? error.message : String(error) };
      }
      // Health is the prerequisites — broker, contract, edge, source. A broker that is reachable
      // but intentionally disabled is still healthy (`broker.enabled` says which), so the same
      // check gates a staged, pre-enable deployment.
      const edgeReachable = await transport.edgeHealth();
      healthy &&= edgeReachable;
      report.edge = { socket: resolveEdgeSocketPath(env), reachable: edgeReachable };
      if (options.sourceFile) {
        try {
          const loaded = loadSourceFile(options.sourceFile);
          // The handle itself is checked against this edge's table, not just the broker's
          // source: a reset edge database or a corrupted file cannot pass as usable.
          const answer = await transport.edge("/attention/read", { op: "source_handle", handle: loaded.file.handle });
          const view = answer.status === 200 && (answer.body as SourceView).source_id === loaded.file.source_id ? answer.body as SourceView : null;
          const brokerUuid = (report.broker as { broker_uuid?: string }).broker_uuid;
          const valid = view !== null && view.revoked_at === null && (brokerUuid === undefined || brokerUuid === loaded.file.broker_uuid);
          healthy &&= valid;
          report.source = {
            source_id: loaded.file.source_id, actor: loaded.file.actor, return_mode: loaded.file.return_mode,
            broker_matches: brokerUuid === undefined ? null : brokerUuid === loaded.file.broker_uuid,
            revoked: view === null ? null : view.revoked_at !== null, valid,
            ...(view === null ? { error: answer.body } : {}),
          };
        } catch (error) {
          healthy = false;
          report.source = { valid: false, detail: error instanceof Error ? error.message : String(error) };
        }
      }
      report.healthy = healthy;
      io.out(options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
      if (!healthy) io.exit(7);
    }));
}

function describeSource(view: SourceView): string {
  return inert(`${view.source_id} · ${view.actor} (${view.provider}) on ${view.edge_id} · ${view.project_id}/${view.work_id} · `
    + `${view.return_mode}${view.session_id ? ` session ${view.session_id}` : ` (${view.session_absence ?? "no session"})`} · `
    + `${view.provenance}${view.revoked_at ? ` · revoked ${view.revoked_at}: ${view.revoked_reason ?? ""}` : ""}`, false);
}
