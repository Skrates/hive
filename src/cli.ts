#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AdmissionPolicySchema } from "./addressing.js";
import { BrokerHttpServer } from "./broker/http.js";
import { BrokerService } from "./broker/service.js";
import { SlackSocketIngress, SlackWebTransport } from "./broker/slack.js";
import { BrokerStore } from "./broker/store.js";
import { SubscriptionInputSchema } from "./domain.js";
import { BrokerClient } from "./edge/broker-client.js";
import { EdgeHttpServer } from "./edge/http.js";
import { LiveIngressRegistry } from "./edge/live-registry.js";
import { ClaudeProvider, CodexProvider } from "./edge/providers.js";
import { EdgeService } from "./edge/service.js";
import { EdgeStore } from "./edge/store.js";

const program = new Command().name("hive").description("Hive broker/edge wake router");

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
    const slack = new SlackSocketIngress(config.HIVE_SLACK_APP_TOKEN, config.HIVE_SLACK_WORKSPACE_ID, policy, broker);
    await http.start();
    await slack.start();
    await untilSignal(async () => {
      await slack.stop();
      await http.stop();
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
    await http.start();
    const controller = new AbortController();
    const run = edge.run(controller.signal);
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

const BrokerConfig = z.object({
  HIVE_BROKER_DB: z.string().min(1).default("hive-broker.sqlite"),
  HIVE_BROKER_HOST: z.string().min(1).default("127.0.0.1"),
  HIVE_BROKER_PORT: z.coerce.number().int().min(0).max(65535).default(8790),
  HIVE_ADMIN_TOKEN: z.string().min(32),
  HIVE_SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  HIVE_SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  HIVE_SLACK_WORKSPACE_ID: z.string().min(1),
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

async function untilSignal(cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await cleanup();
}

await program.parseAsync();
