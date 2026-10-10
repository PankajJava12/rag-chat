---
title: Architecture and code map
type: topic
status: current
reviewed: 2026-10-10
---

# Architecture and code map

Three application entry points share backend libraries; retrieval and LangGraph are functions within the API/worker, not separately deployed services. The inspected code map is summarized by the [walkthrough](../../docs/project-walkthrough.md).

| Location                          | Responsibility                                                   |
| --------------------------------- | ---------------------------------------------------------------- |
| apps/web/src/                     | React sign-in, document library, advisor chat                    |
| apps/api/src/server.ts and app.ts | Dependency wiring, Express, health/security boundaries           |
| apps/worker/src/worker.ts         | Claims/heartbeats, ingestion, optional SQS notification dispatch |
| packages/ingestion/               | Storage, jobs, version applicability and retrieval               |
| packages/document-processing/     | Validation, scan, isolated parsing, OCR and chunks               |
| packages/ai/                      | Embeddings, query cache, keywords, fusion, reranking, evaluation |
| packages/chat/                    | Conversation runs/memory, workflow, generation, grounding        |
| packages/database/                | Connections, migrations, tenant transaction context              |
| packages/security/                | Authentication, roles, encryption                                |
| packages/observability/           | Logs, spans and metrics                                          |
| packages/shared/                  | Validated config, errors, health/shutdown                        |
| infra/ and docker/                | Infrastructure templates and local deployment assets             |

PostgreSQL owns durable jobs, metadata, vectors, encrypted chunks/history and audit events. Redis is a query-vector cache. Original files use encrypted filesystem or S3 storage. LocalStack SQS notifications wake the worker; they do not own job authorization or retries. [Storage/queue design](../../docs/phase-6.md).

A document version represents immutable source terms; a generation represents a derived index. Atomic generation publication hides partial work and can preserve an old index during reindex failure. Tenant → policy → document → version → chunks is separate from user-owned conversations and chat runs. [Ingestion](ingestion.md).

## Sources

- [Walkthrough, Project structure](../../docs/project-walkthrough.md)
- [Database migrations](../../packages/database/migrations/002_ingestion.sql)
- [Chat migration](../../packages/database/migrations/004_chat.sql)
- [Source code inventory](../sources/code.md)

## Related

[Overview](../overview.md) · [API](api.md) · [Historical conflicts](open-questions.md)
