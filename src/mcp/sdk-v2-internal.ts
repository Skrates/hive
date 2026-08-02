import {
  McpServer,
  createMcpHandler,
  hostHeaderValidationResponse,
  isLegacyRequest,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  AuthenticationHeaderError,
  AuthenticationResponseStager,
} from "./authentication-headers.js";
import {
  validateHivePrincipal,
  type HivePrincipal,
  type RequestingEdgeHealth,
} from "./catalog.js";
import { formatBrokerHandle, normalizeBrokerUuid } from "./handles.js";
import { MCP_CONFORMANCE_MANIFEST } from "./schemas.js";

const SERVER_IDENTITY = Object.freeze({ name: "hive", version: "0.4.0" });
const REDACTED_BEARER = "hive-authenticated-principal";

export interface HiveMcpAuthenticator {
  authenticate(request: Request): Promise<HivePrincipal | null>;
}

export interface HiveMcpConformanceFixture {
  readRequestingEdgeHealth(
    edgeId: string,
    principal: HivePrincipal,
  ): Promise<RequestingEdgeHealth>;
  onServerCreated?(principal: HivePrincipal): void;
}

export interface HiveMcpAdapterOptions {
  readonly brokerUuid: string;
  readonly authenticator: HiveMcpAuthenticator;
  readonly allowedHostnames?: readonly string[];
  readonly allowedOriginHostnames?: readonly string[];
}

/**
 * The split-v2 SDK terminates inside this adapter. Callers see only Web
 * Platform and Hive domain types; KRA-899 owns the production Node mount.
 */
export interface HiveMcpAdapter {
  readonly authenticationHeaders: AuthenticationResponseStager;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Internal constructor; import policy confines fixture injection to test support. */
export function createHiveMcpAdapterInternal(
  options: HiveMcpAdapterOptions,
  fixture?: HiveMcpConformanceFixture,
): HiveMcpAdapter {
  return new HiveMcpAdapterImplementation(options, fixture);
}

class HiveMcpAdapterImplementation implements HiveMcpAdapter {
  readonly authenticationHeaders = new AuthenticationResponseStager("broker");

  private readonly brokerUuid: string;
  private readonly authenticator: HiveMcpAuthenticator;
  private readonly allowedHostnames: string[];
  private readonly allowedOriginHostnames: string[];
  private readonly conformanceFixture: HiveMcpConformanceFixture | undefined;
  private readonly handler: McpHttpHandler;

  constructor(
    options: HiveMcpAdapterOptions,
    conformanceFixture?: HiveMcpConformanceFixture,
  ) {
    this.brokerUuid = normalizeBrokerUuid(options.brokerUuid);
    this.authenticator = options.authenticator;
    this.allowedHostnames = [...(options.allowedHostnames ?? localhostAllowedHostnames())];
    this.allowedOriginHostnames = [
      ...(options.allowedOriginHostnames ?? localhostAllowedOrigins()),
    ];
    if (this.allowedHostnames.length === 0 || this.allowedOriginHostnames.length === 0) {
      throw new Error("empty_mcp_host_or_origin_allowlist");
    }
    this.conformanceFixture = conformanceFixture;
    this.handler = createMcpHandler(
      ({ era, authInfo }) => {
        if (era !== "modern") throw new Error("legacy_mcp_factory_invocation");
        const principal = principalFromAuthInfo(authInfo);
        this.conformanceFixture?.onServerCreated?.(principal);
        return createPrincipalFilteredServer(
          this.brokerUuid,
          principal,
          this.conformanceFixture,
        );
      },
      {
        legacy: "reject",
        responseMode: "json",
      },
    );
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.fetchBeforeCredentialFirewall(request);
    return await enforceAuthorizationCredentialNegativeResponse(
      response,
      request.headers.get("authorization"),
    );
  }

