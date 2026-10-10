import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { withTenant } from "../../packages/database/src/tenant.js";
const owner = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const app = new Pool({ connectionString: process.env.DATABASE_URL });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
const tenant = randomUUID(),
  user = randomUUID(),
  policy = randomUUID(),
  doc = randomUUID(),
  version = randomUUID(),
  job = randomUUID();
beforeAll(async () => {
  await owner.query(
    "INSERT INTO tenants(id,name) VALUES($1,'Cloud integration')",
    [tenant],
  );
  await owner.query(
    "INSERT INTO users(id,tenant_id,cognito_sub,role) VALUES($1,$2,$3,'ADMIN')",
    [user, tenant, `local:${user}`],
  );
  await owner.query(
    "INSERT INTO policies(id,tenant_id,name,provider) VALUES($1,$2,'Cloud','Synthetic')",
    [policy, tenant],
  );
  await owner.query(
    "INSERT INTO documents(id,tenant_id,policy_id,name,document_type) VALUES($1,$2,$3,'cloud.csv','policy')",
    [doc, tenant, policy],
  );
  await owner.query(
    "INSERT INTO document_versions(id,tenant_id,document_id,version,s3_key,file_name,mime_type,size_bytes,content_hash,uploaded_by,effective_from) VALUES($1,$2,$3,1,$4,'cloud.csv','text/csv',10,$5,$6,'2026-01-01')",
    [version, tenant, doc, `${tenant}/${version}`, "0".repeat(64), user],
  );
});
afterAll(async () => {
  for (const t of [
    "ingestion_jobs",
    "document_versions",
    "documents",
    "policies",
    "users",
  ])
    await owner.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenant]);
  await owner.query("DELETE FROM tenants WHERE id=$1", [tenant]);
  await app.end();
  await worker.end();
  await owner.end();
});
test("notification creation is atomic with job reservation and rolls back on failure", async () => {
  await expect(
    withTenant(app, tenant, async (c) => {
      await c.query(
        "INSERT INTO ingestion_jobs(id,tenant_id,version_id,generation_id) VALUES($1,$2,$3,$4)",
        [job, tenant, version, randomUUID()],
      );
      throw Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(
    (
      await owner.query(
        "SELECT job_id FROM ingestion_notifications WHERE job_id=$1",
        [job],
      )
    ).rowCount,
  ).toBe(0);
  await withTenant(app, tenant, (c) =>
    c.query(
      "INSERT INTO ingestion_jobs(id,tenant_id,version_id,generation_id) VALUES($1,$2,$3,$4)",
      [job, tenant, version, randomUUID()],
    ),
  );
  expect(
    (
      await owner.query(
        "SELECT job_id FROM ingestion_notifications WHERE job_id=$1",
        [job],
      )
    ).rowCount,
  ).toBe(1);
});
test("worker notification publication is leased and stale publishers cannot acknowledge it", async () => {
  const first = (
    await worker.query("SELECT * FROM claim_ingestion_notification()")
  ).rows[0];
  expect(first.job_id).toBe(job);
  expect(
    (await worker.query("SELECT * FROM claim_ingestion_notification()")).rows,
  ).toHaveLength(0);
  await worker.query("SELECT finish_ingestion_notification($1,$2,true)", [
    job,
    randomUUID(),
  ]);
  expect(
    (
      await owner.query(
        "SELECT sent_at FROM ingestion_notifications WHERE job_id=$1",
        [job],
      )
    ).rows[0].sent_at,
  ).toBeNull();
  await worker.query("SELECT finish_ingestion_notification($1,$2,false)", [
    job,
    first.lease_token,
  ]);
  const retry = (
    await owner.query(
      "SELECT sent_at,lease_token,available_at>now() AS deferred FROM ingestion_notifications WHERE job_id=$1",
      [job],
    )
  ).rows[0];
  expect(retry).toEqual({ sent_at: null, lease_token: null, deferred: true });
  await owner.query(
    "UPDATE ingestion_notifications SET available_at=now() WHERE job_id=$1",
    [job],
  );
  const second = (
    await worker.query("SELECT * FROM claim_ingestion_notification()")
  ).rows[0];
  expect(second.attempts).toBe(2);
  await worker.query("SELECT finish_ingestion_notification($1,$2,true)", [
    job,
    second.lease_token,
  ]);
  expect(
    (
      await owner.query(
        "SELECT sent_at FROM ingestion_notifications WHERE job_id=$1",
        [job],
      )
    ).rows[0].sent_at,
  ).not.toBeNull();
});
test("runtime cannot read or mutate the notification outbox through table grants", async () => {
  await expect(
    app.query("SELECT * FROM ingestion_notifications"),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    app.query("SELECT * FROM claim_ingestion_notification()"),
  ).rejects.toMatchObject({ code: "42501" });
});

test("global operational aggregates are worker-only and expose no tenant identifiers", async () => {
  await expect(
    app.query("SELECT * FROM ingestion_operational_metrics()"),
  ).rejects.toMatchObject({ code: "42501" });
  const result = (
    await worker.query("SELECT * FROM ingestion_operational_metrics()")
  ).rows[0];
  expect(Object.keys(result).sort()).toEqual([
    "failed",
    "notifications_pending",
    "oldest_pending_seconds",
    "pending",
  ]);
  expect(Number(result.pending)).toBeGreaterThanOrEqual(0);
});
