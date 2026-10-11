# Database foundation

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package owns database setup and helpers for safely using PostgreSQL and Redis. PostgreSQL is the authoritative store for tenant metadata, versions, chunks/vectors, ingestion jobs, conversations and audit records. SQL migrations define the data constraints and runtime privileges.

## Main files

| File                                     | Responsibility                                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/connections.ts](src/connections.ts) | `createDependencies()` creates bounded PostgreSQL/Redis health clients, checks required migration availability, pings Redis and exposes cleanup. Application work uses the separate pool composed by ingestion runtime. |
| [src/tenant.ts](src/tenant.ts)           | `withTenant()` validates the tenant ID, begins a transaction, sets transaction-local `app.tenant_id`, executes work, commits/rolls back and releases the pooled client.                                                 |
| [src/migrate.ts](src/migrate.ts)         | Runs sorted SQL migrations under an advisory lock, records SHA-256 checksums and rejects modifications to applied migrations. Uses migration credentials.                                                               |
| [src/seed.ts](src/seed.ts)               | Provisions a local tenant and ADMIN/ADVISOR accounts using supplied credentials; preserves existing accounts and rejects production/non-local-auth seeding.                                                             |
| [migrations/](migrations/)               | Additive schema evolution, tenant-aware relations, forced RLS, vector/keyword indexes, durable lease functions, chat ownership rules, security and notification/telemetry support.                                      |

## How it is used

The [API](../../apps/api/README.md) and [worker](../../apps/worker/README.md) create readiness clients here. [Ingestion](../ingestion/README.md), [chat](../chat/README.md) and [security](../security/README.md) use `withTenant()` for authorized database work. Chat's owner helper also sets transaction-local `app.user_id`.

The tenant helper does not authenticate a caller: tenant identity must come from verified server-side authentication. Transaction-local context prevents a pooled connection from carrying tenant settings into another request. Migrations establish separate API/worker privileges and controlled job-claim functions.

The core document chain is tenant → policy → document → version → generation chunks. Conversations belong to users and contain chat runs/messages. Notification rows and jobs are durable PostgreSQL state, independent of Redis availability.

## Operational use

From the repository root, `npm run db:migrate` applies migrations and `npm run db:seed` provisions local accounts. Follow the [runbook](../../README.md) for prerequisites and the selected environment/profile. Add new migrations rather than rewriting applied SQL; checksum enforcement will reject modified history.

Readiness currently requires migration `008_observability.sql`. These clients check database/cache availability; they do not certify the complete application workflow. See [security](../../wiki/topics/security.md) and [architecture](../../wiki/topics/architecture.md).

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
