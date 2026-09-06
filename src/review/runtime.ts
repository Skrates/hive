/**
 * Composition of the review state machine inside the broker (module map §8).
 *
 * `bootReviewRuntime` builds the `ReviewStore` on the broker's own SQLite handle with the
 * real `decide`/`fold`/`read`, the `ReviewPublisher` over the broker's system-wake port,
 * and — when the GitHub App is configured — the webhook handler and the
 * `ReconcileScheduler`. The App's secrets are owner-only files named by
 * `HIVE_GITHUB_WEBHOOK_SECRET_FILE` and `HIVE_GITHUB_APP_KEY_FILE` (§7: tier-2 secrets on
 * the dev box), never bare environment variables; `HIVE_GITHUB_APP_ID` is the App's id.
 *
 * Configuration is all-or-nothing: with none of the three names set, the broker boots with
 * the GitHub adapter disabled and says so once (M0, the App does not exist yet — §1 F-2);
 * M0's Slack board line still publishes. Anything else that is not a complete, readable
 * configuration is a boot failure: a partial set, a file readable beyond its owner, or a
 * named file that is absent. A path typo must never boot a broker that acknowledges nothing
 * from GitHub while the operator believes the adapter is live ("a missing profile is a hard
 * pre-dispatch failure, never a fallback").
 */
import type { BrokerStore } from "../broker/store.js";
import type { Clock } from "../time.js";
import type { ReviewKey } from "./contract.js";
import { AppGitHubPort, type FetchLike } from "./github/port.js";
import { ReconcileScheduler } from "./github/reconcile.js";
import { handleWebhook } from "./github/webhook.js";
import type { ReviewHttpDeps } from "./http.js";
import { ReviewPublisher } from "./publisher.js";
import { decide, fold, read } from "./reducer.js";
import { readOwnerOnlyFile } from "./secret-file.js";
import { ReviewStore } from "./store.js";

export interface ReviewRuntimeEnv {
  HIVE_GITHUB_WEBHOOK_SECRET_FILE?: string | undefined;
  HIVE_GITHUB_APP_ID?: string | undefined;
  HIVE_GITHUB_APP_KEY_FILE?: string | undefined;
}

export interface ReviewRuntimeInput {
  broker: BrokerStore;
  clock: Clock;
  adminToken: string;
  env: ReviewRuntimeEnv;
  log: (line: string) => void;
  /** Test seam for the App port; production uses undici. */
  fetch?: FetchLike;
}

export interface ReviewRuntime {
  store: ReviewStore;
  publisher: ReviewPublisher;
  /** Present only when the GitHub adapter is enabled (M1). */
  scheduler: ReconcileScheduler | null;
  github: { appId: string } | null;
  http: ReviewHttpDeps;
  /** Starts the reconcile loops (inbox drain, sweep, start-up redelivery ask); a no-op without the adapter. */
  start(): void;
  stop(): Promise<void>;
}

export class ReviewRuntimeConfigError extends Error {}

const GITHUB_ENV = ["HIVE_GITHUB_WEBHOOK_SECRET_FILE", "HIVE_GITHUB_APP_ID", "HIVE_GITHUB_APP_KEY_FILE"] as const;

interface GitHubConfig { appId: string; webhookSecret: string; privateKeyPem: string }

/**
 * All three present ⇒ config; none named ⇒ null with the reason (the only disabled state);
 * partial ⇒ throws. A named file that cannot be read — absent, empty, or readable beyond its
 * owner — throws {@link ReviewRuntimeConfigError} (absent) or `SecretFileError` (the rest).
 */
function githubConfig(env: ReviewRuntimeEnv): { config: GitHubConfig } | { config: null; reason: string } {
  const named = GITHUB_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (named.length === 0) return { config: null, reason: `${GITHUB_ENV.join(", ")} are not set` };
  if (named.length < GITHUB_ENV.length) {
    const missing = GITHUB_ENV.filter((name) => !named.includes(name));
    throw new ReviewRuntimeConfigError(
      `GitHub adapter is partially configured: ${named.join(", ")} set but ${missing.join(", ")} not; set all three or none`,
    );
  }
  const appId = env.HIVE_GITHUB_APP_ID as string;
  const webhookSecret = readSecret("HIVE_GITHUB_WEBHOOK_SECRET_FILE", env.HIVE_GITHUB_WEBHOOK_SECRET_FILE as string);
  const privateKeyPem = readSecret("HIVE_GITHUB_APP_KEY_FILE", env.HIVE_GITHUB_APP_KEY_FILE as string);
  return { config: { appId, webhookSecret, privateKeyPem } };
}

function readSecret(name: string, path: string): string {
  try {
    return readOwnerOnlyFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ReviewRuntimeConfigError(`${name} names ${path}, which does not exist; the GitHub adapter refuses to boot without it (unset all three names to run without the adapter)`);
    }
    throw error;
  }
}

export function bootReviewRuntime(input: ReviewRuntimeInput): ReviewRuntime {
  const { broker, clock, log } = input;
  const store = new ReviewStore(broker.db, { decide, fold, read, clock });
  const resolved = githubConfig(input.env);

  if (resolved.config === null) {
    log(`[review] GitHub adapter disabled (${resolved.reason}): webhook ingress 404, no reconcile, Slack board line only (M0)`);
    const publisher = new ReviewPublisher(store, { github: null, slack: broker }, clock);
    return {
      store,
      publisher,
      scheduler: null,
      github: null,
      http: { store, broker, webhook: null, adminToken: input.adminToken, reconcile: null },
      start: () => {},
      stop: async () => {},
    };
  }

  const { appId, webhookSecret, privateKeyPem } = resolved.config;
  const github = new AppGitHubPort(input.fetch === undefined ? { appId, privateKeyPem, clock } : { appId, privateKeyPem, clock, fetch: input.fetch });
  const publisher = new ReviewPublisher(store, { github, slack: broker }, clock);
  const scheduler = new ReconcileScheduler({ store, github, clock, log });
  log(`[review] GitHub adapter enabled as App ${appId}: webhook ingress on /v1/github/webhook, reconcile scheduler armed`);
  return {
    store,
    publisher,
    scheduler,
    github: { appId },
    http: {
      store,
      broker,
      webhook: (request) => handleWebhook(store, webhookSecret, request, clock),
      adminToken: input.adminToken,
      reconcile: (key: ReviewKey) => scheduler.wake(key),
    },
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
  };
}
