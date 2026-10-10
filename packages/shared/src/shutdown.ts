import type { Server } from "node:http";
import type { Logger } from "pino";
export function installShutdown(
  server: Server,
  close: () => Promise<void>,
  logger: Logger,
) {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, "shutdown_started");
      const timeout = setTimeout(() => {
        logger.error("shutdown_timeout");
        process.exit(1);
      }, 10000);
      timeout.unref();
      server.close(() => {
        void close()
          .then(() => {
            clearTimeout(timeout);
            logger.info("shutdown_complete");
            process.exitCode = 0;
          })
          .catch(() => {
            logger.error("shutdown_failed");
            process.exitCode = 1;
          });
      });
      server.closeIdleConnections();
    });
}
