export const MAX_MCP_JSON_BODY_BYTES = 1_048_576;
export const MCP_JSON_BODY_READ_TIMEOUT_MS = 1_000;

export class BoundedBodyReadError extends Error {
  constructor(code: "mcp_body_read_failed" | "mcp_body_read_timeout" | "mcp_body_too_large") {
    super(code);
    this.name = "BoundedBodyReadError";
  }
}

/**
 * Capture one request into private bounded body bytes and an explicit header
 * snapshot. Callers must transport the returned `.request`, never the consumed
 * source request, so classification, authority binding, and wire bytes agree.
 */
export interface CapturedBoundedRequest {
  readonly request: Request;
  readonly body: Uint8Array;
}

export async function captureBoundedRequest(
  request: Request,
  headerSnapshot: Headers = new Headers(request.headers),
): Promise<CapturedBoundedRequest> {
  const headers = new Headers(headerSnapshot);
  const hadBody = request.body !== null;
  const body = await readBoundedBody(request.body);
  try {
    return {
      request: new Request(request.url, {
        method: request.method,
        headers,
        ...(hadBody && request.method !== "GET" && request.method !== "HEAD"
          ? { body: body.slice() }
          : {}),
        signal: request.signal,
      }),
      body,
    };
  } catch {
    throw new BoundedBodyReadError("mcp_body_read_failed");
  }
}

/**
 * Read one finite MCP JSON body without permitting an application-controlled
 * stream to consume unbounded memory or hold an authority boundary open forever.
 */
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_MCP_JSON_BODY_BYTES,
  timeoutMs = MCP_JSON_BODY_READ_TIMEOUT_MS,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    throw new BoundedBodyReadError("mcp_body_read_failed");
  }

  const timeout = Symbol("mcp_body_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineAt = performance.now() + timeoutMs;
  const read = readAll(reader, maxBytes, deadlineAt);
  // Promise.race installs rejection handlers on every input. Keep an explicit
  // sink as well so a late source failure after timeout can never become an
  // unhandled rejection in a host process.
  void read.catch(() => {});
  const timeoutSignal = new Promise<typeof timeout>((resolve) => {
    timer = setTimeout(() => resolve(timeout), timeoutMs);
  });
  try {
    const outcome = await Promise.race([read, timeoutSignal]);
    if (outcome === timeout) {
      cancelReader(reader);
      throw new BoundedBodyReadError("mcp_body_read_timeout");
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  deadline: number,
): Promise<Uint8Array> {
  let buffer: Uint8Array;
  try {
    buffer = new Uint8Array(maxBytes);
  } catch {
    cancelReader(reader);
    throw new BoundedBodyReadError("mcp_body_too_large");
  }
  let total = 0;
  try {
    for (;;) {
      // A hostile stream can keep resolving reads with empty chunks. That
      // starves the timer task while consuming only microtasks, so enforce the
      // monotonic deadline inside the loop as well as with the outer race.
      if (performance.now() >= deadline) {
        cancelReader(reader);
        throw new BoundedBodyReadError("mcp_body_read_timeout");
      }
      const next = await reader.read();
      if (performance.now() >= deadline) {
        cancelReader(reader);
        throw new BoundedBodyReadError("mcp_body_read_timeout");
      }
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      if (next.value.byteLength > maxBytes - total) {
        cancelReader(reader);
        throw new BoundedBodyReadError("mcp_body_too_large");
      }
      buffer.set(next.value, total);
      total += next.value.byteLength;
    }
    reader.releaseLock();
  } catch (error) {
    if (error instanceof BoundedBodyReadError) throw error;
    cancelReader(reader);
    throw new BoundedBodyReadError("mcp_body_read_failed");
  }
  return total === buffer.byteLength ? buffer : buffer.slice(0, total);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const cancellation = reader.cancel();
    void cancellation.catch(() => {});
  } catch {
    // Source-controlled cancellation may throw or never settle. It cannot
    // replace or delay the fixed boundary outcome.
  }
}
