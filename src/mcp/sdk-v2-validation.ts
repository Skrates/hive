import { isCallToolResult } from "@modelcontextprotocol/server";

/**
 * Keep the split-v2 runtime schema at the adapter boundary. Domain-facing
 * authentication code receives only a boolean and no SDK type.
 */
export function isSuccessfulCallToolResult(value: unknown): boolean {
  return isCallToolResult(value)
    && value.resultType === "complete"
    && value.isError !== true;
}
