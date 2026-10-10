import { queryCache, redisQueryCache } from "../../ai/src/query-cache.js";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { S3EncryptedStorage } from "./aws-storage.js";
import { SqsNotifications } from "./notifications.js";
import { Pool } from "pg";
import {
  loadConfig,
  requireIngestionSecrets,
} from "../../shared/src/config.js";
import { Vault } from "../../security/src/crypto.js";
import { LocalEncryptedStorage } from "./storage.js";
import { createEmbedder } from "../../ai/src/embeddings.js";
export function ingestionRuntime(authRequired = true) {
  const config = loadConfig();
  requireIngestionSecrets(config, authRequired);
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    idleTimeoutMillis: 30000,
  });
  pool.on("error", () => undefined);
  const vault = new Vault(config.STORAGE_ENCRYPTION_KEY!);
  const localStorage = new LocalEncryptedStorage(
    config.STORAGE_DIRECTORY,
    vault,
  );
  const aws = {
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
    ...(config.DEPLOYMENT_TARGET === "localstack"
      ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } }
      : {}),
  };
  const cache = config.QUERY_CACHE_ENABLED
    ? redisQueryCache(config.REDIS_URL)
    : undefined;
  const baseEmbedder = createEmbedder(config);
  return {
    closeCache: () => cache?.close(),
    notifications:
      config.QUEUE_PROVIDER === "sqs"
        ? new SqsNotifications(new SQSClient(aws), config.SQS_QUEUE_URL!)
        : undefined,
    config,
    pool,
    vault,
    storage:
      config.STORAGE_PROVIDER === "s3"
        ? new S3EncryptedStorage(
            new S3Client({
              ...aws,
              forcePathStyle: config.DEPLOYMENT_TARGET === "localstack",
            }),
            config.S3_BUCKET!,
            vault,
            config.S3_KMS_KEY_ID,
            config.DEPLOYMENT_TARGET === "localstack"
              ? localStorage
              : undefined,
          )
        : localStorage,
    embedder: cache
      ? queryCache(
          baseEmbedder,
          vault,
          config.STORAGE_ENCRYPTION_KEY!,
          cache.store,
          config.QUERY_CACHE_TTL_SECONDS,
        )
      : baseEmbedder,
  };
}
