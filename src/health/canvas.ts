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
  archiveUrl: z.url(),
  // The manual roster owns collector joins; stale profile probes cannot override it.
  usageBindings: z.array(z.object({ actor: z.string(), edgeId: z.string(), profileId: z.string() })).min(1),
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
  archiveUrl: string;
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
    probes: persisted, failedProbes: [], usageState: "unavailable", brokerState, bindings: config.usageBindings, archiveUrl: config.archiveUrl };
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
function displayName(actor: string): string {
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

function mcpName(name: string): string {
  if (name.startsWith("plugin:cloudflare:")) return "Cloudflare";
  return name.replace(/^claude\.ai /, "").replace(/^plugin:[^:]+:/, "");
}

/** One row per declared seat. Detailed probe/collector evidence stays in the JSON receipt. */
export function renderCanvas(s: CanvasSnapshot, refreshStatus = "Snapshot only"): string {
  const attention = new Map<string, string[]>();
  const add = (issue: string, actor: string) => {
    const actors = attention.get(issue) ?? [];
    if (!actors.includes(actor)) actors.push(actor);
    attention.set(issue, actors);
  };
  if (s.usageState !== "ready") add("usage feed unavailable", "Usage");
  if (s.brokerState !== "observed") add("broker state unavailable", "Hive");

  const rows: string[][] = [];
  // The explicit binding list owns order and membership, just as the app's
  // roster does. Independent/historical collectors cannot add a sixth row.
  for (const binding of s.bindings) {
    const seat = s.seats.find(seat => seat.actor === binding.actor);
    const name = displayName(binding.actor);
    const d = s.doctor.find(d => d.configured && d.profile_id === binding.profileId &&
      d.edge_id === binding.edgeId && (!seat || d.provider === seat.provider));
    const pool = d ? s.pools.find(pool => pool.id === d.pool_id && pool.profiles.some(p => p.id === binding.profileId)) : undefined;
    const usage = pool?.windows.length
      ? pool.windows.map(w => `${w.label} ${Math.round(w.utilization * 100)}%`).join(" · ")
      : "No reading";
    const quotaAge = pool ? age(pool.sampled_at, s.generatedAt) : "unknown";
    const edge = seat?.subscription;
    const expired = edge?.expiresAt != null && Date.parse(edge.expiresAt) <= Date.parse(s.generatedAt);
    const edgeState = !edge ? "unknown" : expired ? "expired" : stale(edge.lastSeen, s.generatedAt) ? "stale" : "online";
    rows.push([`${name} · ${edge?.edge ?? seat?.machine ?? "unknown host"}`, usage, `${quotaAge} · ${edgeState}`]);

    if (!d) add("quota collector has no matched report", name);
    else {
      if (stale(d.last_received_at, s.generatedAt)) add(`collector receipt ${age(d.last_received_at, s.generatedAt)}`, name);
      if (d.last_outcome === "conflict") add(`latest quota rejected (${d.last_conflict?.kind ?? "conflict"})`, name);
    }
    if (!pool?.windows.length) add("quota unavailable", name);
    if (pool && stale(pool.sampled_at, s.generatedAt)) add(`quota sample ${quotaAge}`, name);
    if (pool && pool.status !== "ok") add(`quota ${pool.status.replaceAll("_", " ")}`, name);
    if (edgeState === "stale" || expired) add(`Hive edge ${edgeState}`, name);
    if (seat?.delivery && ["failed", "undeliverable"].includes(seat.delivery.status)) add(`last delivery ${seat.delivery.status}`, name);

    const p = seat ? s.probes.find(p => p.actor === seat.actor && p.provider === seat.provider &&
      p.edgeId === seat.subscription?.edge && !seat.profile.startsWith("~/") && p.accountProfile === seat.profile) : undefined;
    // Stale maintenance is one actionable gap, not a list of old auth/plugin
    // failures presented as current. Quota and edge freshness are independent.
    if (!p || stale(p.observedAt, s.generatedAt)) {
      add(p ? `maintenance checks stale (${age(p.observedAt, s.generatedAt)})`
        : s.failedProbes.includes(binding.actor) ? "maintenance check failed" : "maintenance not observed", name);
      continue;
    }
    if (stale(p.auth.observedAt, s.generatedAt)) add("provider auth check stale", name);
    else if (p.auth.state !== "local_login_present") add(`provider auth ${p.auth.state.replaceAll("_", " ")}`, name);
    const reconnect = new Set<string>();
    const uncertain = new Set<string>();
    for (const mcp of p.mcp) {
      if (stale(mcp.observedAt, s.generatedAt)) { add("MCP checks stale", name); continue; }
      if (mcp.state === "reauth_required") reconnect.add(mcpName(mcp.name));
      else if (!["connected", "tools_available", "none_configured", "disabled"].includes(mcp.state)) uncertain.add(mcpName(mcp.name));
    }
    if (reconnect.size) add(`reconnect ${[...reconnect].join(", ")}`, name);
    if (uncertain.size) add(`check ${[...uncertain].join(", ")} connections`, name);
    if (stale(p.inventory.observedAt, s.generatedAt)) add("installation checks stale", name);
    else {
      if (p.inventory.state !== "observed") add(`installation ${p.inventory.state.replaceAll("_", " ")}`, name);
      const intended = seat?.intendedSkills;
      if (intended) {
        const missing = Object.keys(intended).filter(n => !(n in p.skills));
        const changed = Object.keys(intended).filter(n => n in p.skills && p.skills[n] !== intended[n]);
        if (missing.length) add(`${missing.length} skills missing`, name);
        if (changed.length) add(`${changed.length} skills differ from intended`, name);
      }
      const badPlugins = new Set(p.plugins.filter(i => ["missing", "missing_files", "disabled_but_intended", "version_differs"].includes(i.state)).map(i => i.name));
      for (const plugin of seat?.intendedPlugins ?? []) if (!p.plugins.some(i => i.name === plugin && i.installed !== null)) badPlugins.add(plugin);
      if (badPlugins.size) add(`${badPlugins.size} plugins need checking`, name);
    }
  }

  const shared = new Map<string, string[]>();
  for (const b of s.bindings) {
    const key = `${b.edgeId}/${b.profileId}`;
    shared.set(key, [...(shared.get(key) ?? []), displayName(b.actor)]);
  }
  const sharing = [...shared.values()].filter(actors => actors.length > 1)
    .map(actors => `${actors.join(" + ")} share one subscription.`).join(" ");
  const updated = new Date(s.generatedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return `Updated ${updated} · ${refreshStatus} · stale after 15m.\n\n` +
    `## Needs attention\n\n${attention.size ? [...attention].map(([issue, actors]) => `- **${cell(actors.join(", "))}:** ${cell(issue)}.`).join("\n") : "No current issues observed."}\n\n` +
    `## Seats\n\n${table(["Seat", "Used", "Quota age · Hive edge"], rows)}\n\n` +
    `${sharing ? `${sharing} ` : ""}${s.bindings.length} seats · ${shared.size} ${shared.size === 1 ? "subscription" : "subscriptions"}.\n\n` +
    `[Earlier State of the Weave — August 6 archive](${s.archiveUrl})\n`;
}
