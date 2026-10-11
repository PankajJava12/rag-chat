# Ingestion, storage and retrieval

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package owns the document indexing lifecycle and scoped index search. It connects encrypted originals, durable PostgreSQL jobs, document processing, embeddings and active generations. Both the [API](../../apps/api/README.md) and [worker](../../apps/worker/README.md) use it.

## Main files

| File                                                 | Responsibility                                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/runtime.ts](src/runtime.ts)                     | `ingestionRuntime()` composes validated config, application pool, encryption vault, local/S3 storage, embedder, optional query cache and optional SQS notifications.         |
| [src/pipeline.ts](src/pipeline.ts)                   | Job claiming, fenced renewable leases, source integrity, scan/parse/chunk/embed, PostgreSQL embedding reuse, batch writes, retries and atomic active-generation publication. |
| [src/storage.ts](src/storage.ts)                     | `ObjectStorage` interface and immutable encrypted local filesystem storage.                                                                                                  |
| [src/aws-storage.ts](src/aws-storage.ts)             | S3 storage with application encryption and server-side encryption; optional encrypted local recovery mirror in LocalStack mode.                                              |
| [src/notifications.ts](src/notifications.ts)         | SQS publish/consume adapter and dispatch of durable database notification rows. Messages are wake-up hints.                                                                  |
| [src/retrieval.ts](src/retrieval.ts)                 | `applicableVersions()` and `searchIndex()`: policy/date/version selection, profile-aware semantic search, blind keyword search, RRF/reranking and generation snapshots.      |
| [src/backfill-keywords.ts](src/backfill-keywords.ts) | Updates existing chunks to the current blind keyword profile in bounded tenant-scoped batches, without reembedding them.                                                     |

## Ingestion flow

The API reserves a version, receives/encrypts bytes and creates a job after upload completion. The worker claims the job and calls `processJob()`. It verifies/decrypts the original, scans and parses it, builds chunks, reuses cached embeddings and writes a staged generation. After checking completeness, a transaction activates that generation and completes the job.

PostgreSQL owns leases and retry state. A 90-second lease is renewed every 20 seconds and checked before writes; expired leases can be reclaimed. Retryable work has up to three job attempts. Retrieval uses only `active_generation_id`, preventing partial-generation exposure and retaining an existing index during reindex work.

## Retrieval flow

Search first establishes authorized policy scope and applicable versions using effective dates, explicit choices and supersession. Selected versions require clean scans and active generations. It embeds the query for compatible model profiles, retrieves cosine and keyword candidates, combines ranks and optionally reranks decrypted candidates.

Older embedding profiles remain available through keyword retrieval; switching providers does not automatically reindex the corpus. The result includes matches, retrieval diagnostics and a version/generation snapshot for chat's final validation. This package supplies evidence, not generated answers; [chat](../chat/README.md) owns generation and quotation validation.

## Configuration and use

Storage/queue/model/cache settings live in [shared config](../shared/src/config.ts). `npm run db:keywords` invokes keyword backfill from the repository root. Redis caches query vectors; PostgreSQL caches document embedding reuse. SQS notifications and their database outbox are separate from the authoritative job queue.

See [ingestion and versioning](../../wiki/topics/ingestion.md) and [retrieval and chat](../../wiki/topics/retrieval-and-chat.md) for source-linked detail.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
