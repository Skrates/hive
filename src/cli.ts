#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AdmissionPolicySchema } from "./addressing.js";
import { BrokerHttpServer } from "./broker/http.js";
import { BrokerService } from "./broker/service.js";
import { SlackSocketIngress, SlackWebTransport } from "./broker/slack.js";
import { BrokerStore } from "./broker/store.js";
import {
	AttachmentUpdateSchema,
	BindingUpdateSchema,
	ChannelListenerUpdateSchema,
		DeliveryStatusSchema,
		EgressPolicyUpdateSchema,
		OutboxReconciliationSchema,
		SlackOutboxStateSchema,
	SubscriptionInputSchema,
	type LivePresence,
	type Subscription,
} from "./domain.js";
import { CodexThreadCatalog } from "./codex/discovery.js";
import { BrokerClient } from "./edge/broker-client.js";
import { EdgeHttpServer } from "./edge/http.js";
import { LiveIngressRegistry } from "./edge/live-registry.js";
import { ClaudeProvider, CodexProvider } from "./edge/providers.js";
import { EdgeService } from "./edge/service.js";
import { EdgeStore } from "./edge/store.js";
import { OperatorClient } from "./operator/client.js";
import { OperatorDashboardServer } from "./operator/dashboard.js";
import { formatOperatorDeliveries, formatOperatorOutbox, formatOperatorStatus } from "./operator/format.js";

const program = new Command().name("hive").description("Hive broker/edge collaboration router");

program.command("broker")
  .description("run the central Slack Socket Mode broker")
  .action(async () => {
    const config = BrokerConfig.parse(process.env);
    const policy = AdmissionPolicySchema.parse(JSON.parse(config.HIVE_ADMISSION_POLICY));
	if (!policy.workspaceIds.has(config.HIVE_SLACK_WORKSPACE_ID)) {
	  throw new Error("HIVE_SLACK_WORKSPACE_ID is not admitted by HIVE_ADMISSION_POLICY");
	}
	const store = new BrokerStore(config.HIVE_BROKER_DB);
	const slackTransport = new SlackWebTransport(config.HIVE_SLACK_BOT_TOKEN);
	await slackTransport.preflight(policy.channelIds);
	const broker = new BrokerService(store, slackTransport);
    const http = new BrokerHttpServer(broker, {
      host: config.HIVE_BROKER_HOST,
      port: config.HIVE_BROKER_PORT,
      adminToken: config.HIVE_ADMIN_TOKEN,
    });
    const slack = new SlackSocketIngress(config.HIVE_SLACK_APP_TOKEN, config.HIVE_SLACK_WORKSPACE_ID, policy, broker);
	    await slack.start();
	broker.setSlackReadinessSource(() => {
	  const socket = slack.readiness();
	  const bot = slackTransport.botReadiness();
	  return {
		ready: socket.socket === "connected" && bot.bot === "ready",
		socket: socket.socket,
		bot: bot.bot,
		updatedAt: new Date(Math.max(new Date(socket.updatedAt).getTime(), new Date(bot.updatedAt).getTime())).toISOString(),
	  };
	});
	if (!broker.readiness().ready) throw new Error("Slack broker failed readiness preflight");
	await http.start();
			broker.startOutbox();
			const slackPreflightTimer = setInterval(() => {
				void slackTransport.preflight(policy.channelIds).catch(() => undefined);
			}, 30_000);
			slackPreflightTimer.unref();
		    await untilSignal(async () => {
			  clearInterval(slackPreflightTimer);
      await slack.stop();
      await http.stop();
		  await broker.stopOutbox();
      store.close();
    });
  });

