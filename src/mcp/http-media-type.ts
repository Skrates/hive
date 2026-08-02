/**
 * Parse one unambiguous HTTP media type. The result is the lower-case essence;
 * malformed parameters, duplicate parameters, lists, and trailing junk fail
 * closed instead of being ignored by an essence-only convenience parser.
 */
export function parseHttpMediaTypeEssence(value: string | null): string | null {
  if (!value) return null;
  let index = skipOptionalWhitespace(value, 0);
  const typeStart = index;
  index = readHttpTokenEnd(value, index);
  if (index === typeStart || value[index] !== "/") return null;
  const type = value.slice(typeStart, index).toLowerCase();
  index += 1;
  const subtypeStart = index;
  index = readHttpTokenEnd(value, index);
  if (index === subtypeStart) return null;
  const subtype = value.slice(subtypeStart, index).toLowerCase();
  index = skipOptionalWhitespace(value, index);

  const parameters = new Set<string>();
  while (index < value.length) {
    if (value[index] !== ";") return null;
    index = skipOptionalWhitespace(value, index + 1);
    const nameStart = index;
    index = readHttpTokenEnd(value, index);
    if (index === nameStart) return null;
    const name = value.slice(nameStart, index).toLowerCase();
    if (parameters.has(name)) return null;
    parameters.add(name);
    index = skipOptionalWhitespace(value, index);
    if (value[index] !== "=") return null;
    index = skipOptionalWhitespace(value, index + 1);
    if (value[index] === '"') {
      index = readQuotedStringEnd(value, index);
      if (index < 0) return null;
    } else {
      const valueStart = index;
      index = readHttpTokenEnd(value, index);
      if (index === valueStart) return null;
    }
    index = skipOptionalWhitespace(value, index);
  }
  return `${type}/${subtype}`;
}

/** Require both final MCP response representations with a strictly parsed, positive qvalue. */
export function acceptsMcpJsonAndSse(value: string | null): boolean {
  if (!value) return false;
  const items = splitOutsideQuotedStrings(value, ",");
  if (items === null || items.some((item) => item.trim().length === 0)) return false;
  const accepted = new Set<string>();
  for (const item of items) {
    const essence = parseHttpMediaTypeEssence(item);
    if (essence === null) return false;
    const quality = parseQuality(item);
    if (quality === null) return false;
    if (quality > 0) accepted.add(essence);
  }
  return accepted.has("application/json") && accepted.has("text/event-stream");
}

function parseQuality(item: string): number | null {
  const segments = splitOutsideQuotedStrings(item, ";");
  if (segments === null) return null;
  let quality = 1;
  for (const segment of segments.slice(1)) {
    const separator = segment.indexOf("=");
    if (separator < 0) return null;
    const name = segment.slice(0, separator).trim().toLowerCase();
    if (name !== "q") continue;
    const candidate = segment.slice(separator + 1).trim();
    if (!/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(candidate)) return null;
    quality = Number(candidate);
  }
  return quality;
}

function splitOutsideQuotedStrings(value: string, separator: "," | ";"): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === separator) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start));
  return parts;
}

function skipOptionalWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index += 1;
  return index;
}

function readHttpTokenEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length && isHttpTokenCode(value.charCodeAt(index))) index += 1;
  return index;
}

function isHttpTokenCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x21
    || code === 0x23
    || code === 0x24
    || code === 0x25
    || code === 0x26
    || code === 0x27
    || code === 0x2a
    || code === 0x2b
    || code === 0x2d
    || code === 0x2e
    || code === 0x5e
    || code === 0x5f
    || code === 0x60
    || code === 0x7c
    || code === 0x7e;
}

function readQuotedStringEnd(value: string, start: number): number {
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length || !isQuotedPairCode(value.charCodeAt(index))) return -1;
      index += 1;
      continue;
    }
    if (!isQuotedTextCode(code)) return -1;
    index += 1;
  }
  return -1;
}

function isQuotedPairCode(code: number): boolean {
  return code === 0x09
    || code === 0x20
    || (code >= 0x21 && code <= 0x7e)
    || (code >= 0x80 && code <= 0xff);
}

function isQuotedTextCode(code: number): boolean {
  return code === 0x09
    || code === 0x20
    || code === 0x21
    || (code >= 0x23 && code <= 0x5b)
    || (code >= 0x5d && code <= 0x7e)
    || (code >= 0x80 && code <= 0xff);
}
