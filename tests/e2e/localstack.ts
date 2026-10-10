import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import request from "supertest";
import {
  S3Client,
  GetObjectCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  GetBucketEncryptionCommand,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  GetQueueAttributesCommand,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
} from "@aws-sdk/client-sqs";
import { Authentication } from "../../packages/security/src/auth.js";
import { Vault } from "../../packages/security/src/crypto.js";
import { createApp } from "../../apps/api/src/app.js";
import { createLogger } from "../../packages/observability/src/logger.js";
import { ingestionRuntime } from "../../packages/ingestion/src/runtime.js";
import { S3EncryptedStorage } from "../../packages/ingestion/src/aws-storage.js";
import {
  dispatchNotification,
  SqsNotifications,
} from "../../packages/ingestion/src/notifications.js";
import { processJob, claimJob } from "../../packages/ingestion/src/pipeline.js";
import { ClamScanner } from "../../packages/document-processing/src/scanner.js";
import { isolatedParse } from "../../packages/document-processing/src/isolated-parser.js";
import { hash } from "../../packages/security/src/crypto.js";
process.env.DEPLOYMENT_TARGET = "localstack";
process.env.STORAGE_PROVIDER = "s3";
process.env.QUEUE_PROVIDER = "sqs";
process.env.AWS_ENDPOINT_URL = "http://localhost:4566";
process.env.S3_BUCKET = "advisor-policies-local";
process.env.SQS_QUEUE_URL =
  "http://localhost:4566/000000000000/advisor-ingestion";
const runtime = ingestionRuntime(),
  logger = createLogger("localstack-test", "silent");
