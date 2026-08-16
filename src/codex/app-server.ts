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
  items?: Array<{ type?: string; text?: string }>;
}

interface CodexThread {
  id: string;
  status: { type: "notLoaded" | "idle" | "systemError" | "active" };
  turns: CodexTurn[];
}

export class CodexAppServerClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

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
    }, 10_000);
    this.notify("initialized");
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
  }

  async deliver(
    threadId: string,
    framed: string,
    deliveryId: number,
    timeoutMs = 30_000,
  ): Promise<{ turnId: string; mode: "start" | "steer" }> {
    const deadline = Date.now() + timeoutMs;
    await this.connect();
    const result = await this.request(
      "thread/read",
      { threadId, includeTurns: true },
      Math.min(10_000, remaining(deadline)),
    ) as { thread: CodexThread };
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
      }, remaining(deadline)) as { turnId?: string };
      return { turnId: steered.turnId ?? active.id, mode: "steer" };
    }
    if (thread.status.type === "idle") {
      const started = await this.request(
        "turn/start",
        { threadId, input, clientUserMessageId },
        remaining(deadline),
      ) as { turn?: { id?: string } };
      const turnId = started.turn?.id;
      if (!turnId) throw new Error("Codex app-server accepted a turn without a correlatable turn id");
      return { turnId, mode: "start" };
    }
    throw new Error(`Codex thread is not live: ${thread.status.type}`);
  }

  async interrupt(threadId: string, turnId: string, timeoutMs = 10_000): Promise<void> {
    await this.connect();
    await this.request("turn/interrupt", { threadId, turnId }, timeoutMs);
  }

  async waitForCompletion(
    threadId: string,
    turnId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: "completed" | "failed" | "interrupted"; assistantText: string | null }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Codex live delivery aborted");
      await this.connect();
      // The read itself races the abort: a poll that has just started its
      // 10-second window would otherwise serialize in front of the 10-second
      // interrupt, doubling the cancellation bound. The read continues on the
      // wire — it is read-only — but this waiter stops immediately.
      const result = await raceAbort(
        this.request(
          "thread/read",
          { threadId, includeTurns: true },
          Math.min(10_000, remaining(deadline)),
        ),
        signal,
        "Codex live delivery aborted",
      ) as { thread: CodexThread };
      const turn = result.thread.turns.find((candidate) => candidate.id === turnId);
      if (turn && turn.status !== "inProgress") {
        const assistant = [...(turn.items ?? [])].reverse().find((item) =>
          (item.type === "agentMessage" || item.type === "agent_message")
          && typeof item.text === "string");
        return { status: turn.status, assistantText: assistant?.text ?? null };
      }
      await delay(Math.min(500, Math.max(1, deadline - Date.now())), signal);
    }
    throw new Error(`Timed out waiting for Codex app-server turn ${turnId}`);
  }

  readThread(threadId: string): Promise<unknown> {
    return this.request("thread/read", { threadId, includeTurns: false });
  }

  async assertLiveThread(threadId: string): Promise<"active" | "idle"> {
    let result = await this.readThread(threadId) as { thread: CodexThread };
    if (result.thread.status.type === "notLoaded") {
      // App-server thread ownership is scoped to the client connection. Load
      // the persisted thread on this long-lived supervisor connection so it
      // remains steerable after any short-lived setup client disconnects.
      result = await this.request("thread/resume", { threadId }) as { thread: CodexThread };
    }
    const status = result.thread.status.type;
    if (status !== "active" && status !== "idle") {
      throw new Error(`Codex thread ${threadId} is not owned by this app-server connection: ${status}`);
    }
    return status;
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket = null;
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Codex live delivery aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Codex live delivery aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** Resolve with the promise, or reject as soon as the signal aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(message));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
