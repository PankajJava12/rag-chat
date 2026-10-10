# Phase 3 — local RAG chatbot

## Scope and decisions

Phase 3 adds authenticated chat APIs, semantic retrieval, bounded context construction, real model generation, source citations and streaming. The default is fully local: Ollama `qwen2.5:1.5b` generates structured evidence selections, and the existing Nomic embedding profile retrieves from pgvector. The optional OpenAI Responses adapter uses the installed official SDK. AWS and LocalStack remain deferred.

A conversation fixes one policy, an effective date and optional explicit historical version IDs. Membership comes from verified authentication. Advisors can search tenant policies, but even an ADMIN cannot read another user's conversation. Tenant RLS and restrictive ownership/expiry policies protect conversations, messages and runs at the database layer. Both identities are transaction-local settings; they never come from user-supplied tenant headers.

The generation contract is deliberately **extractive**: the model selects directly relevant, complete policy sentences or table rows. The server verifies each quote against its retrieved source and constructs a readable cited answer. Invalid JSON, invented source IDs, altered amounts, partial clauses or empty selections produce an insufficient-evidence response. Conflict responses require at least two cited chunks. No confidence score is fabricated. This is a bounded local alternative to unchecked model paraphrases, not a guarantee that all relevant evidence has been retrieved or that a selected quote is sufficient in its broader policy context.

History is persisted and displayed so completed answers survive reloads/disconnects. History is **not** inserted into model context; standalone questions operate within the fixed policy scope. Query rewriting, summarization, hybrid search, reranking and cross-policy comparison belong to Phase 4.

## Request flow

1. Verify authentication, allowed Origin for cookie writes, ownership, expiry and request schema.
2. Reserve an idempotent run under a conversation row lock. Enforce one active run per chat; recover expired runs after a five-minute lease. The request fingerprint is an HMAC; questions are not stored as guessable plaintext hashes.
3. Resolve authorized effective versions before question embedding. Retrieve semantic matches from the existing tenant-filtered index.
4. Select whole chunks within the token budget; exclude obvious instruction-bearing chunks and abstain on obvious instruction-override questions. Never cut a clause to fit. Send only the question and selected evidence to the configured model.
5. Consume provider streaming frames into a bounded internal buffer. Verify completion, schema, exact quotes, source IDs and sentence boundaries.
6. Recheck the entire applicable version/generation snapshot after generation, under database locks. A new applicable version, archival or reindex during generation prevents publication.
7. Atomically persist the encrypted user message, encrypted final answer/citations, completed run and audit event. No partial assistant answer is persisted.
8. Stream validated answer paragraphs and the final structured response. A dropped connection can recover the saved answer by replaying the same idempotency key or reopening history.

The UI renders all content as plain React text; no model HTML, executable Markdown, tools, remote URLs or source URLs supplied by a model are accepted. Citation download links are built from verified database IDs and authenticate through the existing document-source endpoint. A later archived source can remain quoted in historical chat, but its download may no longer be available; old answers are not recomputed automatically.

## API

All paths use `/api/v1`. Existing session cookies or verified bearer tokens are required.

| Method | Path                          | Purpose                                                         |
| ------ | ----------------------------- | --------------------------------------------------------------- |
| GET    | `/conversations`              | Up to 50 owned, unexpired chats, most recent first              |
| POST   | `/conversations`              | Create with `policyId`, `asOfDate`, optional `versionIds`       |
| GET    | `/conversations/:id`          | Owner-only scope and up to 200 decrypted messages               |
| POST   | `/conversations/:id/messages` | Submit `{ "question": "..." }`; UUID `Idempotency-Key` required |

The message endpoint returns JSON by default. With `Accept: text/event-stream`, it emits:

```text
event: status
data: {"stage":"retrieving"}

event: status
data: {"stage":"generating"}

event: heartbeat
data: {}

event: status
data: {"stage":"validating"}

event: delta
data: {"text":"According to the policy documents:\n\n"}

event: done
data: {"id":"...","conversationId":"...","answer":"...","citations":[],"insufficientEvidence":false,"conflict":false,"grounding":"verified_quotes","asOfDate":"2026-10-08","model":"ollama:qwen2.5:1.5b","processingTimeMs":1234,"tokenUsage":{"inputTokens":500,"outputTokens":70}}
```

This illustrates event shape, not a real answer. Once SSE headers are sent, failures use an `error` event containing a safe code and request ID; HTTP status cannot then be changed. No `done` event means the client must not treat the stream as a completed answer. Authentication/schema failures before the stream use ordinary HTTP error responses. A failed idempotency key is not reused for new inference; explicitly retry with a fresh key. A completed key returns the same saved result, even if the policy has subsequently changed.

