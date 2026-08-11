#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdmissionPolicySchema } from "./addressing.js";
import { BrokerHttpServer } from "./broker/http.js";
import { BrokerService } from "./broker/service.js";
import { SlackSocketIngress, SlackWebTransport } from "./broker/slack.js";
import { BrokerStore } from "./broker/store.js";
import { SlackDeafnessWatchdog } from "./broker/watchdog.js";
import { SubscriptionInputSchema, type Delivery } from "./domain.js";
import { ensureEdgeStateDirs } from "./edge/bootstrap.js";
import { BrokerClient } from "./edge/broker-client.js";
import { EdgeControlServer } from "./edge/control.js";
import { LiveIngressRegistry } from "./edge/live-registry.js";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { ClaudeProvider, CodexProvider, GrokProvider } from "./edge/providers.js";
import { EdgeService } from "./edge/service.js";
import { EdgeStore } from "./edge/store.js";
import { udsRequestJson } from "./local/uds.js";
import {
  assertCodexAttachmentActor,
  createCodexForegroundBinding,
  readCodexForegroundBinding,
  removeCodexForegroundBinding,
  restoreCodexForegroundBinding,
} from "./codex/binding.js";
import type { BindingStatus } from "./codex/live.js";
import { installCodexSkill } from "./codex/skill-install.js";

const program = new Command().name("hive").description("Hive broker/edge wake router");

const hiveHome = (): string => process.env.HIVE_HOME ?? join(homedir(), ".hive");

program.command("broker")
  .description("run the central Slack Socket Mode broker")
  .action(async () => {
    const config = BrokerConfig.parse(process.env);
    const policy = AdmissionPolicySchema.parse(JSON.parse(config.HIVE_ADMISSION_POLICY));
    const store = new BrokerStore(config.HIVE_BROKER_DB);
    const broker = new BrokerService(store, new SlackWebTransport(config.HIVE_SLACK_BOT_TOKEN));
    const http = new BrokerHttpServer(broker, {
      host: config.HIVE_BROKER_HOST,
      port: config.HIVE_BROKER_PORT,
      adminToken: config.HIVE_ADMIN_TOKEN,
    });
    const slack = new SlackSocketIngress(
      config.HIVE_SLACK_APP_TOKEN,
      config.HIVE_SLACK_WORKSPACE_ID,
      policy,
      broker,
      (message) => console.error(message),
    );
    await http.start();
    await slack.start();
    // The claim loop also sweeps and drains, but only while an edge is
    // polling. This interval keeps loss visible (R-3) and the outbox flowing
    // (R-6) even when every edge is dark.
    const housekeeping = setInterval(() => {
      try {
        store.requeueExpiredLeases();
      } catch (error) {
        console.error("hive broker sweep failed", error instanceof Error ? error.message : String(error));
      }
      void broker.drainOutbox().catch((error: unknown) => {
        console.error("hive broker outbox drain failed", error instanceof Error ? error.message : String(error));
      });
    }, 5_000);
    // Deafness watchdog: a Socket Mode link that stays "connected" but stops
    // carrying events (half-open socket, or a second consumer stealing the
    // stream) is invisible without this. First stale cycle forces a reconnect;
    // a second consecutive silent cycle exits for a systemd restart.
    const watchdog = new SlackDeafnessWatchdog({
      lastEventAt: () => slack.lastEventAt(),
      lastConnectAt: () => slack.lastConnectAt(),
      hasActiveSubscription: () => broker.hasActiveSubscription(),
      restart: () => slack.restart(),
      exit: (code) => process.exit(code),
      now: () => Date.now(),
      log: (message) => console.error(message),
    }, config.HIVE_WATCHDOG_STALE_MS);
    const watchdogTimer = setInterval(() => {
      void watchdog.check().catch((error: unknown) => {
        console.error("[watchdog] cycle failed", error instanceof Error ? error.message : String(error));
      });
    }, config.HIVE_WATCHDOG_STALE_MS);
    await untilSignal(async () => {
      clearInterval(housekeeping);
      clearInterval(watchdogTimer);
      // Bound every teardown step: a hung disconnect or a lingering long-poll
      // must never turn SIGTERM into a SIGKILL. Force-exit once best-effort
      // cleanup returns so a stuck socket handle cannot keep the loop alive.
      await withTimeout(slack.stop(), 5_000, "slack.stop");
      await withTimeout(http.stop(), 5_000, "http.stop");
      store.close();
      process.exit(0);
    });
  });

