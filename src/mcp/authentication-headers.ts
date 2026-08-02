import { AsyncLocalStorage } from "node:async_hooks";
import {
  AUTHENTICATION_HEADER_MANIFEST,
  type AuthenticationResponseHeaderName,
} from "./schemas.js";
import {
  isSuccessfulCallToolResult,
  readFinalToolsCallContext,
} from "./sdk-v2-validation.js";
import { captureBoundedRequest, readBoundedBody } from "./bounded-body.js";
import {
  hasAmbiguousProtectedCredentialHeaders,
  protectedSecretCandidatesFromHeaders,
} from "./credential-secrets.js";
import { decodeJsonBytes, parseCredentialNegativeJson } from "./json-security.js";
import { parseHttpMediaTypeEssence } from "./http-media-type.js";

export type AuthenticationHeaderServer = "broker" | "edge-control";

export interface AuthenticationHeaderRoute {
  readonly server: AuthenticationHeaderServer;
  readonly method: string;
  readonly resultVariant: string;
}

export interface AuthenticationSecretRecord extends AuthenticationHeaderRoute {
  readonly responseKey: string;
  readonly headerName: AuthenticationResponseHeaderName;
  readonly value: string;
}

export interface AuthenticationSecretSink {
  persist(record: AuthenticationSecretRecord): Promise<void>;
}

export interface AuthenticationResponseRoute {
  readonly responseKey: string;
}

export interface BoundAuthenticationResponse {
  /** The exact bounded request authorized by this binding; transport this instance. */
  readonly request: Request;
  intercept(response: Response): Promise<Response>;
}

interface StagedAuthenticationHeader extends AuthenticationHeaderRoute {
  readonly headerName: AuthenticationResponseHeaderName;
  readonly value: string;
}

interface StageContext {
  readonly requestToolName: string | null;
  readonly requestId: string | number | null;
  readonly requestSecrets: readonly string[];
  staged: StagedAuthenticationHeader | null;
}

const RESULT_VARIANT_FIELD = "resultVariant";

interface ManifestEntry {
  readonly name: string;
  readonly server: string;
  readonly method: string;
  readonly alternateMethods?: readonly string[];
  readonly resultVariants: readonly string[];
}

export class AuthenticationHeaderError extends Error {
  constructor() {
    super("invalid_authentication_response_header");
    this.name = "AuthenticationHeaderError";
  }
}

export class AuthenticationResponseStager {
  private readonly storage = new AsyncLocalStorage<StageContext>();

  constructor(private readonly server: AuthenticationHeaderServer) {}

