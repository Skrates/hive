import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface SkillInstallResult {
  installed: boolean;
  source: string;
  target: string;
}

/**
 * Install a repository-owned Codex skill into the supported user skill root.
 * The link keeps the installed command on the same reviewed bytes as Hive.
 * Existing non-matching paths are never replaced.
 */
export async function installCodexSkill(source: string, target: string): Promise<SkillInstallResult> {
  const sourcePath = await assertSecureSkillSource(source);
  const targetDirectory = dirname(target);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await assertSecureOwnedDirectory(targetDirectory);

  try {
    const targetStat = await lstat(target);
    if (!targetStat.isSymbolicLink()) {
      throw new Error(`refusing to replace existing Codex skill path ${target}`);
    }
    const linked = await readlink(target);
    const linkedPath = resolve(targetDirectory, linked);
    const resolvedLink = await realpath(linkedPath).catch(() => null);
    if (resolvedLink !== sourcePath) {
      throw new Error(`refusing to replace existing Codex skill link ${target}`);
    }
    return { installed: false, source: sourcePath, target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await symlink(sourcePath, target, "dir");
  return { installed: true, source: sourcePath, target };
}

async function assertSecureSkillSource(source: string): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Cannot verify Codex skill ownership");
  const sourcePath = await realpath(source);
  const [directory, instructions] = await Promise.all([
    lstat(sourcePath),
    lstat(resolve(sourcePath, "SKILL.md")),
  ]);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) !== 0) {
    throw new Error("Codex skill source directory is not securely owned");
  }
  if (!instructions.isFile() || instructions.uid !== uid || (instructions.mode & 0o022) !== 0) {
    throw new Error("Codex skill instructions are not securely owned");
  }
  return sourcePath;
}

async function assertSecureOwnedDirectory(directory: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Cannot verify Codex skill directory ownership");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error("Codex user skill directory is not securely owned");
  }
}
