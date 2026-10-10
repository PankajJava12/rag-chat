import { randomBytes, randomUUID } from "node:crypto";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  SqsNotifications,
  dispatchNotification,
} from "../../packages/ingestion/src/notifications.js";
import type { Pool } from "pg";
import { createLogger } from "../../packages/observability/src/logger.js";
import { S3Client } from "@aws-sdk/client-s3";
import { S3EncryptedStorage } from "../../packages/ingestion/src/aws-storage.js";
import { Vault } from "../../packages/security/src/crypto.js";
import { loadConfig } from "../../packages/shared/src/config.js";
const key = `${randomUUID()}/${randomUUID()}`;
const vault = new Vault(randomBytes(32).toString("hex"));
afterEach(() => jest.restoreAllMocks());
test("S3 publishes ciphertext with an immutable conditional write and server encryption", async () => {
  const send = jest
    .spyOn(S3Client.prototype, "send")
    .mockResolvedValue({} as never);
  const storage = new S3EncryptedStorage(
    new S3Client({ region: "ap-south-1" }),
    "test-bucket",
    vault,
  );
  await storage.put(key, Buffer.from("private document"));
  const command = send.mock.calls[0]![0];
  expect(command.input).toMatchObject({
    Key: key,
    IfNoneMatch: "*",
    ServerSideEncryption: "AES256",
    ContentType: "application/octet-stream",
  });
  const body = (command.input as { Body: Buffer }).Body;
  expect(body.includes(Buffer.from("private document"))).toBe(false);
  expect(vault.open(body, key).toString()).toBe("private document");
});
test("conditional write conflict permits identical retries and rejects different bytes", async () => {
  const stored = vault.seal(Buffer.from("original"), key);
  const send = jest.spyOn(S3Client.prototype, "send");
  const response = { Body: { transformToByteArray: async () => stored } };
  send
    .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } } as never)
    .mockResolvedValueOnce(response as never);
  const storage = new S3EncryptedStorage(
    new S3Client({ region: "ap-south-1" }),
    "test-bucket",
    vault,
  );
  await storage.put(key, Buffer.from("original"));
  send
    .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } } as never)
    .mockResolvedValueOnce(response as never);
  await expect(storage.put(key, Buffer.from("modified"))).rejects.toMatchObject(
    { code: "IMMUTABLE_UPLOAD_CONFLICT" },
  );
});
test("unsafe object keys are rejected before network calls", async () => {
  const send = jest.spyOn(S3Client.prototype, "send");
  const storage = new S3EncryptedStorage(
    new S3Client({ region: "ap-south-1" }),
    "test-bucket",
    vault,
  );
  await expect(storage.get("../foreign")).rejects.toMatchObject({
    code: "INVALID_STORAGE_KEY",
  });
  expect(send).not.toHaveBeenCalled();
});
const env = {
  DATABASE_URL: "postgresql://localhost/test",
  REDIS_URL: "redis://localhost",
};
test("local defaults do not enable AWS endpoints or providers", () => {
  expect(loadConfig(env)).toMatchObject({
    DEPLOYMENT_TARGET: "local",
    STORAGE_PROVIDER: "local",
    QUEUE_PROVIDER: "postgres",
    PRODUCTION_DEPLOYMENT_APPROVED: false,
  });
  expect(() => loadConfig({ ...env, DEPLOYMENT_TARGET: "aws" })).toThrow(
    "AWS deployment remains disabled",
  );
});
test.each(["https://s3.ap-south-1.amazonaws.com", "http://attacker.example"])(
  "LocalStack cannot target a remote endpoint: %s",
  (endpoint) => {
    expect(() =>
      loadConfig({
        ...env,
        DEPLOYMENT_TARGET: "localstack",
        AWS_ENDPOINT_URL: endpoint,
      }),
    ).toThrow("explicit local AWS endpoint");
  },
);
test("queue endpoints cannot escape the configured emulator", () => {
  expect(() =>
    loadConfig({
      ...env,
      DEPLOYMENT_TARGET: "localstack",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      SQS_QUEUE_URL: "https://sqs.ap-south-1.amazonaws.com/real",
    }),
  ).toThrow("configured local endpoint");
});

test("LocalStack mirror is written first and recovers only missing objects", async () => {
  const mirror = {
    put: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(Buffer.from("original")),
  };
  const send = jest
    .spyOn(S3Client.prototype, "send")
    .mockResolvedValue({} as never);
  const storage = new S3EncryptedStorage(
    new S3Client({ region: "ap-south-1" }),
    "fixture",
    vault,
    undefined,
    mirror,
  );
  await storage.put(key, Buffer.from("original"));
  expect(mirror.put).toHaveBeenCalledWith(key, Buffer.from("original"));
  expect(mirror.put.mock.invocationCallOrder[0]).toBeLessThan(
    send.mock.invocationCallOrder[0]!,
  );
  send.mockRejectedValueOnce({ name: "NoSuchKey" } as never);
  expect((await storage.get(key)).toString()).toBe("original");
  send.mockRejectedValueOnce({ name: "AccessDenied" } as never);
  await expect(storage.get(key)).rejects.toMatchObject({
    name: "AccessDenied",
  });
  expect(mirror.get).toHaveBeenCalledTimes(1);
  mirror.put.mockRejectedValueOnce(new Error("mirror full"));
  const calls = send.mock.calls.length;
  await expect(storage.put(key, Buffer.from("original"))).rejects.toThrow(
    "mirror full",
  );
  expect(send.mock.calls).toHaveLength(calls);
});

test("SQS poison payloads stay unacknowledged while valid hints are acknowledged", async () => {
  const send = jest.spyOn(SQSClient.prototype, "send");
  const queue = new SqsNotifications(
    new SQSClient({ region: "ap-south-1" }),
    "http://localhost:4566/fixture",
  );
  for (const Body of [
    "invalid JSON",
    JSON.stringify({
      version: 1,
      jobId: randomUUID(),
      tenantId: randomUUID(),
      text: "unexpected content",
    }),
  ]) {
    send.mockResolvedValueOnce({
      Messages: [{ Body, ReceiptHandle: "poison" }],
    } as never);
    const count = send.mock.calls.length;
    await queue.wake();
    expect(send.mock.calls.length).toBe(count + 1);
  }
  send
    .mockResolvedValueOnce({
      Messages: [
        {
          Body: JSON.stringify({
            version: 1,
            jobId: randomUUID(),
            tenantId: randomUUID(),
          }),
          ReceiptHandle: "valid",
        },
      ],
    } as never)
    .mockResolvedValueOnce({} as never);
  await queue.wake();
  expect(send.mock.calls.at(-1)![0].input).toMatchObject({
    ReceiptHandle: "valid",
  });
});
test("notification send failure retains the fenced outbox for retry", async () => {
  const row = {
    job_id: randomUUID(),
    tenant_id: randomUUID(),
    lease_token: randomUUID(),
  };
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [row] })
    .mockResolvedValueOnce({ rows: [] });
  const send = jest
    .spyOn(SQSClient.prototype, "send")
    .mockRejectedValueOnce(new Error("fixture outage") as never);
  await dispatchNotification(
    { query } as unknown as Pool,
    new SqsNotifications(
      new SQSClient({ region: "ap-south-1" }),
      "http://localhost:4566/fixture",
    ),
    createLogger("fixture", "silent"),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenLastCalledWith(
    "SELECT finish_ingestion_notification($1,$2,false)",
    [row.job_id, row.lease_token],
  );
});
