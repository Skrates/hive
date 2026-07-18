import assert from "node:assert/strict";
import test from "node:test";
import type { Subscription } from "../domain.js";
import { LiveIngressRegistry } from "./live-registry.js";

function binding(overrides: Partial<Subscription> = {}): Subscription {
  return {
    actor: "ariadne",
    provider: "codex",
    providerSurface: "codex-desktop-ipc",
    providerVersion: "desktop-ipc-v1",
    sessionId: "thread-1",
    homeEdge: "mac",
    workspace: "hive",
    edgeWorkspaces: [{ edgeId: "mac", cwd: "/work/hive", worktree: null }],
    wakePolicy: "live_only",
    permissionProfile: "read-only",
    leaseTtlMs: 30_000,
    deliveryTtlMs: 300_000,
    homeGraceMs: 0,
    spawnRateLimit: 1,
    expiresAt: null,
    updatedAt: "2026-07-18T00:00:00.000Z",
    bindingMode: "auto",
    bindingSource: "edge-discovery",
		bindingRevision: 7,
		egressPolicy: "receipt_only",
		egressChannelIds: [],
    ...overrides,
  };
}

test("live callbacks are fenced by the full binding tuple including ABA revision", () => {
  const registry = new LiveIngressRegistry();
  registry.register({
    actor: "ariadne",
    provider: "codex",
    callbackUrl: "http://127.0.0.1:1234/deliver",
    sessionId: "thread-1",
    bindingRevision: 7,
    providerSurface: "codex-desktop-ipc",
    surfaceVersion: "desktop-ipc-v1",
  }, 30_000);

  assert.ok(registry.get("ariadne", "codex", binding()));
  assert.equal(registry.get("ariadne", "codex", binding({ bindingRevision: 9 })), null);
  assert.equal(registry.get("ariadne", "codex", binding()), null);
});
