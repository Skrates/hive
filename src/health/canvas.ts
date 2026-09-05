import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { z } from "zod";
import { treeDigest, type ProfileObservation } from "./profile-probe.js";
import { ProfileReport } from "./report.js";

const Command = z.array(z.string()).min(1);
export const CanvasConfig = z.object({
  doctrineRoot: z.string(), brokerDb: z.string(), canvasId: z.string().optional(),
  usageUrl: z.url(),
  probes: z.array(z.object({ actor: z.string(), edgeId: z.string(), command: Command })).default([]),
  // Only explicit operator mappings join a collector to a seat when its local config is absent.
  usageBindings: z.array(z.object({ actor: z.string(), edgeId: z.string(), profileId: z.string() })).default([]),
  accountChanges: z.array(z.object({ actors: z.array(z.string()).min(1), label: z.string(), note: z.string(), previousPoolIds: z.array(z.string()).optional() })).default([]),
});
export type CanvasConfig = z.infer<typeof CanvasConfig>;
const Text = z.string().max(512);
const Timestamp = z.iso.datetime();
// Project only display fields. Raw provider payloads and future credential fields are discarded.
const Pool = z.object({ id: Text, provider: Text, label: Text, identity_state: Text, status: Text,
  sampled_at: Timestamp, received_at: Timestamp,
  windows: z.array(z.object({ label: Text, utilization: z.number().min(0).max(1), resets_at: Timestamp.nullable() })).max(100),
  profiles: z.array(z.object({ id: Text, binding_confidence: Text })).max(1000),
});
const DoctorProfile = z.object({ profile_id: Text, edge_id: Text.nullable(), provider: Text.nullable(), configured: z.boolean(),
  last_received_at: Timestamp.nullable(), last_sampled_at: Timestamp.nullable(), last_outcome: Text.nullable(),
  pool_id: Text.nullable(), last_conflict: z.object({ kind: Text, at: Timestamp }).nullable(),
});
export type Pool = z.infer<typeof Pool>;
export type DoctorProfile = z.infer<typeof DoctorProfile>;
export type HealthObservation = ProfileObservation & { edgeId: string };
export interface Seat {
  actor: string; provider: string; machine: string; profile: string;
  intendedSkills: Record<string, string> | null; intendedPlugins: string[];
  subscription: { edge: string; lastSeen: string | null; expiresAt: string | null; sessionId: string | null } | null;
  delivery: { id: number; status: string; at: string; sessionId: string | null } | null;
}
export interface CanvasSnapshot {
  generatedAt: string; doctrineCommit: string; seats: Seat[]; pools: Pool[];
  doctor: DoctorProfile[]; probes: HealthObservation[]; failedProbes: string[];
  usageState: string; brokerState: string;
  bindings: CanvasConfig["usageBindings"];
  accountChanges: CanvasConfig["accountChanges"];
}

