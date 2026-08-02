import { MCP_CONFORMANCE_MANIFEST } from "./schemas.js";
import {
  createHiveMcpAdapterInternal,
  enforceAuthorizationCredentialNegativeResponse,
  type HiveMcpAdapter,
  type HiveMcpAdapterOptions,
  type HiveMcpConformanceFixture,
} from "./sdk-v2-internal.js";

export const TEST_BROKER_UUID = "123e4567-e89b-42d3-a456-426614174000";
export const TEST_PROTOCOL_VERSION = MCP_CONFORMANCE_MANIFEST.stableCore.protocolVersion;

export interface ModernRequestOptions {
  readonly id?: string | number;
  readonly name?: string;
  readonly clientInfo?: unknown;
  readonly includeClientInfo?: boolean;
  readonly clientCapabilities?: unknown;
  readonly protocolVersion?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export function modernRequest(
  method: string,
  params: Readonly<Record<string, unknown>> = {},
  options: ModernRequestOptions = {},
): Request {
  const envelope: Record<string, unknown> = {
    "io.modelcontextprotocol/protocolVersion": options.protocolVersion ?? TEST_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": options.clientCapabilities ?? {},
  };
  if (options.includeClientInfo || options.clientInfo !== undefined) {
    envelope["io.modelcontextprotocol/clientInfo"] = options.clientInfo ?? {
      name: "hive-conformance-client",
      version: "1.0.0",
    };
  }
  const body = {
    jsonrpc: "2.0",
    id: options.id ?? 1,
    method,
    params: { ...params, _meta: envelope },
  };
  const headers: Record<string, string> = {
    host: "localhost",
    authorization: "Bearer test-secret-never-forward",
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": TEST_PROTOCOL_VERSION,
    "mcp-method": method,
    ...options.headers,
  };
  if (options.name !== undefined) headers["mcp-name"] = options.name;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function rawRequest(
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  method = "POST",
): Request {
  return new Request("http://localhost/mcp", {
    method,
    headers: {
      host: "localhost",
      authorization: "Bearer test-secret-never-forward",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

export async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

export function jsonRpcErrorCode(body: Record<string, unknown>): number | undefined {
  const error = body.error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "number" ? code : undefined;
}
/** Test/conformance-only fixture constructor, blocked from production imports. */
export function createHiveMcpConformanceAdapter(
  options: HiveMcpAdapterOptions,
  fixture: HiveMcpConformanceFixture,
): HiveMcpAdapter {
  return createHiveMcpAdapterInternal(options, fixture);
}

export function applyCredentialFirewallForTest(
  response: Response,
  authorization: string,
): Promise<Response> {
  return enforceAuthorizationCredentialNegativeResponse(response, authorization);
}
