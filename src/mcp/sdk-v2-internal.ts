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
import { captureBoundedRequest, readBoundedBody } from "./bounded-body.js";
import {
  validateHivePrincipal,
  type HivePrincipal,
  type RequestingEdgeHealth,
} from "./catalog.js";
import {
  hasAmbiguousProtectedCredentialHeaders,
  protectedSecretCandidatesFromHeaders,
  protectedSecretCandidatesFromRequest,
} from "./credential-secrets.js";
import { formatBrokerHandle, normalizeBrokerUuid } from "./handles.js";
import {
  acceptsMcpJsonAndSse,
  parseHttpMediaTypeEssence,
} from "./http-media-type.js";
import { decodeJsonBytes, parseCredentialNegativeJson } from "./json-security.js";
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
    // Snapshot credential-shaped metadata before the first await. Neither an
    // application-controlled body pull nor a caller retaining the source
    // Request may erase a value that authentication or dispatch observed.
    const requestHeaders = new Headers(request.headers);
    const requestSecrets = protectedSecretCandidatesFromHeaders(requestHeaders);
    const response = await this.fetchBeforeCredentialFirewall(request, requestHeaders);
    return await enforceCredentialNegativeResponse(
      response,
      requestSecrets,
    );
  }

  private async fetchBeforeCredentialFirewall(
    request: Request,
    requestHeaders: Headers,
  ): Promise<Response> {
    const metadataRequest = new Request(request.url, {
      method: request.method,
      headers: requestHeaders,
    });
    const hostRejected = hostHeaderValidationResponse(metadataRequest, this.allowedHostnames);
    if (hostRejected) {
      cancelRequestBody(request);
      return hostRejected;
    }
    const originRejected = originValidationResponse(metadataRequest, this.allowedOriginHostnames);
    if (originRejected) {
      cancelRequestBody(request);
      return originRejected;
    }

    // Final 2026-07-28 stateless transport ignores these removed mechanisms.
    // Strip them before authentication and SDK dispatch so no downstream
    // component can accidentally interpret or echo them.
    const authenticationHeaders = new Headers(requestHeaders);
    authenticationHeaders.delete("mcp-session-id");
    authenticationHeaders.delete("last-event-id");
    // This broker adapter accepts no Hive-* request header. The sole canonical
    // request-only header belongs to the future provider-ingress adapter and
    // must be verified and stripped there before domain dispatch (KRA-908).
    if (hasHiveRequestHeader(authenticationHeaders)) {
      cancelRequestBody(request);
      return invalidHiveRequestHeaderResponse();
    }
    if (hasAmbiguousProtectedCredentialHeaders(authenticationHeaders)) {
      cancelRequestBody(request);
      return invalidHiveRequestHeaderResponse();
    }
    if (hasCanonicalCredentialNegativeCollision(
      protectedSecretCandidatesFromHeaders(authenticationHeaders),
    )) {
      cancelRequestBody(request);
      return invalidHiveRequestHeaderResponse();
    }
    if (request.method !== "POST") {
      cancelRequestBody(request);
      return methodNotAllowedResponse();
    }
    if (
      parseHttpMediaTypeEssence(authenticationHeaders.get("content-type"))
        !== "application/json"
    ) {
      cancelRequestBody(request);
      return unsupportedMediaTypeResponse();
    }
    if (
      !acceptsMcpJsonAndSse(authenticationHeaders.get("accept"))
    ) {
      cancelRequestBody(request);
      return notAcceptableResponse();
    }
    let capturedRequest: Awaited<ReturnType<typeof captureBoundedRequest>>;
    try {
      capturedRequest = await captureBoundedRequest(request, authenticationHeaders);
    } catch {
      return invalidRequestBodyResponse();
    }
    const authenticationRequest = capturedRequest.request;
    // Authentication may inspect the complete body. Give it an independent
    // branch so a body-consuming authenticator cannot disturb SDK dispatch.
    const principal = await authenticateSafely(
      this.authenticator,
      authenticationRequest.clone(),
    );
    if (!principal) return unauthenticatedResponse();
    if (
      request.method === "POST"
      && !authenticationRequest.headers.get("mcp-protocol-version")
      && !await isLegacyRequest(authenticationRequest)
    ) {
      return await missingProtocolVersionResponse(authenticationRequest);
    }
    if (request.method === "POST" && !isValidJsonBody(capturedRequest.body)) {
      return parseErrorResponse();
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

function cancelRequestBody(request: Request): void {
  try {
    const cancellation = request.body?.cancel();
    void cancellation?.catch(() => {});
  } catch {
    // A caller-controlled upload cannot delay or replace the fixed rejection.
  }
}

function withoutHeaders(request: Request, names: readonly string[]): Request {
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

function hasHiveRequestHeader(headers: Headers): boolean {
  for (const [name] of headers.entries()) {
    if (name.toLowerCase().startsWith("hive-")) return true;
  }
  return false;
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

function invalidHiveRequestHeaderResponse(): Response {
  return jsonRpcErrorResponse(400, -32_600, "Invalid Request: unsupported authentication metadata.");
}

function invalidRequestBodyResponse(): Response {
  return jsonRpcErrorResponse(400, -32_600, "Invalid Request: malformed or unbounded body.");
}

function parseErrorResponse(): Response {
  return jsonRpcErrorResponse(400, -32_700, "Parse error.");
}

function isValidJsonBody(body: Uint8Array): boolean {
  try {
    JSON.parse(decodeJsonBytes(body));
    return true;
  } catch {
    return false;
  }
}

function unsupportedMediaTypeResponse(): Response {
  return jsonRpcErrorResponse(
    415,
    -32_000,
    "Unsupported Media Type: Content-Type must be application/json",
  );
}

function notAcceptableResponse(): Response {
  return jsonRpcErrorResponse(
    406,
    -32_000,
    "Not Acceptable: Accept must list application/json and text/event-stream.",
  );
}

function methodNotAllowedResponse(): Response {
  return jsonRpcErrorResponse(405, -32_000, "Method not allowed.");
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

export async function enforceAuthorizationCredentialNegativeResponse(
  response: Response,
  authorization: string | null,
): Promise<Response> {
  const request = new Request("http://localhost/mcp", {
    headers: authorization ? { authorization } : {},
  });
  return await enforceCredentialNegativeResponse(
    response,
    protectedSecretCandidatesFromRequest(request),
  );
}

async function enforceCredentialNegativeResponse(
  response: Response,
  secrets: readonly string[],
): Promise<Response> {
  if (secrets.length === 0) return response;
  const metadata = snapshotResponseMetadata(response);
  const metadataLeak = responseMetadataLeaksSecret(metadata, secrets);
  if (metadataLeak || !hasScannableContentEncoding(metadata.headers.get("content-encoding"))) {
    return sanitizeCredentialReflectingResponse(response, null, secrets);
  }
  if (!response.body) {
    return new Response(null, metadata);
  }
  const contentType = metadata.headers.get("content-type");
  if (isJsonLikeContentType(contentType)) {
    return await preflightCredentialNegativeJsonResponse(response, metadata, secrets);
  }
  if (!isEventStreamContentType(contentType)) {
    return sanitizeCredentialReflectingResponse(response, null, secrets);
  }
  const protectedSource = collapseCredentialStreamErrors(response.body);
  const protectedBody = secretNegativeSseStream(protectedSource, secrets);
  return new Response(protectedBody, {
    status: metadata.status,
    statusText: metadata.statusText,
    headers: metadata.headers,
  });
}

interface ResponseMetadataSnapshot {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
}

function snapshotResponseMetadata(response: Response): ResponseMetadataSnapshot {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  };
}

async function preflightCredentialNegativeJsonResponse(
  response: Response,
  metadata: ResponseMetadataSnapshot,
  secrets: readonly string[],
): Promise<Response> {
  let bytes: Uint8Array;
  let serialized: string;
  try {
    bytes = await readBoundedBody(response.body);
    serialized = decodeJsonBytes(bytes);
    if (secrets.some((secret) => serialized.includes(secret))) {
      return sanitizeCredentialReflectingResponse(response, serialized, secrets);
    }
    parseCredentialNegativeJson(serialized, secrets);
  } catch {
    return sanitizeCredentialReflectingResponse(response, null, secrets);
  }
  return new Response(bytes, {
    status: metadata.status,
    statusText: metadata.statusText,
    headers: metadata.headers,
  });
}

const CREDENTIAL_FIREWALL_SOURCE_FAILURE = "credential_firewall_source_failure";

/**
 * A response body is application-controlled and its stream error reason may
 * itself contain an authorization value or an owner-private path. Proxy it
 * one chunk per pull so backpressure survives, while replacing every source
 * failure and cancellation failure with a fixed secret-negative boundary.
 */
function collapseCredentialStreamErrors(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(CREDENTIAL_FIREWALL_SOURCE_FAILURE));
      },
    });
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.error(new Error(CREDENTIAL_FIREWALL_SOURCE_FAILURE));
        cancelStreamReader(reader);
      }
    },
    cancel() {
      cancelStreamReader(reader);
    },
  });
}

function cancelStreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const cancellation = reader.cancel();
    void cancellation.catch(() => {});
  } catch {
    // Application-controlled cancellation cannot delay or replace the public
    // stream outcome.
  }
}

function responseMetadataLeaksSecret(
  response: ResponseMetadataSnapshot,
  secrets: readonly string[],
): boolean {
  return secrets.some((secret) => {
    if (String(response.status).includes(secret)) return true;
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
      const errorCode = body.error?.code;
      if (typeof errorCode === "number" && Number.isSafeInteger(errorCode)) code = errorCode;
    } catch {
      // A credential-reflecting malformed response becomes a constant failure.
    }
  }
  const status = response.status >= 400 ? response.status : 500;
  // The replacement severs the caller from the original response. Cancel its
  // body first so an open SSE handler, keepalive, or transport cannot survive
  // behind the constant-shape error with no remaining cancellation path.
  cancelResponseBody(response);
  const replacement = jsonRpcErrorResponse(
    status,
    code,
    constantCredentialNegativeMessage(status, code),
    {},
    id,
  );
  const replacementBytes = await replacement.clone().text();
  const replacementMetadata = snapshotResponseMetadata(replacement);
  if (
    secrets.some((secret) => replacementBytes.includes(secret))
    || responseMetadataLeaksSecret(replacementMetadata, secrets)
  ) {
    // If request text collides with the immutable JSON-RPC grammar itself,
    // byte-level absence is impossible (for example a bearer named `id`).
    // Admission rejects those values before authentication or dispatch; this
    // fixed scaffold then contains no application-controlled response bytes.
    return canonicalCredentialNegativeResponse();
  }
  return replacement;
}

