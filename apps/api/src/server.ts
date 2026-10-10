import { readiness } from "../../../packages/shared/src/health.js";
import { readinessGauge } from "../../../packages/observability/src/telemetry.js";
import { closeTelemetry } from "../../../packages/observability/src/init.js";
import { ChatService } from "../../../packages/chat/src/service.js";
import { createGenerator } from "../../../packages/chat/src/generation.js";
import { ingestionRuntime } from "../../../packages/ingestion/src/runtime.js";
import { Authentication } from "../../../packages/security/src/auth.js";
import { createApp } from "./app.js";
import { loadConfig } from "../../../packages/shared/src/config.js";
import { installShutdown } from "../../../packages/shared/src/shutdown.js";
import { createDependencies } from "../../../packages/database/src/connections.js";
import { createLogger } from "../../../packages/observability/src/logger.js";
const config = loadConfig();
const logger = createLogger("advisor-api", config.LOG_LEVEL);
const dependencies = createDependencies(config);
const runtime = ingestionRuntime();
const healthTimer = setInterval(() => {
  void readiness("advisor-api", dependencies).then((h) =>
    readinessGauge.set(h.status === "ready" ? 1 : 0),
  );
}, 5000);
healthTimer.unref();
const auth = new Authentication(runtime.pool, {
  mode: config.AUTH_MODE,
  secret: config.AUTH_SECRET!,
  environment: config.NODE_ENV,
  userPoolId: config.COGNITO_USER_POOL_ID,
  clientId: config.COGNITO_CLIENT_ID,
});
const server = createApp(dependencies, logger, {
  ...runtime,
  chat: new ChatService({
    ...runtime,
    generator: createGenerator(config, logger),
    logger,
    contextBudget: config.CHAT_CONTEXT_TOKENS,
    topK: config.CHAT_TOP_K,
    retrievalMode: config.RETRIEVAL_MODE,
    rerank: config.RETRIEVAL_RERANK,
    candidateK: config.RETRIEVAL_CANDIDATES,
  }),
  auth,
  origins: config.ALLOWED_ORIGINS.split(","),
  authMode: config.AUTH_MODE,
}).listen(config.API_PORT, config.BIND_HOST, () =>
  logger.info({ port: config.API_PORT }, "listening"),
);
server.requestTimeout = 120000;
server.headersTimeout = 10000;
installShutdown(
  server,
  async () => {
    clearInterval(healthTimer);
    await dependencies.close();
    runtime.closeCache();
    await runtime.pool.end();
    await closeTelemetry();
  },
  logger,
);
