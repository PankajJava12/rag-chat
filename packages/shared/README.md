# Shared runtime utilities

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package holds common runtime contracts used by the API, worker and backend libraries: validated configuration, structured errors, readiness and shutdown. It has no standalone application process.

## Main files

| File                               | Responsibility                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/config.ts](src/config.ts)     | `loadConfig()` validates environment settings with Zod and supplies defaults; `requireIngestionSecrets()` enforces required credentials and deployment gates. |
| [src/errors.ts](src/errors.ts)     | `AppError` carries a stable code, HTTP status and retryability; `errorCode()` maps failures to codes.                                                         |
| [src/health.ts](src/health.ts)     | Health/dependency interfaces and `readiness()` combining bounded PostgreSQL/Redis dependency checks.                                                          |
| [src/shutdown.ts](src/shutdown.ts) | `installShutdown()` handles SIGTERM/SIGINT, stops HTTP acceptance/idle connections, runs cleanup and enforces a shutdown deadline.                            |

## How it is used

[API](../../apps/api/README.md), [worker](../../apps/worker/README.md) and [ingestion runtime](../ingestion/README.md) load configuration before composing services. Parsers, storage, authentication, embeddings and chat use `AppError` to preserve meaningful failure codes and retry decisions. [Database](../database/README.md) supplies readiness dependencies; applications expose the resulting health state.

Shutdown callbacks belong to each application: they close database/cache clients and telemetry, while the worker also stops its polling loop and awaits current work within the process shutdown budget.

## Configuration groups

- Process/network: environment, bind address, API/worker ports, connection limits and origin settings.
- AI/retrieval: chat and embedding providers/models, external-AI consent gate, timeouts, context/output limits, top K, candidate count and reranking.
- Data: PostgreSQL/Redis URLs, encryption key, local/S3 storage and PostgreSQL/SQS queue profile.
- Identity/deployment: local/Cognito mode, membership-verification settings, LocalStack/AWS options and production prerequisites.

OpenAI embeddings require 1536 dimensions and Gemini/Ollama require 768 in this implementation; incompatible dimension settings are rejected. External providers require the external-AI gate. Production has additional approved-deployment/auth/storage/TLS requirements in the source. Supported settings do not imply a production deployment has occurred.

Telemetry startup settings are also read directly by [observability](../observability/README.md), so `config.ts` is not the only environment consumer. Use the [root runbook](../../README.md) and [operations wiki](../../wiki/topics/operations.md) for complete profile setup.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