const CANONICAL_CREDENTIAL_NEGATIVE_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error."},"id":null}';
const CANONICAL_CREDENTIAL_NEGATIVE_HEADER_NAMES = Object.freeze([
  "cache-control",
  "content-type",
]);
const CANONICAL_CREDENTIAL_NEGATIVE_METADATA_VALUES = Object.freeze([
  "500",
  "no-store",
  "application/json",
]);

function hasCanonicalCredentialNegativeCollision(secrets: readonly string[]): boolean {
  return secrets.some((secret) =>
    CANONICAL_CREDENTIAL_NEGATIVE_BODY.includes(secret)
    || CANONICAL_CREDENTIAL_NEGATIVE_HEADER_NAMES.some((name) =>
      name.includes(secret.toLowerCase()))
    || CANONICAL_CREDENTIAL_NEGATIVE_METADATA_VALUES.some((value) => value.includes(secret)));
}

function canonicalCredentialNegativeResponse(): Response {
  return new Response(CANONICAL_CREDENTIAL_NEGATIVE_BODY, {
    status: 500,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => {});
  } catch {
    // Cancellation is best-effort and its application-controlled failure is
    // never allowed to replace or delay the constant safe response.
  }
}

function hasScannableContentEncoding(value: string | null): boolean {
  return value === null || value.trim().toLowerCase() === "identity";
}

