import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SeatWakeMint, SeatWakeReceipt } from "../domain.js";
import { udsRequest, udsRequestJson } from "../local/uds.js";
import { BrokerHttpError } from "./broker-client.js";
import { EdgeControlServer } from "./control.js";
import { LiveIngressRegistry } from "./live-registry.js";
import type { EdgeService } from "./service.js";

interface OutcomeRecord { deliveryId: number; text: string }

function fixture(mintWake?: (input: SeatWakeMint) => Promise<SeatWakeReceipt>) {
  const root = mkdtempSync(join(tmpdir(), "hive-control-"));
  const socketPath = join(root, "sockets", "edge.sock");
  const live = new LiveIngressRegistry();
  const outcomes: OutcomeRecord[] = [];
  const mints: SeatWakeMint[] = [];
  // The one dispatch this fake edge is running, and the token it issued for it.
  const dispatches = new Map([["token-of-the-running-turn", { deliveryId: 512, generation: 3 }]]);
  const edge = {
    live,
    resolveMintSource(token: string) {
      return dispatches.get(token) ?? null;
    },
    broker: {
      async outcome(deliveryId: number, text: string) {
        outcomes.push({ deliveryId, text });
        return {};
      },
      async mintWake(input: SeatWakeMint): Promise<SeatWakeReceipt> {
        mints.push(input);
        if (mintWake) return mintWake(input);
        return { deliveryId: 77, actor: input.actor, from: "ariadne", channelId: "C1", threadTs: "100.1", created: true };
      },
    },
  } as unknown as EdgeService;
  const server = new EdgeControlServer(edge, { socketPath });
  return { root, socketPath, live, outcomes, mints, server };
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

test("a live register carries the surface's runtime attestation", async (t) => {
  const { root, socketPath, live, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  await udsRequestJson(socketPath, "POST", "/live/register", {
    actor: "codex-1",
    provider: "codex",
    socketPath: join(root, "codex-live.sock"),
    sessionId: "desktop-task",
    surfaceVersion: "hive-codex-live",
    ttlMs: 120_000,
    attestation: {
      ok: true,
      attestationId: "sha256:" + "d".repeat(64),
      doctrineCommit: "2".repeat(40),
      actor: "codex-1",
    },
  });
  const ingress = live.get("codex-1", "codex");
  assert.ok(ingress);
  assert.equal(ingress.runtimeAttestation?.ok, true);
  if (ingress.runtimeAttestation?.ok) {
    assert.equal(ingress.runtimeAttestation.attestation.attestationId, "sha256:" + "d".repeat(64));
  }
});

test("a register with no attestation field is recorded as having reported nothing", async (t) => {
  // The destruction site. Dropping the key here made `undefined` inside the
  // registry mean two different things — "no prior registration" and "the
  // prior registration said nothing" — and no downstream reconciliation can
  // recover a distinction the write already erased.
  const { root, socketPath, live, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  await udsRequestJson(socketPath, "POST", "/live/register", {
    actor: "codex-1",
    provider: "codex",
    socketPath: join(root, "codex-live.sock"),
    sessionId: "rollout-task",
    surfaceVersion: "hive-codex-live",
    ttlMs: 120_000,
  });
  assert.deepEqual(
    live.get("codex-1", "codex")?.runtimeAttestation,
    { ok: false, absence: "attestation_unreported" },
  );

  // …and because the omission is now named, a later heartbeat that DOES carry
  // an id cannot be adopted as the snapshot this session started under. A
  // session spanning a hook rollout is the shape; if the profile was replaced
  // in between, that id is not what the running turn loaded.
  await udsRequestJson(socketPath, "POST", "/live/register", {
    actor: "codex-1",
    provider: "codex",
    socketPath: join(root, "codex-live.sock"),
    sessionId: "rollout-task",
    surfaceVersion: "hive-codex-live",
    ttlMs: 120_000,
    attestation: {
      ok: true,
      attestationId: "sha256:" + "d".repeat(64),
      doctrineCommit: "2".repeat(40),
      actor: "codex-1",
    },
  });
  assert.deepEqual(
    live.get("codex-1", "codex")?.runtimeAttestation,
    { ok: false, absence: "attestation_ambiguous" },
  );
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

test("the control plane relays a seat's wake mint to the broker", async (t) => {
  const { root, socketPath, mints, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  const receipt = await udsRequestJson<SeatWakeReceipt>(socketPath, "POST", "/wake", {
    token: "token-of-the-running-turn",
    actor: "GNOMON",
    text: "please verify the gate set",
    threadTs: null,
  });

  assert.equal(receipt.deliveryId, 77);
  // The edge carries intent only, and it — not the caller — names the source:
  // the delivery and generation come from the edge's own dispatch state, and
  // the broker then resolves the sender from its own ledger.
  assert.deepEqual(mints, [{
    sourceDeliveryId: 512,
    generation: 3,
    actor: "gnomon",
    text: "please verify the gate set",
    threadTs: null,
  }]);
});

test("a mint that names a delivery instead of its own turn reaches no broker", async (t) => {
  const { root, socketPath, mints, server } = fixture();
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  // The co-tenant case that `claimed_by === edgeId` could not see: several
  // seats share one edge and one owner-only socket, so a body naming a peer's
  // delivery id would mint under that peer's attribution. The id is not a
  // field any more, and the capability of a turn this edge is not running
  // resolves to nothing.
  const named = await udsRequest(socketPath, "POST", "/wake", {
    sourceDeliveryId: 512,
    actor: "gnomon",
    text: "minted as my co-tenant",
    threadTs: null,
  });
  assert.equal(named.status, 400);
  assert.equal((JSON.parse(named.body) as { error: string }).error, "invalid_wake");

  const foreign = await udsRequest(socketPath, "POST", "/wake", {
    token: "a-token-this-edge-never-issued",
    actor: "gnomon",
    text: "minted from a turn that is not mine",
    threadTs: null,
  });
  assert.equal(foreign.status, 403);
  assert.equal((JSON.parse(foreign.body) as { error: string }).error, "unknown_dispatch_token");

  // Neither reached the broker at all — no mint was attempted under anyone.
  assert.deepEqual(mints, []);
});

test("a refused mint reaches the seat with the broker's own reason (R-3)", async (t) => {
  const { root, socketPath, server } = fixture(() => {
    throw new BrokerHttpError(422, JSON.stringify({
      error: "unroutable_actor",
      detail: "no live subscription for actor `theoros`",
    }));
  });
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();

  const response = await udsRequest(socketPath, "POST", "/wake", {
    token: "token-of-the-running-turn",
    actor: "theoros",
    text: "hello",
    threadTs: null,
  });

  // Flattening this to a generic edge failure is exactly the render-and-vanish
  // shape KRA-1097 exists to kill: the minting seat must learn WHY.
  assert.equal(response.status, 422);
  const body = JSON.parse(response.body) as { error: string; detail: string };
  assert.equal(body.error, "unroutable_actor");
  assert.match(body.detail, /no live subscription for actor `theoros`/);

  // A malformed mint is refused before the broker is ever asked.
  const invalid = await udsRequest(socketPath, "POST", "/wake", { token: "", actor: "", text: "" });
  assert.equal(invalid.status, 400);
  assert.equal((JSON.parse(invalid.body) as { error: string }).error, "invalid_wake");
});
