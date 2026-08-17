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

export type TraceContext = {
  traceparent: string;
  tracestate?: string;
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

/** Field-specific caps so allowlisted strings cannot export unbounded cardinality. */
export const STRING_ATTRIBUTE_LIMITS: Record<string, number> = {
  dedupe_key: 128,
  channel_id: 32,
  thread_ts: 32,
  actor: 64,
  event_type: 16,
  outcome: 32,
  dispatch_mode: 16,
};

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
/** W3C tracestate maximum; a longer value is dropped rather than truncated into invalid syntax. */
const MAX_TRACESTATE_LENGTH = 512;

type LogfireNode = typeof import("@pydantic/logfire-node");

let enabled = false;
let sdk: LogfireNode | null = null;
const deliveryTraces = new Map<number, TraceContext>();

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 2_000);
    timer.unref?.();
  });
  try {
    await Promise.race([
      current.shutdown({ timeoutMillis: 2_000 }),
      timeout,
    ]);
  } catch {
    // A Logfire outage must be invisible to the bus.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

export function rememberDeliveryTraceparent(
  deliveryId: number,
  traceparent?: string,
  tracestate?: string,
): void {
  const ctx = traceparent === undefined
    ? captureActiveTraceContext()
    : boundTraceContext({ traceparent, tracestate });
  if (ctx === undefined) return;
  deliveryTraces.set(deliveryId, ctx);
}

export function peekDeliveryTraceparent(deliveryId: number): string | undefined {
  return deliveryTraces.get(deliveryId)?.traceparent;
}

export function peekDeliveryTrace(deliveryId: number): TraceContext | undefined {
  return deliveryTraces.get(deliveryId);
}

export function forgetDeliveryTraceparent(deliveryId: number): void {
  deliveryTraces.delete(deliveryId);
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

export function captureActiveTraceContext(): TraceContext | undefined {
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const injected = boundTraceContext({
      traceparent: carrier["traceparent"],
      tracestate: carrier["tracestate"],
    });
    if (injected) return injected;
  } catch {
    // fall through to the hand-serialized parent
  }
  const traceparent = captureActiveTraceparent();
  return traceparent === undefined ? undefined : { traceparent };
}

export function runInTraceContext<T>(ctx: TraceContext | undefined, fn: () => T): T {
  if (ctx === undefined) return fn();
  const parsed = parseTraceparent(ctx.traceparent);
  if (!parsed) return fn();
  try {
    const extracted = propagation.extract(context.active(), {
      traceparent: ctx.traceparent,
      ...(ctx.tracestate ? { tracestate: ctx.tracestate } : {}),
    });
    return context.with(extracted, fn);
  } catch {
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
}

export function runInTraceparent<T>(traceparent: string | undefined, fn: () => T, tracestate?: string): T {
  if (traceparent === undefined) return fn();
  return runInTraceContext({ traceparent, ...(tracestate ? { tracestate } : {}) }, fn);
}

/** Headers for one W3C hop. Empty when no context is stored. */
export function traceContextHeaders(ctx: TraceContext | undefined): Record<string, string> {
  if (ctx === undefined) return {};
  return ctx.tracestate
    ? { traceparent: ctx.traceparent, tracestate: ctx.tracestate }
    : { traceparent: ctx.traceparent };
}

/** Inject W3C traceparent and tracestate from the active context. No-op when unset or empty. */
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
    if (typeof value === "number") {
      out[key] = value;
      continue;
    }
    if (typeof value !== "string") continue;
    const limit = STRING_ATTRIBUTE_LIMITS[key];
    out[key] = limit !== undefined && value.length > limit ? value.slice(0, limit) : value;
  }
  return out;
}

export function resetObservabilityForTests(): void {
  enabled = false;
  sdk = null;
  deliveryTraces.clear();
}

/** Test-only: drive `withSpan` against a configured SDK without a write token. */
export function installObservabilitySdkForTests(module: LogfireNode): void {
  sdk = module;
  enabled = true;
}

function boundTraceContext(input: {
  traceparent: string | undefined;
  tracestate?: string | undefined;
}): TraceContext | undefined {
  if (input.traceparent === undefined) return undefined;
  const parsed = parseTraceparent(input.traceparent);
  if (!parsed) return undefined;
  const tracestate = input.tracestate;
  if (tracestate === undefined || tracestate.length === 0 || tracestate.length > MAX_TRACESTATE_LENGTH) {
    return { traceparent: input.traceparent };
  }
  return { traceparent: input.traceparent, tracestate };
}