async function commandJson(command: string[]): Promise<any> {
  const [file, ...args] = command;
  if (!file) throw new Error("missing command");
  const { stdout } = await promisify(execFile)(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function collectCanvas(config: CanvasConfig): Promise<CanvasSnapshot> {
  const commit = execFileSync("git", ["-C", config.doctrineRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Intended versions are a clean, pinned source snapshot, never dirty files called a revision.
  const dirty = execFileSync("git", ["-C", config.doctrineRoot, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
  if (dirty) throw new Error("doctrine source must be a clean checkout");
  const registry = JSON.parse(readFileSync(join(config.doctrineRoot, "seats/registry.json"), "utf8"));
  const template = JSON.parse(readFileSync(join(config.doctrineRoot, "templates/claude/settings.json"), "utf8"));
  const allSkills = readdirSync(join(config.doctrineRoot, "skills")).filter(n => existsSync(join(config.doctrineRoot, "skills", n, "SKILL.md")));
  const seats: Seat[] = Object.entries(registry).map(([actor, raw]) => {
    const seat = raw as any;
    const intended = seat.skills_dir === null ? null : Object.fromEntries((seat.skills ?? allSkills).map((name: string) =>
      [name, treeDigest(join(config.doctrineRoot, "skills", name))]));
    const plugins = seat.provider === "claude" ? { ...template.enabledPlugins, ...seat.settings_overrides?.enabledPlugins } : {};
    return { actor, provider: seat.provider, machine: seat.machine, profile: seat.profile_dir,
      intendedSkills: intended, intendedPlugins: Object.keys(plugins).filter(n => plugins[n] === true), subscription: null, delivery: null };
  });
  let brokerState = "observed";
  const persisted: HealthObservation[] = [];
  try {
    const db = new Database(config.brokerDb, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`SELECT s.actor,s.provider,s.account_profile,s.home_edge,s.session_id,s.expires_at,e.last_seen_at
        FROM subscriptions s LEFT JOIN edges e ON e.edge_id=s.home_edge`).all() as any[];
      for (const row of rows) {
        let seat = seats.find(s => s.actor === row.actor);
        if (!seat) {
          seat = { actor: row.actor, provider: row.provider, machine: row.home_edge, profile: row.account_profile,
            intendedSkills: null, intendedPlugins: [], subscription: null, delivery: null };
          seats.push(seat);
        }
        seat.profile = row.account_profile;
        seat.subscription = { edge: row.home_edge, lastSeen: row.last_seen_at, expiresAt: row.expires_at, sessionId: row.session_id };
        const d = db.prepare("SELECT delivery_id,status,updated_at FROM deliveries WHERE actor=? ORDER BY delivery_id DESC LIMIT 1").get(row.actor) as any;
        if (d) seat.delivery = { id: d.delivery_id, status: d.status, at: d.updated_at, sessionId: null };
      }
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profile_health'").get()) {
        const reports = db.prepare(`SELECT h.edge_id,h.report_json FROM profile_health h JOIN subscriptions s ON s.actor=h.actor AND s.home_edge=h.edge_id`).all() as Array<{ edge_id: string; report_json: string }>;
        for (const row of reports) {
          const parsed = ProfileReport.safeParse(JSON.parse(row.report_json));
          if (parsed.success) persisted.push({ ...parsed.data, edgeId: row.edge_id });
        }
      }
    } finally { db.close(); }
  } catch { brokerState = "unreachable_or_unreadable"; }
  const snapshot: CanvasSnapshot = { generatedAt: new Date().toISOString(), doctrineCommit: commit, seats, pools: [], doctor: [],
    probes: persisted, failedProbes: [], usageState: "unavailable", brokerState, bindings: config.usageBindings, accountChanges: config.accountChanges };
  await Promise.all([
    (async () => {
      try {
        const token = process.env.HIVE_USAGE_READ_TOKEN;
        if (!token) throw new Error("usage read credential missing");
        const [doctor, usage] = await Promise.all(["/doctor", "/v3/usage"].map(async path => {
          const response = await fetch(new URL(path, config.usageUrl), { headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000), redirect: "error" });
          if (!response.ok) throw new Error("usage unavailable");
          return response.json();
        }));
        const data = {
          doctor: z.object({ schema: z.literal(3), ready: z.boolean(), profiles: z.array(DoctorProfile).max(1000) }).parse(doctor),
          usage: z.object({ schema: z.literal(3), pools: z.array(Pool).max(1000) }).parse(usage),
        };
        snapshot.pools = data.usage.pools; snapshot.doctor = data.doctor.profiles;
        snapshot.usageState = data.doctor.ready === true ? "ready" : "not_ready";
      } catch { /* Render an unavailable source, never retain old green rows with a new timestamp. */ }
    })(),
    ...config.probes.map(async probe => {
      try {
        const data = ProfileReport.parse(await commandJson(probe.command));
        if (data.actor !== probe.actor) throw new Error("probe actor mismatch");
        snapshot.probes = snapshot.probes.filter(p => p.actor !== probe.actor);
        snapshot.probes.push({ ...data, edgeId: probe.edgeId });
      } catch { snapshot.failedProbes.push(probe.actor); }
    }),
  ]);
  snapshot.generatedAt = new Date().toISOString();
  return snapshot;
}

export function age(value: string | null, now: string): string {
  if (!value) return "never observed";
  const minutes = (Date.parse(now) - Date.parse(value)) / 60_000;
  if (!Number.isFinite(minutes) || minutes < -5) return "invalid observation time";
  if (minutes < 60) return `${Math.max(0, Math.floor(minutes))}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
function stale(value: string | null, now: string): boolean {
  if (!value) return true;
  const elapsed = Date.parse(now) - Date.parse(value);
  return !Number.isFinite(elapsed) || elapsed < -300_000 || elapsed > 15 * 60_000;
}
function cell(value: unknown): string {
  return String(value ?? "unknown").replace(/[\r\n|]/g, " ").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}
function table(headers: string[], rows: unknown[][]): string {
  return [headers, headers.map(() => "---"), ...rows].map(row => `| ${row.map(cell).join(" | ")} |`).join("\n");
}
function stamp(value: string | null, now: string): string { return value ? `${value} (${age(value, now)})` : "never observed"; }

export function renderCanvas(s: CanvasSnapshot, refreshStatus = "Snapshot only. Unattended refresh has not been enabled."): string {
  const attention: string[] = [];
  const overview: unknown[][] = [];
  const details: string[] = [];
  const joined = new Set<string>();
  const retiredPools = new Set(s.accountChanges.flatMap(c => c.previousPoolIds ?? []));
  // Display policy only: retained source history is never deleted or rewritten.
  const currentReporters = s.doctor.filter(d => d.configured && !retiredPools.has(d.pool_id ?? ""));
  const currentIds = new Set(currentReporters.map(d => d.profile_id));
  const currentPools = s.pools.filter(p => !retiredPools.has(p.id) && p.profiles.some(d => currentIds.has(d.id)));
  if (s.usageState !== "ready") attention.push(`Usage aggregator: ${s.usageState}; profile and quota status unverified.`);
  if (s.brokerState !== "observed") attention.push(`Hive broker: ${s.brokerState}; subscriptions and deliveries unverified.`);
  for (const seat of s.seats) {
    const p = s.probes.find(p => p.actor === seat.actor && p.provider === seat.provider &&
      p.edgeId === seat.subscription?.edge && !seat.profile.startsWith("~/") && p.accountProfile === seat.profile);
    const binding = p?.usageProfileId && p.usageEdgeId ? { profileId: p.usageProfileId, edgeId: p.usageEdgeId }
      : s.bindings.find(b => b.actor === seat.actor);
    const d = binding ? currentReporters.find(d => d.profile_id === binding.profileId && d.edge_id === binding.edgeId && d.provider === seat.provider) : undefined;
    if (d) joined.add(d.profile_id);
    const pool = d ? currentPools.find(pool => pool.id === d.pool_id) : undefined;
    const probeFresh = p && !stale(p.observedAt, s.generatedAt);
    const auth = p ? `${stale(p.auth.observedAt, s.generatedAt) ? "stale / " : ""}${p.auth.state}` : "unverified";
    const missing = seat.intendedSkills && p ? Object.keys(seat.intendedSkills).filter(n => !(n in p.skills)) : [];
    const changed = seat.intendedSkills && p ? Object.keys(seat.intendedSkills).filter(n => n in p.skills && p.skills[n] !== seat.intendedSkills![n]) : [];
    const missingPlugins = p ? seat.intendedPlugins.filter(n => !p.plugins.some(i => i.name === n && i.installed !== null)) : [];
    const installation = !p ? "unverified" : `${probeFresh ? "" : "stale / "}${missing.length} missing; ${changed.length} differ from intended`;
    const ownAttention: string[] = [];
    const accountChange = s.accountChanges.find(change => change.actors.includes(seat.actor));
    if (accountChange?.note) ownAttention.push(`current account: ${accountChange.label} (operator confirmed); ${accountChange.note}`);
    const receiving = p?.receiving;
    const expired = seat.subscription?.expiresAt != null && Date.parse(seat.subscription.expiresAt) <= Date.parse(s.generatedAt);
    const receivingState = receiving && receiving.expiresAt > Date.parse(s.generatedAt) ? `receiving session ${receiving.sessionId ?? "unnamed"}`
      : receiving ? "receiving heartbeat expired" : p?.receiving === null ? "no registered receiving session at observation" : "receiving session unverified";
    if (!p) ownAttention.push(s.failedProbes.includes(seat.actor) ? "maintenance probe unreachable or failed (not an auth verdict)" : "maintenance never observed");
    else {
      if (!probeFresh) ownAttention.push("maintenance observation stale");
      if (p.auth.state !== "local_login_present") ownAttention.push(`provider auth: ${auth}`);
      if (p.inventory.state !== "observed") ownAttention.push(p.inventory.state);
      const mcp = p.mcp.filter(c => c.state !== "connected" && c.state !== "tools_available");
      if (mcp.length) ownAttention.push(`MCP: ${mcp.map(c => `${c.name} ${c.state}`).join(", ")}`);
      if (missing.length || changed.length) ownAttention.push(`skills: ${missing.length} missing, ${changed.length} differ from intended source`);
      if (missingPlugins.length) ownAttention.push(`plugins missing: ${missingPlugins.join(", ")}`);
      const badPlugins = p.plugins.filter(i => ["missing", "missing_files", "version_differs"].includes(i.state));
      if (badPlugins.length) ownAttention.push(`plugin inventory: ${badPlugins.map(i => `${i.name} ${i.state}`).join(", ")}`);
    }
    if (!d) ownAttention.push("usage collector binding unverified / no matched report");
    else {
      if (stale(d.last_received_at, s.generatedAt)) ownAttention.push(`collector last receipt ${age(d.last_received_at, s.generatedAt)}`);
      if (d.last_outcome === "conflict") ownAttention.push(`latest usage rejected: ${d.last_conflict?.kind ?? "conflict"}`);
      if (!pool || pool.windows.length === 0) ownAttention.push("no usable quota sample for the current collector");
    }
    if (pool && stale(pool.sampled_at, s.generatedAt)) ownAttention.push(`quota sample ${age(pool.sampled_at, s.generatedAt)}`);
    if (pool && pool.status !== "ok") ownAttention.push(`pool status ${pool.status} (pool evidence, not this profile's auth test)`);
    if (seat.subscription && stale(seat.subscription.lastSeen, s.generatedAt)) ownAttention.push(`Hive edge last seen ${age(seat.subscription.lastSeen, s.generatedAt)}`);
    if (expired) ownAttention.push("Hive subscription expired; new wakes are unroutable");
    if (seat.delivery && ["failed", "undeliverable"].includes(seat.delivery.status)) ownAttention.push(`last Hive delivery ${seat.delivery.status}`);
    attention.push(...ownAttention.map(text => `${seat.actor}: ${text}.`));
    overview.push([seat.actor, `${seat.provider} / ${seat.subscription?.edge ?? seat.machine}`, accountChange ? `${accountChange.label}; collector ${d?.profile_id ?? "unmatched"}` : d?.profile_id ?? "unmatched",
      auth, installation, expired ? "subscription expired; unroutable" : seat.subscription ? `edge ${age(seat.subscription.lastSeen, s.generatedAt)}; ${receivingState}` : "no observed subscription"]);
    details.push(`## ${cell(seat.actor)}\n\nProfile: ${cell(seat.profile)}. Health source: ${cell(p ? `${p.edgeId} / ${p.sourceHost}` : `unverified; expected ${seat.subscription?.edge ?? seat.machine}`)}. Maintenance observed: ${stamp(p?.observedAt ?? null, s.generatedAt)}.\n\n` +
      (accountChange ? `Current account: ${cell(accountChange.label)}, shared by ${accountChange.actors.map(cell).join(", ")} (operator confirmed). ${cell(accountChange.note)}\n\n` : "") +
      `Provider auth: ${auth}; checked ${stamp(p?.auth.observedAt ?? null, s.generatedAt)}. Local login presence does not prove a successful provider request.\n\n` +
      `Skills on disk: ${cell(p?.skillsRoot ?? "unverified or disabled")}; receipt ${cell(p?.doctrineCommit ?? "absent")}; intended ${s.doctrineCommit}. Missing: ${cell(missing.join(", ") || (p ? "none" : "unverified"))}. Differ from intended: ${cell(changed.join(", ") || (p ? "none" : "unverified"))}. An older receipt alone does not prove that files differ. Existing-session loaded skills and plugins: unverified.\n\n` +
      table(["MCP server", "Connection / auth observation", "Checked at"], p ? p.mcp.map(c => [c.name, c.state, stamp(c.observedAt, s.generatedAt)]) : [["unknown", "unverified", "never observed"]]) + "\n\n" +
      table(["Plugin / marketplace", "Disk version(s)", "Intended cached catalog version", "Evidence"], p?.plugins.length ? p.plugins.map(i => [i.name, i.installed ?? "missing", i.intended ?? "not declared", i.state]) : [["unknown", "unverified", "not declared", "unverified"]]) + "\n\n" +
      `Plugin inventory checked: ${stamp(p?.inventory.observedAt ?? null, s.generatedAt)}. Cached catalogs are not a live marketplace version check.\n\n` +
      `Hive subscription session: ${cell(seat.subscription?.sessionId ?? "not pinned")}; expires: ${cell(seat.subscription?.expiresAt ?? "no expiry / unknown")}. ` +
      (seat.delivery ? `Most recent delivery: #${seat.delivery.id}, ${seat.delivery.status}, ${stamp(seat.delivery.at, s.generatedAt)}.` : "No observed delivery.") +
      ` ${receivingState}. Reported runtime attestation: ${cell(receiving?.attestation ?? "unverified")}; it is a session claim, not verification of loaded files. An edge heartbeat or past delivery is not current session readiness.`);
  }
  for (const d of currentReporters.filter(d => !joined.has(d.profile_id))) {
    overview.push([`collector: ${d.profile_id}`, `${d.provider ?? "unknown"} / ${d.edge_id ?? "unknown edge"}`, d.profile_id, "unverified", "unverified", "seat binding unverified"]);
    attention.push(`${d.profile_id}: configured collector; ${age(d.last_received_at, s.generatedAt)}; seat binding unverified.`);
  }
  return `${refreshStatus}\n\nUpdated ${s.generatedAt}. Refresh target: every 5 minutes; treat this entire canvas as stale after 15 minutes without an update.\n\n` +
    `## Needs attention\n\n${attention.length ? attention.map(t => `- ${cell(t)}`).join("\n") : "No failures observed; unverified checks remain unverified."}\n\n` +
    `## Current seats and reporters\n\n${table(["Seat / reporter", "Provider / machine", "Usage profile", "Provider auth", "Skills on disk", "Hive"], overview)}\n\n` +
    `## Quota pools\n\nPools are listed once. Profiles in the same pool share the reported quota; provisional bindings do not establish shared identity. Retained windows can be older than collector receipts.\n\n` +
    table(["Pool ID / label", "Identity / status", "Profile bindings", "Utilization / reset", "Quota sample"], currentPools.map(p => [
      `${p.id} / ${p.label}`, `${p.identity_state} / ${p.status}`, p.profiles.filter(i => currentIds.has(i.id)).map(i => `${i.id} (${i.binding_confidence})`).join(", "),
      p.windows.map(w => `${w.label}: ${(w.utilization * 100).toFixed(0)}%; reset ${w.resets_at ?? "unknown"}`).join("; "), stamp(p.sampled_at, s.generatedAt),
    ])) + "\n\n## Collector observations\n\n" + table(["Profile / edge", "Last receipt", "Last attempted sample", "Outcome / conflict"], currentReporters.map(d => [
      `${d.profile_id} / ${d.edge_id ?? "unknown"}`, stamp(d.last_received_at, s.generatedAt), stamp(d.last_sampled_at, s.generatedAt),
      `${d.last_outcome ?? "never"}; ${d.last_conflict ? `${d.last_conflict.kind} at ${d.last_conflict.at}` : "no recorded conflict"}`,
    ])) + "\n\n" + details.join("\n\n");
}
