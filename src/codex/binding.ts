import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CodexThreadCatalog } from "./discovery.js";

export interface CodexForegroundBinding {
  actor: string;
  sessionId: string;
  cwd: string;
  revision: string;
  attachedAt: string;
}

/**
 * The actor grammar for every Codex attachment path. Actor names are
 * interpolated into owner-only file paths, so the grammar must be applied
 * before any path is constructed, read, or removed — not only on the write
 * path. A name containing path segments would otherwise escape the bindings
 * directory.
 */
export function assertCodexAttachmentActor(actor: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(actor) || actor === "everyone") {
    throw new Error("invalid Hive actor for Codex attachment");
  }
}

export async function createCodexForegroundBinding(input: {
  actor: string;
  sessionId: string;
  cwd: string;
  stateDatabase: string;
  bindingFile: string;
}): Promise<CodexForegroundBinding> {
  assertCodexAttachmentActor(input.actor);
  if (!input.sessionId) throw new Error("Codex attachment requires a session id");
  if (!input.cwd.startsWith("/")) throw new Error("Codex attachment cwd must be absolute");
  const catalog = new CodexThreadCatalog(input.stateDatabase);
  try {
    if (!catalog.primaryUserThread(input.sessionId, input.cwd)) {
      throw new Error("Codex attachment target is not an active primary user task at the exact cwd");
    }
  } finally {
    catalog.close();
  }
  const binding: CodexForegroundBinding = {
    actor: input.actor,
    sessionId: input.sessionId,
    cwd: input.cwd,
    revision: randomUUID(),
    attachedAt: new Date().toISOString(),
  };
  await writeBinding(input.bindingFile, binding);
  return binding;
}

export async function readCodexForegroundBinding(
  bindingFile: string,
): Promise<CodexForegroundBinding | null> {
  let stat;
  try {
    stat = await lstat(bindingFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const uid = process.getuid?.();
  if (uid === undefined || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error("Codex attachment file is not private to the current user");
  }
  const value = JSON.parse(await readFile(bindingFile, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error("Codex attachment file is invalid");
  const binding: CodexForegroundBinding = {
    actor: requiredString(value.actor, "actor"),
    sessionId: requiredString(value.sessionId, "sessionId"),
    cwd: requiredString(value.cwd, "cwd"),
    revision: requiredString(value.revision, "revision"),
    attachedAt: requiredString(value.attachedAt, "attachedAt"),
  };
  assertCodexAttachmentActor(binding.actor);
  if (!binding.cwd.startsWith("/") || !Number.isFinite(Date.parse(binding.attachedAt))) {
    throw new Error("Codex attachment file is invalid");
  }
  return binding;
}

export async function removeCodexForegroundBinding(bindingFile: string): Promise<void> {
  await rm(bindingFile, { force: true });
}

/**
 * Roll back an attachment that the live surface did not confirm. The failed
 * revision fences the cleanup so a newer attachment is never removed. A prior
 * binding is restored through the same temporary-file + rename path as a new
 * binding, making the visible replacement atomic; absence is restored by
 * removing only the still-current failed revision.
 */
export async function restoreCodexForegroundBinding(
  bindingFile: string,
  failedRevision: string,
  previous: CodexForegroundBinding | null,
): Promise<boolean> {
  const current = await readCodexForegroundBinding(bindingFile);
  if (current?.revision !== failedRevision) return false;
  if (previous) await writeBinding(bindingFile, previous);
  else await removeCodexForegroundBinding(bindingFile);
  return true;
}

async function writeBinding(path: string, binding: CodexForegroundBinding): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${binding.revision}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