const owner = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
const options = {
  region: "ap-south-1",
  endpoint: "http://localhost:4566",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
  maxAttempts: 1,
};
const s3 = new S3Client({ ...options, forcePathStyle: true });
const sqs = new SQSClient(options);
const report = {
  validatedAt: new Date().toISOString(),
  environment: "LocalStack 4.12.0; local PostgreSQL/Redis/ClamAV/Ollama",
  checks: [] as string[],
  policyId: "",
  versionId: "",
};
let cookie = "";
const app = createApp(
  {
    postgres: async () => undefined,
    redis: async () => undefined,
    close: async () => undefined,
  },
  logger,
  {
    ...runtime,
    auth: new Authentication(runtime.pool, {
      mode: "local",
      environment: "development",
      secret: runtime.config.AUTH_SECRET!,
    }),
    origins: ["http://localhost:8080"],
    authMode: "local",
  },
);
async function call(path: string, body?: unknown, status = 200) {
  const r = body
    ? await request(app)
        .post("/api/v1" + path)
        .set("Origin", "http://localhost:8080")
        .set("Cookie", cookie)
        .set("Idempotency-Key", randomUUID())
        .send(body)
    : await request(app)
        .get("/api/v1" + path)
        .set("Cookie", cookie);
  assert.equal(r.status, status, `${path}: ${JSON.stringify(r.body)}`);
  return r;
}
async function main() {
  try {
    const login = await call("/auth/login", {
      email: process.env.LOCAL_ADMIN_EMAIL,
      password: process.env.LOCAL_ADMIN_PASSWORD,
    });
    cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(
      ";",
    )[0]!;
    const p = await call(
      "/policies",
      {
        name: `LocalStack synthetic ${report.validatedAt}`,
        provider: "Synthetic",
      },
      201,
    );
    report.policyId = p.body.id;
    const bytes = Buffer.from(
      'clause,terms\nWAIT-CLOUD-001,"The initial waiting period is 30 days."\n',
    );
    const v = await call(
      "/documents/upload-url",
      {
        policyId: p.body.id,
        fileName: "localstack-synthetic.csv",
        mimeType: "text/csv",
        sizeBytes: bytes.length,
        sha256: hash(bytes),
        effectiveFrom: "2026-01-01",
      },
      201,
    );
    report.versionId = v.body.versionId;
    const upload = await request(app)
      .put(v.body.uploadUrl)
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:8080")
      .set("Content-Type", "text/csv")
      .send(bytes);
    assert.equal(upload.status, 204);
    const queued = await call(
      "/documents/complete-upload",
      { versionId: v.body.versionId },
      202,
    );
    const stored = await s3.send(
      new GetObjectCommand({
        Bucket: runtime.config.S3_BUCKET,
        Key: `${login.body.user.tenantId}/${v.body.versionId}`,
      }),
    );
    const encrypted = Buffer.from(await stored.Body!.transformToByteArray());
    assert.equal(encrypted.subarray(0, 4).toString(), "AA01");
    assert.equal(encrypted.includes(bytes), false);
    report.checks.push(
      "Authenticated upload stores ciphertext in LocalStack S3",
    );
    const isolatedKey = `${randomUUID()}/${randomUUID()}`;
    const immutable = new S3EncryptedStorage(
      s3,
      runtime.config.S3_BUCKET!,
      new Vault(randomBytes(32).toString("hex")),
    );
    await immutable.put(isolatedKey, Buffer.from("fixture"));
    await immutable.put(isolatedKey, Buffer.from("fixture"));
    await assert.rejects(
      () => immutable.put(isolatedKey, Buffer.from("different")),
      (e) => (e as { code: string }).code === "IMMUTABLE_UPLOAD_CONFLICT",
    );
    report.checks.push(
      "S3 conditional write permits identical retries and rejects changed content",
    );
    assert.equal(
      (
        await s3.send(
          new GetBucketVersioningCommand({ Bucket: runtime.config.S3_BUCKET }),
        )
      ).Status,
      "Enabled",
    );
    assert.equal(
      (
        await s3.send(
          new GetPublicAccessBlockCommand({ Bucket: runtime.config.S3_BUCKET }),
        )
      ).PublicAccessBlockConfiguration!.BlockPublicPolicy,
      true,
    );
    assert.equal(
      (
        await s3.send(
          new GetBucketEncryptionCommand({ Bucket: runtime.config.S3_BUCKET }),
        )
      ).ServerSideEncryptionConfiguration!.Rules![0]!
        .ApplyServerSideEncryptionByDefault!.SSEAlgorithm,
      "AES256",
    );
    report.checks.push(
      "S3 versioning, public-access block and server encryption are enabled",
    );
    const notifications = new SqsNotifications(
      sqs,
      runtime.config.SQS_QUEUE_URL!,
    );
    await dispatchNotification(worker, notifications, logger);
    const outbox = (
      await owner.query(
        "SELECT sent_at FROM ingestion_notifications WHERE job_id=$1",
        [queued.body.jobId],
      )
    ).rows[0];
    assert(outbox.sent_at);
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: runtime.config.SQS_QUEUE_URL,
        AttributeNames: ["All"],
      }),
    );
    assert.equal(
      Number(JSON.parse(attrs.Attributes!.RedrivePolicy!).maxReceiveCount),
      5,
    );
    await notifications.wake();
    report.checks.push(
      "Committed job outbox is published to encrypted SQS with a DLQ",
    );
    const job = await claimJob(worker);
    assert.equal(job?.id, queued.body.jobId);
    await processJob(job!, {
      ...runtime,
      pool: worker,
      scanner: new ClamScanner(
        runtime.config.CLAMAV_HOST,
        runtime.config.CLAMAV_PORT,
      ),
      parse: isolatedParse,
      batchSize: 8,
      logger,
    });
    const status = await call(`/documents/${v.body.documentId}/status`);
    assert.equal(status.body.status, "INDEXED", JSON.stringify(status.body));
    const found = await call("/search", {
      question: "WAIT-CLOUD-001 waiting period",
      policyId: p.body.id,
      asOfDate: "2026-10-08",
      mode: "hybrid",
    });
    assert(found.body.matches.length > 0);
    report.checks.push(
      "S3 bytes are scanned, parsed, embedded by Ollama and indexed in real pgvector",
    );
    const download = await call(
      `/documents/${v.body.documentId}/source/${v.body.versionId}`,
    );
    assert.equal(download.text, bytes.toString());
    report.checks.push(
      "Authenticated source download decrypts the original S3 document",
    );
    // Independent short-visibility queues exercise real DLQ redrive without changing application queue settings.
    const suffix = randomUUID().slice(0, 8),
      dlqName = `advisor-test-dlq-${suffix}`,
      queueName = `advisor-test-redrive-${suffix}`;
    const localUrl = (name: string) =>
      `http://localhost:4566/000000000000/${name}`;
    await sqs.send(new CreateQueueCommand({ QueueName: dlqName }));
    await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          VisibilityTimeout: "0",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:ap-south-1:000000000000:${dlqName}`,
            maxReceiveCount: "2",
          }),
        },
      }),
    );
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: localUrl(queueName),
          MessageBody: "invalid notification fixture",
        }),
      );
      for (let i = 0; i < 4; i++)
        await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: localUrl(queueName),
            WaitTimeSeconds: 0,
          }),
        );
      const dead = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: localUrl(dlqName),
          WaitTimeSeconds: 1,
        }),
      );
      assert.equal(dead.Messages?.[0]?.Body, "invalid notification fixture");
      if (dead.Messages?.[0]?.ReceiptHandle)
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: localUrl(dlqName),
            ReceiptHandle: dead.Messages[0].ReceiptHandle,
          }),
        );
      report.checks.push(
        "Unacknowledged poison message reaches the real LocalStack DLQ after bounded delivery attempts",
      );
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: localUrl(queueName) }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: localUrl(dlqName) }));
    }
    await writeFile(
      "docs/phase-6-demo.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(report.checks);
  } finally {
    runtime.closeCache();
    await runtime.pool.end();
    await worker.end();
    await owner.end();
    s3.destroy();
    sqs.destroy();
  }
}
void main().catch((error) => {
  console.error(
    "LocalStack validation failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
});
