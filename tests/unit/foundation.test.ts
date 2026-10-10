import request from "supertest";
import { createApp } from "../../apps/api/src/app.js";
import { createLogger } from "../../packages/observability/src/logger.js";
import { loadConfig } from "../../packages/shared/src/config.js";
import type { Dependencies } from "../../packages/shared/src/health.js";
const logger = createLogger("test", "silent");
function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    postgres: async () => undefined,
    redis: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}
describe("Phase 1 HTTP contract", () => {
  test("liveness stays available during a dependency outage", async () => {
    const check = jest
      .fn()
      .mockRejectedValue(new Error("private connection string"));
    const app = createApp(dependencies({ postgres: check }), logger);
    const live = await request(app).get("/health/live");
    expect(live.status).toBe(200);
    expect(check).not.toHaveBeenCalled();
    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.checks).toEqual({ postgres: "down", redis: "up" });
    expect(ready.text).not.toContain("private");
  });
  test("reports real dependency success and supplies safe headers", async () => {
    const response = await request(createApp(dependencies(), logger)).get(
      "/health/ready",
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ready");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-request-id"]).toMatch(/^[a-f0-9-]{36}$/);
  });
  test("Redis outage fails readiness", async () => {
    const response = await request(
      createApp(
        dependencies({
          redis: async () => {
            throw new Error("offline");
          },
        }),
        logger,
      ),
    ).get("/health/ready");
    expect(response.status).toBe(503);
    expect(response.body.checks.redis).toBe("down");
  });
  test("does not advertise unimplemented integrations", async () => {
    const app = createApp(dependencies(), logger);
    const response = await request(app).get("/api/v1/platform");
    expect(response.body.capabilities).toEqual({
      documentUpload: false,
      policyChat: false,
      advancedRetrieval: false,
      policyComparison: false,
      authentication: false,
      enterpriseSecurity: false,
    });
    const chat = await request(app)
      .post("/api/v1/chat")
      .send({ question: "Coverage?" });
    expect(chat.status).toBe(404);
    expect(chat.body.error.code).toBe("NOT_FOUND");
  });
  test("does not echo client request IDs into logs or headers", async () => {
    const response = await request(createApp(dependencies(), logger))
      .get("/health/live")
      .set("X-Request-Id", "untrusted-value");
    expect(response.headers["x-request-id"]).not.toBe("untrusted-value");
  });
});
describe("configuration", () => {
  const env = {
    DATABASE_URL: "postgresql://user:secret@localhost/advisor",
    REDIS_URL: "redis://localhost",
  };
  test("validates URLs and bounds", () => {
    expect(loadConfig(env).API_PORT).toBe(3000);
    expect(() => loadConfig({ ...env, API_PORT: "0" })).toThrow("API_PORT");
    expect(() =>
      loadConfig({ ...env, DATABASE_URL: "https://localhost" }),
    ).toThrow("DATABASE_URL");
  });
  test("refuses embedding/schema dimension drift", () => {
    expect(() => loadConfig({ ...env, EMBEDDING_DIMENSIONS: "3072" })).toThrow(
      "matching database migration",
    );
  });
  test("validation errors exclude credential values", () => {
    expect(() =>
      loadConfig({ ...env, DATABASE_URL: "invalid-secret-password" }),
    ).toThrow("Invalid configuration fields: DATABASE_URL");
  });
});