function isJsonLikeContentType(value: string | null): boolean {
  const mediaType = parseHttpMediaTypeEssence(value);
  return mediaType === "application/json"
    || (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
}

function isEventStreamContentType(value: string | null): boolean {
  return parseHttpMediaTypeEssence(value) === "text/event-stream";
}

const MAX_SSE_EVENT_BYTES = 1_048_576;

function secretNegativeSseStream(
  stream: ReadableStream<Uint8Array>,
  secrets: readonly string[],
): ReadableStream<Uint8Array> {
  const eventBuffer = new Uint8Array(MAX_SSE_EVENT_BYTES);
  let eventBytes = 0;
  let previousLineEnding = false;
  let previousWasCr = false;
  let leadingLfContinuesEmittedCr = false;
  let currentChunk: Uint8Array | null = null;
  let currentOffset = 0;
  let sourceDone = false;
  let emptyChunks = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(CREDENTIAL_FIREWALL_SOURCE_FAILURE));
      },
    });
  }

  async function hasInput(): Promise<boolean> {
    while (currentChunk === null || currentOffset >= currentChunk.byteLength) {
      if (sourceDone) return false;
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const next = await reader.read();
        done = next.done;
        value = next.value;
      } catch {
        throw new Error(CREDENTIAL_FIREWALL_SOURCE_FAILURE);
      }
      if (done) {
        sourceDone = true;
        currentChunk = null;
        return false;
      }
      if (value === undefined) throw new Error(CREDENTIAL_FIREWALL_SOURCE_FAILURE);
      if (value.byteLength === 0) {
        emptyChunks += 1;
        if (emptyChunks > 1_024) throw new Error(CREDENTIAL_FIREWALL_SOURCE_FAILURE);
        continue;
      }
      emptyChunks = 0;
      currentChunk = value;
      currentOffset = 0;
    }
    return true;
  }

  function appendByte(byte: number): void {
    if (eventBytes >= eventBuffer.byteLength) {
      throw new Error("credential_firewall_sse_event_too_large");
    }
    eventBuffer[eventBytes] = byte;
    eventBytes += 1;
  }

  function emitEvent(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const event = eventBuffer.slice(0, eventBytes);
    assertCredentialNegativeSseEvent(event, secrets, false);
    controller.enqueue(event);
    eventBytes = 0;
    previousLineEnding = false;
    previousWasCr = false;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A CR delimiter is emitted promptly instead of waiting indefinitely
        // to discover whether a later LF completes CRLF. Preserve that LF as
        // one bounded continuation chunk on the next downstream pull.
        if (leadingLfContinuesEmittedCr) {
          leadingLfContinuesEmittedCr = false;
          if (await hasInput() && currentChunk![currentOffset] === 0x0a) {
            currentOffset += 1;
            controller.enqueue(Uint8Array.of(0x0a));
            return;
          }
        }

        for (;;) {
          if (!await hasInput()) {
            if (eventBytes === 0) {
              controller.close();
              return;
            }
            const event = eventBuffer.slice(0, eventBytes);
            assertCredentialNegativeSseEvent(event, secrets, true);
            controller.enqueue(event);
            eventBytes = 0;
            return;
          }

          const byte = currentChunk![currentOffset]!;
          if (previousWasCr) {
            previousWasCr = false;
            if (byte === 0x0a) {
              appendByte(byte);
              currentOffset += 1;
              continue;
            }
          }

          appendByte(byte);
          currentOffset += 1;
          if (byte !== 0x0d && byte !== 0x0a) {
            previousLineEnding = false;
            continue;
          }
          if (!previousLineEnding) {
            previousLineEnding = true;
            previousWasCr = byte === 0x0d;
            continue;
          }

          emitEvent(controller);
          leadingLfContinuesEmittedCr = byte === 0x0d;
          return;
        }
      } catch (error) {
        cancelStreamReader(reader);
        controller.error(error instanceof Error
          ? error
          : new Error(CREDENTIAL_FIREWALL_SOURCE_FAILURE));
      }
    },
    cancel() {
      cancelStreamReader(reader);
    },
  });
}

function assertCredentialNegativeSseEvent(
  bytes: Uint8Array,
  secrets: readonly string[],
  unterminated: boolean,
): void {
  if (bytes.byteLength > MAX_SSE_EVENT_BYTES) {
    throw new Error("credential_firewall_sse_event_too_large");
  }
  let eventText: string;
  try {
    eventText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("credential_firewall_invalid_sse_utf8");
  }
  // Fatal decoding makes the decoded string a lossless view of valid UTF-8.
  // Delegate substring search to the runtime's linear-time string engine
  // instead of multiplying event size by credential length in userland.
  if (secrets.some((secret) => eventText.includes(secret))) {
    throw new Error("credential_reflection");
  }
  const data = sseDataPayload(eventText);
  if (data === null) return;
  if (unterminated) throw new Error("credential_firewall_unterminated_sse_event");
  try {
    parseCredentialNegativeJson(data, secrets);
  } catch (error) {
    if (error instanceof Error && error.message === "credential_reflection") throw error;
    throw new Error("credential_firewall_invalid_sse_json");
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

function constantCredentialNegativeMessage(status: number, code: number): string {
  if (code === -32_020) return "Bad Request: request metadata mismatch.";
  if (code === -32_022) return "Unsupported protocol version.";
  if (status === 403) return "Forbidden.";
  if (status === 406) return "Not Acceptable.";
  if (status >= 400 && status < 500) return "Request rejected.";
  return "Internal error.";
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
