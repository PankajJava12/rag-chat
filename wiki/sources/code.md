---
title: Implementation evidence inventory
type: source
status: current
reviewed: 2026-10-12
---

# Implementation evidence inventory

Initial inventory reviewed on 2026-10-10. On 2026-10-11, inspected application wiring, worker flow, frontend entry points, backend symbols, configuration, processing, runtime/storage composition, database helpers and telemetry to add local app/package guides. This is a navigation map, not a full audit or runtime verification.

| Source                                                                                                                                             | Authority / topic                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [package.json](../../package.json)                                                                                                                 | Node constraint, workspaces and executable npm scripts        |
| [Configuration](../../packages/shared/src/config.ts)                                                                                               | Provider enums/defaults, dimensions and startup gates         |
| [Embeddings](../../packages/ai/src/embeddings.ts)                                                                                                  | Provider adapters/profile validation                          |
| [Retrieval](../../packages/ingestion/src/retrieval.ts)                                                                                             | Semantic model matching and keyword fallback                  |
| [Pipeline](../../packages/ingestion/src/pipeline.ts)                                                                                               | Scan/parse/embed/staging/publication                          |
| [Ranking](../../packages/ai/src/retrieval/ranking.ts)                                                                                              | Fusion and deterministic reranker                             |
| [Query cache](../../packages/ai/src/query-cache.ts)                                                                                                | Encrypted query embeddings and outage handling                |
| [Chat service](../../packages/chat/src/service.ts)                                                                                                 | Runs/history, version checks and final persistence            |
| [Workflow](../../packages/chat/src/workflow.ts)                                                                                                    | Bounded graph stages                                          |
| [Grounding](../../packages/chat/src/grounding.ts)                                                                                                  | Evidence selection and quote verification                     |
| [Authentication](../../packages/security/src/auth.ts)                                                                                              | Verified identity and revocation                              |
| [Tenant helper](../../packages/database/src/tenant.ts)                                                                                             | Transaction-local tenant/owner context                        |
| [OpenAI overlay](../../docker-compose.openai.yml)                                                                                                  | Container provider and dimension settings                     |
| [Tools Compose](../../docker-compose.tools.yml), [pgAdmin server](../../docker/pgadmin/servers.json), [tools setup](../../scripts/tools-setup.mjs) | Separate database browser, shared network and generated login |

SQL migrations and route schemas are authoritative for constraints and requests. The [walkthrough](../../docs/project-walkthrough.md) connects these files to user behavior; inspect code directly before editing or asserting changed behavior. Generated dist/ is an output, not the editing target. Private environment files and Terraform state are excluded from wiki sources.

The [architecture code map](../topics/architecture.md) links all three application and eight package READMEs. Each guide links its original implementation files and records its source-review date. Documentation link/coverage/format checks do not validate runtime behavior.

## Sources

[Walkthrough](../../docs/project-walkthrough.md) and the file map above.

## Related

[Architecture](../topics/architecture.md) · [Retrieval](../topics/retrieval-and-chat.md) · [API](../topics/api.md) · [Documentation sources](project-docs.md)
