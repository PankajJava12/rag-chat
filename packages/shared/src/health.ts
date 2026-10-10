export interface Health {
  status: "ready" | "degraded";
  service: "advisor-api" | "advisor-worker";
  checks: Record<"postgres" | "redis", "up" | "down">;
}
export interface Dependencies {
  postgres(): Promise<void>;
  redis(): Promise<void>;
  close(): Promise<void>;
}
export async function readiness(
  service: Health["service"],
  dependencies: Dependencies,
): Promise<Health> {
  const results = await Promise.allSettled([
    dependencies.postgres(),
    dependencies.redis(),
  ]);
  return {
    status: results.every((r) => r.status === "fulfilled")
      ? "ready"
      : "degraded",
    service,
    checks: {
      postgres: results[0]?.status === "fulfilled" ? "up" : "down",
      redis: results[1]?.status === "fulfilled" ? "up" : "down",
    },
  };
}
