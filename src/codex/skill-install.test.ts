import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCodexSkill } from "./skill-install.js";

test("skill install creates one durable link and is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-skill-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source", "hive-attach");
  const target = join(root, "user", ".agents", "skills", "hive-attach");
  await mkdir(source, { recursive: true });
  // mkdir takes its mode from the caller's umask, and the install refuses a
  // group- or other-writable source. Set the mode explicitly so the test
  // asserts the install's behaviour rather than the developer's umask.
  await chmod(source, 0o700);
  await writeFile(join(source, "SKILL.md"), "---\nname: hive-attach\n---\n", { mode: 0o600 });

  const first = await installCodexSkill(source, target);
  assert.equal(first.installed, true);
  assert.equal(await readlink(target), await realpath(source));
  const second = await installCodexSkill(source, target);
  assert.equal(second.installed, false);
});

test("skill install refuses an existing path and an insecure source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hive-skill-refuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "user", ".agents", "skills", "hive-attach");
  await mkdir(source, { recursive: true });
  // Secure by construction, so the existing-path refusal below is what fails
  // the install — not the caller's umask leaking a group-writable source. The
  // insecure case is exercised deliberately by the chmod 0o777 further down.
  await chmod(source, 0o700);
  await writeFile(join(source, "SKILL.md"), "instructions", { mode: 0o600 });
  await mkdir(target, { recursive: true });
  // The install checks the target's containing directory too, with the same
  // rule — set it explicitly for the same reason.
  await chmod(join(root, "user", ".agents", "skills"), 0o700);
  await assert.rejects(() => installCodexSkill(source, target), /refusing to replace existing/);

  await rm(target, { recursive: true });
  await chmod(source, 0o777);
  await assert.rejects(() => installCodexSkill(source, target), /source directory is not securely owned/);
});