  private async fetchBeforeCredentialFirewall(request: Request): Promise<Response> {
    const hostRejected = hostHeaderValidationResponse(request, this.allowedHostnames);
    if (hostRejected) return hostRejected;
    const originRejected = originValidationResponse(request, this.allowedOriginHostnames);
    if (originRejected) return originRejected;

    if (
      request.method === "POST"
      && !request.headers.get("mcp-protocol-version")
      && !await isLegacyRequest(request)
    ) {
      return await missingProtocolVersionResponse(request);
    }

    // Final 2026-07-28 stateless transport ignores these removed mechanisms.
    // Strip them before authentication and SDK dispatch so no downstream
    // component can accidentally interpret or echo them.
    const authenticationRequest = withoutHeaders(request, [
      "mcp-session-id",
      "last-event-id",
    ]);
    // Authentication may inspect the complete body. Give it an independent
    // branch so a body-consuming authenticator cannot disturb SDK dispatch.
    const principal = await authenticateSafely(
      this.authenticator,
      authenticationRequest.clone(),
    );
    if (!principal) return unauthenticatedResponse();
    if (
      request.method === "POST"
      && !acceptsModernMcpResponses(authenticationRequest.headers.get("accept"))
    ) {
      return notAcceptableResponse();
    }

    // The raw bearer terminates at the authentication seam. The SDK receives
    // a display-safe synthetic token and the validated Hive principal only.
    const sdkRequest = withoutHeaders(authenticationRequest, ["authorization"]);
    const authInfo = authInfoForPrincipal(principal);
    try {
      return await this.authenticationHeaders.run(
        sdkRequest,
        (stagedRequest) => this.handler.fetch(stagedRequest, { authInfo }),
      );
    } catch (error) {
      if (error instanceof AuthenticationHeaderError) return secretHeaderFailureResponse();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handler.close();
  }
}

function createPrincipalFilteredServer(
  brokerUuid: string,
  principal: HivePrincipal,
  conformanceFixture: HiveMcpConformanceFixture | undefined,
): McpServer {
  const exposesRequestingEdgeHealth = conformanceFixture !== undefined
    && principal.kind === "edge"
    && principal.edgeId !== undefined;
  const server = new McpServer(SERVER_IDENTITY, {
    supportedProtocolVersions: [MCP_CONFORMANCE_MANIFEST.stableCore.protocolVersion],
    ...(exposesRequestingEdgeHealth
      ? { capabilities: { resources: { listChanged: false } } }
      : {}),
    cacheHints: {
      "server/discover": { cacheScope: "private", ttlMs: 5_000 },
      "tools/list": { cacheScope: "private", ttlMs: 5_000 },
      "prompts/list": { cacheScope: "private", ttlMs: 5_000 },
      "resources/list": { cacheScope: "private", ttlMs: 5_000 },
      "resources/templates/list": { cacheScope: "private", ttlMs: 5_000 },
      "resources/read": { cacheScope: "private", ttlMs: 0 },
    },
  });
  if (
    exposesRequestingEdgeHealth
    && conformanceFixture
    && principal.edgeId !== undefined
  ) {
    const edgeId = principal.edgeId;
    const uri = formatBrokerHandle(brokerUuid, "edge", { edgeId });
    server.registerResource(
      "hive.edge.health",
      uri,
      {
        title: "Requesting edge health",
        description: "Conformance-only projection for the authenticated requesting edge.",
        mimeType: "application/json",
        cacheHint: { cacheScope: "private", ttlMs: 0 },
      },
      async (requestedUri) => {
        if (requestedUri.href !== uri) throw new Error("hidden_resource");
        const health = validateRequestingEdgeHealth(
          await conformanceFixture.readRequestingEdgeHealth(edgeId, principal),
          edgeId,
        );
        return {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify(health),
          }],
        };
      },
    );
  }
  return server;
}

async function authenticateSafely(
  authenticator: HiveMcpAuthenticator,
  request: Request,
): Promise<HivePrincipal | null> {
  try {
    const principal = await authenticator.authenticate(request);
    return principal ? validateHivePrincipal(principal) : null;
  } catch {
    return null;
  }
}

function authInfoForPrincipal(principal: HivePrincipal): AuthInfo {
  return {
    token: REDACTED_BEARER,
    clientId: principal.id,
    scopes: [...principal.scopes],
    extra: { hivePrincipal: principal },
  };
}

function principalFromAuthInfo(authInfo: AuthInfo | undefined): HivePrincipal {
  const principal = authInfo?.extra?.hivePrincipal;
  if (!principal || typeof principal !== "object") throw new Error("missing_hive_principal");
  return validateHivePrincipal(principal as HivePrincipal);
}

