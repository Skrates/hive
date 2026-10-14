/**
 * Shared test fixtures for the attention suites: a file-backed broker database (never
 * `:memory:` — restart and multi-connection behaviour are part of what is under test), a
 * manual clock, enrolled seats and packet builders.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerStore } from "../broker/store.js";
import type { SubscriptionInput } from "../domain.js";
import type { Clock } from "../time.js";
import type { AttentionCommand, InterventionPacket, Receipt, ReturnMode } from "./contract.js";
import { AttentionStore, type AttentionPrincipal, type CommandOutcome } from "./store.js";

export const T0 = new Date("2026-10-12T09:00:00.000Z");
export const THREAD = { channel_id: "C0HIVE0001", thread_ts: "1760259600.000100" };

export class ManualClock implements Clock {
  constructor(public current: Date = T0) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

export function scratchDb(): string {
  return join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "hive-attention-")), "broker.sqlite");
}

export function seat(actor: string, overrides: Partial<SubscriptionInput> = {}): SubscriptionInput {
  return {
    actor,
    provider: "claude",
    providerSurface: "claude-code",
    providerVersion: "test",
    sessionId: null,
    homeEdge: "edge-a",
    workspace: "/work",
    edgeWorkspaces: [{ edgeId: "edge-a", cwd: "/work", worktree: null }],
    wakePolicy: "spawn",
    permissionProfile: "workspace-write",
    accountProfile: `/profiles/${actor}`,
    leaseTtlMs: 30_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 30_000,
    spawnRateLimit: 5,
    maxAttempts: 5,
    turnSlots: 1,
    expiresAt: null,
    ...overrides,
  };
}

export interface Harness {
  path: string;
  clock: ManualClock;
  broker: BrokerStore;
  store: AttentionStore;
  reopen(): Harness;
  close(): void;
}

export function harness(options: { path?: string; clock?: ManualClock; enabled?: boolean; seats?: SubscriptionInput[] } = {}): Harness {
  const path = options.path ?? scratchDb();
  const clock = options.clock ?? new ManualClock();
  const broker = new BrokerStore(path, clock);
  if (!options.path) {
    broker.createEdge("edge-a");
    broker.createEdge("edge-b");
    for (const subscription of options.seats ?? [seat("fable"), seat("ariadne", { provider: "codex" })]) broker.upsertSubscription(subscription);
  }
  const store = new AttentionStore({ broker, clock, humanId: "hakon", enabled: options.enabled ?? true });
  return {
    path,
    clock,
    broker,
    store,
    reopen() {
      broker.close();
      return harness({ path, clock, enabled: options.enabled ?? true });
    },
    close() { broker.close(); },
  };
}

export function packet(overrides: Partial<InterventionPacket> = {}): InterventionPacket {
  return {
    human_id: "hakon",
    project_id: "birthday-film",
    work_id: "parents-likeness-round-2",
    intervention_key: "candidate-selection",
    kind: "selection",
    title: "Choose the next birthday-film render",
    requested_action: "Select candidate A, B, C or D for the next video batch.",
    context: "Round 2. Same lighting and composition; compare likeness and expression.",
    unblocks: "The next video-generation batch.",
    artifacts: [],
    estimate_minutes: 8,
    deadline_at: null,
    predecessor_item_id: null,
    ...overrides,
  };
}

export const OPERATOR: AttentionPrincipal = { kind: "operator" };

export function command(action: AttentionCommand["action"], payload: unknown, commandId: string = randomUUID()): AttentionCommand {
  return { schema_version: 1, command_id: commandId, action, payload } as AttentionCommand;
}

export function act(store: AttentionStore, principal: AttentionPrincipal, action: AttentionCommand["action"], payload: unknown, commandId?: string): Receipt {
  return outcome(store, principal, action, payload, commandId).receipt;
}

export function outcome(store: AttentionStore, principal: AttentionPrincipal, action: AttentionCommand["action"], payload: unknown, commandId?: string): CommandOutcome {
  return store.execute(principal, command(action, payload, commandId));
}

/** Enroll a source through the live-registration path (edge-verified), returning its principal. */
export function liveSource(
  store: AttentionStore,
  options: { actor?: string; provider?: "claude" | "codex"; edgeId?: string; project?: string; work?: string; returnMode?: ReturnMode; session?: string; cwd?: string | null } = {},
): Extract<AttentionPrincipal, { kind: "source" }> {
  const edgeId = options.edgeId ?? "edge-a";
  const returnMode = options.returnMode ?? "pinned_session";
  const receipt = store.bindSource({ edgeId, operator: false }, {
    schema_version: 1,
    command_id: randomUUID(),
    action: "source_bind",
    payload: {
      project_id: options.project ?? "birthday-film",
      work_id: options.work ?? "parents-likeness-round-2",
      return_mode: returnMode,
      thread: returnMode === "none" ? null : THREAD,
      evidence: {
        kind: "live_registration",
        actor: options.actor ?? "fable",
        provider: options.provider ?? "claude",
        session_id: options.session ?? "session-fable-1",
        cwd: options.cwd === undefined ? "/work/hive" : options.cwd,
        surface_version: "claude-hook",
      },
    },
  }).receipt;
  return { kind: "source", edgeId, sourceId: receipt.source!.source_id };
}

export function summon(store: AttentionStore, source: AttentionPrincipal, overrides: Partial<InterventionPacket> = {}, commandId?: string): Receipt {
  return act(store, source, "summon", packet(overrides), commandId);
}

export function next(store: AttentionStore, pick: number | null = null, commandId?: string): Receipt {
  return act(store, OPERATOR, "next", { human_id: "hakon", item_id: pick }, commandId);
}

export function resolve(store: AttentionStore, itemId: number, revision: number, selectNext = false, commandId?: string): Receipt {
  return act(store, OPERATOR, "resolve", {
    item_id: itemId, expected_revision: revision, outcome: "selected", response: "Use candidate C; retain the current lighting.", select_next: selectNext,
  }, commandId);
}
