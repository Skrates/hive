#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdmissionPolicySchema } from "./addressing.js";
import { BrokerHttpServer } from "./broker/http.js";
import { SlackLinkProbe } from "./broker/probe.js";
import { BrokerService, housekeepingTick } from "./broker/service.js";
import { SlackCanaryPoster, SlackSocketIngress, SlackWebTransport } from "./broker/slack.js";
import { BrokerStore, LegacyDatabaseError } from "./broker/store.js";
import { SlackDeafnessWatchdog } from "./broker/watchdog.js";
import { startHealthReporter } from "./health/edge-reporter.js";
import { SubscriptionInputSchema, type Delivery, type SeatWakeReceipt } from "./domain.js";
import { ensureEdgeStateDirs } from "./edge/bootstrap.js";
import { BrokerClient } from "./edge/broker-client.js";
import { EdgeControlServer } from "./edge/control.js";
import { LiveIngressRegistry } from "./edge/live-registry.js";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { ClaudeProvider, CodexProvider, GrokProvider, resolveEdgeSocketPath } from "./edge/providers.js";
import { EdgeService } from "./edge/service.js";
import { EdgeStore } from "./edge/store.js";
import { udsRequestJson, UdsHttpError } from "./local/uds.js";
import {
  assertCodexAttachmentActor,
  CODEX_ATTACHMENT_CONFIRMATION_TIMEOUT_MS,
  createCodexForegroundBinding,
  readCodexForegroundBinding,
  removeCodexForegroundBinding,
  restoreCodexForegroundBinding,
} from "./codex/binding.js";
import type { BindingStatus } from "./codex/live.js";
import { installCodexSkill } from "./codex/skill-install.js";
import { registerReviewCommands } from "./review/cli.js";
import { bootReviewRuntime, type ReviewRuntime } from "./review/runtime.js";
import { LegacyReviewStoreError } from "./review/store.js";
import { systemClock } from "./time.js";

const program = new Command().name("hive").description("Hive broker/edge wake router");

const hiveHome = (): string => process.env.HIVE_HOME ?? join(homedir(), ".hive");

