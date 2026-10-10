import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const token = () => randomBytes(32).toString("hex");
const development = ".env.development";
if (!existsSync(development)) {
  const owner = token(),
    app = token();
  writeFileSync(
    development,
    `NODE_ENV=development\nAPI_PORT=3000\nWORKER_PORT=3001\nPOSTGRES_PASSWORD=${owner}\nAPP_DB_PASSWORD=${app}\nDATABASE_URL=postgresql://advisor_app:${app}@localhost:5432/advisor\nMIGRATION_DATABASE_URL=postgresql://advisor_owner:${owner}@localhost:5432/advisor\nREDIS_URL=redis://localhost:6379\nLOG_LEVEL=info\n`,
    { mode: 0o600, flag: "wx" },
  );
}
let content = readFileSync(development, "utf8");
const worker = token();
const additions = {
  CHAT_PROVIDER: "ollama",
  OLLAMA_CHAT_MODEL: "qwen2.5:1.5b",
  AUTH_MODE: "local",
  AUTH_SECRET: token(),
  STORAGE_ENCRYPTION_KEY: token(),
  LOCAL_ADMIN_EMAIL: "admin@advisor.local",
  LOCAL_ADMIN_PASSWORD: randomBytes(18).toString("base64url"),
  LOCAL_ADVISOR_EMAIL: "advisor@advisor.local",
  LOCAL_ADVISOR_PASSWORD: randomBytes(18).toString("base64url"),
  LOCAL_TENANT_ID: randomUUID(),
  WORKER_DB_PASSWORD: worker,
  WORKER_DATABASE_URL: `postgresql://advisor_worker:${worker}@localhost:5432/advisor`,
  STORAGE_DIRECTORY: ".local/documents",
  EMBEDDING_PROVIDER: "ollama",
  OLLAMA_URL: "http://localhost:11434",
  OLLAMA_MODEL: "nomic-embed-text:v1.5",
  CLAMAV_HOST: "localhost",
  CLAMAV_PORT: "3310",
  AWS_REGION: "ap-south-1",
  ALLOWED_ORIGINS:
    "http://localhost:8080,http://localhost:5173,http://127.0.0.1:8080,http://127.0.0.1:5173",
};
for (const [key, value] of Object.entries(additions))
  if (!new RegExp(`^${key}=`, "m").test(content))
    content += `\n${key}=${value}`;
// Phase 1's 1536-dimensional default is no longer used by local Ollama.
if (!/^INGESTION_CONFIG_VERSION=2$/m.test(content)) {
  content = content.replace(/^EMBEDDING_DIMENSIONS=.*\n?/m, "");
  content += "\nINGESTION_CONFIG_VERSION=2\n";
}
writeFileSync(development, content.trim() + "\n", { mode: 0o600 });
// Test configuration shares only this disposable local stack; preserve custom files once upgraded.
if (
  !existsSync(".env.test") ||
  !/^INGESTION_CONFIG_VERSION=2$/m.test(readFileSync(".env.test", "utf8"))
)
  writeFileSync(
    ".env.test",
    content.replace(/^NODE_ENV=.*$/m, "NODE_ENV=test").trim() + "\n",
    { mode: 0o600 },
  );
console.log(
  "Local configuration is ready. Existing credentials were preserved. Login credentials are in .env.development; they are never printed.",
);
