import Database from "better-sqlite3";
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolveEdgeSocketPath } from "../edge/providers.js";
import { udsRequest, udsRequestJson } from "../local/uds.js";
import {
  validateAction,
  validatePolicy,
  type Action,
  type Priority,
  type Receipt,
  type ResolveFindingAction,
  type ReviewState,
} from "./contract.js";
import { parseReviewKey } from "./key.js";
import { readOwnerOnlyFile, SecretFileError } from "./secret-file.js";
import { resetReviewStore, verifyOperatorToken, REVIEW_STATE_TABLES, REVIEW_STORE_GENERATION } from "./store.js";
import { ulid } from "./ulid.js";

/**
 * `hive review …` (design §9.1). Every write mints a client ULID as its `act_id`
 * (§5.B2) and carries `--expect` as `expected_revision` (§5.B1); a refusal exits
 * non-zero naming the code, the detail and the current revision. Custody is
 * never named in a body: a seat presents the turn's dispatch token to its edge,
 * an operator presents the credential from `HIVE_OPERATOR_TOKEN_FILE` (§5.A2).
 */

export interface ReviewActBody {
  act_id: string;
  expected_revision: number;
  action: Action;
}

export interface ReviewActAnswer {
  status: 200 | 409;
  receipt: Receipt;
}

/** The two custodies a write can present; the edge or the broker turns each into a Principal. */
export type Custody =
  | { kind: "delivery"; token: string }
  | { kind: "operator"; token: string };

/** How the commands reach the edge socket and the broker; injectable so a test needs neither. */
export interface ReviewTransport {
  edgeRead(key: string): Promise<ReviewState>;
  edgeReconcile(key: string): Promise<unknown>;
  edgeAct(key: string, token: string, body: ReviewActBody): Promise<ReviewActAnswer>;
  operatorRead(key: string, token: string): Promise<ReviewState>;
  operatorAct(key: string, token: string, body: ReviewActBody): Promise<ReviewActAnswer>;
  adminPutPolicy(repositoryId: number, policy: unknown, adminToken: string): Promise<unknown>;
  adminCreateOperator(operatorId: string, adminToken: string): Promise<{ operator_id: string; token: string }>;
}

export class ReviewCliError extends Error {
  constructor(message: string, readonly receipt: Receipt | null = null) {
    super(message);
    this.name = "ReviewCliError";
  }
}

/**
 * §5.A2: which credential this invocation may act under.
 *
 * `--as-operator` is refused outright while `HIVE_DELIVERY_TOKEN` or
 * `HIVE_SESSION_TOKEN` is in the environment — the human credential does not
 * run inside an agent's execution environment — and the token file must be
 * owner-only. Session custody (`HIVE_SESSION_TOKEN` alone) is recognised only
 * to say it is not implemented yet (M2).
 */
export function resolveCustody(env: NodeJS.ProcessEnv, asOperator: boolean): Custody {
  const agentVariable = ["HIVE_DELIVERY_TOKEN", "HIVE_SESSION_TOKEN"].find((name) => env[name] !== undefined) ?? null;
  if (asOperator) {
    if (agentVariable !== null) {
      throw new ReviewCliError(
        `refusing --as-operator: ${agentVariable} is present, so this is an agent's execution environment; `
        + "the operator credential never runs inside one (§5.A2)",
      );
    }
    const file = env.HIVE_OPERATOR_TOKEN_FILE;
    if (!file) throw new ReviewCliError("--as-operator needs HIVE_OPERATOR_TOKEN_FILE naming an owner-only (0600) token file");
    let token: string;
    try {
      token = readOwnerOnlyFile(file);
    } catch (error) {
      if (error instanceof SecretFileError) throw new ReviewCliError(error.message);
      throw error;
    }
    return { kind: "operator", token };
  }
  if (env.HIVE_DELIVERY_TOKEN) return { kind: "delivery", token: env.HIVE_DELIVERY_TOKEN };
  if (env.HIVE_SESSION_TOKEN) {
    throw new ReviewCliError("session custody (HIVE_SESSION_TOKEN) is not implemented yet (M2); this session can read but not write");
  }
  throw new ReviewCliError(
    "no custody: a write presents HIVE_DELIVERY_TOKEN (exported by the edge for a running turn) "
    + "or --as-operator with HIVE_OPERATOR_TOKEN_FILE",
  );
}

