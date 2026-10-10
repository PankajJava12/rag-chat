import { trace, context } from "@opentelemetry/api";
import pino from "pino";
export function createLogger(service: string, level = "info") {
  return pino({
    level,
    mixin() {
      const span = trace.getSpan(context.active())?.spanContext();
      return span ? { traceId: span.traceId, spanId: span.spanId } : {};
    },
    base: { service },
    redact: {
      paths: [
        "authorization",
        "password",
        "token",
        "req.headers.authorization",
        "req.headers.cookie",
      ],
      censor: "[REDACTED]",
    },
  });
}
