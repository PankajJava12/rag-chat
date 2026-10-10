# Local API contracts — Phase 4

The implemented API is described in [OpenAPI](openapi.json), regenerated with `npm run docs:api`. The local base URL is `http://localhost:3000`. The React/Nginx origin proxies the same `/api/v1` paths.

Every business route requires a signed session cookie or verified bearer token. Membership and ADMIN/ADVISOR roles come from the database, not request headers or client tenant claims. Cookie-based writes require an allowed Origin. Requests use strict Zod validation. Errors include a safe `error.code` (and, where available, `message` and `requestId`), with no raw dependency errors or policy text.

| Endpoint                                    | Access / behavior                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| GET /health/live, /health/ready             | Public process/dependency diagnostics                                                                           |
| GET /api/v1/platform, /auth/config          | Public capability/auth mode metadata                                                                            |
| POST /api/v1/auth/login                     | Local email/password, rate-limited, HttpOnly cookie; no tenant chooser                                          |
| GET /api/v1/auth/me                         | Current authenticated tenant/role                                                                               |
| POST /api/v1/auth/logout                    | Clear cookie                                                                                                    |
| GET /api/v1/policies                        | Tenant-wide list, up to 100                                                                                     |
| POST /api/v1/policies                       | ADMIN: name, provider                                                                                           |
| POST /api/v1/documents/upload-url           | ADMIN: reserve version with an Idempotency-Key UUID                                                             |
| PUT /api/v1/documents/uploads/:versionId    | ADMIN and reservation owner: authenticated binary upload                                                        |
| POST /api/v1/documents/complete-upload      | ADMIN and owner: transactionally commit UPLOADED and durable job; duplicate completion returns the same job     |
| GET /api/v1/documents                       | Tenant version list, limit (default 50/max 100), offset (max 10000), optional status                            |
| GET /api/v1/documents/:id                   | Authorized document plus version metadata                                                                       |
| GET /api/v1/documents/:id/status            | Latest version or explicit versionId query parameter                                                            |
| GET /api/v1/documents/:id/source/:versionId | Download only a clean indexed authorized version; attachment, audit event, no permanent public URL              |
| POST /api/v1/documents/:id/reindex          | ADMIN: versionId + Idempotency-Key; new staged generation                                                       |
| POST /api/v1/admin/documents/:id/retry      | Same idempotent operation for failed work                                                                       |
| POST /api/v1/documents/:id/archive          | ADMIN: versionId; cancel active jobs, retain source and historical chunks                                       |
| POST /api/v1/search                         | question, policyId, asOfDate?, versionIds?, mode?, rerank?, candidateK?, topK?; authorized source excerpts only |
| GET /api/v1/conversations/:id               | Strict owner, tenant, and expiry check; encrypted chat messages returned                                        |

`upload-url` returns a **local authenticated PUT endpoint**, not a presigned S3 URL. Reservations expire after 15 minutes. Upload metadata includes policyId, optional documentId, documentType, fileName, MIME type, sizeBytes, SHA-256, effectiveFrom, optional effectiveTo and supersedesId. The server assigns version numbers. Metadata and source bytes are immutable after reservation. Invalid content is rejected; corrected files require a new reservation/key.

Upload is bounded by actual byte size as well as declared Content-Length. Completion does not trust a client-reported object identifier: it requires the authenticated upload receipt. The database state and queue job commit together. Scanning and parsing happen asynchronously. Failed/quarantined files never become searchable.

A reindex Idempotency-Key can be replayed after completion without creating another generation. If a different reindex request is already active, the API returns INGESTION_ALREADY_RUNNING (409). Archived and unreceived versions cannot be retried, and quarantined versions are rejected. Operators should inspect the safe failure code and correct the cause before retrying.

Version selection uses effective dates and explicit supersession. Two unresolved candidate versions of one document yield VERSION_CLARIFICATION_REQUIRED (409). If a newer applicable version is not indexed, APPLICABLE_VERSION_NOT_INDEXED (409) prevents fallback to obsolete terms. Explicit version IDs enable deliberate historical retrieval within the authorized policy. Model/profile mismatches require reindexing.

Search matches contain chunkId, text, documentId, documentName, versionId, version, source metadata (pageNumber/sectionTitle/sheetName/rowStart/rowEnd/kind), and cosine distance. Distance is a retrieval ranking value, **not a confidence score**. No generated insurance answer or citation-grounding claim is made in Phase 2.

Chat, streaming and owner-only history reads are implemented. Feedback, analytics, history management/deletion operations, automatic retention deletion, and S3/SQS upload contracts remain later work. No DELETE route physically removes production documents. Use the explicit archive operation in the local MVP.

## Phase 3 chat

The chat endpoints are now implemented. See [Phase 3 API and streaming semantics](phase-3.md#api) and the generated [OpenAPI contract](openapi.json). Conversation scope is fixed at creation; messages require an idempotency key. Strict owner/expiry RLS applies in addition to tenant filtering. Responses contain verified source quotations and server-built citations, or explicit insufficient-evidence/conflict outcomes. The default generator is local Ollama; no cloud credentials are required.

## Phase 4 additions

`POST /conversations` accepts optional `comparisonPolicyId` alongside `policyId` and `asOfDate`. The policies must be distinct and tenant-authorized; comparison scopes cannot include `versionIds`. Responses include both policy IDs. List items include both policy names. Chat responses add `usedHistory` and, for comparisons, per-policy outcomes in `comparison` plus policy-labelled, globally numbered citations. Both evidence sets are validated before one atomic result is saved. Encrypted memory remains private to the service.

`POST /search` accepts `mode=hybrid|semantic|keyword`, `rerank` and `candidateK` (1–40, bounded to at least topK). Defaults are hybrid retrieval with local heuristic reranking. Matches add policy identity and branch/fusion/rerank ranking signals. Diagnostics include candidate counts and `keywordReady`. These scores are not calibrated confidence. See [Phase 4 implementation and evaluation limits](phase-4.md).


## Phase 5 security

`POST /api/v1/auth/logout` revokes the presented session token at this API before clearing its cookie. Reuse via cookie or bearer returns `401 TOKEN_REVOKED`. Other sessions remain valid. Cognito provider refresh tokens are not revoked here.

`GET /api/v1/admin/audit-logs` is ADMIN-only and tenant-filtered. Query `limit` (1–100, default 50) and optional exclusive `before` ISO timestamp bound the result. Items contain only `id`, `actor_id`, `action`, `resource_id`, `request_id`, `created_at`. Requests record `audit.viewed`; authenticated denials record `access.denied` without private content. Runtime cannot alter/delete audit entries.

Chat validates current authentication again before generated-answer persistence and replay publication. Accounts disabled during generation receive `ACCESS_DENIED`; changed identity/role receives `ACCESS_CHANGED`. External AI providers/endpoints require `ALLOW_EXTERNAL_AI=true`; defaults remain local. See [Phase 5](phase-5.md).
