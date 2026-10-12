import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSocketPath, udsRequest, UdsTimeoutError } from "./uds.js";

function serve(socketPath: string, handler: (respond: (status: number) => void) => void) {
  prepareSocketPath(socketPath);
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => handler((status) => { response.writeHead(status); response.end("{}"); }));
  });
  return new Promise<typeof server>((resolve) => server.listen({ path: socketPath }, () => resolve(server)));
}

test("consecutive requests survive a restarted server on the same socket path", async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "hive-uds-")), "s.sock");
  let server = await serve(socketPath, (respond) => respond(200));
  assert.equal((await udsRequest(socketPath, "POST", "/a", { n: 1 })).status, 200);
  assert.equal((await udsRequest(socketPath, "POST", "/a", { n: 2 })).status, 200);
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  server = await serve(socketPath, (respond) => respond(201));
  assert.equal((await udsRequest(socketPath, "POST", "/a", { n: 3 })).status, 201, "no stale keep-alive socket is reused");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a bounded request is cancelled when it elapses", async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "hive-uds-")), "s.sock");
  const server = await serve(socketPath, () => {});
  await assert.rejects(udsRequest(socketPath, "POST", "/slow", {}, { timeoutMs: 50 }), UdsTimeoutError);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
