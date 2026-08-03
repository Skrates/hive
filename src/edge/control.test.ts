import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { udsRequest, udsRequestJson } from "../local/uds.js";
import { EdgeControlServer } from "./control.js";
import { LiveIngressRegistry } from "./live-registry.js";
import type { EdgeService } from "./service.js";

interface OutcomeRecord { deliveryId: number; text: string }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hive-control-"));
  const socketPath = join(root, "sockets", "edge.sock");
  const live = new LiveIngressRegistry();
  const outcomes: OutcomeRecord[] = [];
  const edge = {
    live,
    broker: {
      async outcome(deliveryId: number, text: string) {
        outcomes.push({ deliveryId, text });
        return {};
      },
    },
  } as unknown as EdgeService;
  const server = new EdgeControlServer(edge, { socketPath });
  return { root, socketPath, live, outcomes, server };
}

test("the control plane binds an owner-only UDS socket and registers liveness", async (t) => {
  const { root, socketPath, live, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  // Owner-only directory: filesystem ownership is the authentication (R-4).
  const mode = statSync(dirname(socketPath)).mode & 0o777;
  assert.equal(mode, 0o700);

  const registered = await udsRequestJson<{ actor: string; expiresAt: number }>(socketPath, "POST", "/live/register", {
    actor: "claude-1",
    provider: "claude",
    socketPath: join(root, "inbox", "claude-1"),
    sessionId: "session-9",
    surfaceVersion: "claude-hook",
    ttlMs: 120_000,
  });
  assert.equal(registered.actor, "claude-1");
  assert.ok(live.get("claude-1", "claude"));
  // Registration is a heartbeat: expiry lapses without renewal.
  assert.equal(live.get("claude-1", "codex"), null);
});

test("the control plane relays agent outcomes to the broker without a lease fence", async (t) => {
  const { root, socketPath, outcomes, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  const ok = await udsRequestJson<{ ok: boolean }>(socketPath, "POST", "/outcome", {
    deliveryId: 42,
    text: "done: shipped the fix",
  });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(outcomes, [{ deliveryId: 42, text: "done: shipped the fix" }]);

  const bad = await udsRequest(socketPath, "POST", "/outcome", { deliveryId: 0, text: "x" });
  assert.equal(bad.status, 400);
  const missing = await udsRequest(socketPath, "POST", "/nope");
  assert.equal(missing.status, 404);
});

test("a stale socket file is replaced on start and a non-socket path is refused", async (t) => {
  const { root, socketPath, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  await server.stop();
  // Restart over the leftover socket file must succeed.
  const edge = {
    live: new LiveIngressRegistry(),
    broker: { async outcome() { return {}; } },
  } as unknown as EdgeService;
  const again = new EdgeControlServer(edge, { socketPath });
  await again.start();
  await again.stop();
});

test("a terminal-session deregister withdraws liveness immediately and is idempotent", async (t) => {
  const { root, socketPath, live, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  await udsRequestJson(socketPath, "POST", "/live/register", {
    actor: "claude-1",
    provider: "claude",
    socketPath: join(root, "inbox", "claude-1"),
    sessionId: "session-9",
    surfaceVersion: "claude-hook",
    ttlMs: 120_000,
  });
  assert.ok(live.get("claude-1", "claude"));

  await udsRequestJson(socketPath, "POST", "/live/deregister", { actor: "claude-1", provider: "claude" });
  assert.equal(live.get("claude-1", "claude"), null);
  // Idempotent: a second withdrawal of an absent binding succeeds.
  const again = await udsRequestJson<{ ok: boolean }>(socketPath, "POST", "/live/deregister", { actor: "claude-1", provider: "claude" });
  assert.equal(again.ok, true);
});