Raw provider token streaming is intentionally not displayed: validation happens before text is released. There are no artificial typing delays. Progress/heartbeats remain responsive during CPU generation, and browser cancellation aborts embedding/generation. Disconnects after the commit may still leave a complete saved turn.

See [OpenAPI](openapi.json) for routes and input contracts.

## Configuration and operations

| Variable                 | Default        | Meaning                                                   |
| ------------------------ | -------------- | --------------------------------------------------------- |
| `CHAT_PROVIDER`          | `ollama`       | `openai` is explicitly opt-in                             |
| `OLLAMA_CHAT_MODEL`      | `qwen2.5:1.5b` | Small local CPU model                                     |
| `OPENAI_MODEL`           | `gpt-4.1`      | Configurable model supporting Responses structured output |
| `CHAT_CONTEXT_TOKENS`    | `2000`         | Whole retrieved-chunk budget, at most 2000                |
| `CHAT_TOP_K`             | `8`            | Semantic candidates, 1–10                                 |
| `CHAT_MAX_OUTPUT_TOKENS` | `768`          | Structured model output, at most 1024                     |
| `CHAT_TIMEOUT_MS`        | `180000`       | Generation deadline including one bounded retry           |

Question length is at most 4000 characters and 512 cl100k tokens. Token counts for context are estimates for local Qwen; the context window is 4096 with conservative headroom. Provider-reported usage is stored separately. Ollama uses four threads and batch size 128; Compose assigns four CPU cores, permits two loaded models and caps Ollama at 2500 MiB. An 8 GiB Docker allocation is recommended for comfortable operation with ClamAV and ingestion. First startup pulls the models; subsequent startups reuse the volume.

Per API process: two concurrent chat requests and ten questions/minute/account, plus the existing general API limiter. The database enforces one active request per conversation across processes. Distributed tenant quotas are future work. There is a 240-second overall request deadline and a five-minute persisted run lease. HTTP request body limits remain in force. The chat lifetime follows `tenants.conversation_retention_days` (default 90); no automatic physical deletion is enabled. One conversation is limited to 100 completed turns.

Structured logs record IDs, duration, token counts, citation/chunk counts, evidence status and safe errors, never question text, source passages, model responses or provider error bodies. Audit events include chat start/completion/failure and conversation creation. Base readiness checks database and Redis; model failure is represented in the chat response rather than taking ingestion or the library offline. Service readiness does not assert model readiness or answer quality.

Messages, citations and run replay payloads are AES-256-GCM encrypted with tenant/message-specific associated data. Queryable metadata (timestamps, policy IDs, token counters) still relies on encrypted host volumes for full at-rest coverage. Existing local-only TLS/key-management/compliance limitations remain.

## Validation

Run `npm run check`, `npm run test:integration`, `npm run test:chat`, then `node scripts/smoke.mjs`. Unit tests cover context budgets, instruction-bearing chunks, complete quote boundaries, fabricated citations, table preservation, conflict requirements, streaming frame parsing, truncation, cancellation and the optional OpenAI protocol. Integration tests use real PostgreSQL RLS and test ownership, expiry, encryption, idempotency, failed/cancelled runs, concurrent requests, stale lease recovery, cookie-origin checks and archival during generation. Deterministic integration tests replace the model boundary; `test:chat` uses the real local generator and complete upload/indexing path.

The completed real-model demonstration passed all eight cases; actual outputs and timings are recorded in [phase-3-demo.json](phase-3-demo.json). The observed chat model digest was `65ec06548149b04c096a120e4a6da9d4017ea809c91734ea5631e89f96ddc57b`. Model-backed requests took 5.5–32.9 seconds in this synthetic run; this is not a performance guarantee. Desktop browser submission and citation expansion also passed; see [the preview](phase-3-preview.jpg). Synthetic fixtures remain for inspection. No real customer documents are needed.

Remaining limitations: small local models can select irrelevant passages, miss conflicts or abstain unnecessarily; exact quote checks do not prove relevance or policy completeness. Injection detection is defense in depth, not comprehensive. No production load test, broad RAG quality benchmark, penetration test, compliance certification, live OpenAI/Cognito test, LocalStack test or AWS deployment is claimed.

## Provider references

- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs): official Responses schema contract, used by the optional adapter with `store:false`.
- [Ollama chat API](https://docs.ollama.com/api/chat): streaming chat frames, structured format and usage fields.
- [Qwen 2.5 model family](https://ollama.com/library/qwen2.5): local model distribution; model choice here prioritizes the available CPU/memory budget and remains provisional pending a broader evaluation.
