---
title: Implementation evidence inventory
type: source
status: current
reviewed: 2026-10-10
---

# Implementation evidence inventory

Inspected filenames, manifests, selected configuration/retrieval code and the dated implementation walkthrough on 2026-10-10. This is a navigation map, not a full audit or runtime verification.

| Source                                                 | Authority / topic                                      |
| ------------------------------------------------------ | ------------------------------------------------------ |
| [package.json](../../package.json)                     | Node constraint, workspaces and executable npm scripts |
| [Configuration](../../packages/shared/src/config.ts)   | Provider enums/defaults, dimensions and startup gates  |
| [Embeddings](../../packages/ai/src/embeddings.ts)      | Provider adapters/profile validation                   |
| [Retrieval](../../packages/ingestion/src/retrieval.ts) | Semantic model matching and keyword fallback           |
| [Pipeline](../../packages/ingestion/src/pipeline.ts)   | Scan/parse/embed/staging/publication                   |
| [Ranking](../../packages/ai/src/retrieval/ranking.ts)  | Fusion and deterministic reranker                      |
| [Query cache](../../packages/ai/src/query-cache.ts)    | Encrypted query embeddings and outage handling         |
| [Chat service](../../packages/chat/src/service.ts)     | Runs/history, version checks and final persistence     |
| [Workflow](../../packages/chat/src/workflow.ts)        | Bounded graph stages                                   |
| [Grounding](../../packages/chat/src/grounding.ts)      | Evidence selection and quote verification              |
| [Authentication](../../packages/security/src/auth.ts)  | Verified identity and revocation                       |
| [Tenant helper](../../packages/database/src/tenant.ts) | Transaction-local tenant/owner context                 |
| [OpenAI overlay](../../docker-compose.openai.yml)      | Container provider and dimension settings              |

SQL migrations and route schemas are authoritative for constraints and requests. The [walkthrough](../../docs/project-walkthrough.md) connects these files to user behavior; inspect code directly before editing or asserting changed behavior. Generated dist/ is an output, not the editing target. Private environment files and Terraform state are excluded from wiki sources.

## Sources

[Walkthrough](../../docs/project-walkthrough.md) and the file map above.

## Related

[Architecture](../topics/architecture.md) · [Retrieval](../topics/retrieval-and-chat.md) · [API](../topics/api.md) · [Documentation sources](project-docs.md)
