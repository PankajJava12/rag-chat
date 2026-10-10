import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import {
  httpDuration,
  readinessGauge,
} from "../../../packages/observability/src/telemetry.js";
import { ZodError } from "zod";
import { AppError } from "../../../packages/shared/src/errors.js";
import { ingestionRouter, type IngestionApi } from "./routes/ingestion.js";
import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import {
  readiness,
  type Dependencies,
} from "../../../packages/shared/src/health.js";
export function createApp(
  dependencies: Dependencies,
  logger: Logger,
  ingestion?: IngestionApi,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const start = performance.now();
    const span = trace.getTracer("advisor").startSpan("http.request");
    const sc = span.spanContext();
    if (sc.traceId !== "00000000000000000000000000000000")
      res.setHeader("X-Trace-Id", sc.traceId);
    let spanEnded = false;
    const endSpan = (closed = false) => {
      if (spanEnded) return;
      spanEnded = true;
      const route = req.route?.path ?? "unmatched";
      const method = [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
      ].includes(req.method)
        ? req.method
        : "OTHER";
      const status = closed && !res.writableFinished ? 499 : res.statusCode;
      span.updateName(`${method} ${route}`);
      span.setAttributes({
        "http.request.method": method,
        "http.route": route,
        "http.response.status_code": status,
      });
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      httpDuration.observe(
        { method, route, status: String(status) },
        (performance.now() - start) / 1000,
      );
      span.end();
    };
    res.once("finish", () => endSpan());
    res.once("close", () => endSpan(true));
    res.on("finish", () =>
      logger.info(
        {
          requestId,
          traceId: sc.traceId,
          operation: req.route?.path ?? "unmatched",
          method: req.method,
          durationMs: Math.round(performance.now() - start),
          statusCode: res.statusCode,
        },
        "request_complete",
      ),
    );
    context.with(trace.setSpan(context.active(), span), next);
  });
  app.get("/health/live", (_req, res) => {
    res.json({ status: "alive", service: "advisor-api" });
  });
  app.get("/health/ready", async (_req, res) => {
    const health = await readiness("advisor-api", dependencies);
    readinessGauge.set(health.status === "ready" ? 1 : 0);
    res.setHeader("Cache-Control", "no-store");
    res.status(health.status === "ready" ? 200 : 503).json(health);
  });
  app.get("/api/v1/platform", (_req, res) => {
    res.json({
      name: "AI Advisor Assistant",
      version: "0.7.0",
      phase: ingestion?.chat ? 7 : ingestion ? 2 : 1,
      capabilities: {
        documentUpload: Boolean(ingestion),
        policyChat: Boolean(ingestion?.chat),
        advancedRetrieval: Boolean(ingestion?.chat),
        policyComparison: Boolean(ingestion?.chat),
        enterpriseSecurity: Boolean(ingestion),
        authentication: Boolean(ingestion),
      },
      message: ingestion?.chat
        ? "Local cited policy chat available."
        : ingestion
          ? "Local document ingestion and version-aware index search available. Chat generation is not enabled."
          : "Foundation only.",
    });
  });
  if (ingestion) app.use("/api/v1", ingestionRouter(ingestion));
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: res.getHeader("X-Request-Id"),
      },
    });
  });
  app.use(
    async (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        error instanceof AppError
          ? error.status
          : error instanceof ZodError
            ? 400
            : "type" in error && error.type === "entity.too.large"
              ? 413
              : "type" in error && error.type === "entity.parse.failed"
                ? 400
                : 500;
      const code =
        error instanceof AppError
          ? error.code
          : error instanceof ZodError
            ? "INVALID_INPUT"
            : status === 413
              ? "FILE_TOO_LARGE"
              : status === 400
                ? "INVALID_JSON"
                : "INTERNAL_ERROR";
      if (status === 403 || status === 404) {
        const auditDenial = res.locals.auditDenial as
          (() => Promise<unknown>) | undefined;
        if (auditDenial)
          await auditDenial().catch(() =>
            logger.error(
              { requestId: res.getHeader("X-Request-Id") },
              "audit_write_failed",
            ),
          );
      }
      logger.error(
        { errorType: error.name, requestId: res.getHeader("X-Request-Id") },
        "request_failed",
      );
      res.status(status).json({
        error: {
          code,
          message: status === 500 ? "An unexpected error occurred" : code,
          requestId: res.getHeader("X-Request-Id"),
        },
      });
    },
  );
  return app;
}