program.command("edge")
  .description("run a workstation edge")
  .action(async () => {
    const config = EdgeConfig.parse(process.env);
    const broker = new BrokerClient(config.HIVE_BROKER_URL, config.HIVE_EDGE_ID, config.HIVE_EDGE_TOKEN);
    const store = new EdgeStore(config.HIVE_EDGE_DB);
    const live = new LiveIngressRegistry();
    const edge = new EdgeService(broker, store, live, [
      new CodexProvider(config.HIVE_EDGE_LOCAL_TOKEN),
      new ClaudeProvider(config.HIVE_EDGE_LOCAL_TOKEN),
    ]);
    const http = new EdgeHttpServer(edge, {
      host: config.HIVE_EDGE_HOST,
      port: config.HIVE_EDGE_PORT,
      localToken: config.HIVE_EDGE_LOCAL_TOKEN,
    });
    const controller = new AbortController();
	await edge.preflight(AbortSignal.timeout(8_000));
    const run = edge.run(controller.signal);
	await http.start();
    await untilSignal(async () => {
      controller.abort();
      await http.stop();
      await run;
      store.close();
    });
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

program.command("status")
	.argument("[actor]")
	.option("--json", "emit machine-readable JSON")
	.option("--stale-after <seconds>", "seconds before an edge is shown as stale", "60")
	.description("show edges, actor bindings, leases, and delivery health")
	.action(async (
		actor: string | undefined,
		options: { json?: boolean; staleAfter: string },
	) => {
		const staleAfterMs = positiveNumber(options.staleAfter, "stale-after") * 1_000;
		const status = await operatorClient().status({ ...(actor ? { actor } : {}), staleAfterMs });
		process.stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : formatOperatorStatus(status));
	});

program.command("attach")
	.argument("<actor>")
	.option("--channel <channel-id...>", "exact Slack channel(s) to listen to")
	.option("--cwd <path>", "exact Codex task workspace", process.cwd())
	.option("--session <session-id>", "bind this session instead of discovering the newest primary task")
	.option("--surface <name>", "update the provider surface metadata")
	.option("--provider-version <version>", "update the provider version metadata")
	.option("--no-wait", "return before the live owner confirms the attachment")
	.option("--json", "emit machine-readable JSON")
	.description("attach the current Codex task to admitted channel traffic")
	.action(async (
		actor: string,
		options: {
			channel?: string[];
			cwd: string;
			session?: string;
			surface?: string;
			providerVersion?: string;
			wait: boolean;
			json?: boolean;
		},
	) => {
		const client = operatorClient();
		const status = await client.status({ actor });
		const current = status.actors[0]?.subscription;
		if (!current || current.actor !== actor) throw new Error(`subscription ${actor} not found`);
		const cwd = resolve(options.cwd);

		let sessionId = options.session ?? process.env.CODEX_THREAD_ID;
		if (current.provider === "codex") {
			const catalog = new CodexThreadCatalog();
			try {
				if (sessionId) {
					const exact = catalog.primaryUserThread(sessionId, cwd);
					if (!exact) {
						throw new Error(
							`Codex task ${sessionId} is not a primary user task at ${cwd}`,
						);
					}
					sessionId = exact.sessionId;
				} else {
					const discovered = catalog.latestPrimaryUserThread(cwd);
					if (!discovered) throw new Error(`no primary Codex task found at ${cwd}`);
					sessionId = discovered.sessionId;
				}
			} finally {
				catalog.close();
			}
		} else if (!sessionId) {
			throw new Error("--session is required when attaching a non-Codex provider");
		}

		const channelIds = options.channel
			?? current.listenChannelIds
			?? (process.env.HIVE_CHANNEL_ID ? [process.env.HIVE_CHANNEL_ID] : []);
		const update = AttachmentUpdateSchema.parse({
			sessionId,
			cwd,
			channelIds,
			...(options.surface ? { providerSurface: options.surface } : {}),
			...(options.providerVersion ? { providerVersion: options.providerVersion } : {}),
		});
		const subscription = await client.attach(actor, update);
		const livePresence = options.wait
			? await waitForAttachment(client, subscription)
			: null;
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ subscription, livePresence }, null, 2)}\n`);
		} else {
			process.stdout.write(
				`Attached ${subscription.actor} session ${subscription.sessionId} to `
				+ `${(subscription.listenChannelIds ?? []).join(", ")}`
				+ `${livePresence ? `; live via ${livePresence.transport}.` : "."}\n`,
			);
		}
	});

program.command("detach")
	.argument("<actor>")
	.option("--json", "emit machine-readable JSON")
	.description("stop channel-wide delivery without changing the actor's session binding")
	.action(async (actor: string, options: { json?: boolean }) => {
		const update = ChannelListenerUpdateSchema.parse({ channelIds: [] });
		const result = await operatorClient().setChannelListener(actor, update);
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(
			`Detached ${result.actor} from channel-wide delivery; session binding is unchanged.\n`,
		);
	});

program.command("bind")
	.argument("<actor>")
	.argument("<session-id>")
	.option("--surface <name>", "update the provider surface metadata")
	.option("--provider-version <version>", "update the provider version metadata")
	.option("--json", "emit machine-readable JSON")
	.description("bind an actor to a provider session without changing its authority")
	.action(async (
		actor: string,
		sessionId: string,
		options: { surface?: string; providerVersion?: string; json?: boolean },
	) => {
		const update = BindingUpdateSchema.parse({
			sessionId,
			...(options.surface ? { providerSurface: options.surface } : {}),
			...(options.providerVersion ? { providerVersion: options.providerVersion } : {}),
		});
		const result = await operatorClient().bind(actor, update);
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`Bound ${result.actor} to ${result.sessionId} on ${result.homeEdge}.\n`);
	});

program.command("unbind")
	.argument("<actor>")
	.option("--json", "emit machine-readable JSON")
	.description("remove an actor's resumable session binding without changing its authority")
	.action(async (actor: string, options: { json?: boolean }) => {
		const result = await operatorClient().bind(actor, { sessionId: null });
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`Unbound ${result.actor}; wake policy remains ${result.wakePolicy}.\n`);
	});

program.command("auto-bind")
	.argument("<actor>")
	.option("--json", "emit machine-readable JSON")
	.description("allow the actor's home edge to follow the latest matching primary Desktop task")
	.action(async (actor: string, options: { json?: boolean }) => {
		const result = await operatorClient().setBindingMode(actor, "auto");
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`Auto-binding enabled for ${result.actor} on ${result.homeEdge}.\n`);
	});

program.command("pin-binding")
	.argument("<actor>")
	.option("--json", "emit machine-readable JSON")
	.description("stop automatic session discovery without changing the current binding")
	.action(async (actor: string, options: { json?: boolean }) => {
		const result = await operatorClient().setBindingMode(actor, "pinned");
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`Pinned ${result.actor} to its current binding.\n`);
	});

program.command("deliveries")
	.option("--actor <actor>", "filter by actor")
	.option("--status <status>", "filter by delivery status")
	.option("--limit <count>", "maximum rows", "50")
	.option("--json", "emit machine-readable JSON")
	.description("inspect recent delivery outcomes without rendering Slack bodies")
	.action(async (options: { actor?: string; status?: string; limit: string; json?: boolean }) => {
		const status = options.status ? DeliveryStatusSchema.parse(options.status) : undefined;
		const limit = positiveInteger(options.limit, "limit");
			const deliveries = await operatorClient().deliveries({
			...(options.actor ? { actor: options.actor } : {}),
			...(status ? { status } : {}),
				limit,
			});
			process.stdout.write(
				options.json ? `${JSON.stringify(deliveries, null, 2)}\n` : formatOperatorDeliveries(deliveries),
			);
		});

program.command("egress")
	.argument("<actor>")
	.argument("<policy>", "receipt_only or assistant_text")
	.option("--channel <channel-id...>", "exact Slack channel allowlist for assistant_text")
	.option("--json", "emit machine-readable JSON")
	.description("set the admin-only Slack completion egress policy")
	.action(async (
		actor: string,
		policy: string,
		options: { channel?: string[]; json?: boolean },
	) => {
		const update = EgressPolicyUpdateSchema.parse({
			policy,
			channelIds: options.channel ?? [],
		});
		const result = await operatorClient().setEgressPolicy(actor, update);
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(
			`Egress for ${result.actor}: ${result.egressPolicy}`
			+ `${result.egressChannelIds.length > 0 ? ` in ${result.egressChannelIds.join(", ")}` : ""}.\n`,
		);
	});

program.command("outbox")
	.option("--state <state>", "filter by pending, sending, sent, ambiguous, or dead")
	.option("--limit <count>", "maximum rows", "50")
	.option("--json", "emit machine-readable JSON")
	.description("inspect payload-free Slack egress state")
	.action(async (options: { state?: string; limit: string; json?: boolean }) => {
		const state = options.state ? SlackOutboxStateSchema.parse(options.state) : undefined;
		const items = await operatorClient().outbox({
			...(state ? { state } : {}),
			limit: positiveInteger(options.limit, "limit"),
		});
		process.stdout.write(options.json ? `${JSON.stringify(items, null, 2)}\n` : formatOperatorOutbox(items));
	});

program.command("reconcile-outbox")
	.argument("<outbox-id>")
	.argument("<disposition>", "sent, retry, or dead")
	.requiredOption("--detail <detail>", "operator audit detail")
	.option("--slack-ts <timestamp>", "Slack message timestamp when marking sent")
	.option("--json", "emit machine-readable JSON")
	.description("resolve ambiguous Slack egress after inspecting the thread")
	.action(async (
		outboxIdValue: string,
		disposition: string,
		options: { detail: string; slackTs?: string; json?: boolean },
	) => {
		const input = OutboxReconciliationSchema.parse({
			disposition,
			detail: options.detail,
			...(options.slackTs ? { slackTs: options.slackTs } : {}),
		});
		const result = await operatorClient().reconcileOutbox(
			positiveInteger(outboxIdValue, "outbox-id"),
			input,
		);
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`Slack outbox #${result.id} is now ${result.state}.\n`);
	});

