import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient } from "redis";
import request from "supertest";
import { withTenant } from "../../packages/database/src/tenant.js";
import { createDependencies } from "../../packages/database/src/connections.js";
import { loadConfig } from "../../packages/shared/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { createLogger } from "../../packages/observability/src/logger.js";
const owner = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const appPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
const tenantA = randomUUID(),
  tenantB = randomUUID(),
  policyB = randomUUID();
beforeAll(async () => {
  if (!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)
    throw new Error("Real PostgreSQL and Redis are required");
  await owner.query("INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)", [
    tenantA,
    "Integration A",
    tenantB,
    "Integration B",
  ]);
  await owner.query(
    "INSERT INTO policies(id,tenant_id,name,provider) VALUES($1,$2,$3,$4)",
    [policyB, tenantB, "B policy", "Test provider"],
  );
});
afterAll(async () => {
  try {
    await owner.query(
      "DELETE FROM policies WHERE tenant_id = ANY($1::uuid[])",
      [[tenantA, tenantB]],
    );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      [tenantA, tenantB],
    ]);
  } finally {
    await appPool.end();
    await owner.end();
  }
});
test("runtime role has no owner or RLS bypass privileges", async () => {
  const result = await appPool.query(
    "SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user",
  );
  expect(result.rows[0]).toEqual({
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
  });
});
test("no tenant context means no visible tenant rows", async () => {
  expect((await appPool.query("SELECT * FROM tenants")).rows).toEqual([]);
});
test("tenant context restricts reads and does not leak when a pooled connection is reused", async () => {
  await withTenant(appPool, tenantA, async (client) => {
    expect((await client.query("SELECT id FROM tenants")).rows).toEqual([
      { id: tenantA },
    ]);
    expect(
      (await client.query("SELECT id FROM policies WHERE id=$1", [policyB]))
        .rows,
    ).toEqual([]);
  });
  expect((await appPool.query("SELECT id FROM tenants")).rows).toEqual([]);
});
test("RLS rejects cross-tenant writes", async () => {
  await expect(
    withTenant(appPool, tenantA, async (client) => {
      await client.query(
        "INSERT INTO policies(tenant_id,name,provider) VALUES($1,$2,$3)",
        [tenantB, "forbidden", "test"],
      );
    }),
  ).rejects.toMatchObject({ code: "42501" });
});
test("composite foreign keys reject cross-tenant parent relationships", async () => {
  await expect(
    withTenant(appPool, tenantA, async (client) => {
      await client.query(
        "INSERT INTO documents(tenant_id,policy_id,name,document_type) VALUES($1,$2,$3,$4)",
        [tenantA, policyB, "forbidden", "policy"],
      );
    }),
  ).rejects.toMatchObject({ code: "23503" });
});
test("pgvector performs real cosine distance computation", async () => {
  const result = await appPool.query(
    "SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS distance",
  );
  expect(result.rows[0].distance).toBe(0);
});
test("Redis roundtrips expiring data", async () => {
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on("error", () => undefined);
  await redis.connect();
  const key = `test:${randomUUID()}`;
  try {
    await redis.set(key, "healthy", { EX: 10 });
    expect(await redis.get(key)).toBe("healthy");
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  } finally {
    await redis.del(key);
    await redis.quit();
  }
});
test("HTTP readiness verifies actual database migration and cache", async () => {
  const dependencies = createDependencies(loadConfig());
  try {
    // Redis establishes its connection asynchronously; bounded retry handles startup only.
    let response;
    for (let i = 0; i < 20; i++) {
      response = await request(
        createApp(dependencies, createLogger("test", "silent")),
      ).get("/health/ready");
      if (response.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(response?.status).toBe(200);
    expect(response?.body.checks).toEqual({ postgres: "up", redis: "up" });
  } finally {
    await dependencies.close();
  }
});