program.command("broker")
  .description("run the central Slack Socket Mode broker")
  .action(async () => {
    const config = BrokerConfig.parse(process.env);
    const policy = AdmissionPolicySchema.parse(JSON.parse(config.HIVE_ADMISSION_POLICY));
    // Two generations are asserted here, and a stale one is a boot failure, never a degraded
    // broker: `LegacyDatabaseError` for the Hive ledger (ADR-0003 R-8), `LegacyReviewStoreError`
    // for the persisted reviews (design §9.3). Each names its own reset procedure; the review one
    // is `hive review reset-store`, which leaves the ledger alone.
    let store: BrokerStore;
    let review: ReviewRuntime;
    try {
      store = new BrokerStore(config.HIVE_BROKER_DB);
      // The review state machine lives in the broker's own database (module map §8): the
      // store, the publisher, and — once the App's owner-only secret files exist — the
      // webhook ingress and the reconcile scheduler.
      review = bootReviewRuntime({
        broker: store,
        clock: systemClock,
        adminToken: config.HIVE_ADMIN_TOKEN,
        env: config,
        failureChannelId: policy.channelIds.values().next().value,
        log: (line) => console.error(line),
      });
    } catch (error) {
      if (error instanceof LegacyDatabaseError || error instanceof LegacyReviewStoreError) {
        console.error(`[boot] refusing to start: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    const broker = new BrokerService(store, new SlackWebTransport(config.HIVE_SLACK_BOT_TOKEN));
    const http = new BrokerHttpServer(broker, {
      host: config.HIVE_BROKER_HOST,
      port: config.HIVE_BROKER_PORT,
      adminToken: config.HIVE_ADMIN_TOKEN,
      ...(config.HIVE_HEALTH_CANVAS_CONFIG ? { healthCanvasConfigPath: config.HIVE_HEALTH_CANVAS_CONFIG } : {}),
      review: review.http,
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
    review.start();
    // The claim loop also sweeps and drains, but only while an edge is
    // polling. This interval keeps loss visible (R-3) and the outbox flowing
    // (R-6) even when every edge is dark. The review publisher rides the same
    // tick (§8.1) but not the same queue: publication and the outbox drain run
    // independently, so a GitHub port that is slow or hung delays no Hive wake.
    const housekeeping = setInterval(() => {
      void housekeepingTick({
        sweep: () => store.requeueExpiredLeases(),
        publish: () => review.housekeeping(),
        drainOutbox: () => broker.drainOutbox(),
        log: (what, error) => console.error(what, error instanceof Error ? error.message : String(error)),
      });
    }, 5_000);
    // Deafness watchdog: a Socket Mode link that stays "connected" but stops
    // carrying events (half-open socket, or a second consumer stealing the
    // stream) is invisible without this. Silence alone never decides — the
    // watchdog first probes the link with its own canaries (KRA-1357); only an
    // unexplained silence forces a reconnect, and only a persistent one exits
    // for a systemd restart.
    const probeChannelId = config.HIVE_WATCHDOG_PROBE_CHANNEL ?? [...policy.channelIds][0] ?? null;
    if (!probeChannelId) {
      console.error(
        "[watchdog] no admitted channel to probe (set HIVE_WATCHDOG_PROBE_CHANNEL) "
        + "— quiet and deaf will be indistinguishable, as they were before KRA-1357",
      );
    }
    let probe: SlackLinkProbe | null = null;
    if (probeChannelId) {
      const poster = new SlackCanaryPoster(config.HIVE_SLACK_BOT_TOKEN, probeChannelId);
      // Bind the canary identity before the first cycle can run: only the
      // broker's own bot user, in this channel, may settle a probe. A failure
      // here is a startup failure — Socket Mode needs the same Slack reach.
      const identity = await poster.identify();
      slack.expectCanariesFrom(identity);
      console.error(`[watchdog] canaries authenticated as bot user ${identity.userId} in ${identity.channelId}`);
      probe = new SlackLinkProbe(poster, slack, (message) => console.error(message));
    }
    const watchdog = new SlackDeafnessWatchdog({
      lastEventAt: () => slack.lastEventAt(),
      lastConnectAt: () => slack.lastConnectAt(),
      hasActiveSubscription: () => broker.hasActiveSubscription(),
      probeLink: async (timeoutMs) => (probe ? probe.run(timeoutMs) : "unavailable"),
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
      await withTimeout(review.stop(), 5_000, "review.stop");
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
    const socketPath = resolveEdgeSocketPath();
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
    const stopHealth = startHealthReporter(broker, live);
    await untilSignal(async () => {
      stopHealth();
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
    const socketPath = resolveEdgeSocketPath();
    await udsRequestJson(socketPath, "POST", "/outcome", { deliveryId: id, text: text.join(" ") });
    process.stdout.write(`outcome recorded for delivery ${id}\n`);
  });

program.command("wake")
  .argument("<actor>", "the peer seat to wake")
  .argument("<text...>", "the instruction to deliver")
  .option("--thread <thread-ts>", "target thread in the source delivery's channel (default: that delivery's thread)")
  .description("mint a wake for a peer seat (KRA-1097)")
  .action(async (actor: string, text: string[], options: { thread?: string }) => {
    // The minting seat is named by the delivery it is executing, and that
    // delivery is named by the EDGE, not by this command: the turn's capability
    // is all the caller presents. A seat therefore cannot name a source at all,
    // so it can neither forge an attribution nor lose one — on a box where
    // several seats share one edge and one socket, an id in the request would
    // have been exactly that forgery.
    const token = process.env.HIVE_DELIVERY_TOKEN;
    if (!token) {
      throw new Error(
        "no dispatch token: `hive wake` mints from a turn this edge is running, which exports "
        + "HIVE_DELIVERY_TOKEN. A live-delivered turn holds no per-dispatch capability and cannot mint "
        + "(KRA-1118); ask the human in the thread instead.",
      );
    }
    const socketPath = resolveEdgeSocketPath();
    let receipt: SeatWakeReceipt;
    try {
      receipt = await udsRequestJson<SeatWakeReceipt>(socketPath, "POST", "/wake", {
        token,
        actor,
        text: text.join(" "),
        threadTs: options.thread ?? null,
      });
    } catch (error) {
      // R-3: a mint that could not be delivered says so, loudly and non-zero.
      // Never "posted" with nothing behind it.
      if (error instanceof UdsHttpError) throw new Error(`hive wake refused: ${refusalDetail(error.responseBody)}`);
      throw error;
    }
    process.stdout.write(receipt.created
      ? `minted delivery ${receipt.deliveryId}: ${receipt.from} → ${receipt.actor} in ${receipt.channelId}/${receipt.threadTs}\n`
      : `already minted as delivery ${receipt.deliveryId}: ${receipt.from} → ${receipt.actor} (identical text, nothing re-sent)\n`);
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

registerReviewCommands(program);

const BrokerConfig = z.object({
  HIVE_BROKER_DB: z.string().min(1).default("hive-broker.sqlite"),
  HIVE_BROKER_HOST: z.string().min(1).default("127.0.0.1"),
  HIVE_BROKER_PORT: z.coerce.number().int().min(0).max(65535).default(8790),
  HIVE_ADMIN_TOKEN: z.string().min(32),
  HIVE_SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  HIVE_SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  HIVE_SLACK_WORKSPACE_ID: z.string().min(1),
  HIVE_ADMISSION_POLICY: z.string().min(2),
  HIVE_HEALTH_CANVAS_CONFIG: z.string().min(1).optional(),
  // Deafness threshold: silence past this while subscriptions are live opens a
  // link probe; unexplained silence then forces a Socket Mode reconnect, and a
  // second consecutive unexplained cycle exits for systemd.
  HIVE_WATCHDOG_STALE_MS: z.coerce.number().int().min(10_000).default(300_000),
  // Channel the watchdog posts its link canaries to (they are hive_*-stamped, so
  // admission drops them, and each is deleted once observed). Defaults to the
  // first admitted channel — the commons.
  HIVE_WATCHDOG_PROBE_CHANNEL: z.string().min(1).optional(),
  // The GitHub App (design §7): secrets are owner-only files, never bare values. All
  // three or none; a named file that is absent or readable beyond its owner refuses to boot.
  HIVE_GITHUB_WEBHOOK_SECRET_FILE: z.string().min(1).optional(),
  HIVE_GITHUB_APP_ID: z.string().min(1).optional(),
  HIVE_GITHUB_APP_KEY_FILE: z.string().min(1).optional(),
  HIVE_GITHUB_SUMMON_TOKEN_FILE: z.string().min(1).optional(),
  HIVE_REVIEW_LOGFIRE_TOKEN: z.string().min(1).optional(),
  HIVE_REVIEW_LOGFIRE_REGION: z.enum(["us", "eu"]).optional(),
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

/**
 * The reason a mint was refused, taken from the edge's relayed error envelope.
 * A body that is not that envelope is surfaced raw rather than guessed at — the
 * seat must always be able to see what actually happened.
 */
function refusalDetail(body: string): string {
  try {
    const value = JSON.parse(body) as { error?: unknown; detail?: unknown };
    if (typeof value.error === "string") {
      return typeof value.detail === "string" ? `${value.error} — ${value.detail}` : value.error;
    }
  } catch {
    // fall through to the raw body below
  }
  return body.slice(0, 500);
}

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
  timeoutMs = CODEX_ATTACHMENT_CONFIRMATION_TIMEOUT_MS,
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
