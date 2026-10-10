import { z } from "zod";
const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  BIND_HOST: z.string().default("0.0.0.0"),
  QUERY_CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  QUERY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(900).default(300),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DEPENDENCY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10000)
    .default(2000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  ALLOW_EXTERNAL_AI: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CHAT_PROVIDER: z.enum(["ollama", "openai", "gemini"]).default("ollama"),
  OLLAMA_CHAT_MODEL: z.string().min(1).default("qwen2.5:1.5b"),
  CHAT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(180000)
    .default(180000),
  CHAT_CONTEXT_TOKENS: z.coerce.number().int().min(256).max(2000).default(2000),
  CHAT_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(4096)
    .default(768),
  RETRIEVAL_MODE: z.enum(["semantic", "hybrid"]).default("hybrid"),
  RETRIEVAL_RERANK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  RETRIEVAL_CANDIDATES: z.coerce.number().int().min(10).max(40).default(20),
  CHAT_TOP_K: z.coerce.number().int().min(1).max(10).default(8),
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1"),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  EMBEDDING_PROVIDER: z.enum(["ollama", "openai", "gemini"]).default("ollama"),
  OLLAMA_URL: z.url().default("http://localhost:11434"),
  OLLAMA_CHAT_URL: z.url().optional(),
  OLLAMA_MODEL: z.string().default("nomic-embed-text:v1.5"),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-001"),
  AUTH_MODE: z.enum(["local", "cognito"]).default("local"),
  AUTH_SECRET: z.string().min(32).optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  STORAGE_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  STORAGE_DIRECTORY: z.string().default(".local/documents"),
  CLAMAV_HOST: z.string().default("localhost"),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(32).default(8),
  DEPLOYMENT_TARGET: z.enum(["local", "localstack", "aws"]).default("local"),
  PRODUCTION_DEPLOYMENT_APPROVED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  QUEUE_PROVIDER: z.enum(["postgres", "sqs"]).default("postgres"),
  AWS_ENDPOINT_URL: z.url().optional(),
  S3_BUCKET: z.string().min(3).optional(),
  S3_KMS_KEY_ID: z.string().optional(),
  SQS_QUEUE_URL: z.url().optional(),
  AWS_REGION: z.string().default("ap-south-1"),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:8080,http://localhost:5173"),
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration fields: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  if (
    !result.data.ALLOW_EXTERNAL_AI &&
    (result.data.CHAT_PROVIDER !== "ollama" ||
      result.data.EMBEDDING_PROVIDER !== "ollama")
  )
    throw new Error(
      "External AI processing requires explicit ALLOW_EXTERNAL_AI approval",
    );
  const localModelHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "ollama",
    "host.docker.internal",
  ]);
  if (
    !result.data.ALLOW_EXTERNAL_AI &&
    [result.data.OLLAMA_URL, result.data.OLLAMA_CHAT_URL]
      .filter(Boolean)
      .some((u) => !localModelHosts.has(new URL(u!).hostname))
  )
    throw new Error(
      "Remote model endpoints require explicit ALLOW_EXTERNAL_AI approval",
    );
  const c = result.data;
  if (
    (c.CHAT_PROVIDER === "gemini" || c.EMBEDDING_PROVIDER === "gemini") &&
    !c.GEMINI_API_KEY
  )
    throw new Error("Gemini requires GEMINI_API_KEY");
  if (c.DEPLOYMENT_TARGET === "localstack") {
    if (
      !c.AWS_ENDPOINT_URL ||
      !new Set(["localhost", "127.0.0.1", "[::1]", "localstack"]).has(
        new URL(c.AWS_ENDPOINT_URL).hostname,
      )
    )
      throw new Error("LocalStack requires an explicit local AWS endpoint");
    if (
      c.SQS_QUEUE_URL &&
      new URL(c.SQS_QUEUE_URL).origin !== new URL(c.AWS_ENDPOINT_URL).origin
    )
      throw new Error(
        "LocalStack queue must use the configured local endpoint",
      );
  } else if (c.AWS_ENDPOINT_URL)
    throw new Error("AWS endpoint overrides are permitted only for LocalStack");
  if (
    c.STORAGE_PROVIDER === "s3" &&
    (!c.S3_BUCKET || c.DEPLOYMENT_TARGET === "local")
  )
    throw new Error("S3 requires a bucket and an explicit deployment target");
  if (
    c.QUEUE_PROVIDER === "sqs" &&
    (!c.SQS_QUEUE_URL || c.DEPLOYMENT_TARGET === "local")
  )
    throw new Error("SQS requires a queue and an explicit deployment target");
  if (c.DEPLOYMENT_TARGET === "aws" && !c.PRODUCTION_DEPLOYMENT_APPROVED)
    throw new Error(
      "AWS deployment remains disabled pending explicit approval",
    );
  const expected = result.data.EMBEDDING_PROVIDER === "openai" ? 1536 : 768;
  if (
    result.data.EMBEDDING_DIMENSIONS &&
    result.data.EMBEDDING_DIMENSIONS !== expected
  )
    throw new Error(
      "EMBEDDING_DIMENSIONS requires a matching database migration and embedding profile",
    );
  return { ...result.data, EMBEDDING_DIMENSIONS: expected };
}
export function requireIngestionSecrets(config: Config, authRequired = true) {
  if ((authRequired && !config.AUTH_SECRET) || !config.STORAGE_ENCRYPTION_KEY)
    throw new Error(
      "Run npm run setup: authentication and encryption configuration required",
    );
  if (
    config.NODE_ENV === "production" &&
    (config.DEPLOYMENT_TARGET !== "aws" ||
      !config.PRODUCTION_DEPLOYMENT_APPROVED ||
      config.AUTH_MODE !== "cognito" ||
      config.STORAGE_PROVIDER !== "s3" ||
      config.QUEUE_PROVIDER !== "sqs" ||
      !config.S3_KMS_KEY_ID ||
      !config.REDIS_URL.startsWith("rediss://") ||
      !config.DATABASE_URL.includes("sslmode=verify-full"))
  )
    throw new Error(
      "Production requires approved AWS, Cognito, S3/KMS, SQS and verified database/cache TLS",
    );
}
