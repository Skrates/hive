import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_CONCURRENT_DISPATCHES } from "./service.js";

// This gate exists because prose failed at exactly this job. `docs/operations.md`
// enumerated two launchers by hand while three existed, and the third — the RunPod
// pod, whose seat HOME sits on a network-backed /workspace — was the one deployment
// the attestation read's threadpool guard was written for. A hand-written list
// cannot notice a fourth launcher; a derived one has to.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deployDir = join(repoRoot, "deploy");

// The edge process, in every spelling this repo ships: the built entrypoint
// (`… dist/cli.js edge`, with or without the quote a shell launcher closes the
// interpreter path with), the `hive-cli` symlink the RunPod image installs, and
// the `hive` bin itself. Discovery is textual, so a launcher invented with a
// fourth spelling is the residual — which is what the floor test above is for:
// it fails the moment a known launcher stops matching, rather than letting the
// set quietly shrink to the ones that still do.
const LAUNCH = /(?:cli\.js|hive-cli|\/hive)["']?\s+edge\b/;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function launchers(): { path: string; body: string }[] {
  return filesUnder(deployDir)
    .map((path) => ({ path, body: readFileSync(path, "utf8") }))
    .filter(({ body }) =>
      body.split("\n").some((line) => !line.trimStart().startsWith("#") && LAUNCH.test(line)),
    );
}

test("the launcher set is discoverable, and discovery is not vacuous", () => {
  const found = launchers().map(({ path }) => relative(repoRoot, path)).sort();
  // Not an allowlist to keep in sync — a floor. A new launcher joins the set and
  // is held to the assertion below; the named three may never silently leave it.
  for (const known of [
    "deploy/launchd/run-edge.zsh",
    "deploy/machines/edge-runpod/start-edge.sh",
    "deploy/systemd/hive-edge.service",
  ]) {
    assert.ok(found.includes(known), `${known} no longer reads as an edge launcher: ${found}`);
  }
});

test("every repo-owned launcher sizes the libuv threadpool above the dispatch cap", () => {
  // A stalled network mount parks the claim-time attestation read on a libuv
  // thread that no timeout reclaims — the wall-clock bound frees the dispatch
  // slot and loses the thread. At libuv's default of 4, which is exactly
  // MAX_CONCURRENT_DISPATCHES, the pool is gone after four stalls and every later
  // fs/dns job on the edge queues forever. Loud becomes silent: R-3 inverted.
  for (const { path, body } of launchers()) {
    const sized = body.match(/UV_THREADPOOL_SIZE[=\s]*["']?\$?\{?[A-Za-z_]*:?-?(\d+)/);
    assert.ok(
      sized !== null,
      `${relative(repoRoot, path)} launches the edge without setting UV_THREADPOOL_SIZE`,
    );
    assert.ok(
      Number(sized[1]) > MAX_CONCURRENT_DISPATCHES,
      `${relative(repoRoot, path)} sets UV_THREADPOOL_SIZE=${sized[1]}, not above the dispatch cap of ${MAX_CONCURRENT_DISPATCHES}`,
    );
  }
});
