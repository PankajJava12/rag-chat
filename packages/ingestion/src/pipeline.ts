import { observed, jobs } from "../../observability/src/telemetry.js";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import {
  keywordVector,
  KEYWORD_PROFILE,
} from "../../ai/src/retrieval/keywords.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import { withTenant } from "../../database/src/tenant.js";
import type { ObjectStorage } from "./storage.js";
import { Vault, hash } from "../../security/src/crypto.js";
import { AppError, errorCode } from "../../shared/src/errors.js";
import {
  fileType,
  validateBytes,
} from "../../document-processing/src/validate.js";
import type { ParsedSection } from "../../document-processing/src/parsers.js";
import type { MalwareScanner } from "../../document-processing/src/scanner.js";
import { chunkSections } from "../../document-processing/src/chunk.js";
import type { Embedder } from "../../ai/src/embeddings.js";
export interface Job {
  id: string;
  tenant_id: string;
  version_id: string;
  generation_id: string;
  lease_token: string;
  attempts: number;
  request_id: string;
  trace_parent?: string | null;
}
export interface PipelineServices {
  pool: Pool;
  storage: ObjectStorage;
  vault: Vault;
  scanner: MalwareScanner;
  embedder: Embedder;
  parse: (
    data: Buffer,
    type: ReturnType<typeof fileType>,
  ) => Promise<ParsedSection[]>;
  batchSize: number;
  logger: Logger;
}
export async function assertLease(client: PoolClient, job: Job) {
  const result = await client.query(
    "SELECT id FROM ingestion_jobs WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_until>now() FOR UPDATE",
    [job.id, job.tenant_id, job.lease_token],
  );
  if (!result.rowCount) throw new AppError("LEASE_LOST", 409);
}
export async function claimJob(pool: Pool): Promise<Job | undefined> {
  return (await pool.query("SELECT * FROM claim_ingestion_job()")).rows[0];
}
async function processJobInternal(
  job: Job,
  services: PipelineServices,
): Promise<void> {
  const { pool, storage, vault, scanner, embedder, parse, batchSize, logger } =
    services;
  const started = performance.now();
  let lostLease = false;
  let heartbeatActive = false;
  const heartbeat = setInterval(() => {
    if (heartbeatActive) return;
    heartbeatActive = true;
    void withTenant(pool, job.tenant_id, async (client) => {
      const result = await client.query(
        "UPDATE ingestion_jobs SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND lease_until>now()",
        [job.id, job.lease_token],
      );
      if (!result.rowCount) lostLease = true;
    })
      .catch(() => {
        lostLease = true;
      })
      .finally(() => {
        heartbeatActive = false;
      });
  }, 20000);
  heartbeat.unref();
  const audit = async (client: PoolClient, action: string) =>
    client.query(
      "INSERT INTO audit_logs(tenant_id,action,resource_id,request_id) VALUES($1,$2,$3,$4)",
      [job.tenant_id, action, job.version_id, job.request_id ?? randomUUID()],
    );
  try {
    const version = await withTenant(pool, job.tenant_id, async (client) => {
      await assertLease(client, job);
      const row = (
        await client.query(
          "SELECT * FROM document_versions WHERE id=$1 FOR UPDATE",
          [job.version_id],
        )
      ).rows[0];
      if (!row || row.status === "ARCHIVED")
        throw new AppError("VERSION_ARCHIVED", 409);
      await client.query(
        "UPDATE document_versions SET status='PROCESSING',failure_code=NULL WHERE id=$1",
        [job.version_id],
      );
      await audit(client, "ingestion.started");
      return row;
    });
    const data = await observed("ingestion.source", () =>
      storage.get(version.s3_key),
    );
    if (
      hash(data) !== version.content_hash ||
      data.length !== Number(version.size_bytes)
    )
      throw new AppError("STORED_FILE_INTEGRITY_FAILED");
    await observed("ingestion.scan", () => scanner.scan(data));
    const type = fileType(version.file_name, version.mime_type);
    await validateBytes(data, type);
    await withTenant(pool, job.tenant_id, async (client) => {
      await assertLease(client, job);
      await client.query(
        "UPDATE document_versions SET scan_status='CLEAN' WHERE id=$1",
        [job.version_id],
      );
    });
    const chunks = chunkSections(
      await observed("ingestion.parse", () => parse(data, type)),
    );
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      if (lostLease) throw new AppError("LEASE_LOST", 409);
      const batch = chunks.slice(offset, offset + batchSize);
      const cached = await withTenant(
        pool,
        job.tenant_id,
        async (client) =>
          (
            await client.query(
              "SELECT content_hash,embedding::text FROM embedding_cache WHERE tenant_id=$1 AND model=$2 AND dimensions=$3 AND content_hash=ANY($4::text[])",
              [
                job.tenant_id,
                embedder.model,
                embedder.dimensions,
                batch.map((c) => c.hash),
              ],
            )
          ).rows,
      );
      const vectors = new Map<string, number[]>(
        cached.map((r) => [r.content_hash, JSON.parse(r.embedding)]),
      );
      const missing = [
        ...new Map(
          batch.filter((c) => !vectors.has(c.hash)).map((c) => [c.hash, c]),
        ).values(),
      ];
      const result = missing.length
        ? await embedder.embed(missing.map((c) => c.text))
        : { vectors: [], inputTokens: 0 };
      missing.forEach((chunk, i) =>
        vectors.set(chunk.hash, result.vectors[i]!),
      );
      await withTenant(pool, job.tenant_id, async (client) => {
        await assertLease(client, job);
        for (const [i, chunk] of batch.entries()) {
          const vector = JSON.stringify(vectors.get(chunk.hash));
          const id = randomUUID();
          await client.query(
            "INSERT INTO embedding_cache(tenant_id,content_hash,model,dimensions,embedding) VALUES($1,$2,$3,$4,$5::vector) ON CONFLICT DO NOTHING",
            [
              job.tenant_id,
              chunk.hash,
              embedder.model,
              embedder.dimensions,
              vector,
            ],
          );
          await client.query(
            `INSERT INTO document_chunks(id,tenant_id,version_id,generation_id,chunk_index,content,content_hash,embedding,embedding_model,embedding_dimensions,metadata,keyword_vector,keyword_profile)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12::tsvector,$13) ON CONFLICT(tenant_id,version_id,generation_id,chunk_index) DO NOTHING`,
            [
              id,
              job.tenant_id,
              job.version_id,
              job.generation_id,
              offset + i,
              vault.sealText(chunk.text, `${job.tenant_id}:${id}`),
              chunk.hash,
              vector,
              embedder.model,
              embedder.dimensions,
              {
                encrypted: vault.sealText(
                  JSON.stringify(chunk.metadata),
                  `${job.tenant_id}:${id}:metadata`,
                ),
                tokenCount: chunk.tokenCount,
              },
              keywordVector(chunk.text, job.tenant_id, vault),
              KEYWORD_PROFILE,
            ],
          );
        }
        await client.query(
          "UPDATE ingestion_jobs SET processed_chunks=$2,input_tokens=input_tokens+$3 WHERE id=$1",
          [job.id, offset + batch.length, result.inputTokens],
        );
      });
    }
    await withTenant(pool, job.tenant_id, async (client) => {
      await assertLease(client, job);
      const versionResult = await client.query(
        "SELECT id FROM document_versions WHERE id=$1 AND status='PROCESSING' FOR UPDATE",
        [job.version_id],
      );
      if (!versionResult.rowCount)
        throw new AppError("VERSION_STATE_CHANGED", 409);
      const count = Number(
        (
          await client.query(
            "SELECT count(*) FROM document_chunks WHERE version_id=$1 AND generation_id=$2",
            [job.version_id, job.generation_id],
          )
        ).rows[0].count,
      );
      if (count !== chunks.length)
        throw new AppError("INDEX_INCOMPLETE", 500, true);
      await client.query(
        "UPDATE document_versions SET status='INDEXED',active_generation_id=$2,chunk_count=$3,embedding_model=$4,embedding_dimensions=$5,parser_version='local-v2',indexed_at=now(),failure_code=NULL WHERE id=$1",
        [
          job.version_id,
          job.generation_id,
          count,
          embedder.model,
          embedder.dimensions,
        ],
      );
      await client.query(
        "UPDATE ingestion_jobs SET status='COMPLETED',finished_at=now(),lease_until=NULL WHERE id=$1",
        [job.id],
      );
      await audit(client, "ingestion.indexed");
    });
    jobs.inc({ outcome: "indexed" });
    logger.info(
      {
        operation: "ingestion",
        tenantId: job.tenant_id,
        versionId: job.version_id,
        jobId: job.id,
        requestId: job.request_id,
        chunkCount: chunks.length,
        durationMs: Math.round(performance.now() - started),
        status: "INDEXED",
        model: embedder.model,
      },
      "document_indexed",
    );
  } catch (error) {
    trace.getSpan(context.active())?.setStatus({ code: SpanStatusCode.ERROR });
    const code = errorCode(error);
    const retryable =
      (error instanceof AppError ? error.retryable : true) && job.attempts < 3;
    jobs.inc({
      outcome:
        code === "LEASE_LOST" ? "lease_lost" : retryable ? "retry" : "failed",
    });
    // A replaced lease must never overwrite another worker's state.
    if (code !== "LEASE_LOST")
      await withTenant(pool, job.tenant_id, async (client) => {
        const locked = await client.query(
          "SELECT id FROM ingestion_jobs WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND lease_until>now() FOR UPDATE",
          [job.id, job.lease_token],
        );
        if (!locked.rowCount) return;
        await client.query(
          "UPDATE ingestion_jobs SET status=$2,last_error=$3,lease_until=NULL,available_at=now()+($4*interval '1 second'),finished_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END WHERE id=$1",
          [
            job.id,
            retryable ? "PENDING" : "FAILED",
            code,
            Math.min(60, 2 ** job.attempts) + Math.random(),
          ],
        );
        await client.query(
          "UPDATE document_versions SET status=$2,failure_code=$3,scan_status=CASE WHEN $3 IN ('MALWARE_DETECTED','SCAN_REJECTED') THEN 'REJECTED' ELSE scan_status END WHERE id=$1 AND status<>'ARCHIVED'",
          [job.version_id, retryable ? "UPLOADED" : "FAILED", code],
        );
        await audit(
          client,
          retryable ? "ingestion.retry_scheduled" : "ingestion.failed",
        );
      }).catch(() => {
        logger.error(
          { jobId: job.id },
          "failure_state_write_failed_lease_will_recover",
        );
      });
    logger.warn(
      {
        operation: "ingestion",
        tenantId: job.tenant_id,
        versionId: job.version_id,
        jobId: job.id,
        requestId: job.request_id,
        errorCode: code,
        retryable,
      },
      "document_processing_failed",
    );
  } finally {
    clearInterval(heartbeat);
  }
}

export function processJob(
  job: Job,
  services: PipelineServices,
): Promise<void> {
  return observed(
    "ingestion.attempt",
    () => processJobInternal(job, services),
    job.trace_parent,
  );
}
