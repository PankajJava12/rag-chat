import { Pool } from "pg";
import { createClient } from "redis";
import type { Config } from "../../shared/src/config.js";
import type { Dependencies } from "../../shared/src/health.js";
export function createDependencies(config: Config): Dependencies {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DEPENDENCY_TIMEOUT_MS,
    statement_timeout: config.DEPENDENCY_TIMEOUT_MS,
    query_timeout: config.DEPENDENCY_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
  });
  pool.on("error", () => {
    /* Dependency checks expose outage without leaking connection credentials. */
  });
  const redis = createClient({
    url: config.REDIS_URL,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: config.DEPENDENCY_TIMEOUT_MS,
      reconnectStrategy: (retries) => Math.min(100 * (retries + 1), 2000),
    },
  });
  redis.on("error", () => {
    /* Reported by readiness. */
  });
  void redis.connect().catch(() => undefined);
  return {
    async postgres() {
      const result = await pool.query(
        "SELECT version FROM schema_migrations WHERE version = '008_observability.sql'",
      );
      if (result.rowCount !== 1) throw new Error("Database migration required");
    },
    async redis() {
      if (!redis.isReady) throw new Error("Redis not ready");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          redis.ping(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Redis timed out")),
              config.DEPENDENCY_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (redis.isOpen) redis.destroy();
      await pool.end();
    },
  };
}
