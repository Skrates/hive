import { request as httpRequest } from "node:http";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * ADR-0003 R-4: the machine-local plane runs over owner-only Unix domain
 * sockets. Filesystem ownership is the authentication — there is no local
 * token, no capability header, no loopback TCP listener.
 */

export interface UdsResponse {
  status: number;
  body: string;
}

export class UdsHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`uds ${path} ${status}: ${responseBody.slice(0, 500)}`);
    this.name = "UdsHttpError";
  }
}

/** A bounded local request that did not answer in time; it proves nothing about commit. */
export class UdsTimeoutError extends Error {
  constructor(readonly path: string, readonly timeoutMs: number) {
    super(`uds ${path} did not answer within ${timeoutMs}ms`);
    this.name = "UdsTimeoutError";
  }
}

export interface UdsRequestOptions {
  /** Enforced with cancellation: the request is destroyed when it elapses. */
  timeoutMs?: number;
}

export function udsRequest(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: UdsRequestOptions = {},
): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: payload === null
          ? {}
          : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    request.once("error", reject);
    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs;
      request.setTimeout(timeoutMs, () => request.destroy(new UdsTimeoutError(path, timeoutMs)));
    }
    if (payload !== null) request.write(payload);
    request.end();
  });
}

export async function udsRequestJson<T>(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: UdsRequestOptions = {},
): Promise<T> {
  const response = await udsRequest(socketPath, method, path, body, options);
  if (response.status < 200 || response.status >= 300) {
    throw new UdsHttpError(path, response.status, response.body);
  }
  return JSON.parse(response.body) as T;
}

/**
 * Prepare a socket path for binding: ensure the parent directory exists with
 * owner-only permissions and remove any stale socket left by a previous
 * process. Refuses to remove a path that exists but is not a socket.
 */
export function prepareSocketPath(socketPath: string): void {
  const directory = dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(socketPath)) {
    if (!statSync(socketPath).isSocket()) {
      throw new Error(`refusing to unlink non-socket path ${socketPath}`);
    }
    rmSync(socketPath);
  }
}
