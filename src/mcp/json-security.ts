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
