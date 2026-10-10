import {
  readinessGauge,
  backlog,
} from "../../../packages/observability/src/telemetry.js";
import { closeTelemetry } from "../../../packages/observability/src/init.js";
import { dispatchNotification } from "../../../packages/ingestion/src/notifications.js";
import { createServer } from "node:http";
import { loadConfig } from "../../../packages/shared/src/config.js";
import { readiness } from "../../../packages/shared/src/health.js";
import { installShutdown } from "../../../packages/shared/src/shutdown.js";
import { createDependencies } from "../../../packages/database/src/connections.js";
import { createLogger } from "../../../packages/observability/src/logger.js";
import { ingestionRuntime } from "../../../packages/ingestion/src/runtime.js";
import {
  claimJob,
  processJob,
} from "../../../packages/ingestion/src/pipeline.js";
import { ClamScanner } from "../../../packages/document-processing/src/scanner.js";
import { isolatedParse } from "../../../packages/document-processing/src/isolated-parser.js";
// Host development uses the separate worker credential; Compose injects it directly as DATABASE_URL.
if (process.env.WORKER_DATABASE_URL)
  process.env.DATABASE_URL = process.env.WORKER_DATABASE_URL;
const config = loadConfig(),
  logger = createLogger("advisor-worker", config.LOG_LEVEL),
  dependencies = createDependencies(config);
const runtime = ingestionRuntime(false);
let stopping = false;
const healthTimer = setInterval(() => {
  void readiness("advisor-worker", dependencies).then((h) =>
    readinessGauge.set(
      h.status === "ready" && (busy || Date.now() - lastPoll < 10000) ? 1 : 0,
    ),
  );
  void runtime.pool
    .query("SELECT * FROM ingestion_operational_metrics()")
    .then((r) => {
      for (const [kind, n] of Object.entries(r.rows[0] ?? {}))
        backlog.set({ kind }, Number(n));
    })
    .catch(() => undefined);
}, 5000);
healthTimer.unref();
let lastPoll = Date.now();
const services = {
  ...runtime,
  scanner: new ClamScanner(config.CLAMAV_HOST, config.CLAMAV_PORT),
  parse: isolatedParse,
  batchSize: config.EMBEDDING_BATCH_SIZE,
  logger,
};
let busy = false;
async function loop() {
  while (!stopping) {
    try {
      // Notifications accelerate awareness; PostgreSQL remains the durable fenced lease authority.
      if (runtime.notifications) {
        try {
          await dispatchNotification(
            runtime.pool,
            runtime.notifications,
            logger,
          );
          await runtime.notifications.wake();
        } catch {
          logger.warn(
            { operation: "sqs_wakeup" },
            "notification_service_unavailable",
          );
        }
      }
      const job = await claimJob(runtime.pool);
      lastPoll = Date.now();
      if (job) {
        busy = true;
        await processJob(job, services);
        busy = false;
        continue;
      }
    } catch {
      busy = false;
      logger.warn({ operation: "queue_poll" }, "queue_temporarily_unavailable");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const running = loop();
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/health/live") {
    res.end(
      JSON.stringify({
        status: "alive",
        service: "advisor-worker",
        ingestionEnabled: true,
      }),
    );
    return;
  }
  if (req.url === "/health/ready") {
    void readiness("advisor-worker", dependencies).then((health) => {
      const healthy =
        health.status === "ready" &&
        (busy || Date.now() - lastPoll < 10000) &&
        !stopping;
      readinessGauge.set(healthy ? 1 : 0);
      res.statusCode = healthy ? 200 : 503;
      res.end(
        JSON.stringify({
          ...health,
          status: healthy ? "ready" : "degraded",
          ingestionEnabled: true,
          busy,
        }),
      );
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "NOT_FOUND" }));
}).listen(config.WORKER_PORT, config.BIND_HOST, () =>
  logger.info({ port: config.WORKER_PORT }, "ingestion_worker_listening"),
);
installShutdown(
  server,
  async () => {
    stopping = true;
    clearInterval(healthTimer);
    await running;
    await dependencies.close();
    runtime.closeCache();
    await runtime.pool.end();
    await closeTelemetry();
  },
  logger,
);
