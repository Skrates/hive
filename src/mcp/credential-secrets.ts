/**
 * Collect transport credentials that must never be reflected. Every Hive-*
 * request header is credential-shaped even when its eventual semantic use is
 * non-authorizing evidence, so the transport protects its complete value.
 */
export function protectedSecretCandidatesFromRequest(request: Request): readonly string[] {
  return protectedSecretCandidatesFromHeaders(request.headers);
}

export function protectedSecretCandidatesFromHeaders(headers: Headers): readonly string[] {
  const candidates = new Set<string>();
  const authorization = headers.get("authorization");
  if (authorization) {
    addCredentialAndComponents(candidates, authorization, true);
  }
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase().startsWith("hive-") && value.length > 0) {
      addCredentialAndComponents(candidates, value, false);
    }
  }
  return [...candidates];
}

export function hasAmbiguousProtectedCredentialHeaders(headers: Headers): boolean {
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if ((lower === "authorization" || lower.startsWith("hive-")) && value.includes(",")) {
      return true;
    }
  }
  return false;
}

function addCredentialAndComponents(
  candidates: Set<string>,
  value: string,
  bearerSyntax: boolean,
): void {
  candidates.add(value);
  for (const component of value.split(",")) {
    const trimmed = component.trim();
    if (!trimmed) continue;
    candidates.add(trimmed);
    if (bearerSyntax) {
      const bearer = /^Bearer\s+(.+)$/i.exec(trimmed)?.[1];
      if (bearer) candidates.add(bearer);
    }
  }
}
