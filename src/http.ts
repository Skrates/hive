import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpErrorEnvelope {
  error: string;
  detail?: string;
}

export function writeJsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export function parseHttpErrorEnvelope(body: string): HttpErrorEnvelope | null {
  try {
    const value = JSON.parse(body) as { error?: unknown; detail?: unknown };
    if (typeof value.error !== "string") return null;
    return typeof value.detail === "string"
      ? { error: value.error, detail: value.detail }
      : { error: value.error };
  } catch {
    return null;
  }
}

export function formatHttpErrorEnvelope(envelope: HttpErrorEnvelope): string {
  return typeof envelope.detail === "string" ? `${envelope.error} — ${envelope.detail}` : envelope.error;
}

/** The `Authorization: Bearer <token>` credential, or null. */
export function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

/** Credential comparison that does not leak the matching prefix length through timing. */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
