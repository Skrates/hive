import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDesktopIpcClient, DesktopIpcError } from "./desktop-ipc.js";

interface Message { [key: string]: unknown }

test("Desktop IPC correlates the exact steered final answer before the foreground turn ends", async (t) => {
  const seen: Message[] = [];
  const framed = "Message from U1 in Slack thread C1/100.1:\n\nDo the thing.";
  const router = await mockRouter((socket, message) => {
    seen.push(message);
    if (message.method === "initialize") {
      const frame = encode({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "initialize",
        result: { clientId: "hive-client" },
      });
      socket.write(frame.subarray(0, 3));
      socket.write(frame.subarray(3));
    }
    if (message.method === "thread-stream-following-changed") {
      socket.write(Buffer.concat([
        encode({ type: "broadcast", method: "unrelated", version: 0, params: {} }),
        streamSnapshot("owner-1", 1, "turn-1", "inProgress", []),
      ]));
    }
    if (message.method === "thread-follower-steer-turn") {
      assert.equal(message.version, 1);
      const params = message.params as Message;
      assert.deepEqual(params.input, [{ type: "text", text: framed, text_elements: [] }]);
      const restore = params.restoreMessage as Message;
      assert.equal(restore.text, framed);
      assert.equal((restore.context as Message).prompt, framed);
      assert.doesNotMatch(framed, /untrusted/i);
      socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "thread-follower-steer-turn",
        result: { result: { turnId: "turn-1" } },
      }));
      setTimeout(() => socket.write(streamSnapshot(
        "owner-1",
        2,
        "turn-1",
        "inProgress",
        [
          {
            type: "steeringUserMessage",
            clientUserMessageId: "hive-delivery-7",
            status: "accepted",
          },
          { type: "agentMessage", phase: "final_answer", text: "Previous foreground answer." },
          { type: "steered" },
          {
            type: "steeringUserMessage",
            clientUserMessageId: "later-human-message",
            status: "accepted",
          },
          { type: "agentMessage", phase: "final_answer", text: "Handled from Desktop." },
        ],
      )), 5);
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());

  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", framed, "hive-delivery-7");
  assert.equal(accepted.turnId, "turn-1");
  assert.equal(accepted.mode, "steer");
  const completion = await client.waitForDeliveryOutcome("thread-1", accepted, 100);
  assert.deepEqual(completion, {
    turnId: "turn-1",
    status: "completed",
    assistantText: "Handled from Desktop.",
  });
  assert.equal(seen.filter((message) => message.method === "thread-follower-start-turn").length, 0);
});

test("Desktop IPC retry recovers an accepted delivery and its final answer without reinjection", async (t) => {
  let steerRequests = 0;
  const router = await mockRouter((socket, message) => {
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      socket.write(streamSnapshot("owner", 4, "turn-48", "inProgress", [
        {
          type: "steeringUserMessage",
          clientUserMessageId: "hive-delivery-48",
          status: "accepted",
        },
        { type: "agentMessage", phase: "final_answer", text: "Unrelated earlier answer." },
        { type: "steered" },
        { type: "agentMessage", phase: "final_answer", text: "Recovered Fable answer." },
      ]));
    }
    if (message.method === "thread-follower-steer-turn") steerRequests += 1;
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());

  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", "redelivery", "hive-delivery-48");
  const outcome = await client.waitForDeliveryOutcome("thread-1", accepted, 100);

  assert.deepEqual(accepted, {
    turnId: "turn-48",
    clientUserMessageId: "hive-delivery-48",
    mode: "steer",
  });
  assert.deepEqual(outcome, {
    turnId: "turn-48",
    status: "completed",
    assistantText: "Recovered Fable answer.",
  });
  assert.equal(steerRequests, 0);
});

