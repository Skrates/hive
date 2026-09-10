/** Design §8.3. Only explicit process attributes leave the broker, never command bodies. */
import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, type SpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

export type ReviewSpanName = "review.ingress" | "review.reconcile" | "review.admit"
  | "review.publish" | "review.housekeeping" | "review.outbox";
interface ActiveSpan { span: Span; name: ReviewSpanName; parent: ActiveSpan | undefined; counts: Record<string, number> }

export class ReviewTelemetry {
  private readonly active = new AsyncLocalStorage<ActiveSpan>();
  private readonly provider: NodeTracerProvider;

  constructor(processors: SpanProcessor[] = []) {
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ "service.name": "review" }),
      spanProcessors: processors,
    });
  }

  private start(name: ReviewSpanName, attributes: Attributes): Span {
    const parent = this.active.getStore();
    return this.provider.getTracer("hive.review").startSpan(name, { attributes },
      parent ? trace.setSpan(ROOT_CONTEXT, parent.span) : ROOT_CONTEXT);
  }

  sync<T>(name: ReviewSpanName, attributes: Attributes, work: (span: Span) => T): T {
    const span = this.start(name, attributes);
    try { return this.active.run({ span, name, parent: this.active.getStore(), counts: {} }, () => work(span)); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
    finally { span.end(); }
  }

  async run<T>(name: ReviewSpanName, attributes: Attributes, work: (span: Span) => Promise<T>): Promise<T> {
    const span = this.start(name, attributes);
    try { return await this.active.run({ span, name, parent: this.active.getStore(), counts: {} }, () => work(span)); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
    finally { span.end(); }
  }

  stop(): Promise<void> { return this.provider.shutdown(); }
  attributes(attributes: Attributes): void { this.active.getStore()?.span.setAttributes(attributes); }

  housekeepingCounts(counts: Record<string, number>): void {
    this.attributes(counts);
    for (let current = this.active.getStore(); current; current = current.parent) {
      if (current.name !== "review.housekeeping") continue;
      for (const [name, value] of Object.entries(counts)) current.counts[name] = (current.counts[name] ?? 0) + value;
      current.span.setAttributes(current.counts);
      return;
    }
  }
}

/** No credential means no exporter. The project is selected by its write token. */
export function reviewTelemetry(token: string | undefined, region: "us" | "eu" | undefined): ReviewTelemetry {
  if (token && !region) throw new Error("HIVE_REVIEW_LOGFIRE_REGION must name the sokrates project's region (us or eu) when HIVE_REVIEW_LOGFIRE_TOKEN is set");
  if (!token) return new ReviewTelemetry();
  const delegate = new OTLPTraceExporter({
    url: `https://logfire-${region}.pydantic.dev/v1/traces`,
    headers: { Authorization: token },
    timeoutMillis: 5_000,
  });
  // OTel's default diagnostics may have no logger. Export failure must remain visible,
  // without logging exporter errors that might carry request headers (R-3).
  const exporter: SpanExporter = {
    export(spans, callback) {
      delegate.export(spans, result => {
        if (result.code !== 0) console.error("[review] Logfire span export failed");
        callback(result);
      });
    },
    shutdown: () => delegate.shutdown(),
  };
  return new ReviewTelemetry([new BatchSpanProcessor(exporter)]);
}

export const noReviewTelemetry = new ReviewTelemetry();
