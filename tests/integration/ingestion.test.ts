import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../../apps/api/src/app.js";
import { Authentication } from "../../packages/security/src/auth.js";
import { Vault, hash } from "../../packages/security/src/crypto.js";
import { LocalEncryptedStorage } from "../../packages/ingestion/src/storage.js";
import { withTenant } from "../../packages/database/src/tenant.js";
import { createLogger } from "../../packages/observability/src/logger.js";
import {
  processJob,
  assertLease,
  type Job,
} from "../../packages/ingestion/src/pipeline.js";
import { AppError } from "../../packages/shared/src/errors.js";
import { searchIndex } from "../../packages/ingestion/src/retrieval.js";
const owner = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const runtime = new Pool({ connectionString: process.env.DATABASE_URL });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
const tenant = randomUUID(),
  otherTenant = randomUUID(),
  admin = randomUUID(),
  advisor = randomUUID(),
  otherUser = randomUUID(),
  policy = randomUUID(),
  foreignPolicy = randomUUID(),
  conversation = randomUUID();
const secret = randomBytes(32).toString("hex"),
  vault = new Vault(randomBytes(32).toString("hex"));
let directory: string, storage: LocalEncryptedStorage;
const logger = createLogger("test", "silent");
const embedding = {
  model: "test:boundary",
  dimensions: 768,
  embed: jest.fn(async (texts: string[]) => ({
    vectors: texts.map(() => Array(768).fill(0.1) as number[]),
    inputTokens: 10,
  })),
};
const auth = new Authentication(runtime, {
  mode: "local",
  environment: "test",
  secret,
});
const token = (subject: string) =>
  jwt.sign({}, secret, {
    algorithm: "HS256",
    subject,
    issuer: "advisor-local",
    audience: "advisor-api",
    expiresIn: "5m",
  });
