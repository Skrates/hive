/**
 * Env-gated Logfire setup shared by the broker and the edge.
 *
 * Fail-open: if LOGFIRE_TOKEN is unset or blank, configuration is a no-op and
 * every helper is a no-op. The edge spawns headless children with a minimal
 * env; a throw or a blocking configure here deafens a seat.
 *
 * Spans carry delivery metadata only. Never message bodies, Slack tokens, or
 * credentials. The token is read from process.env.LOGFIRE_TOKEN by the SDK —
 * this module never writes it, never logs it, never puts it on a span.
 */

import { context, propagation, trace, TraceFlags } from "@opentelemetry/api";

export type DeliverySpanAttributes = {
  delivery_id?: number;
  dedupe_key?: string;
  channel_id?: string;
  thread_ts?: string;
  actor?: string;
  event_type?: string;
  outcome?: string;
  dispatch_mode?: "live" | "resume" | "spawn";
};

const ALLOWED_ATTRIBUTE_KEYS = new Set<string>([
  "delivery_id",
  "dedupe_key",
  "channel_id",
  "thread_ts",
  "actor",
  "event_type",
  "outcome",
  "dispatch_mode",
]);

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

type LogfireNode = typeof import("@pydantic/logfire-node");

let enabled = false;
let sdk: LogfireNode | null = null;
const deliveryTraceparents = new Map<number, string>();

export function observabilityEnabled(): boolean {
  return enabled;
}

/**
 * Configure the Node SDK only when a write token is present.
 * Never call this from a provider child. Broker and edge CLI actions only.
 */
export async function configureObservability(serviceName: string): Promise<boolean> {
  const token = process.env.LOGFIRE_TOKEN;
  if (token === undefined || token.trim() === "") {
    enabled = false;
    sdk = null;
    return false;
  }
  try {
    const logfire = await import("@pydantic/logfire-node");
    const options: Parameters<typeof logfire.configure>[0] = {
      serviceName,
      // Token is read from LOGFIRE_TOKEN natively. Do not pass it.
      sendToLogfire: true,
      console: false,
      metrics: false,
      variables: false,
      // Manual spans only. Auto HTTP/undici would capture Authorization and
      // Slack request bodies — both forbidden on this bus.
      nodeAutoInstrumentations: {
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-http": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        "@opentelemetry/instrumentation-undici": { enabled: false },
      },
      scrubbing: {
        extraPatterns: [
          "xoxb-",
          "xapp-",
          "xoxp-",
          "xoxe-",
          "HIVE_SLACK",
          "HIVE_ADMIN_TOKEN",
          "HIVE_EDGE_TOKEN",
        ],
      },
    };
    const version = process.env.npm_package_version;
    if (version) options.serviceVersion = version;
    const environment = process.env.LOGFIRE_ENVIRONMENT ?? process.env.NODE_ENV;
    if (environment) options.environment = environment;
    logfire.configure(options);
    sdk = logfire;
    enabled = true;
    return true;
  } catch (error) {
    enabled = false;
    sdk = null;
    console.error(
      "hive observability configure failed; continuing without export",
      error instanceof Error ? error.name : "non-error thrown",
    );
    return false;
  }
}

/** Best-effort flush on process shutdown. Never call on the delivery hot path. */
export async function shutdownObservability(): Promise<void> {
  if (!enabled || sdk === null) return;
  const current = sdk;
  enabled = false;
  sdk = null;
  try {
    await Promise.race([
      current.shutdown({ timeoutMillis: 2_000 }),
      delay(2_000),
    ]);
  } catch {
    // A Logfire outage must be invisible to the bus.
  }
}

export function withSpan<T>(name: string, attributes: DeliverySpanAttributes, fn: () => T): T {
  if (!enabled || sdk === null) return fn();
  let started = false;
  try {
    return sdk.span(name, {
      attributes: sanitizeAttributes(attributes),
      callback: () => {
        started = true;
        return fn();
      },
    });
  } catch (error) {
    if (started) throw error;
    return fn();
  }
}

export function rememberDeliveryTraceparent(deliveryId: number, traceparent?: string): void {
  const value = traceparent ?? captureActiveTraceparent();
  if (value === undefined) return;
  deliveryTraceparents.set(deliveryId, value);
}

export function peekDeliveryTraceparent(deliveryId: number): string | undefined {
  return deliveryTraceparents.get(deliveryId);
}

export function forgetDeliveryTraceparent(deliveryId: number): void {
  deliveryTraceparents.delete(deliveryId);
}

export function captureActiveTraceparent(): string | undefined {
  try {
    const span = trace.getActiveSpan();
    if (!span) return undefined;
    const spanContext = span.spanContext();
    if (spanContext.traceId === ZERO_TRACE_ID || spanContext.spanId === ZERO_SPAN_ID) return undefined;
    const flags = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? "01" : "00";
    return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
  } catch {
    return undefined;
  }
}

export function parseTraceparent(value: string): { traceId: string; spanId: string; flags: number } | undefined {
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return undefined;
  const traceId = match[1];
  const spanId = match[2];
  const flagBits = match[3];
  if (traceId === undefined || spanId === undefined || flagBits === undefined) return undefined;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  return { traceId, spanId, flags: Number.parseInt(flagBits, 16) };
}

export function runInTraceparent<T>(traceparent: string | undefined, fn: () => T): T {
  if (traceparent === undefined) return fn();
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return fn();
  try {
    const parent = context.active();
    const next = trace.setSpanContext(parent, {
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      traceFlags: (parsed.flags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: true,
    });
    return context.with(next, fn);
  } catch {
    return fn();
  }
}

/** Inject W3C traceparent from the active context. No-op when unset or empty. */
export function injectTraceHeaders(headers: Record<string, string>): void {
  if (!enabled) return;
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const traceparent = carrier["traceparent"];
    if (traceparent) headers.traceparent = traceparent;
    const tracestate = carrier["tracestate"];
    if (tracestate) headers.tracestate = tracestate;
  } catch {
    // fail-open
  }
}

export function sanitizeAttributes(attributes: DeliverySpanAttributes): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key) || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

export function resetObservabilityForTests(): void {
  enabled = false;
  sdk = null;
  deliveryTraceparents.clear();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