program.command("reconcile")
	.argument("<delivery-id>")
	.argument("<disposition>", "processed or requeue")
	.requiredOption("--detail <detail>", "operator audit detail")
	.option("--json", "emit machine-readable JSON")
	.description("resolve an ambiguous delivery with an explicit audit reason")
	.action(async (
		deliveryIdValue: string,
		dispositionValue: string,
		options: { detail: string; json?: boolean },
	) => {
		const deliveryId = positiveInteger(deliveryIdValue, "delivery-id");
		const disposition = z.enum(["processed", "requeue"]).parse(dispositionValue);
		const result = await operatorClient().reconcile(deliveryId, disposition, options.detail);
		if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`Delivery #${result.id} is now ${result.status}.\n`);
	});

program.command("web")
	.option("--port <port>", "loopback dashboard port", process.env.HIVE_OPERATOR_PORT ?? "8792")
	.description("run the loopback-only Hive operator dashboard")
	.action(async (options: { port: string }) => {
		const port = positiveInteger(options.port, "port");
		if (port > 65_535) throw new Error("port must be at most 65535");
		const dashboard = new OperatorDashboardServer(operatorClient(), { port });
		const address = await dashboard.start();
		process.stdout.write(`Hive operator dashboard: ${address.url}\n`);
		await untilSignal(() => dashboard.stop());
	});

