# Ingestion worker application

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This application processes uploaded policy documents asynchronously. Keeping it separate from the HTTP API isolates long OCR, parsing and embedding work from interactive requests. Each worker process runs one ingestion job at a time.

## Main file

[src/worker.ts](src/worker.ts) is the process entry point. It loads configuration, selects the worker database connection when supplied, creates runtime services, and runs the polling loop. It also exposes health endpoints, updates readiness/backlog metrics and installs graceful shutdown.

## Processing flow

1. In the SQS profile, dispatch a pending database notification and consume a wake-up hint. Notification outages are logged; PostgreSQL polling continues.
2. Claim a durable PostgreSQL ingestion job using `claimJob()` from [ingestion](../../packages/ingestion/README.md).
3. Execute `processJob()` with encrypted storage, a ClamAV scanner, isolated parser, embedding adapter and configured batch size.
4. Repeat immediately after work, or wait approximately one second when no job is available or polling fails.

The ingestion library owns source integrity checks, renewable fenced leases, retries, chunks, embedding reuse and atomic generation publication. SQS messages do not grant authorization or own the durable job state. Redis is not the job queue.

## Dependencies

- [Document processing](../../packages/document-processing/README.md): ClamAV integration and isolated format parsing/OCR.
- [Ingestion](../../packages/ingestion/README.md): runtime composition, jobs, storage and notifications.
- [Database](../../packages/database/README.md): dependency clients and migration readiness.
- [Shared](../../packages/shared/README.md) and [observability](../../packages/observability/README.md): config, health, shutdown, logs, traces and metrics.

## Running and health

Run `npm run dev:worker` from the repository root after setup. Parser threads load compiled JavaScript, so build the project before running and rebuild after parser changes. The [root runbook](../../README.md) documents host and Docker profiles and parser-tool prerequisites.

`WORKER_PORT` defaults to 3001. `/health/live` reports liveness. `/health/ready` requires PostgreSQL/Redis readiness, a busy worker or recent successful poll, and no shutdown in progress. It does not independently probe every scanner/storage/model operation.

If `WORKER_DATABASE_URL` is present, the entry point uses it as its database URL. The runtime calls `ingestionRuntime(false)`, so a worker does not require a session-signing secret.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
