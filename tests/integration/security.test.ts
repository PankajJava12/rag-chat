import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import jwt from "jsonwebtoken";
import { Authentication } from "../../packages/security/src/auth.js";
import { Vault, passwordHash } from "../../packages/security/src/crypto.js";
import { withTenant } from "../../packages/database/src/tenant.js";
import { createApp } from "../../apps/api/src/app.js";
import { createLogger } from "../../packages/observability/src/logger.js";
const owner = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tenant = randomUUID(),
  foreign = randomUUID(),
  admin = randomUUID(),
  advisor = randomUUID();
const secret = randomBytes(32).toString("hex");
const auth = new Authentication(pool, {
  mode: "local",
  environment: "test",
  secret,
});
const app = createApp(
  {
    postgres: async () => undefined,
    redis: async () => undefined,
    close: async () => undefined,
  },
  createLogger("test", "silent"),
  {
    pool,
    auth,
    vault: new Vault(randomBytes(32).toString("hex")),
    origins: ["http://localhost:8080"],
    authMode: "local",
    embedder: {
      model: "test",
      dimensions: 768,
      embed: async () => ({ vectors: [], inputTokens: 0 }),
    },
    storage: { put: async () => undefined, get: async () => Buffer.alloc(0) },
  },
);
const token = (id: string, claims = {}) =>
  jwt.sign(claims, secret, {
    algorithm: "HS256",
    subject: `local:${id}`,
    issuer: "advisor-local",
    audience: "advisor-api",
    expiresIn: "5m",
    jwtid: randomUUID(),
  });
beforeAll(async () => {
  await owner.query(
    "INSERT INTO tenants(id,name) VALUES($1,'Security'),($2,'Foreign')",
    [tenant, foreign],
  );
  await owner.query(
    "INSERT INTO users(id,tenant_id,cognito_sub,role,email,password_hash) VALUES($1,$2,$3,'ADMIN',$4,$5),($6,$2,$7,'ADVISOR',$8,$5)",
    [
      admin,
      tenant,
      `local:${admin}`,
      `${admin}@test.invalid`,
      await passwordHash("test-password"),
      advisor,
      `local:${advisor}`,
      `${advisor}@test.invalid`,
    ],
  );
  await owner.query(
    "INSERT INTO audit_logs(tenant_id,action,request_id) VALUES($1,'foreign.secret',gen_random_uuid())",
    [foreign],
  );
});
afterAll(async () => {
  for (const table of ["revoked_tokens", "audit_logs", "users"])
    await owner.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`, [
      [tenant, foreign],
    ]);
  await owner.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [
    [tenant, foreign],
  ]);
  await pool.end();
  await owner.end();
});
test("logout revokes a copied cookie and bearer while leaving another session usable", async () => {
  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", "http://localhost:8080")
    .send({ email: `${admin}@test.invalid`, password: "test-password" });
  expect(login.status).toBe(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(
    ";",
  )[0]!;
  const copied = cookie.slice("advisor_session=".length);
  expect(
    (
      await request(app)
        .post("/api/v1/auth/logout")
        .set("Origin", "http://localhost:8080")
        .set("Cookie", cookie)
    ).status,
  ).toBe(204);
  expect(
    (await request(app).get("/api/v1/auth/me").set("Cookie", cookie)).body.error
      .code,
  ).toBe("TOKEN_REVOKED");
  expect(
    (await request(app).get("/api/v1/auth/me").auth(copied, { type: "bearer" }))
      .status,
  ).toBe(401);
  expect(
    (
      await request(app)
        .get("/api/v1/auth/me")
        .auth(token(admin), { type: "bearer" })
    ).status,
  ).toBe(200);
  const stored = (
    await owner.query(
      "SELECT token_hash FROM revoked_tokens WHERE tenant_id=$1",
      [tenant],
    )
  ).rows[0];
  expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(stored.token_hash).not.toBe(copied);
});
test("audit reader is ADMIN-only, tenant-filtered, bounded and audits its own use and denials", async () => {
  expect(
    (
      await request(app)
        .get("/api/v1/admin/audit-logs")
        .auth(token(advisor), { type: "bearer" })
    ).status,
  ).toBe(403);
  const result = await request(app)
    .get("/api/v1/admin/audit-logs?limit=100")
    .auth(token(admin), { type: "bearer" });
  expect(result.status).toBe(200);
  const actions = result.body.items.map((r: { action: string }) => r.action);
  expect(actions).toEqual(
    expect.arrayContaining([
      "auth.login",
      "auth.logout",
      "access.denied",
      "audit.viewed",
    ]),
  );
  expect(actions).not.toContain("foreign.secret");
  expect(
    (
      await request(app)
        .get("/api/v1/admin/audit-logs?limit=101")
        .auth(token(admin), { type: "bearer" })
    ).status,
  ).toBe(400);
});
test("runtime cannot read password hashes, escalate users or mutate tenant configuration", async () => {
  for (const sql of [
    "SELECT password_hash FROM users",
    "UPDATE users SET role='ADMIN'",
    "UPDATE tenants SET name='hijacked'",
  ])
    await expect(
      withTenant(pool, tenant, (c) => c.query(sql)),
    ).rejects.toMatchObject({ code: "42501" });
});
test("audit records cannot be altered or deleted by runtime", async () => {
  for (const sql of [
    "DELETE FROM audit_logs",
    "UPDATE audit_logs SET action='tampered'",
  ])
    await expect(
      withTenant(pool, tenant, (c) => c.query(sql)),
    ).rejects.toMatchObject({ code: "42501" });
});
test("identity and role come from database, never forged token claims or tenant headers", async () => {
  const result = await request(app)
    .get("/api/v1/auth/me")
    .set("X-Tenant-Id", foreign)
    .auth(token(advisor, { tenantId: foreign, role: "ADMIN" }), {
      type: "bearer",
    });
  expect(result.body.user).toEqual({
    id: advisor,
    tenantId: tenant,
    role: "ADVISOR",
  });
});
test("disabled accounts are rejected with an otherwise valid token", async () => {
  await owner.query("UPDATE users SET disabled=true WHERE id=$1", [advisor]);
  try {
    expect(
      (
        await request(app)
          .get("/api/v1/auth/me")
          .auth(token(advisor), { type: "bearer" })
      ).status,
    ).toBe(403);
  } finally {
    await owner.query("UPDATE users SET disabled=false WHERE id=$1", [advisor]);
  }
});
test("malformed bearer headers cannot fall back to a valid cookie", async () => {
  expect(
    (
      await request(app)
        .get("/api/v1/auth/me")
        .set("Cookie", `advisor_session=${token(admin)}`)
        .set("Authorization", "Basic invalid")
    ).status,
  ).toBe(401);
});