const BrokerConfig = z.object({
  HIVE_BROKER_DB: z.string().min(1).default("hive-broker.sqlite"),
  HIVE_BROKER_HOST: z.string().min(1).default("127.0.0.1"),
  HIVE_BROKER_PORT: z.coerce.number().int().min(0).max(65535).default(8790),
  HIVE_ADMIN_TOKEN: z.string().min(32),
  HIVE_SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  HIVE_SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
	HIVE_SLACK_WORKSPACE_ID: z.string().regex(/^T[A-Z0-9]+$/i).transform((value) => value.toUpperCase()),
  HIVE_ADMISSION_POLICY: z.string().min(2),
});

const EdgeConfig = z.object({
  HIVE_BROKER_URL: z.string().url(),
  HIVE_EDGE_ID: z.string().min(1),
  HIVE_EDGE_TOKEN: z.string().min(32),
  HIVE_EDGE_LOCAL_TOKEN: z.string().min(32),
  HIVE_EDGE_DB: z.string().min(1).default("hive-edge.sqlite"),
  HIVE_EDGE_HOST: z.string().min(1).default("127.0.0.1"),
  HIVE_EDGE_PORT: z.coerce.number().int().min(0).max(65535).default(8791),
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function operatorClient(): OperatorClient {
	return new OperatorClient(requiredEnv("HIVE_BROKER_URL"), requiredEnv("HIVE_ADMIN_TOKEN"));
}

function positiveNumber(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
	return parsed;
}

function positiveInteger(value: string, name: string): number {
	const parsed = positiveNumber(value, name);
	if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
	return parsed;
}

async function waitForAttachment(
	client: OperatorClient,
	subscription: Subscription,
	timeoutMs = 15_000,
): Promise<LivePresence> {
	const deadline = Date.now() + timeoutMs;
	do {
		const status = await client.status({ actor: subscription.actor, staleAfterMs: 60_000 });
		const actor = status.actors[0];
		const current = actor?.subscription;
		const live = actor?.livePresence;
		if (
			current?.sessionId === subscription.sessionId
			&& current.bindingRevision === subscription.bindingRevision
			&& live?.sessionId === subscription.sessionId
			&& live.bindingRevision === subscription.bindingRevision
			&& live.ownerLoaded
			&& new Date(live.expiresAt).getTime() > Date.now()
		) return live;
		if (Date.now() >= deadline) break;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	} while (true);
	throw new Error(
		`attachment was recorded but ${subscription.actor}'s live owner did not confirm it within `
		+ `${timeoutMs / 1_000}s; run \`hive status ${subscription.actor}\``,
	);
}

async function untilSignal(cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await cleanup();
}

await program.parseAsync();
