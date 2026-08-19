import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CodexAppServerClient, delay } from "./app-server.js";

test("a resolved polling delay removes its abort listener", async () => {
  const controller = new AbortController();
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const add = controller.signal.addEventListener.bind(controller.signal);
  const drop = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === "abort") added.push(listener);
    return add(type, listener as never, options as never);
  }) as typeof controller.signal.addEventListener;
  controller.signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === "abort") removed.push(listener);
    return drop(type, listener as never, options as never);
  }) as typeof controller.signal.removeEventListener;

  await delay(10, controller.signal);
  assert.equal(added.length, 1);
  assert.deepEqual(removed, added);
  controller.abort();
});

test("the live bridge resumes a persisted thread on its own long-lived connection", async () => {
  const fixture = await appServerFixture((method) => method === "thread/read"
    ? { thread: { id: "thread-1", status: { type: "notLoaded" }, turns: [] } }
    : method === "thread/resume"
      ? { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } }
      : {});
  try {
    assert.equal(await fixture.client.assertLiveThread("thread-1"), "idle");
    assert.deepEqual(fixture.methods, ["initialize", "initialized", "thread/read", "thread/resume"]);
  } finally {
    await fixture.close();
  }
});

test("delivery correlates and waits for the exact completed Codex turn", async () => {
  let reads = 0;
  const fixture = await appServerFixture((method) => {
    if (method === "thread/read") {
      reads += 1;
      return reads === 1
        ? { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } }
        : {
            thread: {
              id: "thread-1",
              status: { type: "idle" },
              turns: [{
                id: "turn-35",
                status: "completed",
                items: [{ type: "agentMessage", text: "Ariadne completed delivery 35." }],
              }],
            },
          };
    }
    if (method === "turn/start") return { turn: { id: "turn-35" } };
    return {};
  });
  try {
    const accepted = await fixture.client.deliver("thread-1", "wake", 35, 1_000);
    assert.deepEqual(accepted, { turnId: "turn-35", mode: "start" });
    assert.deepEqual(
      await fixture.client.waitForCompletion("thread-1", accepted.turnId, 1_000),
      { status: "completed", assistantText: "Ariadne completed delivery 35." },
    );
    assert.deepEqual(fixture.methods, [
      "initialize", "initialized", "thread/read", "turn/start", "thread/read",
    ]);
    await fixture.client.interrupt("thread-1", accepted.turnId);
    assert.equal(fixture.methods.at(-1), "turn/interrupt");
  } finally {
    await fixture.close();
  }
});

async function appServerFixture(resultFor: (method: string) => unknown): Promise<{
  client: CodexAppServerClient;
  methods: string[];
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "hive-codex-app-server-"));
  const socketPath = join(directory, "control.sock");
  const http = createServer();
  const websocket = new WebSocketServer({ server: http });
  const methods: string[] = [];
  websocket.on("connection", (connection) => {
    connection.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: number; method: string };
      methods.push(message.method);
      if (message.id !== undefined) {
        connection.send(JSON.stringify({ id: message.id, result: resultFor(message.method) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(socketPath, resolve);
  });
  const client = new CodexAppServerClient(socketPath);
  await client.connect();
  return {
    client,
    methods,
    async close() {
      await client.close();
      await new Promise<void>((resolve, reject) => websocket.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