test("Desktop IPC stops a delivery outcome at the next steering boundary", async (t) => {
  const router = await mockRouter((socket, message) => {
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      socket.write(streamSnapshot("owner", 4, "turn-49", "inProgress", [
        {
          type: "steeringUserMessage",
          clientUserMessageId: "hive-delivery-49",
          status: "accepted",
        },
        { type: "steered" },
        {
          type: "steeringUserMessage",
          clientUserMessageId: "later-human-message",
          status: "accepted",
        },
        { type: "steered" },
        { type: "agentMessage", phase: "final_answer", text: "Later human answer." },
      ]));
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());

  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", "redelivery", "hive-delivery-49");

  assert.deepEqual(await client.waitForDeliveryOutcome("thread-1", accepted, 100), {
    turnId: "turn-49",
    status: "interrupted",
    assistantText: null,
  });
});

test("Desktop IPC reinjects a terminal steering anchor that never crossed its boundary", async (t) => {
  let steerRequests = 0;
  let startRequests = 0;
  const router = await mockRouter((socket, message) => {
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      socket.write(streamSnapshot("owner", 5, "turn-abandoned", "failed", [
        {
          type: "steeringUserMessage",
          clientUserMessageId: "hive-delivery-50",
          status: "accepted",
        },
      ]));
    }
    if (message.method === "thread-follower-steer-turn") {
      steerRequests += 1;
      socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "Cannot steer conversation thread-1 because its active turn already ended",
      }));
    }
    if (message.method === "thread-follower-start-turn") {
      startRequests += 1;
      const params = message.params as Message;
      assert.equal((params.turnStartParams as Message).clientUserMessageId, "hive-delivery-50");
      socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "thread-follower-start-turn",
        result: { result: { turn: { id: "turn-retry" } } },
      }));
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());

  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", "retry body", "hive-delivery-50");

  assert.deepEqual(accepted, {
    turnId: "turn-retry",
    clientUserMessageId: "hive-delivery-50",
    mode: "start",
  });
  assert.equal(steerRequests, 1);
  assert.equal(startRequests, 1);
});

test("Desktop IPC reports no owner without a mutating history probe", async (t) => {
  const methods: string[] = [];
  const router = await mockRouter((socket, message) => {
    if (typeof message.method === "string") methods.push(message.method);
    if (message.method === "initialize") initialize(socket, message);
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 30);
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(() => client.follow("missing", 30), (error: unknown) =>
    error instanceof DesktopIpcError && error.code === "no_owner_loaded");
  assert.equal(methods.includes("thread-follower-load-complete-history"), false);
});

test("Desktop IPC unfollow retires the obsolete task stream and local snapshot", async (t) => {
  const following: boolean[] = [];
  const router = await mockRouter((socket, message) => {
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      const params = message.params as Message;
      following.push(params.following as boolean);
      if (params.following === true) {
        socket.write(streamSnapshot("owner", 1, "turn-1", "inProgress", []));
      }
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());

  await client.connect();
  await client.follow("thread-1", 100);
  assert.equal(client.isFollowing("thread-1"), true);
  client.unfollow("thread-1");
  await delay(5);

  assert.equal(client.isFollowing("thread-1"), false);
  assert.deepEqual(following, [true, false]);
});

test("uncertain or mismatched steer responses never fall through to start", async (t) => {
  for (const behavior of ["mismatch", "timeout"] as const) {
    let starts = 0;
    const router = await mockRouter((socket, message) => {
      if (message.method === "initialize") initialize(socket, message);
      if (message.method === "thread-stream-following-changed") {
        socket.write(streamSnapshot("owner", 1, "turn-1", "inProgress", []));
      }
      if (message.method === "thread-follower-start-turn") starts += 1;
      if (message.method === "thread-follower-steer-turn" && behavior === "mismatch") {
        socket.write(encode({
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "thread-follower-start-turn",
          result: {},
        }));
      }
    });
    const client = new CodexDesktopIpcClient(router.path, 20);
    try {
      await client.connect();
      await client.follow("thread-1", 50);
      await assert.rejects(() => client.deliver("thread-1", "body", "hive-delivery-1"));
      await delay(30);
      assert.equal(starts, 0, behavior);
    } finally {
      await client.close();
      await router.close();
    }
  }
});

test("an ended active-turn race falls through from steer to start", async (t) => {
  let starts = 0;
  const router = await mockRouter((socket, message) => {
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      socket.write(streamSnapshot("owner", 1, "turn-ended", "completed", []));
    }
    if (message.method === "thread-follower-steer-turn") {
      socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "Cannot steer conversation thread-1 because its active turn already ended",
      }));
    }
    if (message.method === "thread-follower-start-turn") {
      starts += 1;
      assert.equal(message.version, 1);
      const params = message.params as Message;
      assert.equal(params.conversationId, "thread-1");
      assert.deepEqual((params.turnStartParams as Message).input, [{
        type: "text",
        text: "body",
        text_elements: [],
      }]);
      socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "thread-follower-start-turn",
        result: { result: { turn: { id: "turn-new" } } },
      }));
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());

  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", "body", "hive-delivery-9");

  assert.deepEqual(accepted, {
    turnId: "turn-new",
    clientUserMessageId: "hive-delivery-9",
    mode: "start",
  });
  assert.equal(starts, 1);
});

