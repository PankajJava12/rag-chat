---
title: API surface and contract ownership
type: topic
status: current
reviewed: 2026-10-10
---

# API surface and contract ownership

The implemented contract is [docs/openapi.json](../../docs/openapi.json), generated with npm run docs:api. Use the route implementations when generated or narrative docs disagree. Business paths have the /api/v1 prefix and require verified session/bearer authentication, with exceptions for login/public configuration. [Contract narrative](../../docs/api-contracts.md).

| Area      | Representative routes and behavior                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Health    | GET /health/live and /health/ready; readiness is dependency health, not answer quality                                      |
| Identity  | POST /auth/login, GET /auth/me, POST /auth/logout; logout revokes presented API token                                       |
| Policies  | GET /policies, ADMIN POST /policies                                                                                         |
| Ingestion | ADMIN POST /documents/upload-url, PUT /documents/uploads/:versionId, POST /documents/complete-upload                        |
| Documents | List/detail/status; authorized source download; ADMIN reindex/retry/archive                                                 |
| Retrieval | POST /search; policy/date/version filters, semantic/keyword/hybrid modes, ranking diagnostics                               |
| Chat      | Create/list owned conversations, GET /conversations/:id, POST /conversations/:id/messages with Idempotency-Key; JSON or SSE |
| Audit     | ADMIN GET /admin/audit-logs; tenant metadata only                                                                           |

The upload URL is an authenticated API route rather than a presigned S3 URL. Archive retains data; a planned physical DELETE API is not implied. Ranking scores are not confidence. Completed chat requests replay saved results; a failed request needs an explicit new inference key. [Contracts](../../docs/api-contracts.md); [chat streaming semantics](../../docs/phase-3.md).

Phase-labelled contract sections retain history: the initial logout row says clear cookie, while the Phase 5 addition documents revocation. The wiki uses the later scoped behavior. Verify schemas before writing a client; this page intentionally does not duplicate every request field.

## Sources

- [API contracts](../../docs/api-contracts.md), [OpenAPI](../../docs/openapi.json)
- [Ingestion routes](../../apps/api/src/routes/ingestion.ts), [chat routes](../../apps/api/src/routes/chat.ts)

## Related

[Security](security.md) · [Ingestion](ingestion.md) · [Retrieval and chat](retrieval-and-chat.md)
