import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
async function migrate() {
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error("MIGRATION_DATABASE_URL is required");
  const client = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    if (process.env.WORKER_DB_PASSWORD) {
      const role = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname='advisor_worker'",
      );
      if (!role.rowCount) {
        const sql = await client.query(
          "SELECT format('CREATE ROLE advisor_worker LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', $1::text) AS command",
          [process.env.WORKER_DB_PASSWORD],
        );
        await client.query(sql.rows[0].command);
      }
    }
    await client.query("SELECT pg_advisory_lock(71008301)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = resolve("packages/database/migrations");
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(resolve(directory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version=$1",
        [file],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Applied migration was modified: ${file}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
migrate().catch(() => {
  console.error(
    "Migration failed. Check connectivity, migration checksums, and database privileges.",
  );
  process.exitCode = 1;
});
