import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import WebSocket, { type RawData } from "ws";

interface AppServerResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
}

interface CodexThread {
  id: string;
  status: { type: "notLoaded" | "idle" | "systemError" | "active" };
  turns: CodexTurn[];
}

export class CodexAppServerClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(
    private readonly socketPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock"),
  ) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socketPath = this.socketPath;
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => createConnection(socketPath),
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data));
    socket.once("error", (error) => this.failAll(error));
    socket.once("close", () => this.failAll(new Error("Codex app-server connection closed")));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await this.request("initialize", {
      clientInfo: { name: "hive-edge", title: "Hive Codex edge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
  }

  async deliver(threadId: string, framed: string, deliveryId: number): Promise<string> {
    await this.connect();
    const result = await this.request("thread/read", { threadId, includeTurns: true }) as { thread: CodexThread };
    const thread = result.thread;
    // ADR-0003 R-1: the framed envelope is already an imperative instruction
    // from an authenticated trust-set principal. No mistrust wrapper — the
    // live path speaks with the same voice as headless delivery.
    const input = [{
      type: "text",
      text: framed,
      text_elements: [],
    }];
    const clientUserMessageId = `hive-delivery-${deliveryId}`;

    if (thread.status.type === "active") {
      const active = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");
      if (!active) throw new Error("Codex thread active without an in-progress turn");
      const steered = await this.request("turn/steer", {
        threadId,
        expectedTurnId: active.id,
        input,
        clientUserMessageId,
      }) as { turnId?: string };
      return `codex-steer:${steered.turnId ?? active.id}:${deliveryId}`;
    }
    if (thread.status.type === "idle") {
      const started = await this.request("turn/start", { threadId, input, clientUserMessageId }) as { turn?: { id?: string } };
      return `codex-turn:${started.turn?.id ?? "accepted"}:${deliveryId}`;
    }
    throw new Error(`Codex thread is not live: ${thread.status.type}`);
  }

  readThread(threadId: string): Promise<unknown> {
    return this.request("thread/read", { threadId, includeTurns: false });
  }

  async assertLiveThread(threadId: string): Promise<"active" | "idle"> {
    const result = await this.readThread(threadId) as { thread: CodexThread };
    const status = result.thread.status.type;
    if (status !== "active" && status !== "idle") {
      throw new Error(`Codex thread ${threadId} is not owned by this app-server connection: ${status}`);
    }
    return status;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected");
    const id = this.nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string): void {
    this.socket?.send(JSON.stringify({ method }));
  }

  private handleMessage(data: RawData): void {
    let message: AppServerResponse;
    try { message = JSON.parse(data.toString()) as AppServerResponse; } catch { return; }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.socket = null;
  }
}
