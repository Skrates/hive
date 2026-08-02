import { AsyncLocalStorage } from "node:async_hooks";
import {
  AUTHENTICATION_HEADER_MANIFEST,
  type AuthenticationResponseHeaderName,
} from "./schemas.js";
import { isSuccessfulCallToolResult } from "./sdk-v2-validation.js";

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
  intercept(response: Response): Promise<Response>;
}

interface StagedAuthenticationHeader extends AuthenticationHeaderRoute {
  readonly headerName: AuthenticationResponseHeaderName;
  readonly value: string;
}

interface StageContext {
  readonly requestToolName: string | null;
  readonly requestId: string | number | null;
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
    const requestContext = await readRequestToolContext(request);
    const context: StageContext = {
      requestToolName: requestContext.toolName,
      requestId: requestContext.requestId,
      staged: null,
    };
    return this.storage.run(context, async () => {
      const response = await next(request);
      rejectUnstagedHiveHeaders(response.headers);
      const successfulResult = await inspectSuccessfulJsonRpcResult(response);
      const actualResultVariant = successfulResult?.resultVariant ?? null;
      const requestToolName = context.requestToolName;
      const toolEntries = requestToolName === null
        ? []
        : responseManifest().filter((entry) =>
          entry.server === this.server
          && (entry.method === requestToolName
            || entry.alternateMethods?.includes(requestToolName)));
      if (successfulResult && toolEntries.length > 0 && actualResultVariant === null) {
        throw new AuthenticationHeaderError();
      }
      if (
        successfulResult
        && toolEntries.length > 0
        && successfulResult.id !== context.requestId
      ) {
        throw new AuthenticationHeaderError();
      }
      const headerRequired = toolEntries.some((entry) =>
          actualResultVariant !== null
          && entry.resultVariants.includes(actualResultVariant));
      if (!context.staged) {
        if (headerRequired) throw new AuthenticationHeaderError();
        return response;
      }
      if (actualResultVariant !== context.staged.resultVariant) {
        throw new AuthenticationHeaderError();
      }
      if (
        !successfulResult
        || !isSuccessfulCallToolResult(successfulResult.result)
        || responseLeaksSecret(response, successfulResult.serializedBody, context.staged.value)
      ) {
        throw new AuthenticationHeaderError();
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
    if (!canonical || !isSingletonHeaderValue(value)) throw new AuthenticationHeaderError();
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
    const requestContext = await readRequestToolContext(request);
    if (
      requestContext.toolName === null
      || requestContext.requestId === null
      || !isValidResponseKey(route.responseKey)
    ) {
      throw new AuthenticationHeaderError();
    }
    const binding = Object.freeze({
      server: this.server,
      method: requestContext.toolName,
      requestId: requestContext.requestId,
      responseKey: route.responseKey,
    });
    let consumed = false;
    return Object.freeze({
      intercept: async (response: Response): Promise<Response> => {
        if (consumed) throw new AuthenticationHeaderError();
        consumed = true;
        return interceptAuthenticationResponse(response, binding, this.sink);
      },
    });
  }
}

async function interceptAuthenticationResponse(
  response: Response,
  route: {
    readonly server: AuthenticationHeaderServer;
    readonly method: string;
    readonly requestId: string | number;
    readonly responseKey: string;
  },
  sink: AuthenticationSecretSink,
): Promise<Response> {
  if (!isValidResponseKey(route.responseKey)) {
    throw new AuthenticationHeaderError();
  }
  const known = new Map(responseManifest().map((entry) => [entry.name.toLowerCase(), entry]));
  const requestOnly = new Set(
    AUTHENTICATION_HEADER_MANIFEST.requestOnlyHeaders.map((entry) => entry.name.toLowerCase()),
  );
  const found: Array<{ entry: ManifestEntry; value: string }> = [];
  for (const [name, value] of response.headers.entries()) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("hive-")) continue;
    if (requestOnly.has(lower)) throw new AuthenticationHeaderError();
    const entry = known.get(lower);
    if (!entry || !isSingletonHeaderValue(value)) throw new AuthenticationHeaderError();
    found.push({ entry, value });
  }
  if (found.length !== 1) throw new AuthenticationHeaderError();
  const headers = new Headers(response.headers);
  const secret = found[0]!;
  const successfulResult = await inspectSuccessfulJsonRpcResult(response);
  if (successfulResult?.resultVariant === null || successfulResult?.resultVariant === undefined) {
    throw new AuthenticationHeaderError();
  }
  const resultVariant = successfulResult.resultVariant;
  const canonical = matchingManifestEntry(secret.entry.name, { ...route, resultVariant });
  if (!canonical) throw new AuthenticationHeaderError();
  if (
    successfulResult.id !== route.requestId
    || !isSuccessfulCallToolResult(successfulResult.result)
    || responseLeaksSecret(response, successfulResult.serializedBody, secret.value, canonical.name)
  ) {
    throw new AuthenticationHeaderError();
  }
  await sink.persist({
    server: route.server,
    method: route.method,
    resultVariant,
    responseKey: route.responseKey,
    headerName: canonical.name as AuthenticationResponseHeaderName,
    value: secret.value,
  });
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

async function readRequestToolContext(request: Request): Promise<{
  readonly toolName: string | null;
  readonly requestId: string | number | null;
}> {
  if (request.method !== "POST") return { toolName: null, requestId: null };
  try {
    const body = await request.clone().json() as {
      id?: unknown;
      method?: unknown;
      params?: { name?: unknown };
    };
    return {
      toolName: body?.method === "tools/call" && typeof body.params?.name === "string"
        ? body.params.name
        : null,
      requestId: typeof body.id === "string" || typeof body.id === "number" ? body.id : null,
    };
  } catch {
    return { toolName: null, requestId: null };
  }
}

interface SuccessfulJsonRpcResultInspection {
  readonly id: string | number;
  readonly result: unknown;
  readonly resultVariant: string | null;
  readonly serializedBody: string;
}

async function inspectSuccessfulJsonRpcResult(
  response: Response,
): Promise<SuccessfulJsonRpcResultInspection | null> {
  if (response.status !== 200) return null;
  if (mediaTypeEssence(response.headers.get("content-type")) !== "application/json") return null;
  try {
    const serializedBody = await response.clone().text();
    const body = JSON.parse(serializedBody) as Record<string, unknown>;
    if (
      body === null
      || typeof body !== "object"
      || body.jsonrpc !== "2.0"
      || (typeof body.id !== "string" && typeof body.id !== "number")
      || !("result" in body)
      || "error" in body
    ) {
      return null;
    }
    const id = body.id as string | number;
    const result = body.result;
    if (!result || typeof result !== "object") {
      return { id, result, resultVariant: null, serializedBody };
    }
    const structuredContent = (result as Record<string, unknown>).structuredContent;
    if (!structuredContent || typeof structuredContent !== "object") {
      return { id, result, resultVariant: null, serializedBody };
    }
    const variant = (structuredContent as Record<string, unknown>)[RESULT_VARIANT_FIELD];
    return {
      id,
      result,
      resultVariant: typeof variant === "string" ? variant : null,
      serializedBody,
    };
  } catch {
    return null;
  }
}

function mediaTypeEssence(value: string | null): string | null {
  if (!value) return null;
  const essence = value.split(";", 1)[0]?.trim().toLowerCase();
  return essence || null;
}

function responseLeaksSecret(
  response: Response,
  serializedBody: string,
  secret: string,
  allowedHeaderName?: string,
): boolean {
  // Check both wire bytes and decoded JSON semantics. JSON permits a peer to
  // spell any character as `\\uXXXX`; a byte-only search would let the exact
  // authority value reappear after the consumer parses the body.
  if (
    serializedBody.includes(secret)
    || semanticJsonContainsSecret(parseJson(serializedBody), secret)
  ) return true;
  if (response.statusText.includes(secret)) return true;
  const allowed = allowedHeaderName?.toLowerCase();
  for (const [name, value] of response.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes(secret.toLowerCase())) return true;
    if (lowerName !== allowed && value.includes(secret)) return true;
  }
  return false;
}

function parseJson(serializedBody: string): unknown {
  try {
    return JSON.parse(serializedBody) as unknown;
  } catch {
    return null;
  }
}

function semanticJsonContainsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) {
    return value.some((item) => semanticJsonContainsSecret(item, secret));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      key.includes(secret) || semanticJsonContainsSecret(item, secret));
  }
  return false;
}

function rejectUnstagedHiveHeaders(headers: Headers): void {
  for (const [name] of headers.entries()) {
    if (name.toLowerCase().startsWith("hive-")) throw new AuthenticationHeaderError();
  }
}

function isSingletonHeaderValue(value: string): boolean {
  return value.length > 0
    && value === value.trim()
    && !value.includes(",")
    && !value.includes("\r")
    && !value.includes("\n");
}
