import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { passwordHash } from "../../security/src/crypto.js";
async function main() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.AUTH_MODE !== "local"
  )
    throw new Error("Local seeding is disabled");
  const tenant = process.env.LOCAL_TENANT_ID;
  if (!tenant) throw new Error("LOCAL_TENANT_ID required");
  const pool = new Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO tenants(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
      [tenant, "Local Advisor Workspace"],
    );
    for (const role of ["ADMIN", "ADVISOR"]) {
      const email = process.env[`LOCAL_${role}_EMAIL`],
        password = process.env[`LOCAL_${role}_PASSWORD`];
      if (!email || !password || password.length < 12)
        throw new Error("Local credentials missing");
      await client.query(
        "INSERT INTO users(id,tenant_id,cognito_sub,role,email,password_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(email) DO NOTHING",
        [
          randomUUID(),
          tenant,
          `local:${randomUUID()}`,
          role,
          email.toLowerCase(),
          await passwordHash(password),
        ],
      );
    }
    await client.query("COMMIT");
    console.log("Local accounts provisioned (existing passwords unchanged).");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error("Local account provisioning failed");
  process.exitCode = 1;
});