interface WriteOptions {
  expect: string;
  asOperator?: boolean;
  json?: boolean;
}

interface Verb {
  key: string;
  options: WriteOptions;
  /** Reads the current state on demand (for `subject_key` when the caller gave none). */
  state(): Promise<ReviewState>;
}

export function registerReviewCommands(
  program: Command,
  transport: ReviewTransport = defaultReviewTransport(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const review = program.command("review").description("act on a pull-request review (design §9.1)");
  const out = (text: string): void => { process.stdout.write(`${text}\n`); };

  const readState = async (key: string, asOperator: boolean): Promise<ReviewState> => {
    assertKey(key);
    if (!asOperator) return transport.edgeRead(key);
    const custody = resolveCustody(env, true);
    return transport.operatorRead(key, custody.token);
  };

  /**
   * One write: custody, ULID act id, `--expect`, local shape check, send, render.
   * The shape is proven here too — a malformed act is refused before any
   * request leaves the machine, with the same `malformed` detail the broker
   * would give.
   */
  const write = async (
    key: string,
    options: WriteOptions,
    build: (verb: Verb) => Promise<Action> | Action,
    operatorOnly = false,
  ): Promise<void> => {
    assertKey(key);
    const asOperator = options.asOperator === true;
    if (operatorOnly && !asOperator) {
      throw new ReviewCliError("this is an operator act (§4); pass --as-operator with HIVE_OPERATOR_TOKEN_FILE");
    }
    const expectedRevision = Number(options.expect);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new ReviewCliError("--expect must be the revision you read, an integer ≥ 0 (§5.B1)");
    }
    const custody = resolveCustody(env, asOperator);
    let cached: ReviewState | null = null;
    const action = await build({
      key,
      options,
      state: async () => {
        cached ??= await readState(key, asOperator);
        return cached;
      },
    });
    const validated = validateAction(action);
    if (!validated.ok) throw new ReviewCliError(`refused before sending — ${validated.code}: ${validated.detail}`);
    const body: ReviewActBody = { act_id: ulid(), expected_revision: expectedRevision, action: validated.value };
    const answer = custody.kind === "operator"
      ? await transport.operatorAct(key, custody.token, body)
      : await transport.edgeAct(key, custody.token, body);
    renderReceipt(answer.receipt, options.json === true, out);
  };

  review.command("read")
    .argument("<key>", "owner/repo#n or <repository_id>:<pr_number>")
    .option("--json", "print the ReviewState as JSON")
    .option("--as-operator", "read through the broker with the operator credential instead of the edge socket")
    .description("the current ReviewState: requirement, pending requests, findings, holds, readiness")
    .action(async (key: string, options: { json?: boolean; asOperator?: boolean }) => {
      const state = await readState(key, options.asOperator === true);
      out(options.json ? JSON.stringify(state, null, 2) : renderState(state));
    });

  review.command("reconcile")
    .argument("<key>", "owner/repo#n or <repository_id>:<pr_number>")
    .description("wake the GitHub reconciler for this review (adapter act, any seat)")
    .action(async (key: string) => {
      assertKey(key);
      await transport.edgeReconcile(key);
      out(`reconcile accepted for ${key}`);
    });

  review.command("answer")
    .argument("<key>")
    .requiredOption("--request <id>", "the request this answers")
    .option("--report <file>", "reviewkit report JSON (the reviewkit arm)")
    .option("--testimony <file>", "testimony JSON (the retrospective arm)")
    .option("--subject <key>", "subject key <head_sha>:<base_ref> (default: the current subject)")
    .requiredOption("--expect <rev>", "the revision you read")
    .option("--as-operator")
    .option("--json")
    .description("answer a request with a report or testimony (§6.E1)")
    .action((key: string, options: WriteOptions & { request: string; report?: string; testimony?: string; subject?: string }) =>
      write(key, options, async (verb) => {
        if ((options.report === undefined) === (options.testimony === undefined)) {
          throw new ReviewCliError("answer takes exactly one of --report <file> or --testimony <file>");
        }
        const submission = options.report !== undefined
          ? { arm: "reviewkit", report: readJsonFile(options.report) }
          : { arm: "testimony", testimony: readJsonFile(options.testimony!) };
        return {
          kind: "Answer",
          request_id: options.request,
          subject_key: options.subject ?? (await verb.state()).subject.key,
          submission,
        } as Action;
      }));

  review.command("resolve")
    .argument("<key>")
    .argument("<finding-id>")
    .argument("<kind>", "fixed | refuted | withdrawn | product-gate | follow-up | same-as")
    .requiredOption("--evidence <text>")
    .option("--commit <sha>", "a commit carrying the fix (repeatable; fixed needs at least one)", collect, [] as string[])
    .option("--ticket <id>", "the follow-up ticket (follow-up)")
    .option("--other <finding-id>", "the finding this is the same as (same-as)")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("resolve a finding by a named resolution (§6.F3)")
    .action((key: string, findingId: string, kind: string, options: WriteOptions & { evidence: string; commit: string[]; ticket?: string; other?: string }) =>
      write(key, options, () => ({
        kind: "ResolveFinding",
        finding_id: findingId,
        resolution: resolutionRequest(kind, options),
      })));

  review.command("classify")
    .argument("<key>")
    .argument("<finding-id>")
    .argument("<priority>", "P0 | P1 | P2 | P3")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("assign a known priority to a finding (§6.F5)")
    .action((key: string, findingId: string, priority: string, options: WriteOptions) =>
      write(key, options, () => ({ kind: "ClassifyFinding", finding_id: findingId, priority: priority as Priority })));

  review.command("request")
    .argument("<key>")
    .requiredOption("--assignee <actor>")
    .option("--mode <mode>", "initial | closure | appeal (review requests)")
    .requiredOption("--names <ids>", "comma-separated finding ids the request names")
    .requiredOption("--reason <text>")
    .option("--kind <kind>", "review | retrospective", "review")
    .option("--optional", "the request is not required for readiness")
    .option("--subject <key>", "subject key <head_sha>:<base_ref> (default: the current subject)")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("open a review or retrospective request (§6.D1)")
    .action((key: string, options: WriteOptions & { assignee: string; mode?: string; names: string; reason: string; kind: string; optional?: boolean; subject?: string }) =>
      write(key, options, async (verb) => ({
        kind: "OpenRequest",
        request_kind: options.kind,
        mode: options.mode ?? null,
        assignee: options.assignee,
        names: options.names.split(",").map((name) => name.trim()).filter((name) => name.length > 0),
        reason: options.reason,
        required: options.optional !== true,
        subject_key: options.subject ?? (await verb.state()).subject.key,
      } as Action)));

  review.command("hold")
    .argument("<key>")
    .requiredOption("--kind <kind>", "human-gate | stack | operator")
    .requiredOption("--reason <text>")
    .option("--release-on <rule>", "explicit | subject-change", "explicit")
    .option("--blocks-summons", "also block summons while held")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("place a hold on readiness (§6.G3)")
    .action((key: string, options: WriteOptions & { kind: string; reason: string; releaseOn: string; blocksSummons?: boolean }) =>
      write(key, options, () => ({
        kind: "Hold",
        hold: {
          kind: options.kind.replaceAll("-", "_"),
          reason: options.reason,
          release_on: options.releaseOn.replaceAll("-", "_"),
          blocks: { readiness: true, summons: options.blocksSummons === true },
        },
      } as Action)));

  review.command("release")
    .argument("<key>")
    .argument("<hold-id>")
    .requiredOption("--reason <text>")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("release a hold")
    .action((key: string, holdId: string, options: WriteOptions & { reason: string }) =>
      write(key, options, () => ({ kind: "Release", hold_id: holdId, reason: options.reason })));

  review.command("retract")
    .argument("<key>")
    .argument("<answer-id>")
    .requiredOption("--reason <text>")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("retract an answer; the request re-opens, the charge stays (§6.E6)")
    .action((key: string, answerId: string, options: WriteOptions & { reason: string }) =>
      write(key, options, () => ({ kind: "RetractAnswer", answer_id: answerId, reason: options.reason })));

  // Operator credential only (§4, §5.A2): never inside an agent environment.
  review.command("grant-rounds")
    .argument("<key>")
    .argument("<k>", "rounds to add")
    .requiredOption("--reason <text>")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("[operator] add rounds to the budget; closes an open exhaustion episode (§6.G1)")
    .action((key: string, k: string, options: WriteOptions & { reason: string }) =>
      write(key, options, () => ({ kind: "GrantRounds", n: Number(k), reason: options.reason }), true));

  review.command("rule")
    .argument("<key>")
    .argument("<finding-id>")
    .requiredOption("--resolution <text>", "the owner's decision")
    .requiredOption("--evidence <text>")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("[operator] resolve a finding by owner decision (§6.F3)")
    .action((key: string, findingId: string, options: WriteOptions & { resolution: string; evidence: string }) =>
      write(key, options, () => ({
        kind: "ResolveFinding",
        finding_id: findingId,
        resolution: { kind: "owner_decision", resolution_text: options.resolution, evidence: options.evidence },
      }), true));

  review.command("availability")
    .argument("<key>")
    .argument("<reviewer>")
    .option("--available")
    .option("--unavailable")
    .option("--reason <reason>", "quota | connector | meter")
    .option("--until <iso>", "when the condition clears (ISO-8601 UTC)")
    .requiredOption("--evidence <text>")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("[operator] record a reviewer's availability (§6.D3)")
    .action((key: string, reviewer: string, options: WriteOptions & { available?: boolean; unavailable?: boolean; reason?: string; until?: string; evidence: string }) =>
      write(key, options, () => {
        if ((options.available === true) === (options.unavailable === true)) {
          throw new ReviewCliError("availability takes exactly one of --available or --unavailable");
        }
        return {
          kind: "SetReviewerAvailability",
          reviewer,
          available: options.available === true,
          reason: options.reason ?? null,
          until: options.until ?? null,
          evidence: options.evidence,
        } as Action;
      }, true));

  review.command("adopt-policy")
    .argument("<key>")
    .argument("<version>")
    .requiredOption("--expect <rev>")
    .option("--as-operator")
    .option("--json")
    .description("[operator] adopt a newer policy version for this review (§6.I)")
    .action((key: string, version: string, options: WriteOptions) =>
      write(key, options, () => ({ kind: "AdoptPolicy", version: Number(version) }), true));

  /**
   * §9.3: the operator's answer to a `LegacyReviewStoreError`. Unlike every other verb this one
   * opens the database file directly instead of going through the edge or the broker — the
   * broker whose HTTP surface would carry the request is precisely the process that refused to
   * boot, so there is nothing to send to. Custody is not weakened by that: `--as-operator` is
   * required, the token comes from the owner-only `HIVE_OPERATOR_TOKEN_FILE` and never from an
   * agent's environment (§5.A2), and it is verified against an `operators` row *in the database
   * being reset* — the one table, with `review_policies`, the reset leaves standing.
   */
  review.command("reset-store")
    .argument("<db-path>", "the broker database whose review tables to drop")
    .requiredOption("--confirm <db-path>", "repeat <db-path> exactly; every review is dropped and cannot be recovered")
    .option("--as-operator", "required: this is an operator act")
    .description("[operator] drop every review table and stamp the current store generation (§9.3)")
    .action((dbPath: string, options: { confirm: string; asOperator?: boolean }) => {
      if (options.asOperator !== true) {
        throw new ReviewCliError("this is an operator act (§4); pass --as-operator with HIVE_OPERATOR_TOKEN_FILE");
      }
      if (options.confirm !== dbPath) {
        throw new ReviewCliError(
          `refusing reset-store: --confirm names ${options.confirm}, the store to reset is ${dbPath}; `
          + "repeat the path exactly — nothing was touched",
        );
      }
      const custody = resolveCustody(env, true);
      let db: Database.Database;
      try {
        db = new Database(dbPath, { fileMustExist: true });
      } catch (error) {
        throw new ReviewCliError(`refusing reset-store: cannot open ${dbPath} (${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        if (verifyOperatorToken(db, custody.token) === null) {
          throw new ReviewCliError(`refusing reset-store: the operator token is not a live credential in ${dbPath}; nothing was touched`);
        }
        resetReviewStore(db);
      } finally {
        db.close();
      }
      out(
        `review tables dropped in ${dbPath} and stamped generation ${REVIEW_STORE_GENERATION}: `
        + `${REVIEW_STATE_TABLES.join(", ")}. review_policies and operators are untouched. `
        + "Revision history and projection handles are gone; start the broker and run "
        + "`hive review reconcile <owner/repo>#<n>` for every enrolled PR (or wait for the sweep) — "
        + "reconcile rebuilds each Review from GitHub and re-creates the board comment and check runs, "
        + "so any board comment already on a PR is now an orphan.",
      );
    });

  // Admin (HIVE_ADMIN_TOKEN): policy rows and operator credentials.
  review.command("put-review-policy")
    .argument("<repository-id>")
    .argument("<file>", "Policy JSON; version must be latest+1")
    .description("[admin] store a policy version for a repository (§9.2)")
    .action(async (repositoryId: string, file: string) => {
      const id = Number(repositoryId);
      if (!Number.isInteger(id) || id < 1) throw new ReviewCliError("repository-id must be a positive integer");
      const validated = validatePolicy(readJsonFile(file));
      if (!validated.ok) throw new ReviewCliError(`refused before sending — ${validated.code}: ${validated.detail}`);
      out(JSON.stringify(await transport.adminPutPolicy(id, validated.value, requiredEnv(env, "HIVE_ADMIN_TOKEN"))));
    });

  review.command("create-operator")
    .argument("<operator-id>")
    .description("[admin] mint an operator credential; the token is printed once and never stored raw")
    .action(async (operatorId: string) => {
      const created = await transport.adminCreateOperator(operatorId, requiredEnv(env, "HIVE_ADMIN_TOKEN"));
      out(`operator ${created.operator_id} created; write this token to an owner-only file named by HIVE_OPERATOR_TOKEN_FILE:\n${created.token}`);
    });
}

/** §9.1 `resolve` kinds → the contract's `ResolutionRequest` variants. */
function resolutionRequest(
  kind: string,
  options: { evidence: string; commit: string[]; ticket?: string; other?: string },
): ResolveFindingAction["resolution"] {
  const evidence = options.evidence;
  switch (kind) {
    case "fixed": {
      const [first, ...rest] = options.commit;
      if (first === undefined) throw new ReviewCliError("fixed needs at least one --commit <sha>");
      return { kind: "fixed", evidence, commits: [first, ...rest] };
    }
    case "refuted": return { kind: "refuted", evidence };
    case "withdrawn": return { kind: "withdrawn", evidence };
    case "product-gate": return { kind: "product_gate", evidence };
    case "follow-up":
      if (options.ticket === undefined) throw new ReviewCliError("follow-up needs --ticket <id>");
      return { kind: "follow_up", evidence, ticket: options.ticket };
    case "same-as":
      if (options.other === undefined) throw new ReviewCliError("same-as needs --other <finding-id>");
      return { kind: "same_as", evidence, other: options.other };
    default:
      throw new ReviewCliError(`unknown resolution kind ${kind}; use fixed | refuted | withdrawn | product-gate | follow-up | same-as (owner decisions are \`hive review rule\`)`);
  }
}

/** Applied and replayed print; a refusal exits non-zero with code, detail and the current revision. */
export function renderReceipt(receipt: Receipt, asJson: boolean, out: (text: string) => void): void {
  if (asJson) out(JSON.stringify(receipt, null, 2));
  const outcome = receipt.outcome;
  if ("refused" in outcome) {
    throw new ReviewCliError(
      `refused ${outcome.code}: ${outcome.detail} (current revision ${outcome.current_revision}; act ${receipt.act_id})`,
      receipt,
    );
  }
  if (asJson) return;
  if ("replayed" in outcome) {
    out(`already applied as ${outcome.batch_id} at revision ${outcome.revision_at_apply} (act ${receipt.act_id})`);
    return;
  }
  out(`applied ${receipt.act_id}: revision ${outcome.revision_before} → ${outcome.revision_after} `
    + `(${outcome.batch_id}, ${outcome.effects.length} effect${outcome.effects.length === 1 ? "" : "s"})`);
}

/** A glanceable §3.6 summary: what is owed, by whom, and what blocks readiness. */
export function renderState(state: ReviewState): string {
  const lines: string[] = [
    `${state.display} (${state.key.repository_id}:${state.key.pr_number}) revision ${state.revision} `
      + `— ${state.lifecycle}${state.draft ? ", draft" : ""}, policy v${state.policy_version}`,
    `subject ${state.subject.key}`,
    `requirement ${state.requirement.status}`
      + (state.requirement.status === "unsatisfied" ? ` (pending ${state.requirement.pending.join(", ") || "none"})` : "")
      + (state.requirement.status === "satisfied" ? ` (by ${state.requirement.by.join(", ")})` : ""),
    `rounds ${state.rounds_consumed} consumed, ${state.rounds_remaining} remaining of ${state.budget.rounds_max + state.budget.granted}`,
  ];
  const pending = state.requests.filter((request) => request.status === "pending");
  if (pending.length > 0) {
    lines.push("pending requests:");
    for (const request of pending) {
      lines.push(`  ${request.id} ${request.kind}${request.mode ? `/${request.mode}` : ""} → ${request.assignee}`
        + `${request.required ? " (required)" : ""} at ${request.subject_key}`
        + (request.names.length > 0 ? ` names ${request.names.join(", ")}` : ""));
    }
  }
  if (state.blocking_findings.length > 0) {
    lines.push("blocking findings:");
    for (const finding of state.blocking_findings) {
      lines.push(`  ${finding.id} [${finding.priority}] ${finding.title} — ${finding.path}${finding.line === null ? "" : `:${finding.line}`} (raised by ${finding.raised_by})`);
    }
  }
  if (state.active_holds.length > 0) {
    lines.push("holds:");
    for (const hold of state.active_holds) lines.push(`  ${hold.id} ${hold.kind}: ${hold.reason} (release on ${hold.release_on})`);
  }
  const readiness = state.readiness;
  lines.push(readiness.ready
    ? `ready at ${readiness.subject_key}`
    : `not ready: ${readiness.reasons.map((reason) => typeof reason === "string" ? reason : JSON.stringify(reason)).join("; ")}`);
  return lines.join("\n");
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function assertKey(key: string): void {
  if (parseReviewKey(key) === null) throw new ReviewCliError(`not a review key: ${key} (owner/repo#n or <repository_id>:<pr_number>)`);
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ReviewCliError(`${name} is required`);
  return value;
}

/** The real edge socket and broker HTTP; environment read per call, never at registration. */
export function defaultReviewTransport(env: NodeJS.ProcessEnv = process.env): ReviewTransport {
  const socket = (): string => resolveEdgeSocketPath(env);
  const brokerUrl = (): string => requiredEnv(env, "HIVE_BROKER_URL");
  const relayAct = (status: number, body: string): ReviewActAnswer => {
    if (status === 200 || status === 409) return { status, receipt: JSON.parse(body) as Receipt };
    throw new ReviewCliError(`review act failed: ${refusalDetail(status, body)}`);
  };
  const fetchJson = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await fetch(`${brokerUrl()}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new ReviewCliError(`broker refused: ${refusalDetail(response.status, text)}`);
    return JSON.parse(text) as T;
  };
  return {
    edgeRead: (key) => udsRequestJson<ReviewState>(socket(), "POST", "/review/read", { key }),
    edgeReconcile: (key) => udsRequestJson(socket(), "POST", "/review/reconcile", { key }),
    async edgeAct(key, token, body) {
      const response = await udsRequest(socket(), "POST", "/review/act", { key, token, ...body });
      return relayAct(response.status, response.body);
    },
    operatorRead: (key, token) => fetchJson<ReviewState>(`/v1/review/${encodeURIComponent(key)}`, {
      headers: { authorization: `Operator ${token}` },
    }),
    async operatorAct(key, token, body) {
      const response = await fetch(`${brokerUrl()}/v1/review/${encodeURIComponent(key)}/acts`, {
        method: "POST",
        headers: { authorization: `Operator ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return relayAct(response.status, await response.text());
    },
    adminPutPolicy: (repositoryId, policy, adminToken) => fetchJson(`/v1/admin/review-policies/${repositoryId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(policy),
    }),
    adminCreateOperator: (operatorId, adminToken) => fetchJson("/v1/admin/operators", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ operator_id: operatorId }),
    }),
  };
}

/** The broker's `{error, detail}` envelope when that is what came back; the raw body otherwise. */
function refusalDetail(status: number, body: string): string {
  try {
    const value = JSON.parse(body) as { error?: unknown; detail?: unknown };
    if (typeof value.error === "string") {
      return typeof value.detail === "string" ? `${value.error} — ${value.detail}` : value.error;
    }
  } catch {
    // fall through to the raw body below
  }
  return `HTTP ${status}: ${body.slice(0, 500)}`;
}
