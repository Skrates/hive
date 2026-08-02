import {
  MCP_POTENTIAL_CAPABILITY_CATALOG,
  type McpPotentialResource,
  type McpPotentialTool,
} from "./schemas.js";

export type HivePrincipalKind = "edge" | "operator" | "supervisor" | "provider";
export type HiveMcpServer = "broker" | "provider-ingress" | "edge-control";

export interface HivePrincipal {
  readonly id: string;
  readonly kind: HivePrincipalKind;
  readonly scopes: readonly string[];
  readonly edgeId?: string;
}

export interface RequestingEdgeHealth {
  readonly edgeId: string;
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly observedAt: string;
}

export type McpPotentialCapability = McpPotentialResource | McpPotentialTool;

export interface RegisteredMcpCapabilities {
  readonly resourceHandleKinds: readonly string[];
  readonly toolNames: readonly string[];
}

export interface AuthorizedMcpCapabilities {
  readonly resources: readonly McpPotentialResource[];
  readonly tools: readonly McpPotentialTool[];
}

/**
 * Discovery is the strict intersection of generated potential definitions,
 * request-local registered handlers, and current principal authority. The
 * caller supplies the object-aware authority predicate and must repeat it at
 * invocation; string scope hints in the catalog are not authorization.
 */
export function authorizedRegisteredCapabilities(
  server: HiveMcpServer,
  registered: RegisteredMcpCapabilities,
  principal: HivePrincipal,
  authorize: (capability: McpPotentialCapability, principal: HivePrincipal) => boolean,
): AuthorizedMcpCapabilities {
  const resourceKinds = new Set(registered.resourceHandleKinds);
  const toolNames = new Set(registered.toolNames);
  const resources = MCP_POTENTIAL_CAPABILITY_CATALOG.resources.filter((capability) =>
    capability.server === server
    && resourceKinds.has(capability.handleKind)
    && authorize(capability, principal));
  const tools = MCP_POTENTIAL_CAPABILITY_CATALOG.tools.filter((capability) =>
    capability.server === server
    && toolNames.has(capability.name)
    && authorize(capability, principal));
  return Object.freeze({
    resources: Object.freeze([...resources]),
    tools: Object.freeze([...tools]),
  });
}

export function hasHiveScope(principal: HivePrincipal, scope: string): boolean {
  return principal.scopes.includes(scope);
}

export function validateHivePrincipal(value: HivePrincipal): HivePrincipal {
  if (
    typeof value.id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id)
    || !["edge", "operator", "supervisor", "provider"].includes(value.kind)
    || !Array.isArray(value.scopes)
    || value.scopes.some((scope) =>
      typeof scope !== "string" || !/^[a-z][a-z0-9:-]{0,127}$/.test(scope))
    || new Set(value.scopes).size !== value.scopes.length
    || (value.kind === "edge") !== (typeof value.edgeId === "string")
    || (value.edgeId !== undefined
      && (typeof value.edgeId !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.edgeId)))
  ) {
    throw new Error("invalid_hive_principal");
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    scopes: Object.freeze([...value.scopes]),
    ...(value.edgeId === undefined ? {} : { edgeId: value.edgeId }),
  });
}