function withoutHeaders(request: Request, names: readonly string[]): Request {
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

function validateRequestingEdgeHealth(
  value: RequestingEdgeHealth,
  expectedEdgeId: string,
): RequestingEdgeHealth {
  if (
    value.edgeId !== expectedEdgeId
    || !["healthy", "degraded", "unavailable"].includes(value.status)
    || !isCanonicalTimestamp(value.observedAt)
  ) {
    throw new Error("invalid_requesting_edge_health");
  }
  // Emit only the declared projection. A fixture or future store row must not
  // smuggle credentials or other undeclared fields into an MCP resource.
  return Object.freeze({
    edgeId: value.edgeId,
    status: value.status,
    observedAt: value.observedAt,
  });
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function unauthenticatedResponse(): Response {
  return jsonRpcErrorResponse(401, -32_000, "Authentication required.", {
    "www-authenticate": "Bearer",
  });
}

function secretHeaderFailureResponse(): Response {
  return jsonRpcErrorResponse(500, -32_603, "Internal error.");
}

function notAcceptableResponse(): Response {
  return jsonRpcErrorResponse(
    406,
    -32_000,
    "Not Acceptable: Accept must list application/json and text/event-stream.",
  );
}

async function missingProtocolVersionResponse(request: Request): Promise<Response> {
  let id: string | number | null = null;
  try {
    const body = await request.clone().json() as {
      id?: unknown;
    };
    if (typeof body.id === "string" || typeof body.id === "number") id = body.id;
  } catch {
    // Classification already established a modern claim. Preserve a safe null
    // id only if an otherwise valid request id cannot be recovered.
  }
  return jsonRpcErrorResponse(
    400,
    -32_020,
    "Bad Request: required protocol metadata is missing or inconsistent.",
    {},
    id,
    { mismatch: { header: "missing", body: "present" } },
  );
}

function secretCandidatesFromAuthorization(value: string | null): readonly string[] {
  if (!value) return [];
  const candidates = new Set<string>();
  candidates.add(value);
  const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1];
  if (bearer) candidates.add(bearer);
  return [...candidates];
}

export async function enforceAuthorizationCredentialNegativeResponse(
  response: Response,
  authorization: string | null,
): Promise<Response> {
  return await enforceCredentialNegativeResponse(
    response,
    secretCandidatesFromAuthorization(authorization),
  );
}

async function enforceCredentialNegativeResponse(
  response: Response,
  secrets: readonly string[],
): Promise<Response> {
  if (secrets.length === 0) return response;
  const metadataLeak = responseMetadataLeaksSecret(response, secrets);
  const mediaType = responseMediaType(response);
  if (mediaType !== "application/json") {
    if (metadataLeak) return sanitizeCredentialReflectingResponse(response, null, secrets);
    if (!response.body) return response;
    const protectedBody = mediaType === "text/event-stream"
      ? secretNegativeSseStream(response.body, secrets)
      : secretNegativeStream(response.body, secrets);
    return new Response(protectedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const serializedBody = await response.clone().text();
  const bodyLeak = secrets.some((secret) =>
    serializedBody.includes(secret)
    || semanticJsonContainsSecret(parseJson(serializedBody), secret));
  if (!metadataLeak && !bodyLeak) return response;
  return sanitizeCredentialReflectingResponse(response, serializedBody, secrets);
}

function responseMetadataLeaksSecret(response: Response, secrets: readonly string[]): boolean {
  return secrets.some((secret) => {
    if (response.statusText.includes(secret)) return true;
    const lowerSecret = secret.toLowerCase();
    for (const [name, value] of response.headers.entries()) {
      if (name.toLowerCase().includes(lowerSecret) || value.includes(secret)) return true;
    }
    return false;
  });
}

async function sanitizeCredentialReflectingResponse(
  response: Response,
  serializedBody: string | null,
  secrets: readonly string[],
): Promise<Response> {

  let id: string | number | null = null;
  let code = -32_603;
  if (serializedBody !== null) {
    try {
      const body = JSON.parse(serializedBody) as {
        id?: unknown;
        error?: { code?: unknown };
      };
      const candidateId = body.id;
      if (typeof candidateId === "number") id = candidateId;
      if (
        typeof candidateId === "string"
        && !secrets.some((secret) => candidateId.includes(secret))
      ) id = candidateId;
      if (typeof body.error?.code === "number") code = body.error.code;
    } catch {
      // A credential-reflecting malformed response becomes a constant failure.
    }
  }
  const status = response.status >= 400 ? response.status : 500;
  const replacement = jsonRpcErrorResponse(
    status,
    code,
    constantCredentialNegativeMessage(status, code),
    {},
    id,
  );
  const replacementBytes = await replacement.clone().text();
  if (secrets.some((secret) => replacementBytes.includes(secret))) {
    return new Response(null, {
      status: 500,
      headers: { "cache-control": "no-store" },
    });
  }
  return replacement;
}

function responseMediaType(response: Response): string | null {
  const value = response.headers.get("content-type");
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function semanticJsonContainsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => semanticJsonContainsSecret(item, secret));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      key.includes(secret) || semanticJsonContainsSecret(item, secret));
  }
  return false;
}

function secretNegativeStream(
  stream: ReadableStream<Uint8Array>,
  secrets: readonly string[],
): ReadableStream<Uint8Array> {
  const needles = secrets.map((secret) => new TextEncoder().encode(secret));
  const retainedBytes = Math.max(...needles.map((needle) => needle.byteLength)) - 1;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const combined = concatenateBytes(pending, chunk);
      if (needles.some((needle) => containsBytes(combined, needle))) {
        controller.error(new Error("credential_reflection"));
        return;
      }
      const emitLength = Math.max(0, combined.byteLength - retainedBytes);
      if (emitLength > 0) controller.enqueue(combined.slice(0, emitLength));
      pending = combined.slice(emitLength);
    },
    flush(controller) {
      if (needles.some((needle) => containsBytes(pending, needle))) {
        controller.error(new Error("credential_reflection"));
        return;
      }
      if (pending.byteLength > 0) controller.enqueue(pending);
    },
  }));
}