const app = () =>
  createApp(
    {
      postgres: async () => undefined,
      redis: async () => undefined,
      close: async () => undefined,
    },
    logger,
    {
      pool: runtime,
      auth,
      storage,
      vault,
      embedder: embedding,
      origins: ["http://localhost:8080"],
      authMode: "local",
    },
  );
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "advisor-integration-"));
  storage = new LocalEncryptedStorage(directory, vault);
  await owner.query("INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)", [
    tenant,
    "Ingestion test",
    otherTenant,
    "Other tenant",
  ]);
  await owner.query(
    "INSERT INTO users(id,tenant_id,cognito_sub,role) VALUES($1,$2,$3,$4),($5,$2,$6,$7),($8,$9,$10,$4)",
    [
      admin,
      tenant,
      `local:${admin}`,
      "ADMIN",
      advisor,
      `local:${advisor}`,
      "ADVISOR",
      otherUser,
      otherTenant,
      `local:${otherUser}`,
    ],
  );
  await owner.query(
    "INSERT INTO policies(id,tenant_id,name,provider) VALUES($1,$2,$3,$4),($5,$6,$7,$4)",
    [
      policy,
      tenant,
      "Test policy",
      "Synthetic",
      foreignPolicy,
      otherTenant,
      "Other policy",
    ],
  );
  await owner.query(
    "INSERT INTO conversations(id,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
    [conversation, tenant, admin],
  );
});
afterAll(async () => {
  try {
    for (const table of [
      "retrieval_feedback",
      "chat_messages",
      "conversations",
      "audit_logs",
      "document_chunks",
      "embedding_cache",
      "ingestion_jobs",
      "document_versions",
      "documents",
      "policies",
      "users",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,
        [[tenant, otherTenant]],
      );
    await owner.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [
      [tenant, otherTenant],
    ]);
  } finally {
    await Promise.all([runtime.end(), worker.end(), owner.end()]);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
test("authentication, ADMIN enforcement, tenant RLS, and strict conversation ownership are enforced over HTTP", async () => {
  expect((await request(app()).get("/api/v1/documents")).status).toBe(401);
  const advisorToken = token(`local:${advisor}`),
    adminToken = token(`local:${admin}`);
  expect(
    (
      await request(app())
        .post("/api/v1/policies")
        .auth(advisorToken, { type: "bearer" })
        .send({ name: "forbidden", provider: "test" })
    ).status,
  ).toBe(403);
  const own = await request(app())
    .get("/api/v1/policies")
    .auth(adminToken, { type: "bearer" });
  expect(own.body.items.map((p: { id: string }) => p.id)).toEqual([policy]);
  expect(
    (
      await request(app())
        .get(`/api/v1/conversations/${conversation}`)
        .auth(advisorToken, { type: "bearer" })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(app())
        .get(`/api/v1/conversations/${conversation}`)
        .auth(adminToken, { type: "bearer" })
    ).status,
  ).toBe(200);
  const invalid = await request(app())
    .post("/api/v1/search")
    .auth(adminToken, { type: "bearer" })
    .send({ policyId: foreignPolicy, question: "terms" });
  expect(invalid.status).toBe(404);
});
test("cookie-based writes require an allowed Origin; invalid JWT algorithms fail closed", async () => {
  const response = await request(app())
    .post("/api/v1/policies")
    .set("Cookie", `advisor_session=${token(`local:${admin}`)}`)
    .send({ name: "bad", provider: "bad" });
  expect(response.status).toBe(403);
  const invalid = jwt.sign({ sub: `local:${admin}` }, "", {
    algorithm: "none",
  });
  expect(
    (
      await request(app())
        .get("/api/v1/policies")
        .auth(invalid, { type: "bearer" })
    ).status,
  ).toBe(401);
});
test("API role cannot claim worker jobs, and worker role cannot look up credentials", async () => {
  await expect(
    runtime.query("SELECT * FROM claim_ingestion_job()"),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    worker.query("SELECT * FROM lookup_local_login('test@example.com')"),
  ).rejects.toMatchObject({ code: "42501" });
});
test("atomic encrypted storage accepts identical retries and refuses object replacement", async () => {
  const key = `${tenant}/${randomUUID()}`,
    data = Buffer.from("private uploaded policy");
  await Promise.all([storage.put(key, data), storage.put(key, data)]);
  expect(await storage.get(key)).toEqual(data);
  await expect(storage.put(key, Buffer.from("changed"))).rejects.toThrow(
    "IMMUTABLE_UPLOAD_CONFLICT",
  );
});
async function fixtureJob() {
  const document = randomUUID(),
    version = randomUUID(),
    id = randomUUID(),
    generation = randomUUID(),
    lease = randomUUID();
  const bytes = Buffer.from("Benefit,Limit\nWaiting period,30 days\n");
  await owner.query(
    "INSERT INTO documents(id,tenant_id,policy_id,name,document_type) VALUES($1,$2,$3,$4,$5)",
    [document, tenant, policy, "pipeline test", "policy"],
  );
  await owner.query(
    `INSERT INTO document_versions(id,tenant_id,document_id,version,s3_key,file_name,mime_type,size_bytes,content_hash,uploaded_by,status,effective_from)
    VALUES($1,$2,$3,1,$4,'test.csv','text/csv',$5,$6,$7,'UPLOADED','2026-01-01')`,
    [
      version,
      tenant,
      document,
      `${tenant}/${version}`,
      bytes.length,
      hash(bytes),
      admin,
    ],
  );
  await storage.put(`${tenant}/${version}`, bytes);
  await owner.query(
    "INSERT INTO ingestion_jobs(id,tenant_id,version_id,generation_id,status,attempts,lease_token,lease_until,available_at,request_id) VALUES($1,$2,$3,$4,'RUNNING',1,$5,now()+interval '10 minutes','2099-01-01',$6)",
    [id, tenant, version, generation, lease, randomUUID()],
  );
  return {
    id,
    tenant_id: tenant,
    version_id: version,
    generation_id: generation,
    lease_token: lease,
    attempts: 1,
    request_id: randomUUID(),
  } satisfies Job;
}
test("stale leases cannot publish, re-delivery is idempotent, and failed reindex preserves the active generation", async () => {
  const job = await fixtureJob();
  await expect(
    withTenant(worker, tenant, (client) =>
      assertLease(client, { ...job, lease_token: randomUUID() }),
    ),
  ).rejects.toThrow("LEASE_LOST");
  const services = {
    pool: worker,
    storage,
    vault,
    embedder: embedding,
    scanner: { scan: async () => undefined },
    parse: async () => [
      { text: "The waiting period is 30 days.", kind: "paragraph" as const },
    ],
    batchSize: 8,
    logger,
  };
  await processJob(job, services);
  let row = (
    await owner.query(
      "SELECT status,active_generation_id FROM document_versions WHERE id=$1",
      [job.version_id],
    )
  ).rows[0];
  expect(row).toEqual({
    status: "INDEXED",
    active_generation_id: job.generation_id,
  });
  await processJob(job, services);
  expect(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM document_chunks WHERE version_id=$1",
          [job.version_id],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
  const reindex = {
    ...job,
    id: randomUUID(),
    generation_id: randomUUID(),
    lease_token: randomUUID(),
    attempts: 3,
  };
  await owner.query(
    "INSERT INTO ingestion_jobs(id,tenant_id,version_id,generation_id,status,attempts,lease_token,lease_until,available_at) VALUES($1,$2,$3,$4,'RUNNING',3,$5,now()+interval '10 minutes','2099-01-01')",
    [
      reindex.id,
      tenant,
      reindex.version_id,
      reindex.generation_id,
      reindex.lease_token,
    ],
  );
  await owner.query(
    "UPDATE document_versions SET status='UPLOADED' WHERE id=$1",
    [job.version_id],
  );
  await processJob(reindex, {
    ...services,
    parse: async () => {
      throw new AppError("PARSE_TIMEOUT");
    },
  });
  row = (
    await owner.query(
      "SELECT status,active_generation_id FROM document_versions WHERE id=$1",
      [job.version_id],
    )
  ).rows[0];
  expect(row).toEqual({
    status: "FAILED",
    active_generation_id: job.generation_id,
  });
});
test("newly effective unindexed version blocks retrieval instead of returning older policy terms", async () => {
  const job = await fixtureJob();
  await processJob(job, {
    pool: worker,
    storage,
    vault,
    embedder: embedding,
    scanner: { scan: async () => undefined },
    parse: async () => [{ text: "30 days", kind: "paragraph" as const }],
    batchSize: 8,
    logger,
  });
  const source = (
    await owner.query("SELECT document_id FROM document_versions WHERE id=$1", [
      job.version_id,
    ])
  ).rows[0];
  const newVersion = randomUUID();
  await owner.query(
    `INSERT INTO document_versions(id,tenant_id,document_id,version,s3_key,file_name,mime_type,size_bytes,content_hash,uploaded_by,status,effective_from,supersedes_id)
    VALUES($1,$2,$3,2,$4,'new.csv','text/csv',10,$5,$6,'UPLOADED','2026-07-01',$7)`,
    [
      newVersion,
      tenant,
      source.document_id,
      `${tenant}/${newVersion}`,
      hash("future"),
      admin,
      job.version_id,
    ],
  );
  await expect(
    searchIndex(runtime, embedding, vault, tenant, {
      question: "waiting",
      policyId: policy,
      asOfDate: "2026-08-01",
      topK: 5,
    }),
  ).rejects.toThrow("APPLICABLE_VERSION_NOT_INDEXED");
  await expect(
    owner.query("UPDATE document_versions SET effective_from=$2 WHERE id=$1", [
      newVersion,
      "2025-01-01",
    ]),
  ).rejects.toMatchObject({ code: "23514" });
});
test("a partial embedding outage retains completed batches and resumes the same generation", async () => {
  const job = await fixtureJob();
  let calls = 0;
  const embedder = {
    model: "test:partial",
    dimensions: 768,
    embed: async (texts: string[]) => {
      calls++;
      if (calls === 2) throw new AppError("EMBEDDING_UNAVAILABLE", 503, true);
      return {
        vectors: texts.map(() => Array(768).fill(0.2) as number[]),
        inputTokens: 5,
      };
    },
  };
  const services = {
    pool: worker,
    storage,
    vault,
    embedder,
    scanner: { scan: async () => undefined },
    parse: async () => [
      { text: "Coverage is INR 10000.", kind: "paragraph" as const },
      { text: "Waiting period is 45 days.", kind: "paragraph" as const },
    ],
    batchSize: 1,
    logger,
  };
  await processJob(job, services);
  expect(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM document_chunks WHERE version_id=$1",
          [job.version_id],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
  expect(
    (
      await owner.query(
        "SELECT status,active_generation_id FROM document_versions WHERE id=$1",
        [job.version_id],
      )
    ).rows[0],
  ).toEqual({ status: "UPLOADED", active_generation_id: null });
  const retry = { ...job, attempts: 2, lease_token: randomUUID() };
  await owner.query(
    "UPDATE ingestion_jobs SET status='RUNNING',attempts=2,lease_token=$2,lease_until=now()+interval '10 minutes',available_at='2099-01-01' WHERE id=$1",
    [job.id, retry.lease_token],
  );
  await processJob(retry, services);
  expect(
    Number(
      (
        await owner.query(
          "SELECT count(*) FROM document_chunks WHERE version_id=$1",
          [job.version_id],
        )
      ).rows[0].count,
    ),
  ).toBe(2);
  expect(
    (
      await owner.query(
        "SELECT status,active_generation_id FROM document_versions WHERE id=$1",
        [job.version_id],
      )
    ).rows[0],
  ).toEqual({ status: "INDEXED", active_generation_id: job.generation_id });
});
test("crashed-worker leases are reclaimed with a new fencing token; exhaustion becomes FAILED", async () => {
  const job = await fixtureJob();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE ingestion_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    const reclaimed = (
      await client.query("SELECT * FROM claim_ingestion_job()")
    ).rows[0];
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.attempts).toBe(2);
    expect(reclaimed.lease_token).not.toBe(job.lease_token);
    await client.query(
      "UPDATE ingestion_jobs SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    await client.query("SELECT * FROM claim_ingestion_job()");
    expect(
      (
        await client.query(
          "SELECT status,last_error FROM ingestion_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0],
    ).toEqual({ status: "FAILED", last_error: "RETRY_EXHAUSTED" });
    expect(
      (
        await client.query("SELECT status FROM document_versions WHERE id=$1", [
          job.version_id,
        ])
      ).rows[0].status,
    ).toBe("FAILED");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