program.command("edge")
  .description("run a workstation edge")
  .action(async () => {
    const config = EdgeConfig.parse(process.env);
    if (config.HIVE_BROKER_PROXY) setGlobalDispatcher(new ProxyAgent(config.HIVE_BROKER_PROXY));
    const ingressRoot = config.HIVE_INGRESS_DIR ?? join(hiveHome(), "ingress");
    const socketPath = config.HIVE_EDGE_SOCKET ?? join(hiveHome(), "edge.sock");
    // A fresh machine has no ~/.hive/ tree; better-sqlite3 and the control
    // socket both refuse to open into a missing directory. Bootstrap the state
    // dirs before anything opens them.
    ensureEdgeStateDirs({ dbPath: config.HIVE_EDGE_DB, socketPath, ingressDir: ingressRoot });
    const broker = new BrokerClient(config.HIVE_BROKER_URL, config.HIVE_EDGE_ID, config.HIVE_EDGE_TOKEN);
    const store = new EdgeStore(config.HIVE_EDGE_DB);
    const live = new LiveIngressRegistry();
    const edge = new EdgeService(broker, store, live, [
      new CodexProvider(),
      new ClaudeProvider({ ingressRoot }),
      new GrokProvider(),
    ]);
    const control = new EdgeControlServer(edge, { socketPath });
    await control.start();
    const controller = new AbortController();
    const run = edge.run(controller.signal);
    await untilSignal(async () => {
      controller.abort();
      await control.stop();
      await run;
      store.close();
    });
  });

program.command("reply")
  .argument("<delivery-id>", "the delivery being answered")
  .argument("<text...>", "outcome summary to post to the Slack thread")
  .description("report an agent outcome for a delivery (ADR-0003 R-6)")
  .action(async (deliveryId: string, text: string[]) => {
    const id = Number(deliveryId);
    if (!Number.isInteger(id) || id < 1) throw new Error("delivery-id must be a positive integer");
    const socketPath = process.env.HIVE_EDGE_SOCKET ?? join(hiveHome(), "edge.sock");
    await udsRequestJson(socketPath, "POST", "/outcome", { deliveryId: id, text: text.join(" ") });
    process.stdout.write(`outcome recorded for delivery ${id}\n`);
  });

program.command("attach")
  .argument("<actor>", "Hive actor whose live Codex route should follow this task")
  .option("--session <id>", "Codex task id (defaults to CODEX_THREAD_ID)")
  .option("--cwd <path>", "exact task working directory", process.cwd())
  .description("explicitly attach an actor to a foreground Codex Desktop task")
  .action(async (actor: string, options: { session?: string; cwd: string }) => {
    const sessionId = options.session ?? process.env.CODEX_THREAD_ID;
    if (!sessionId) throw new Error("--session is required outside a Codex task");
    const cwd = resolve(options.cwd);
    const paths = codexAttachmentPaths(actor);
    const previous = await readCodexForegroundBinding(paths.bindingFile);
    const binding = await createCodexForegroundBinding({
      actor,
      sessionId,
      cwd,
      stateDatabase: paths.stateDatabase,
      bindingFile: paths.bindingFile,
    });
    try {
      await waitForBinding(paths.surfaceSocket, (status) =>
        status.actor === actor && status.mode === "desktop" && status.revision === binding.revision);
    } catch (error) {
      await restoreCodexForegroundBinding(paths.bindingFile, binding.revision, previous);
      throw error;
    }
    process.stdout.write(`attached ${actor} to foreground Codex task at ${cwd}\n`);
  });

program.command("detach")
  .argument("<actor>", "Hive actor to return to its dedicated Codex task")
  .description("detach an actor from a foreground task and restore its dedicated fallback")
  .action(async (actor: string) => {
    const paths = codexAttachmentPaths(actor);
    await removeCodexForegroundBinding(paths.bindingFile);
    await waitForBinding(paths.surfaceSocket, (status) => status.actor === actor && status.mode === "dedicated");
    process.stdout.write(`detached ${actor}; dedicated Codex task restored\n`);
  });

program.command("install-codex-skill")
  .description("install Hive Attach in the supported user-level Codex skill directory")
  .action(async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = await installCodexSkill(
      join(packageRoot, ".agents", "skills", "hive-attach"),
      join(homedir(), ".agents", "skills", "hive-attach"),
    );
    process.stdout.write(result.installed
      ? "installed Hive Attach for Codex; open the slash menu and choose Hive Attach\n"
      : "Hive Attach is already installed for Codex\n");
  });

program.command("status")
  .description("summarize broker deliveries (operator, flat surface)")
  .action(async () => {
    const baseUrl = requiredEnv("HIVE_BROKER_URL");
    const adminToken = requiredEnv("HIVE_ADMIN_TOKEN");
    const response = await fetch(`${baseUrl}/v1/admin/deliveries`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) throw new Error(`broker ${response.status}: ${await response.text()}`);
    const deliveries = await response.json() as Delivery[];
    const counts = new Map<string, number>();
    for (const delivery of deliveries) {
      counts.set(delivery.status, (counts.get(delivery.status) ?? 0) + 1);
    }
    process.stdout.write(`${JSON.stringify({
      total: deliveries.length,
      byStatus: Object.fromEntries([...counts.entries()].sort()),
      openFailures: deliveries
        .filter((delivery) => delivery.status === "failed" || delivery.status === "undeliverable")
        .map((delivery) => ({ id: delivery.id, actor: delivery.actor, reasons: delivery.reasons })),
    }, null, 2)}\n`);
  });