  async run(request: Request, next: (request: Request) => Promise<Response>): Promise<Response> {
    const requestHeaders = new Headers(request.headers);
    const requestSecrets = protectedSecretCandidatesFromHeaders(requestHeaders);
    if (
      hasAmbiguousProtectedCredentialHeaders(requestHeaders)
      || hasSuccessfulResponseMetadataCollision(requestSecrets)
    ) {
      throw new AuthenticationHeaderError();
    }
    let capturedRequest: Awaited<ReturnType<typeof captureBoundedRequest>>;
    try {
      capturedRequest = await captureBoundedRequest(request, requestHeaders);
    } catch {
      throw new AuthenticationHeaderError();
    }
    if (capturedRequest.request.method === "POST") {
      try {
        JSON.parse(decodeJsonBytes(capturedRequest.body));
      } catch {
        throw new AuthenticationHeaderError();
      }
    }
    const requestContext = await readFinalToolsCallContext(
      capturedRequest.request,
      capturedRequest.body,
    );
    const context: StageContext = {
      requestToolName: requestContext?.toolName ?? null,
      requestId: requestContext?.requestId ?? null,
      requestSecrets,
      staged: null,
    };
    return this.storage.run(context, async () => {
      let response: Response;
      try {
        response = await next(capturedRequest.request);
      } catch (error) {
        if (context.staged) throw new AuthenticationHeaderError();
        throw error;
      }
      const responseMetadata = snapshotResponseMetadata(response);
      if (
        hasUnstagedHiveHeaders(responseMetadata.headers)
        || hasRemovedSessionHeaders(responseMetadata.headers)
      ) {
        rejectAuthenticationResponse(response);
      }
      const captured = await captureSuccessfulJsonRpcResult(response, responseMetadata);
      response = captured.response;
      const successfulResult = captured.successfulResult;
      const actualResultVariant = successfulResult?.resultVariant ?? null;
      const requestToolName = context.requestToolName;
      const toolEntries = requestToolName === null
        ? []
        : responseManifest().filter((entry) =>
          entry.server === this.server
          && (entry.method === requestToolName
            || entry.alternateMethods?.includes(requestToolName)));
      if (successfulResult && toolEntries.length > 0 && actualResultVariant === null) {
        rejectAuthenticationResponse(response);
      }
      if (
        successfulResult
        && toolEntries.length > 0
        && successfulResult.id !== context.requestId
      ) {
        rejectAuthenticationResponse(response);
      }
      const headerRequired = toolEntries.some((entry) =>
          actualResultVariant !== null
          && entry.resultVariants.includes(actualResultVariant));
      if (!context.staged) {
        if (headerRequired) rejectAuthenticationResponse(response);
        return response;
      }
      if (actualResultVariant !== context.staged.resultVariant) {
        rejectAuthenticationResponse(response);
      }
      if (
        !successfulResult
        || !isSuccessfulCallToolResult(successfulResult.result)
        || responseLeaksSecrets(
          response,
          successfulResult.serializedBody,
          [context.staged.value, ...context.requestSecrets],
        )
      ) {
        rejectAuthenticationResponse(response);
      }
      const headers = new Headers(response.headers);
      headers.set(context.staged.headerName, context.staged.value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  }

  stage(
    headerName: AuthenticationResponseHeaderName,
    route: AuthenticationHeaderRoute,
    value: string,
  ): void {
    const context = this.storage.getStore();
    if (
      !context
      || context.staged
      || context.requestToolName !== route.method
      || route.server !== this.server
    ) {
      throw new AuthenticationHeaderError();
    }
    const canonical = matchingManifestEntry(headerName, route);
    if (
      !canonical
      || !isSingletonHeaderValue(value)
      || hasSuccessfulResponseMetadataCollision([value])
    ) throw new AuthenticationHeaderError();
    context.staged = { ...route, headerName: canonical.name as AuthenticationResponseHeaderName, value };
  }
}

export class AuthenticationResponseInterceptor {
  constructor(
    private readonly server: AuthenticationHeaderServer,
    private readonly sink: AuthenticationSecretSink,
  ) {}

  async bind(
    request: Request,
    route: AuthenticationResponseRoute,
  ): Promise<BoundAuthenticationResponse> {
    if (!isValidResponseKey(route.responseKey)) throw new AuthenticationHeaderError();
    const requestHeaders = new Headers(request.headers);
    const requestSecrets = Object.freeze(
      protectedSecretCandidatesFromHeaders(requestHeaders),
    );
    if (
      hasAmbiguousProtectedCredentialHeaders(requestHeaders)
      || hasSuccessfulResponseMetadataCollision(requestSecrets)
    ) {
      throw new AuthenticationHeaderError();
    }
    let capturedRequest: Awaited<ReturnType<typeof captureBoundedRequest>>;
    try {
      capturedRequest = await captureBoundedRequest(request, requestHeaders);
    } catch {
      throw new AuthenticationHeaderError();
    }
    const requestContext = await readFinalToolsCallContext(
      capturedRequest.request,
      capturedRequest.body,
    );
    if (
      requestContext === null
    ) {
      throw new AuthenticationHeaderError();
    }
    const boundHeaders = new Headers(capturedRequest.request.headers);
    const binding = Object.freeze({
      server: this.server,
      method: requestContext.toolName,
      requestId: requestContext.requestId,
      responseKey: route.responseKey,
      requestSecrets,
    });
    let consumed = false;
    return Object.freeze({
      request: capturedRequest.request,
      intercept: async (response: Response): Promise<Response> => {
        if (consumed) throw new AuthenticationHeaderError();
        consumed = true;
        if (!headersEqual(capturedRequest.request.headers, boundHeaders)) {
          rejectAuthenticationResponse(response);
        }
        return interceptAuthenticationResponse(response, binding, this.sink);
      },
    });
  }
}

function headersEqual(left: Headers, right: Headers): boolean {
  const leftEntries = [...left.entries()];
  const rightEntries = [...right.entries()];
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([name, value], index) => {
      const other = rightEntries[index];
      return other?.[0] === name && other[1] === value;
    });
}

async function interceptAuthenticationResponse(
  response: Response,
  route: {
    readonly server: AuthenticationHeaderServer;
    readonly method: string;
    readonly requestId: string | number;
    readonly responseKey: string;
    readonly requestSecrets: readonly string[];
  },
  sink: AuthenticationSecretSink,
): Promise<Response> {
  if (!isValidResponseKey(route.responseKey)) {
    rejectAuthenticationResponse(response);
  }
  const responseMetadata = snapshotResponseMetadata(response);
  const known = new Map(responseManifest().map((entry) => [entry.name.toLowerCase(), entry]));
  const requestOnly = new Set(
    AUTHENTICATION_HEADER_MANIFEST.requestOnlyHeaders.map((entry) => entry.name.toLowerCase()),
  );
  const found: Array<{ entry: ManifestEntry; value: string }> = [];
  for (const [name, value] of responseMetadata.headers.entries()) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("hive-")) continue;
    if (requestOnly.has(lower)) rejectAuthenticationResponse(response);
    const entry = known.get(lower);
    if (!entry || !isSingletonHeaderValue(value)) rejectAuthenticationResponse(response);
    found.push({ entry, value });
  }
  if (found.length > 1 || hasRemovedSessionHeaders(responseMetadata.headers)) {
    rejectAuthenticationResponse(response);
  }
  const captured = await captureSuccessfulJsonRpcResult(response, responseMetadata);
  response = captured.response;
  const successfulResult = captured.successfulResult;
  if (successfulResult?.resultVariant === null || successfulResult?.resultVariant === undefined) {
    rejectAuthenticationResponse(response);
  }
  const resultVariant = successfulResult.resultVariant;
  const variantEntries = responseManifest().filter((entry) =>
    entry.server === route.server
    && (entry.method === route.method || entry.alternateMethods?.includes(route.method))
    && entry.resultVariants.includes(resultVariant));
  if (variantEntries.length === 0) {
    if (
      found.length !== 0
      || successfulResult.id !== route.requestId
      || !isSuccessfulCallToolResult(successfulResult.result)
      || responseLeaksSecrets(
        response,
        successfulResult.serializedBody,
        route.requestSecrets,
      )
    ) {
      rejectAuthenticationResponse(response);
    }
    return response;
  }
  if (variantEntries.length !== 1 || found.length !== 1) {
    rejectAuthenticationResponse(response);
  }
  const secret = found[0]!;
  if (route.requestSecrets.some((requestSecret) => secret.value.includes(requestSecret))) {
    rejectAuthenticationResponse(response);
  }
  const canonical = matchingManifestEntry(secret.entry.name, { ...route, resultVariant });
  if (!canonical) rejectAuthenticationResponse(response);
  if (
    successfulResult.id !== route.requestId
    || !isSuccessfulCallToolResult(successfulResult.result)
    || responseLeaksSecrets(
      response,
      successfulResult.serializedBody,
      [secret.value, ...route.requestSecrets],
      { name: canonical.name, value: secret.value },
    )
  ) {
    rejectAuthenticationResponse(response);
  }
  try {
    await sink.persist({
      server: route.server,
      method: route.method,
      resultVariant,
      responseKey: route.responseKey,
      headerName: canonical.name as AuthenticationResponseHeaderName,
      value: secret.value,
    });
  } catch {
    // A sink owns secret storage and may fail with a message containing the
    // bearer or an owner-private path. Collapse every storage failure before
    // it crosses back into SDK, domain, logging, or provider-visible code.
    rejectAuthenticationResponse(response);
  }
  const headers = new Headers(response.headers);
  headers.delete(canonical.name);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isValidResponseKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

export function authenticationResponseHeaderNames(): readonly AuthenticationResponseHeaderName[] {
  return responseManifest().map((entry) => entry.name as AuthenticationResponseHeaderName);
}

function matchingManifestEntry(
  headerName: string,
  route: AuthenticationHeaderRoute,
): ManifestEntry | null {
  const lower = headerName.toLowerCase();
  return responseManifest().find((entry) =>
    entry.name.toLowerCase() === lower
    && entry.server === route.server
    && (entry.method === route.method || entry.alternateMethods?.includes(route.method))
    && entry.resultVariants.includes(route.resultVariant)) ?? null;
}

function responseManifest(): readonly ManifestEntry[] {
  return AUTHENTICATION_HEADER_MANIFEST.responseHeaders as readonly ManifestEntry[];
}

interface SuccessfulJsonRpcResultInspection {
  readonly id: string | number;
  readonly result: unknown;
  readonly resultVariant: string | null;
  readonly serializedBody: string;
}

interface CapturedJsonRpcResult {
  readonly response: Response;
  readonly successfulResult: SuccessfulJsonRpcResultInspection | null;
}

interface ResponseMetadataSnapshot {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
}

async function captureSuccessfulJsonRpcResult(
  response: Response,
  metadata: ResponseMetadataSnapshot = snapshotResponseMetadata(response),
): Promise<CapturedJsonRpcResult> {
  if (!hasIdentityContentEncoding(metadata.headers.get("content-encoding"))) {
    rejectAuthenticationResponse(response);
  }
  if (
    metadata.status !== 200
    || parseHttpMediaTypeEssence(metadata.headers.get("content-type")) !== "application/json"
  ) {
    return {
      response: responseWithMetadataSnapshot(response, metadata),
      successfulResult: null,
    };
  }
  let serializedBody: string;
  let capturedResponse: Response;
  try {
    // Consume the authoritative branch exactly once into bytes that cannot be
    // aliased by the upstream stream or a secret sink. Validation and emission
    // must observe this same immutable snapshot; scanning a clone and later
    // returning the original body creates a mutable-chunk TOCTOU boundary.
    const bytes = await readBoundedBody(response.body);
    serializedBody = decodeJsonBytes(bytes);
    capturedResponse = new Response(bytes, {
      status: metadata.status,
      statusText: metadata.statusText,
      headers: metadata.headers,
    });
  } catch {
    rejectAuthenticationResponse(response);
  }
  try {
    const body = JSON.parse(serializedBody) as Record<string, unknown>;
    if (
      body === null
      || typeof body !== "object"
      || body.jsonrpc !== "2.0"
      || (typeof body.id !== "string" && typeof body.id !== "number")
      || !("result" in body)
      || "error" in body
    ) {
      return { response: capturedResponse, successfulResult: null };
    }
    const id = body.id as string | number;
    const result = body.result;
    if (!result || typeof result !== "object") {
      return {
        response: capturedResponse,
        successfulResult: { id, result, resultVariant: null, serializedBody },
      };
    }
    const structuredContent = (result as Record<string, unknown>).structuredContent;
    if (!structuredContent || typeof structuredContent !== "object") {
      return {
        response: capturedResponse,
        successfulResult: { id, result, resultVariant: null, serializedBody },
      };
    }
    const variant = (structuredContent as Record<string, unknown>)[RESULT_VARIANT_FIELD];
    return {
      response: capturedResponse,
      successfulResult: {
        id,
        result,
        resultVariant: typeof variant === "string" ? variant : null,
        serializedBody,
      },
    };
  } catch {
    return { response: capturedResponse, successfulResult: null };
  }
}

function snapshotResponseMetadata(response: Response): ResponseMetadataSnapshot {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  };
}

