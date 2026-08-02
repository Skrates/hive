import {
  classifyInboundRequest,
  isCallToolResult,
  specTypeSchemas,
} from "@modelcontextprotocol/server";
import {
  acceptsMcpJsonAndSse,
  parseHttpMediaTypeEssence,
} from "./http-media-type.js";
import { decodeJsonBytes } from "./json-security.js";
import { MCP_CONFORMANCE_MANIFEST } from "./schemas.js";

export interface FinalToolsCallContext {
  readonly toolName: string;
  readonly requestId: string | number;
}

/**
 * Bind secret-bearing response handling only to a complete final-2026 wire
 * request. The SDK classifier proves the JSON-RPC/envelope/version shape; the
 * client-side seam additionally proves the HTTP content negotiation and the
 * standard headers that the server entry validates before dispatch.
 */
export async function readFinalToolsCallContext(
  request: Request,
  bodyBytes: Uint8Array,
): Promise<FinalToolsCallContext | null> {
  if (
    request.method !== "POST"
    || parseHttpMediaTypeEssence(request.headers.get("content-type")) !== "application/json"
    || !acceptsMcpJsonAndSse(request.headers.get("accept"))
  ) return null;

  let body: unknown;
  try {
    body = JSON.parse(decodeJsonBytes(bodyBytes)) as unknown;
  } catch {
    return null;
  }
  const protocolVersionHeader = request.headers.get("mcp-protocol-version");
  const mcpMethodHeader = request.headers.get("mcp-method");
  const mcpNameHeader = request.headers.get("mcp-name");
  if (protocolVersionHeader !== MCP_CONFORMANCE_MANIFEST.stableCore.protocolVersion) return null;
  const classified = classifyInboundRequest({
    httpMethod: request.method,
    ...(protocolVersionHeader === null ? {} : { protocolVersionHeader }),
    ...(mcpMethodHeader === null ? {} : { mcpMethodHeader }),
    ...(mcpNameHeader === null ? {} : { mcpNameHeader }),
    body,
  });
  if (
    classified.kind !== "modern"
    || classified.messageKind !== "request"
    || classified.classification.era !== "modern"
    || classified.classification.revision
      !== MCP_CONFORMANCE_MANIFEST.stableCore.protocolVersion
    || classified.message.method !== "tools/call"
    || request.headers.get("mcp-method") !== "tools/call"
  ) return null;

  const params = classified.message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const callToolValidation = await specTypeSchemas.CallToolRequest["~standard"].validate(body);
  if ("issues" in callToolValidation) return null;
  const toolName = (params as Record<string, unknown>).name;
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  const encodedName = request.headers.get("mcp-name");
  if (encodedName === null || decodeMcpHeaderValue(encodedName) !== toolName) return null;
  const requestId = classified.message.id;
  if (typeof requestId !== "string" && typeof requestId !== "number") return null;
  return { toolName, requestId };
}

/**
 * Keep the split-v2 runtime schema at the adapter boundary. Domain-facing
 * authentication code receives only a boolean and no SDK type.
 */
export function isSuccessfulCallToolResult(value: unknown): boolean {
  return isCallToolResult(value)
    && value.resultType === "complete"
    && value.isError !== true;
}

function decodeMcpHeaderValue(value: string): string | null {
  const normalized = value.replace(/^[\t ]+|[\t ]+$/g, "");
  if (!(normalized.startsWith("=?base64?") && normalized.endsWith("?="))) {
    return normalized;
  }
  const payload = normalized.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    return null;
  }
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0)!);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