program.command("create-edge")
  .argument("<edge-id>")
  .description("mint or rotate an edge credential")
  .action(async (edgeId: string) => {
    const baseUrl = requiredEnv("HIVE_BROKER_URL");
    const adminToken = requiredEnv("HIVE_ADMIN_TOKEN");
    const client = new BrokerClient(baseUrl, "admin", "unused");
    process.stdout.write(`${JSON.stringify(await client.createEdge(adminToken, edgeId))}\n`);
  });

program.command("put-subscription")
  .argument("<json-file>")
  .description("upsert a subscription from a JSON file")
  .action(async (path: string) => {
    const input = SubscriptionInputSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const client = new BrokerClient(requiredEnv("HIVE_BROKER_URL"), "admin", "unused");
    const result = await client.upsertSubscription(requiredEnv("HIVE_ADMIN_TOKEN"), input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program.command("delete-subscription")
  .argument("<actor>")
  .description("retire an actor after its deliveries terminalize; remove its subscription and bindings")
  .action(async (actor: string) => {
    const client = new BrokerClient(requiredEnv("HIVE_BROKER_URL"), "admin", "unused");
    const result = await client.deleteSubscription(requiredEnv("HIVE_ADMIN_TOKEN"), actor);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

const BrokerConfig = z.object({
  HIVE_BROKER_DB: z.string().min(1).default("hive-broker.sqlite"),
  HIVE_BROKER_HOST: z.string().min(1).default("127.0.0.1"),
  HIVE_BROKER_PORT: z.coerce.number().int().min(0).max(65535).default(8790),
  HIVE_ADMIN_TOKEN: z.string().min(32),
  HIVE_SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  HIVE_SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  HIVE_SLACK_WORKSPACE_ID: z.string().min(1),
  HIVE_ADMISSION_POLICY: z.string().min(2),
  // Deafness threshold: silence past this while subscriptions are live forces a
  // Socket Mode reconnect; a second consecutive silent cycle exits for systemd.
  HIVE_WATCHDOG_STALE_MS: z.coerce.number().int().min(10_000).default(300_000),
});

const EdgeConfig = z.object({
  HIVE_BROKER_URL: z.string().url(),
  HIVE_EDGE_ID: z.string().min(1),
  HIVE_EDGE_TOKEN: z.string().min(32),
  HIVE_EDGE_DB: z.string().min(1).default("hive-edge.sqlite"),
  HIVE_EDGE_SOCKET: z.string().min(1).optional(),
  HIVE_INGRESS_DIR: z.string().min(1).optional(),
  /**
   * HTTP CONNECT proxy for the edge's own outbound fetch (the broker dial).
   * Needed where the tailnet is reachable only through a userspace tailscaled
   * (no TUN — e.g. a RunPod pod): plain Node fetch cannot route to tailnet
   * addresses there, so tailscaled's --outbound-http-proxy-listen carries it.
   * Scoped to this process via undici's global dispatcher — provider children
   * are spawned with their own env and dial their own providers directly. The
   * UDS control server uses its own socket transport and is unaffected.
   */
  HIVE_BROKER_PROXY: z.string().url().optional(),
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function codexAttachmentPaths(actor: string): {
  bindingFile: string;
  surfaceSocket: string;
  stateDatabase: string;
} {
  // The actor is interpolated into the binding path and the surface socket
  // path, and `detach` removes the file it names. Apply the grammar before any
  // of those paths exist, so a name carrying path segments can never reach the
  // filesystem — `attach` alone validating inside the binding writer is not
  // enough to cover removal.
  assertCodexAttachmentActor(actor);
  const desktopHome = process.env.HIVE_CODEX_DESKTOP_HOME ?? join(homedir(), ".codex");
  return {
    bindingFile: process.env.HIVE_CODEX_BINDING_FILE ?? join(hiveHome(), "codex-bindings", `${actor}.json`),
    surfaceSocket: process.env.HIVE_SURFACE_SOCKET ?? join(hiveHome(), `codex-live-${actor}.sock`),
    stateDatabase: process.env.HIVE_CODEX_DESKTOP_STATE_DB ?? join(desktopHome, "state_5.sqlite"),
  };
}

async function waitForBinding(
  surfaceSocket: string,
  accepted: (status: BindingStatus) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "surface unavailable";
  while (Date.now() < deadline) {
    try {
      const status = await udsRequestJson<BindingStatus>(surfaceSocket, "GET", "/binding");
      if (accepted(status)) return;
      last = status.mode;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Codex attachment was not confirmed by the live surface (${last})`);
}

/**
 * Await `promise`, but never longer than `ms`. On timeout (or rejection) log and
 * resolve anyway so a shutdown step can't wedge the whole SIGTERM path.
 */
async function withTimeout(promise: Promise<unknown>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = promise.then(
    () => {},
    (error: unknown) => console.error(`[shutdown] ${label} failed:`, error instanceof Error ? error.message : String(error)),
  );
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[shutdown] ${label} exceeded ${ms}ms; continuing`);
      resolve();
    }, ms);
  });
  try {
    await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function untilSignal(cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await cleanup();
}

await program.parseAsync();
