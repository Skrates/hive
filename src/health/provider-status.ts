import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Read-only provider status methods, without creating a conversation or model turn. */
export async function providerStatus(command: string, provider: "codex" | "grok", env: NodeJS.ProcessEnv): Promise<{
  loggedIn: boolean; servers: Array<{ name: string; authStatus: string; toolsAvailable: boolean }>;
}> {
  const child = spawn(command, provider === "codex" ? ["app-server"] : ["agent", "--no-leader", "stdio"], {
    env, stdio: ["pipe", "pipe", "ignore"],
  });
  let next = 1;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const fail = () => { for (const request of pending.values()) request.reject(new Error("provider status unavailable")); pending.clear(); };
  child.on("error", fail); child.on("exit", fail);
  child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout });
  let bytes = 0;
  lines.on("line", line => {
    bytes += Buffer.byteLength(line);
    if (bytes > 2 * 1024 * 1024) { fail(); child.kill("SIGKILL"); return; }
    try {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error("provider status refused"));
      else request.resolve(message.result);
    } catch { /* Non-protocol startup lines contain no status evidence. */ }
  });
  const timer = setTimeout(() => { fail(); child.kill("SIGKILL"); }, 40_000);
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.killed) { reject(new Error("provider status unavailable")); return; }
    const id = next++; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ ...(provider === "grok" ? { jsonrpc: "2.0" } : {}), id, method, params }) + "\n");
  });
  try {
    await request("initialize", provider === "codex" ? {
      clientInfo: { name: "hive-health", version: "0.1.0" }, capabilities: {},
    } : { protocolVersion: 1, clientCapabilities: {} });
    if (provider === "grok") {
      const auth = await request("_x.ai/auth/info", {});
      return { loggedIn: typeof auth?.principalId === "string" && auth.principalId.length > 0, servers: [] };
    }
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const account = await request("account/read", { refreshToken: false });
    const servers: Array<{ name: string; authStatus: string; toolsAvailable: boolean }> = [];
    let cursor: string | null = null;
    do {
      const page = await request("mcpServerStatus/list", { cursor, limit: 100 });
      for (const server of page.data) servers.push({ name: server.name, authStatus: server.authStatus,
        toolsAvailable: Object.keys(server.tools ?? {}).length > 0 });
      cursor = page.nextCursor;
    } while (cursor);
    return { loggedIn: account.account != null, servers };
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.destroy(); child.kill("SIGKILL");
  }
}
