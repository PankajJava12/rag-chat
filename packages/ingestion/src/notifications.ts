import { observed } from "../../observability/src/telemetry.js";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { z } from "zod";
const event = z
  .object({ version: z.literal(1), jobId: z.uuid(), tenantId: z.uuid() })
  .strict();
export class SqsNotifications {
  constructor(
    private client: SQSClient,
    private queueUrl: string,
  ) {}
  async publish(jobId: string, tenantId: string) {
    const message = event.parse({ version: 1, jobId, tenantId });
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }
  async wake() {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 30,
      }),
    );
    for (const message of result.Messages ?? []) {
      let parsed;
      try {
        parsed = event.safeParse(JSON.parse(message.Body ?? ""));
      } catch {
        continue;
      }
      // Poison messages retain their visibility/retry history and eventually reach the SQS DLQ.
      if (!parsed.success || !message.ReceiptHandle) continue;
      // A message is only a wake-up hint, never authorization or the durable job lease.
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }
}
export async function dispatchNotification(
  pool: Pool,
  queue: SqsNotifications,
  logger: Logger,
) {
  const row = (await pool.query("SELECT * FROM claim_ingestion_notification()"))
    .rows[0];
  if (!row) return;
  try {
    await observed(
      "queue.publish",
      () => queue.publish(row.job_id, row.tenant_id),
      row.trace_parent,
    );
    await pool.query("SELECT finish_ingestion_notification($1,$2,true)", [
      row.job_id,
      row.lease_token,
    ]);
  } catch {
    await pool.query("SELECT finish_ingestion_notification($1,$2,false)", [
      row.job_id,
      row.lease_token,
    ]);
    logger.warn(
      { operation: "notification_dispatch", jobId: row.job_id },
      "notification_retry_scheduled",
    );
  }
}
