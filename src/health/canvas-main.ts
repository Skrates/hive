/** Broker-host-only timer entrypoint. Collection never opens a provider turn or repairs a login. */
import { readFileSync, writeFileSync } from "node:fs";
import { WebClient } from "@slack/web-api";
import { execFileSync } from "node:child_process";
import { CanvasConfig, collectCanvas, renderCanvas } from "./canvas.js";

async function main(): Promise<void> {
  const [configPath, outputPath, mode] = process.argv.slice(2);
  if (!configPath || !outputPath || !["preview", "publish"].includes(mode ?? "")) {
    throw new Error("usage: canvas-main CONFIG_JSON OUTPUT_MD preview|publish");
  }
  const config = CanvasConfig.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const snapshot = await collectCanvas(config);
  let status = "Snapshot only. Unattended refresh has not been enabled.";
  if (mode === "publish") {
    try {
      if (execFileSync("systemctl", ["--user", "is-active", "hive-health-canvas.timer"], { encoding: "utf8", timeout: 2_000 }).trim() === "active") {
        status = "Unattended refresh enabled: broker timer runs every five minutes.";
      }
    } catch { /* One-off publishing does not claim a scheduled updater. */ }
  }
  const markdown = renderCanvas(snapshot, status);
  writeFileSync(outputPath, markdown, { mode: 0o600 });
  writeFileSync(`${outputPath}.json`, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  if (mode === "publish") {
    if (!config.canvasId || !process.env.HIVE_SLACK_BOT_TOKEN) throw new Error("canvas ID and broker Slack token required");
    const slack = new WebClient(process.env.HIVE_SLACK_BOT_TOKEN, { retryConfig: { retries: 0 }, timeout: 20_000 });
    await slack.canvases.edit({ canvas_id: config.canvasId, changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }] });
    console.log(`Updated canvas ${config.canvasId} at ${snapshot.generatedAt}`);
  } else console.log(`Rendered ${snapshot.seats.length} seats and ${snapshot.doctor.length} usage reporters at ${snapshot.generatedAt}`);
}
void main().catch((error: unknown) => {
  // Never dump provider command output, environment, or Slack WebClient request objects.
  const slackError = error as { data?: { error?: string } };
  console.error(`health canvas failed: ${slackError.data?.error ?? "collection or configuration error"}`);
  process.exitCode = 1;
});
