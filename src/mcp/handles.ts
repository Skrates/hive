/**
 * ADR-0003 retains ADR-0002 D6: canonical `hive://` handles identify, never
 * authorize. The kind table below is v0.5 truth — the evidence, reconciliation,
 * credential-lineage, and binding-fence handle families left with the strata
 * that owned them.
 */
export const BROKER_HANDLE_DEFINITIONS = [
  { kind: "event", path: "events/{eventId}" },
  { kind: "deliveries", path: "deliveries", optionalQuery: ["cursor"] },
  { kind: "delivery", path: "deliveries/{deliveryId}", positiveIntegers: ["deliveryId"] },
  { kind: "deliveryTransitions", path: "deliveries/{deliveryId}/transitions", positiveIntegers: ["deliveryId"] },
  { kind: "deliveryReplay", path: "deliveries/{deliveryId}/replay", positiveIntegers: ["deliveryId"] },
  { kind: "outbox", path: "outbox", optionalQuery: ["cursor"] },
  { kind: "outboxItem", path: "outbox/{outboxId}" },
  { kind: "subscriptions", path: "subscriptions", optionalQuery: ["cursor"] },
  { kind: "subscription", path: "subscriptions/{actor}" },
  { kind: "edges", path: "edges", optionalQuery: ["cursor"] },
  { kind: "edge", path: "edges/{edgeId}" },
  { kind: "provider", path: "providers/{edgeId}/{provider}" },
  { kind: "workspace", path: "workspaces/{workspaceId}" },
  { kind: "reasonCodes", path: "reason-codes" },
] as const satisfies readonly HandleDefinition[];

export const EDGE_HANDLE_DEFINITIONS = [
  { kind: "localProvider", path: "providers/{provider}/{providerSessionRef}" },
] as const satisfies readonly HandleDefinition[];

export type HiveBrokerHandleKind = typeof BROKER_HANDLE_DEFINITIONS[number]["kind"];
export type HiveEdgeHandleKind = typeof EDGE_HANDLE_DEFINITIONS[number]["kind"];
export type HiveHandleKind = HiveBrokerHandleKind | HiveEdgeHandleKind;

const BROKER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLACEHOLDER_PATTERN = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;
const PERCENT_ESCAPE_PATTERN = /%[0-9A-Fa-f]{2}/;
const MAX_HANDLE_URI_LENGTH = 8_192;
const MAX_HANDLE_SEGMENT_BYTES = 1_024;
const UTF8_ENCODER = new TextEncoder();

interface HandleDefinition {
  readonly kind: string;
  readonly path: string;
  readonly positiveIntegers?: readonly string[];
  readonly optionalQuery?: readonly string[];
  readonly requiredQuery?: readonly string[];
}

export interface ParsedHiveHandle {
  readonly uri: string;
  readonly scope: "broker" | "edge";
  readonly brokerUuid: string | null;
  readonly kind: HiveHandleKind;
  readonly values: Readonly<Record<string, string | number>>;
}

export class InvalidHiveHandleError extends Error {
  constructor() {
    super("invalid_hive_handle");
    this.name = "InvalidHiveHandleError";
  }
}

export function parseBrokerHandle(input: string, expectedBrokerUuid: string): ParsedHiveHandle & {
  readonly scope: "broker";
  readonly kind: HiveBrokerHandleKind;
} {
  const parsed = parseHandle(input, "broker", normalizeBrokerUuid(expectedBrokerUuid));
  return parsed as ParsedHiveHandle & { readonly scope: "broker"; readonly kind: HiveBrokerHandleKind };
}

export function parseEdgeHandle(input: string): ParsedHiveHandle & {
  readonly scope: "edge";
  readonly kind: HiveEdgeHandleKind;
} {
  const parsed = parseHandle(input, "edge", null);
  return parsed as ParsedHiveHandle & { readonly scope: "edge"; readonly kind: HiveEdgeHandleKind };
}

export function formatBrokerHandle(
  brokerUuid: string,
  kind: HiveBrokerHandleKind,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return formatHandle("broker", normalizeBrokerUuid(brokerUuid), kind, values);
}

export function formatEdgeHandle(
  kind: HiveEdgeHandleKind,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return formatHandle("edge", "edge", kind, values);
}

