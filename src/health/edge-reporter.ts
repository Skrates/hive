import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { BrokerClient } from "../edge/broker-client.js";
import type { LiveIngressRegistry } from "../edge/live-registry.js";
import type { Provider } from "../domain.js";

/** Separate child processes keep slow provider diagnostics off the delivery event loop. */
export function startHealthReporter(broker: BrokerClient, live: LiveIngressRegistry): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  async function report(): Promise<void> {
    try {
      const profiles = await broker.healthProfiles();
      for (const profile of profiles) {
        if (stopped) return;
        try {
          const { stdout } = await promisify(execFile)(process.execPath,
            [fileURLToPath(new URL("./profile-probe.js", import.meta.url)), profile.actor, profile.provider, profile.accountProfile],
            { timeout: 110_000, maxBuffer: 2 * 1024 * 1024 });
          if (stopped) return;
          const observation = JSON.parse(stdout);
          const receiving = live.get(profile.actor, profile.provider as Provider);
          observation.receiving = receiving ? { sessionId: receiving.sessionId, expiresAt: receiving.expiresAt,
            attestation: receiving.runtimeAttestation.ok ? receiving.runtimeAttestation.attestation.attestationId : null } : null;
          await broker.reportHealth(observation);
        } catch { console.error(`hive health probe failed for ${profile.actor}`); }
      }
    } catch { console.error("hive health report unavailable"); }
    finally { if (!stopped) { timer = setTimeout(() => void report(), 300_000); timer.unref(); } }
  }
  void report();
  return () => { stopped = true; clearTimeout(timer); };
}