test("stale owner patches are ignored and revision divergence fails completion", async (t) => {
  let clientSocket: Socket | null = null;
  const router = await mockRouter((socket, message) => {
    clientSocket = socket;
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      socket.write(streamSnapshot("owner", 1, "turn-1", "inProgress", []));
    }
    if (message.method === "thread-follower-steer-turn") {
      socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "thread-follower-steer-turn",
        result: { result: { turnId: "turn-1" } },
      }));
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());
  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", "body", "hive-delivery-1");
  const waiting = client.waitForTurnCompletion("thread-1", accepted.turnId, 200);
  clientSocket!.write(streamPatch("other-owner", 1, 2, [{
    op: "replace",
    path: ["turnHistory", "history", "entitiesByKey", "tail", "status"],
    value: "completed",
  }]));
  clientSocket!.write(streamPatch("owner", 0, 2, []));
  await assert.rejects(waiting, (error: unknown) =>
    error instanceof DesktopIpcError && error.code === "revision_mismatch");
});

test("a competing owner snapshot fails closed until an explicit follower reset", async (t) => {
  let clientSocket: Socket | null = null;
  const router = await mockRouter((socket, message) => {
    clientSocket = socket;
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      socket.write(streamSnapshot("owner-a", 1, "turn-1", "inProgress", []));
    }
    if (message.method === "thread-follower-steer-turn") {
      socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "thread-follower-steer-turn",
        result: { result: { turnId: "turn-1" } },
      }));
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());
  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", "body", "hive-delivery-1");
  const waiting = client.waitForTurnCompletion("thread-1", accepted.turnId, 200);

  clientSocket!.write(streamSnapshot("owner-b", 2, "turn-1", "completed", [
    { type: "agentMessage", text: "Wrong owner." },
  ]));

  await assert.rejects(waiting, (error: unknown) =>
    error instanceof DesktopIpcError && error.code === "owner_conflict");
  assert.equal(client.isFollowing("thread-1"), false);
  clientSocket!.write(streamSnapshot("owner-a", 3, "turn-1", "completed", []));
  await delay(5);
  assert.equal(client.isFollowing("thread-1"), false);
});

test("an owner conflict before the steer response rejects completion immediately", async (t) => {
  const router = await mockRouter((socket, message) => {
    if (message.method === "initialize") initialize(socket, message);
    if (message.method === "thread-stream-following-changed") {
      socket.write(streamSnapshot("owner-a", 1, "turn-1", "inProgress", []));
    }
    if (message.method === "thread-follower-steer-turn") {
      socket.write(streamSnapshot("owner-b", 2, "turn-1", "inProgress", []));
      setTimeout(() => socket.write(encode({
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: "thread-follower-steer-turn",
        result: { result: { turnId: "turn-1" } },
      })), 5);
    }
  });
  t.after(() => router.close());
  const client = new CodexDesktopIpcClient(router.path, 100);
  t.after(() => client.close());
  await client.connect();
  await client.follow("thread-1", 100);
  const accepted = await client.deliver("thread-1", "body", "hive-delivery-1");

  await assert.rejects(
    () => client.waitForTurnCompletion("thread-1", accepted.turnId, 5_000),
    (error: unknown) => error instanceof DesktopIpcError && error.code === "owner_conflict",
  );
});

async function mockRouter(
  handler: (socket: Socket, message: Message) => void,
): Promise<{ path: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "hive-ipc-"));
  await chmod(directory, 0o700);
  const path = join(directory, "ipc.sock");
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    attach(socket, (message) => handler(socket, message));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    path,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function attach(socket: Socket, receive: (message: Message) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")) as Message;
      buffer = buffer.subarray(length + 4);
      receive(message);
    }
  });
}

function initialize(socket: Socket, message: Message): void {
  socket.write(encode({
    type: "response",
    requestId: message.requestId,
    resultType: "success",
    method: "initialize",
    result: { clientId: "hive-client" },
  }));
}

function streamSnapshot(
  sourceClientId: string,
  revision: number,
  turnId: string,
  status: string,
  items: unknown[],
): Buffer {
  return encode({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId,
    params: {
      hostId: "local",
      conversationId: "thread-1",
      change: {
        type: "snapshot",
        revision,
        conversationState: {
          turnHistory: { history: { entitiesByKey: { tail: { turnId, status, items } } } },
        },
      },
    },
  });
}

function streamPatch(
  sourceClientId: string,
  baseRevision: number,
  revision: number,
  patches: unknown[],
): Buffer {
  return encode({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId,
    params: {
      hostId: "local",
      conversationId: "thread-1",
      change: { type: "patches", baseRevision, revision, patches },
    },
  });
}

function encode(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