export function normalizeBrokerUuid(value: string): string {
  if (typeof value !== "string" || !BROKER_UUID_PATTERN.test(value)) {
    throw new InvalidHiveHandleError();
  }
  return value;
}

function parseHandle(
  input: string,
  expectedScope: "broker" | "edge",
  expectedBrokerUuid: string | null,
): ParsedHiveHandle {
  if (
    typeof input !== "string"
    || input.length > MAX_HANDLE_URI_LENGTH
    || !isCanonicalAscii(input)
    || input.includes("\\")
  ) throw new InvalidHiveHandleError();
  const match = /^hive:\/\/([^/?#]+)(\/[^?#]*)(\?[^#]*)?$/.exec(input);
  if (!match?.[1] || !match[2]) throw new InvalidHiveHandleError();
  const authority = match[1];
  const scope = authority === "edge" ? "edge" : "broker";
  if (scope !== expectedScope) throw new InvalidHiveHandleError();
  if (scope === "broker") {
    normalizeBrokerUuid(authority);
    if (authority !== expectedBrokerUuid) throw new InvalidHiveHandleError();
  }

  const rawSegments = match[2].split("/");
  if (rawSegments.length < 3 || rawSegments[0] !== "" || rawSegments[1] !== "v1") {
    throw new InvalidHiveHandleError();
  }
  const handleSegments = rawSegments.slice(2);
  if (handleSegments.some((segment) => segment.length === 0)) throw new InvalidHiveHandleError();

  const definitions = scope === "broker" ? brokerDefinitions() : edgeDefinitions();
  for (const definition of definitions) {
    const values = matchDefinition(definition, handleSegments);
    if (!values) continue;
    parseQuery(definition, match[3] ?? "", values);
    const canonical = buildUri(scope, authority, definition, values);
    if (canonical !== input) throw new InvalidHiveHandleError();
    return {
      uri: canonical,
      scope,
      brokerUuid: scope === "broker" ? authority : null,
      kind: definition.kind as HiveHandleKind,
      values: Object.freeze({ ...values }),
    };
  }
  throw new InvalidHiveHandleError();
}

function formatHandle(
  scope: "broker" | "edge",
  authority: string,
  kind: HiveHandleKind,
  values: Readonly<Record<string, string | number>>,
): string {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new InvalidHiveHandleError();
  }
  const definitions = scope === "broker" ? brokerDefinitions() : edgeDefinitions();
  const definition = definitions.find((candidate) => candidate.kind === kind);
  if (!definition) throw new InvalidHiveHandleError();
  const allowed = new Set([
    ...templateParameterNames(definition.path),
    ...(definition.optionalQuery ?? []),
    ...(definition.requiredQuery ?? []),
  ]);
  if (Object.keys(values).some((name) => !allowed.has(name))) throw new InvalidHiveHandleError();
  return buildUri(scope, authority, definition, values);
}

function matchDefinition(
  definition: HandleDefinition,
  rawSegments: readonly string[],
): Record<string, string | number> | null {
  const template = definition.path.split("/");
  if (template.length !== rawSegments.length) return null;
  const values: Record<string, string | number> = {};
  for (let index = 0; index < template.length; index += 1) {
    const expected = template[index]!;
    const actual = rawSegments[index]!;
    const placeholder = PLACEHOLDER_PATTERN.exec(expected)?.[1];
    if (!placeholder) {
      if (actual !== expected) return null;
      continue;
    }
    try {
      const decoded = decodeSegment(actual);
      values[placeholder] = isPositiveInteger(definition, placeholder)
        ? parsePositiveInteger(decoded)
        : decoded;
    } catch {
      return null;
    }
  }
  return values;
}

function parseQuery(
  definition: HandleDefinition,
  rawQuery: string,
  values: Record<string, string | number>,
): void {
  if (definition.requiredQuery) {
    const expected = definition.requiredQuery;
    const entries = parseRawQuery(rawQuery);
    if (entries.length !== expected.length) throw new InvalidHiveHandleError();
    for (let index = 0; index < expected.length; index += 1) {
      const name = expected[index]!;
      const entry = entries[index]!;
      if (entry.name !== name) throw new InvalidHiveHandleError();
      const decoded = decodeSegment(entry.value);
      values[name] = isPositiveInteger(definition, name) ? parsePositiveInteger(decoded) : decoded;
    }
    return;
  }
  if (definition.optionalQuery) {
    if (rawQuery === "") return;
    const entries = parseRawQuery(rawQuery);
    const entry = entries[0];
    if (entries.length !== 1 || !entry || entry.name !== definition.optionalQuery[0]) {
      throw new InvalidHiveHandleError();
    }
    values[entry.name] = decodeSegment(entry.value);
    return;
  }
  if (rawQuery !== "") throw new InvalidHiveHandleError();
}

function parseRawQuery(rawQuery: string): Array<{ name: string; value: string }> {
  if (!rawQuery.startsWith("?") || rawQuery.length === 1) throw new InvalidHiveHandleError();
  return rawQuery.slice(1).split("&").map((part) => {
    const equals = part.indexOf("=");
    if (equals <= 0 || equals === part.length - 1 || part.indexOf("=", equals + 1) !== -1) {
      throw new InvalidHiveHandleError();
    }
    const name = part.slice(0, equals);
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new InvalidHiveHandleError();
    return { name, value: part.slice(equals + 1) };
  });
}

function buildUri(
  scope: "broker" | "edge",
  authority: string,
  definition: HandleDefinition,
  values: Readonly<Record<string, string | number>>,
): string {
  if (scope === "broker") normalizeBrokerUuid(authority);
  else if (authority !== "edge") throw new InvalidHiveHandleError();
  const path = definition.path.split("/").map((part) => {
    const placeholder = PLACEHOLDER_PATTERN.exec(part)?.[1];
    if (!placeholder) return part;
    if (!(placeholder in values)) throw new InvalidHiveHandleError();
    return encodeValue(definition, placeholder, values[placeholder]!);
  }).join("/");

  let query = "";
  if (definition.requiredQuery) {
    query = `?${definition.requiredQuery.map((name) => {
      if (!(name in values)) throw new InvalidHiveHandleError();
      return `${name}=${encodeValue(definition, name, values[name]!)}`;
    }).join("&")}`;
  } else if (definition.optionalQuery) {
    const name = definition.optionalQuery[0]!;
    if (name in values) query = `?${name}=${encodeValue(definition, name, values[name]!)}`;
  }
  const uri = `hive://${authority}/v1/${path}${query}`;
  if (uri.length > MAX_HANDLE_URI_LENGTH) throw new InvalidHiveHandleError();
  return uri;
}

function encodeValue(definition: HandleDefinition, name: string, value: string | number): string {
  if (isPositiveInteger(definition, name)) return String(parsePositiveInteger(String(value)));
  if (typeof value !== "string") throw new InvalidHiveHandleError();
  validateDecodedSegment(value);
  return encodeRfc3986Segment(value);
}

function decodeSegment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new InvalidHiveHandleError();
  }
  validateDecodedSegment(decoded);
  if (encodeRfc3986Segment(decoded) !== value) throw new InvalidHiveHandleError();
  return decoded;
}

function validateDecodedSegment(value: string): void {
  if (
    value.length === 0
    || UTF8_ENCODER.encode(value).byteLength > MAX_HANDLE_SEGMENT_BYTES
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    || PERCENT_ESCAPE_PATTERN.test(value)
  ) {
    throw new InvalidHiveHandleError();
  }
}

function encodeRfc3986Segment(value: string): string {
  try {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    throw new InvalidHiveHandleError();
  }
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new InvalidHiveHandleError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new InvalidHiveHandleError();
  return parsed;
}

function isPositiveInteger(definition: HandleDefinition, name: string): boolean {
  return definition.positiveIntegers?.includes(name) ?? false;
}

function templateParameterNames(path: string): string[] {
  return path.split("/").flatMap((part) => {
    const name = PLACEHOLDER_PATTERN.exec(part)?.[1];
    return name ? [name] : [];
  });
}

function brokerDefinitions(): readonly HandleDefinition[] {
  return BROKER_HANDLE_DEFINITIONS;
}

function edgeDefinitions(): readonly HandleDefinition[] {
  return EDGE_HANDLE_DEFINITIONS;
}

function isCanonicalAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}
