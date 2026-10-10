import { AppError } from "../../shared/src/errors.js";
import {
  context,
  trace,
  propagation,
  SpanStatusCode,
  type Context,
} from "@opentelemetry/api";
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "@prometheus-io/client";
export const registry = new Registry();
registry.setDefaultLabels({
  service: process.env.OTEL_SERVICE_NAME ?? "advisor-test",
});
if (process.env.METRICS_ENABLED === "true")
  collectDefaultMetrics({ register: registry });
const options = { registers: [registry] };
export const httpDuration = new Histogram({
  ...options,
  name: "advisor_http_duration_seconds",
  help: "API request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 5, 30, 180, 300],
});
export const operationDuration = new Histogram({
  ...options,
  name: "advisor_operation_duration_seconds",
  help: "Bounded RAG stage duration",
  labelNames: ["operation", "outcome"],
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 5, 30, 180, 300],
});
export const cacheEvents = new Counter({
  ...options,
  name: "advisor_query_cache_total",
  help: "Encrypted query embedding cache results",
  labelNames: ["result"],
});
export const tokens = new Counter({
  ...options,
  name: "advisor_model_tokens_total",
  help: "Reported model token usage",
  labelNames: ["provider", "purpose", "direction"],
});
export const cost = new Counter({
  ...options,
  name: "advisor_model_estimated_usd_total",
  help: "Estimated API token charges at operator-supplied prices; excludes infrastructure",
  labelNames: ["purpose"],
});
export const jobs = new Counter({
  ...options,
  name: "advisor_ingestion_jobs_total",
  help: "Completed ingestion attempts",
  labelNames: ["outcome"],
});
export const readinessGauge = new Gauge({
  ...options,
  name: "advisor_ready",
  help: "Most recently observed dependency readiness",
});
export function traceCarrier() {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}
export function parentContext(parent?: string | null): Context {
  return parent && /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(parent)
    ? propagation.extract(context.active(), { traceparent: parent })
    : context.active();
}
export async function observed<T>(
  operation: string,
  fn: () => Promise<T>,
  parent?: string | null,
): Promise<T> {
  const start = performance.now();
  return trace
    .getTracer("advisor")
    .startActiveSpan(operation, {}, parentContext(parent), async (span) => {
      try {
        const value = await fn();
        operationDuration.observe(
          { operation, outcome: "success" },
          (performance.now() - start) / 1000,
        );
        return value;
      } catch (e) {
        operationDuration.observe(
          { operation, outcome: "error" },
          (performance.now() - start) / 1000,
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(
          "error.type",
          e instanceof AppError ? e.code : "OPERATION_FAILED",
        );
        throw e;
      } finally {
        span.end();
      }
    });
}
export function recordUsage(
  provider: "ollama" | "openai" | "gemini",
  purpose: "embedding" | "generation",
  input: number,
  output = 0,
) {
  for (const [direction, count] of [
    ["input", input],
    ["output", output],
  ] as const)
    if (Number.isFinite(count) && count > 0)
      tokens.inc({ provider, purpose, direction }, count);
  if (provider !== "openai") return;
  const inputRate = Number(
    process.env[
      purpose === "embedding"
        ? "EMBEDDING_INPUT_USD_PER_MILLION"
        : "GENERATION_INPUT_USD_PER_MILLION"
    ] ?? 0,
  );
  const outputRate = Number(process.env.GENERATION_OUTPUT_USD_PER_MILLION ?? 0);
  const estimate =
    (input * Math.max(0, inputRate) +
      (purpose === "generation" ? output * Math.max(0, outputRate) : 0)) /
    1e6;
  if (Number.isFinite(estimate) && estimate > 0)
    cost.inc({ purpose }, estimate);
}

export const backlog = new Gauge({
  ...options,
  name: "advisor_ingestion_backlog",
  help: "Global operational counts without tenant identifiers",
  labelNames: ["kind"],
});

export const chatResults = new Counter({
  ...options,
  name: "advisor_chat_results_total",
  help: "Persisted chat outcomes",
  labelNames: ["outcome"],
});
export const contextTokens = new Histogram({
  ...options,
  name: "advisor_context_tokens",
  help: "Selected evidence context tokens",
  buckets: [128, 256, 512, 1000, 1500, 2000],
});
