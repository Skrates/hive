import {
  createHiveMcpAdapterInternal,
  type HiveMcpAdapter,
  type HiveMcpAdapterOptions,
  type HiveMcpAuthenticator,
} from "./sdk-v2-internal.js";

export type {
  HiveMcpAdapter,
  HiveMcpAdapterOptions,
  HiveMcpAuthenticator,
} from "./sdk-v2-internal.js";

/**
 * The only production constructor. Its signature has no fixture parameter, so
 * production code cannot advertise or register the synthetic health resource.
 */
export function createHiveMcpAdapter(options: HiveMcpAdapterOptions): HiveMcpAdapter {
  return createHiveMcpAdapterInternal(options);
}
