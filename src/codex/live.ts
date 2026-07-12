#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Delivery } from "../domain.js";
import { CodexAppServerClient } from "./app-server.js";

interface Config {
  actor: string;
  threadId: string;
  edgeUrl: string;
  localToken: string;
  surfaceVersion: string;
  codexCommand: string;
}

export async function runCodexLive(config: Config): Promise<void> {
  const client = new CodexAppServerClient(config.codexCommand);
  await client.connect();
  const http = createServer((request, response) => {
    void handle(request, response, config.localToken, async (delivery, framed) => {
      return client.deliver(config.threadId, framed, delivery.id);
    }).catch((error: unknown) => {
      const body = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Codex live callback did not bind TCP");
  const callbackUrl = `http://127.0.0.1:${address.port}/deliver`;
  const register = async () => {
    const response = await fetch(`${config.edgeUrl}/v1/live/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.localToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        actor: config.actor,
        provider: "codex",
        callbackUrl,
        sessionId: config.threadId,
        surfaceVersion: config.surfaceVersion,
        ttlMs: 30_000,
      }),
    });
    if (!response.ok) throw new Error(`edge registration failed ${response.status}: ${await response.text()}`);
  };
  await register();
  const timer = setInterval(() => void register().catch((error: unknown) => {
    console.error("Hive Codex live renewal failed", error instanceof Error ? error.message : String(error));
  }), 10_000);
  timer.unref();
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  deliver: (delivery: Delivery, framed: string) => Promise<string>,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/deliver") throw new Error("not found");
  if (request.headers.authorization !== `Bearer ${token}`) throw new Error("unauthorized");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { delivery: Delivery; framed: string };
  const receipt = await deliver(body.delivery, body.framed);
  const encoded = JSON.stringify({ receipt });
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  await runCodexLive({
    actor: required("HIVE_ACTOR"),
    threadId: required("HIVE_SESSION_ID"),
    edgeUrl: process.env.HIVE_EDGE_URL ?? "http://127.0.0.1:8791",
    localToken: required("HIVE_EDGE_LOCAL_TOKEN"),
    surfaceVersion: process.env.HIVE_PROVIDER_VERSION ?? "unknown",
    codexCommand: process.env.HIVE_CODEX_COMMAND ?? "codex",
  });
}