const MAX_SSE_EVENT_BYTES = 1_048_576;

function secretNegativeSseStream(
  stream: ReadableStream<Uint8Array>,
  secrets: readonly string[],
): ReadableStream<Uint8Array> {
  const needles = secrets.map((secret) => new TextEncoder().encode(secret));
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending = concatenateBytes(pending, chunk);
      let eventEnd = findSseEventEnd(pending);
      while (eventEnd !== -1) {
        const event = pending.slice(0, eventEnd);
        assertCredentialNegativeSseEvent(event, secrets, needles, false);
        controller.enqueue(event);
        pending = pending.slice(eventEnd);
        eventEnd = findSseEventEnd(pending);
      }
      if (pending.byteLength > MAX_SSE_EVENT_BYTES) {
        controller.error(new Error("credential_firewall_sse_event_too_large"));
      }
    },
    flush(controller) {
      let eventEnd = findSseEventEnd(pending, true);
      while (eventEnd !== -1) {
        const event = pending.slice(0, eventEnd);
        assertCredentialNegativeSseEvent(event, secrets, needles, false);
        controller.enqueue(event);
        pending = pending.slice(eventEnd);
        eventEnd = findSseEventEnd(pending, true);
      }
      if (pending.byteLength === 0) return;
      assertCredentialNegativeSseEvent(pending, secrets, needles, true);
      controller.enqueue(pending);
    },
  }));
}

function findSseEventEnd(bytes: Uint8Array, eof = false): number {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const firstLength = sseLineEndingLength(bytes, index, eof);
    if (firstLength === 0) continue;
    const secondStart = index + firstLength;
    const secondLength = sseLineEndingLength(bytes, secondStart, eof);
    if (secondLength > 0) return secondStart + secondLength;
    index += firstLength - 1;
  }
  return -1;
}

function sseLineEndingLength(bytes: Uint8Array, index: number, eof: boolean): number {
  const byte = bytes[index];
  if (byte === 0x0a) return 1;
  if (byte !== 0x0d) return 0;
  if (index + 1 >= bytes.byteLength) return eof ? 1 : 0;
  return bytes[index + 1] === 0x0a ? 2 : 1;
}

function assertCredentialNegativeSseEvent(
  bytes: Uint8Array,
  secrets: readonly string[],
  needles: readonly Uint8Array[],
  unterminated: boolean,
): void {
  if (bytes.byteLength > MAX_SSE_EVENT_BYTES) {
    throw new Error("credential_firewall_sse_event_too_large");
  }
  if (needles.some((needle) => containsBytes(bytes, needle))) {
    throw new Error("credential_reflection");
  }
  let eventText: string;
  try {
    eventText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("credential_firewall_invalid_sse_utf8");
  }
  const data = sseDataPayload(eventText);
  if (data === null) return;
  if (unterminated) throw new Error("credential_firewall_unterminated_sse_event");
  const parsed = parseJson(data);
  if (parsed === null) throw new Error("credential_firewall_invalid_sse_json");
  if (secrets.some((secret) => semanticJsonContainsSecret(parsed, secret))) {
    throw new Error("credential_reflection");
  }
}

function sseDataPayload(eventText: string): string | null {
  const values: string[] = [];
  for (const line of eventText.split(/\r\n|\r|\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    values.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return values.length === 0 ? null : values.join("\n");
}

function concatenateBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first, 0);
  combined.set(second, first.byteLength);
  return combined;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false;
  outer: for (let start = 0; start <= haystack.byteLength - needle.byteLength; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function constantCredentialNegativeMessage(status: number, code: number): string {
  if (code === -32_020) return "Bad Request: request metadata mismatch.";
  if (code === -32_022) return "Unsupported protocol version.";
  if (status === 403) return "Forbidden.";
  if (status === 406) return "Not Acceptable.";
  if (status >= 400 && status < 500) return "Request rejected.";
  return "Internal error.";
}

function acceptsModernMcpResponses(value: string | null): boolean {
  if (!value) return false;
  const accepted = new Set<string>();
  for (const item of value.split(",")) {
    const parts = item.split(";").map((part) => part.trim().toLowerCase());
    const mediaType = parts[0];
    if (!mediaType) continue;
    const quality = parts.find((part) => part.startsWith("q="));
    if (quality !== undefined) {
      const parsed = Number(quality.slice(2));
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) continue;
    }
    accepted.add(mediaType);
  }
  return accepted.has("application/json") && accepted.has("text/event-stream");
}

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
  id: string | number | null = null,
  data?: unknown,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code, message, ...(data === undefined ? {} : { data }) },
      id,
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...Object.fromEntries(new Headers(extraHeaders)),
      },
    },
  );
}
