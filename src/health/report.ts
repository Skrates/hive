import { z } from "zod";

const Name = z.string().min(1).max(512);
const State = z.enum(["unverified", "observed", "profile_missing", "inventory_incomplete", "check_failed", "reauth_required",
  "local_login_present", "connected", "tools_available", "connection_failed", "configured_connection_unverified"]);
const Check = z.object({ state: State, observedAt: z.iso.datetime() }).strict();
export const ProfileReport = z.object({
  actor: Name, provider: z.enum(["claude", "codex", "grok"]), accountProfile: Name, sourceHost: Name,
  skillsRoot: Name.nullable(), observedAt: z.iso.datetime(),
  usageProfileId: Name.nullable(), usageEdgeId: Name.nullable(), auth: Check,
  mcp: z.array(Check.extend({ name: Name }).strict()).max(200),
  skills: z.record(Name, z.string().regex(/^(?:[0-9a-f]{64}|unverified)$/)), doctrineCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  plugins: z.array(z.object({ name: Name, installed: Name.nullable(), intended: Name.nullable(),
    state: z.enum(["missing", "missing_files", "version_differs", "version_unverified", "cached_only"]) }).strict()).max(500),
  inventory: Check,
  receiving: z.object({ sessionId: Name.nullable(), expiresAt: z.number(), attestation: Name.nullable() }).strict().nullable().optional(),
}).strict();
