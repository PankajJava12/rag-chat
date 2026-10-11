# API application

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This application is the HTTP boundary for the insurance policy assistant. It authenticates users, manages policy documents and conversations, exposes authorized search/source downloads, and delivers validated chat answers. It runs as a separate Express process from the ingestion worker.

## Main files

| File                                               | Responsibility                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/server.ts](src/server.ts)                     | Loads configuration; creates health dependencies, authentication, storage, embedding and generation adapters; wires `ChatService`; starts the listener and installs shutdown.                                 |
| [src/app.ts](src/app.ts)                           | Creates Express, applies Helmet, request IDs, tracing and request metrics, registers health/platform endpoints, mounts the API router and handles errors.                                                     |
| [src/routes/ingestion.ts](src/routes/ingestion.ts) | Session/auth routes, policies, upload reservation/bytes/completion, document listing/status/source, retry/reindex/archive, audit logs and search. Mounts chat routes after authentication and request guards. |
| [src/routes/chat.ts](src/routes/chat.ts)           | Conversation creation/list/detail and message submission; ownership checks, per-user rate limiting, process capacity limits, cancellation and optional Server-Sent Events (SSE).                              |

## How it is used

The [web app](../web/README.md) calls `/api/v1` routes. Upload completion creates a PostgreSQL job for the [worker](../worker/README.md); the API does not parse or index the file synchronously. Upload bytes pass through this API before encrypted storage, even when S3 is selected.

For chat, the API delegates to [chat](../../packages/chat/README.md), which uses [ingestion retrieval](../../packages/ingestion/README.md) and [AI adapters](../../packages/ai/README.md). It sends SSE status/heartbeat events while work runs, then emits answer paragraphs only after evidence validation and persistence. A request can also receive ordinary JSON.

Authentication and role checks come from [security](../../packages/security/README.md). PostgreSQL tenant/owner transactions enforce the data boundary. The API rechecks identity before publishing a newly generated answer.

## Running and configuration

Run `npm run dev:api` from the repository root after the documented dependency/setup steps. `npm run build` compiles the backend; host and Docker launchers use that output. See the [root runbook](../../README.md) for complete profiles.

`API_PORT` defaults to 3000. Database, Redis, auth, encryption, storage, model and origin settings are validated in [config.ts](../../packages/shared/src/config.ts). `/health/live` reports process liveness; `/health/ready` checks PostgreSQL migration availability and Redis. Readiness is not a full end-to-end model or ingestion test.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
