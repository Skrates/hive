import type { ServerResponse } from "node:http";

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
