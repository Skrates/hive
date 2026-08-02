export class JsonSecurityError extends Error {
  constructor(code: "credential_firewall_invalid_json" | "credential_firewall_invalid_json_utf8") {
    super(code);
    this.name = "JsonSecurityError";
  }
}

export function decodeJsonBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new JsonSecurityError("credential_firewall_invalid_json_utf8");
  }
}

/**
 * Validate complete JSON while inspecting every decoded string token before
 * object parsing can collapse duplicate members. This catches secrets in an
 * earlier duplicate key/value that ordinary JSON.parse would overwrite.
 */
export function parseCredentialNegativeJson(
  serialized: string,
  secrets: readonly string[],
): unknown {
  assertEveryJsonStringCredentialNegative(serialized, secrets);
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new JsonSecurityError("credential_firewall_invalid_json");
  }
}

/**
 * Parse JSON while rejecting duplicate object member names at every depth.
 * JSON.parse keeps only the last duplicate, which is unsafe when the parsed
 * value authorizes release of the original bytes. Escaped aliases such as
 * `"result"` and `"\u0072esult"` are compared after JSON decoding.
 */
export function parseUniqueMemberJson(serialized: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new JsonSecurityError("credential_firewall_invalid_json");
  }
  assertUniqueObjectMembers(serialized);
  return parsed;
}

function assertUniqueObjectMembers(serialized: string): void {
  const fail = (): never => {
    throw new JsonSecurityError("credential_firewall_invalid_json");
  };
  const objectMembers: Array<Set<string>> = [];
  let inString = false;
  let escaped = false;
  let tokenStart = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (!inString) {
      if (character === "{") {
        objectMembers.push(new Set());
      } else if (character === "}") {
        if (!objectMembers.pop()) fail();
      } else if (character === '"') {
        inString = true;
        escaped = false;
        tokenStart = index;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;

    let lookahead = index + 1;
    while (isJsonWhitespace(serialized[lookahead])) lookahead += 1;
    if (serialized[lookahead] === ":") {
      const currentMembers = objectMembers.at(-1);
      if (currentMembers === undefined) return fail();
      let decoded: unknown;
      try {
        decoded = JSON.parse(serialized.slice(tokenStart, index + 1)) as unknown;
      } catch {
        fail();
      }
      if (typeof decoded !== "string") return fail();
      if (currentMembers.has(decoded)) return fail();
      currentMembers.add(decoded);
    }
    inString = false;
  }
  if (inString || objectMembers.length !== 0) fail();
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === " "
    || character === "\t"
    || character === "\n"
    || character === "\r";
}

function assertEveryJsonStringCredentialNegative(
  serialized: string,
  secrets: readonly string[],
): void {
  let inString = false;
  let escaped = false;
  let tokenStart = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (!inString) {
      if (character === '"') {
        inString = true;
        escaped = false;
        tokenStart = index;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized.slice(tokenStart, index + 1)) as unknown;
    } catch {
      throw new JsonSecurityError("credential_firewall_invalid_json");
    }
    if (
      typeof decoded === "string"
      && secrets.some((secret) => decoded.includes(secret))
    ) {
      throw new Error("credential_reflection");
    }
    inString = false;
  }
  if (inString) throw new JsonSecurityError("credential_firewall_invalid_json");
}