function responseWithMetadataSnapshot(
  response: Response,
  metadata: ResponseMetadataSnapshot,
): Response {
  try {
    return new Response(response.body, {
      status: metadata.status,
      statusText: metadata.statusText,
      headers: metadata.headers,
    });
  } catch {
    rejectAuthenticationResponse(response);
  }
}

function hasIdentityContentEncoding(value: string | null): boolean {
  return value === null || value.trim().toLowerCase() === "identity";
}

function responseLeaksSecrets(
  response: Response,
  serializedBody: string,
  secrets: readonly string[],
  allowedHeader?: { readonly name: string; readonly value: string },
): boolean {
  // Check both wire bytes and decoded JSON semantics. JSON permits a peer to
  // spell any character as `\\uXXXX`; a byte-only search would let the exact
  // authority value reappear after the consumer parses the body.
  if (secrets.some((secret) => serializedBody.includes(secret))) return true;
  try {
    parseCredentialNegativeJson(serializedBody, secrets);
  } catch {
    return true;
  }
  if (secrets.some((secret) => String(response.status).includes(secret))) return true;
  if (secrets.some((secret) => response.statusText.includes(secret))) return true;
  const allowed = allowedHeader?.name.toLowerCase();
  for (const [name, value] of response.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (secrets.some((secret) => lowerName.includes(secret.toLowerCase()))) return true;
    if (
      lowerName === allowed
      && value === allowedHeader?.value
    ) {
      if (
        secrets.some((secret) => secret !== allowedHeader.value && value.includes(secret))
      ) return true;
      continue;
    }
    if (secrets.some((secret) => value.includes(secret))) return true;
  }
  return false;
}

function hasSuccessfulResponseMetadataCollision(secrets: readonly string[]): boolean {
  return secrets.some((secret) => String(200).includes(secret));
}

function hasUnstagedHiveHeaders(headers: Headers): boolean {
  for (const [name] of headers.entries()) {
    if (name.toLowerCase().startsWith("hive-")) return true;
  }
  return false;
}

function hasRemovedSessionHeaders(headers: Headers): boolean {
  return headers.has("mcp-session-id") || headers.has("last-event-id");
}

function rejectAuthenticationResponse(response: Response): never {
  cancelResponseBody(response);
  throw new AuthenticationHeaderError();
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => {});
  } catch {
    // A hostile or locked stream cannot replace the constant public error.
  }
}

function isSingletonHeaderValue(value: string): boolean {
  return value.length > 0
    && value === value.trim()
    && !value.includes(",")
    && !value.includes("\r")
    && !value.includes("\n");
}
