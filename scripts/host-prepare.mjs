import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { Vault } from "../dist/packages/security/src/crypto.js";
const vault = new Vault(process.env.STORAGE_ENCRYPTION_KEY);
await mkdir(".local/host-documents", { recursive: true, mode: 0o700 });
let count = 0;
for (const src of [".local/documents", ".local/container-documents"]) {
  let tenants;
  try {
    tenants = await readdir(src, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") continue;
    throw e;
  }
  for (const t of tenants.filter(
    (t) => t.isDirectory() && /^[a-f0-9-]{36}$/.test(t.name),
  )) {
    await mkdir(`.local/host-documents/${t.name}`, {
      recursive: true,
      mode: 0o700,
    });
    for (const f of (
      await readdir(`${src}/${t.name}`, { withFileTypes: true })
    ).filter((f) => f.isFile() && /^[a-f0-9-]{36}$/.test(f.name))) {
      const source = `${src}/${t.name}/${f.name}`,
        dest = `.local/host-documents/${t.name}/${f.name}`,
        key = `${t.name}/${f.name}`;
      const bytes = await readFile(source);
      vault.open(bytes, key);
      try {
        const existing = await readFile(dest);
        if (!vault.open(existing, key).equals(vault.open(bytes, key)))
          throw new Error("Storage key conflict");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        await copyFile(source, dest);
        count++;
      }
    }
  }
}
let content = await readFile(".env.development", "utf8");
const overrides = {
  APPLICATION_RUNTIME: "host",
  STORAGE_DIRECTORY: ".local/host-documents",
  DEPLOYMENT_TARGET: "localstack",
  STORAGE_PROVIDER: "s3",
  QUEUE_PROVIDER: "sqs",
  AWS_ENDPOINT_URL: "http://localhost:4566",
  S3_BUCKET: "advisor-policies-local",
  SQS_QUEUE_URL: "http://localhost:4566/000000000000/advisor-ingestion",
  BIND_HOST: "127.0.0.1",
  METRICS_ENABLED: "true",
  TRACING_ENABLED: "true",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
  QUERY_CACHE_ENABLED: "true",
  QUERY_CACHE_TTL_SECONDS: "300",
};
for (const [key, value] of Object.entries(overrides)) {
  content = content.replace(new RegExp(`^${key}=.*\\n?`, "gm"), "");
  content += `\n${key}=${value}\n`;
}
await writeFile(".env.host", content, { mode: 0o600 });
for (const role of ["api", "worker"]) {
  const secretKeys = new Set([
    "POSTGRES_PASSWORD",
    "APP_DB_PASSWORD",
    "WORKER_DB_PASSWORD",
    "MIGRATION_DATABASE_URL",
    "WORKER_DATABASE_URL",
  ]);
  if (role === "worker") {
    secretKeys.add("AUTH_SECRET");
    secretKeys.add("DATABASE_URL");
  }
  let restricted = content
    .split("\n")
    .filter((line) => {
      const key = line.split("=")[0];
      return !secretKeys.has(key) && !key.startsWith("LOCAL_");
    })
    .join("\n");
  if (role === "worker")
    restricted += `\nDATABASE_URL=${process.env.WORKER_DATABASE_URL}\n`;
  await writeFile(`.env.host-${role}`, restricted, { mode: 0o600 });
}
console.log(
  `Host configuration prepared; ${count} encrypted source files copied. Existing files/secrets retained.`,
);
