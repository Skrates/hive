/**
 * Secrets arrive as owner-only files, never as bare environment variables (§7 "private key
 * and webhook secret as tier-2 secrets on the dev box"; §5.A2 the operator token file).
 * One reader enforces the rule for all of them: the file must be mode 0600 or tighter, and
 * it must not be empty. A wider mode is a refusal, not a warning — a readable secret is a
 * misconfiguration to fix, not to tolerate.
 */
import { readFileSync, statSync } from "node:fs";

export class SecretFileError extends Error {}

/** Read an owner-only file; throws {@link SecretFileError} on a wider mode or an empty body. */
export function readOwnerOnlyFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new SecretFileError(
      `refusing to read ${path}: mode ${mode.toString(8).padStart(4, "0")} is readable beyond its owner; chmod 0600 it`,
    );
  }
  const body = readFileSync(path, "utf8").trim();
  if (body.length === 0) throw new SecretFileError(`${path} is empty`);
  return body;
}

/** Like {@link readOwnerOnlyFile}, but a missing file is `null`; every other failure still throws. */
export function readOwnerOnlyFileIfPresent(path: string): string | null {
  try {
    return readOwnerOnlyFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
