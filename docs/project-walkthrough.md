# AI Advisor Assistant: project walkthrough

This explanation follows the TypeScript implementation and migrations inspected on 2026-10-10. It does not claim the services were running or benchmarked during this inspection. `docs/architecture.md` is an explicitly superseded Phase 1 plan: several descriptions there are not the current behavior. README describes Docker/OpenAI as the current profile; the base configuration defaults to Ollama. Secrets were not read.

Open `system-design.drawio` in draw.io/diagrams.net. Its four pages cover the overview, ingestion, query pipeline and data relationships. Boxes within the API and worker represent library functions, not additional deployed microservices.

## 1. Project structure

This is an npm-workspaces TypeScript monorepo with three application entry points and shared backend packages.

| Location | What it does and where it is used |
|---|---|
| `apps/web/src/main.tsx` | React entry point, sign-in and application shell. |
| `apps/web/src/DocumentLibrary.tsx` | Policy/document management, upload and indexing status, original-document access. |
| `apps/web/src/AdvisorChat.tsx` | Conversation scope, as-of date/version choice, comparison, questions, progress and citations. |
| `apps/api/src/server.ts` | Composes configuration, authentication, storage, embedder, generator and ChatService; starts Express. |
| `apps/api/src/app.ts` | Security headers, request IDs, tracing, health endpoints, API mounting and errors. |
| `apps/api/src/routes/ingestion.ts` | Auth/session routes, policy/document operations, admin upload/retry/archive, search, source download; mounts chat routes. |
| `apps/api/src/routes/chat.ts` | Conversation endpoints, rate/capacity controls, cancellation and Server-Sent Events. |
| `apps/worker/src/worker.ts` | Independent ingestion process. Polls/claims jobs, dispatches optional SQS notifications, invokes processing and exposes health. One job runs at a time per process. |
| `packages/ingestion` | Runtime wiring, encrypted storage, S3 adapter, ingestion pipeline, version-aware search and notification dispatch. Retrieval lives here despite its use by chat. |
| `packages/document-processing` | Byte/type validation, Office archive checks, ClamAV scanning, isolated parsing, OCR and token chunking. |
| `packages/ai` | Provider embedding adapters, encrypted Redis query-vector cache, keyword normalization/blind indexing, RRF, deterministic reranker and evaluation metrics. |
| `packages/chat` | Chat orchestration/persistence, bounded question memory, LangGraph workflow, provider generation, layout/excerpt recovery and quotation validation. |
| `packages/database` | Database connections, migrations, seed data and transaction-local tenant context. SQL defines constraints, RLS, claim functions and indexes. |
| `packages/security` | Local/Cognito authentication, role checks, password hashing, AES-GCM encryption and keyed fingerprints. |
| `packages/shared` | Validated configuration, application errors, readiness and graceful shutdown. |
| `packages/observability` | Pino logs, OpenTelemetry tracing, Prometheus metrics and provider token usage. |
| `docker/`, Compose files | Local/container services and optional OpenAI, LocalStack and monitoring overlays. |
| `infra/aws`, `infra/localstack` | Infrastructure definitions; AWS deployment remains deferred according to README. |
| `scripts`, `tests`, `docs` | Setup, migrations, launchers, smoke/performance tools, unit/integration/e2e checks and design/demo records. |
| `dist`, `apps/web/dist` | Generated backend JavaScript and built frontend assets. Change source, then rebuild. |

Durable data flows from tenants to policies, documents, document_versions and document_chunks. A document version identifies the original terms; an indexing generation identifies a particular derived index of those terms. Conversations have an owner and a policy/date scope, with optional comparison scope.

PostgreSQL holds metadata, jobs, chunks, vectors, ingestion embedding reuse, history and audit. Redis holds only query embeddings in the implemented cache. Original documents live in encrypted local storage or S3. LocalStack simulates S3/SQS and adds an encrypted local recovery mirror. The API is the HTTP boundary; parsers, retrieval, LangGraph and generation adapters are shared code inside API/worker processes.

## 2. Ingestion, step by step

### Upload and durable reservation

1. An administrator calls `POST /api/v1/documents/upload-url` with policy/document metadata, filename, MIME type, size, SHA-256, effective dates and optional superseded version. An idempotency key prevents accidental duplicate reservations. A new document/version is reserved as `PENDING_UPLOAD`.
2. The returned URL is an API upload route, not a direct presigned S3 URL. `PUT /api/v1/documents/uploads/:versionId` receives the bytes through Express. It checks administrator role, upload owner, expiry, MIME, size and SHA-256. The supported formats are PDF, DOCX, XLSX and UTF-8 CSV, with a 25 MiB upload cap.
3. File signatures and Office ZIP contents are checked. PDF checks reject selected active/encrypted/embedded content; Office checks bound entry counts, expanded size and compression ratio, and reject unsafe archive paths/content. These are layered checks, not a guarantee that every possible malicious file is detected.
4. The storage adapter encrypts original bytes using AES-256-GCM with object-context binding. S3 receives application ciphertext and also uses server-side encryption. Source objects are immutable.
5. `POST /api/v1/documents/complete-upload` records a durable ingestion job with a fresh generation ID, changes the version to `UPLOADED`, and returns HTTP 202. A database trigger inserts an `ingestion_notifications` row in the same transaction as the job.

### Worker execution and recovery

The worker invokes `claim_ingestion_job()`. PostgreSQL uses `FOR UPDATE SKIP LOCKED` to let multiple worker processes claim different jobs without waiting on one another. A claim increments attempts and issues a random lease token with a 90-second expiry. A heartbeat every 20 seconds renews it. Every batch/publication checks that the token still owns an unexpired lease: an old crashed or delayed worker cannot overwrite its replacement's work.

In the SQS profile, the worker also claims and publishes durable notification rows, retries failed publication, and consumes SQS messages. The message is only a hint; it does not select/authorize the job or own its lease. The worker continues polling PostgreSQL. Redis is not the ingestion queue.

The worker reads/decrypts the original, verifies its stored size/hash again, scans it with ClamAV, repeats byte validation and marks the scan `CLEAN`. It parses the document in a Node worker thread with a 256 MiB old-generation heap limit and a five-minute timeout. That is process-resource isolation for parsing, not a full operating-system security sandbox; Poppler/Tesseract run as subprocesses with their own deadlines.

### Extraction

| Format | Actual extraction |
|---|---|
| PDF | `pdfinfo` bounds the file to 100 pages. `pdftotext -layout` extracts each page independently and retains page number. A page with fewer than 30 extracted characters is rendered to PNG with Poppler and OCRed by English Tesseract. |
| DOCX | Mammoth produces HTML with external-file access disabled. Cheerio walks headings, paragraphs and tables. The latest heading becomes section metadata; table rows repeat column headers. |
| XLSX | ExcelJS emits each populated data row as `Header: value` fields. It retains worksheet and row number. Formula cached results are used; formulas are not recalculated. Missing cached values are labelled. |
| CSV | `csv-parse` reads strict UTF-8 records, uses the first row as headers and emits header-labelled data rows with row positions. |

Text is NFC-normalized, line endings normalized, NULs removed, trimmed and empty sections discarded. Limits also bound extracted text, sheets, rows and columns. This is not a general layout-aware PDF table parser: PDF columns are repaired heuristically later in the query context path. OCR fallback based on character count may miss image-based text on a page that already contains enough selectable text.

### Chunking and indexing

`chunkSections()` uses `cl100k_base` token accounting, a default size of 650 tokens and overlap of 90. It tries to pack paragraphs within each parsed section; oversized text falls back to overlapping token windows. Overlap is about 14% of the maximum window. Sections remain separate, so short DOCX paragraphs and spreadsheet rows may be much smaller than 650 tokens. Table rows are kept intact; a table row exceeding the size cap fails with `TABLE_ROW_TOO_LARGE` rather than silently splitting it.

Each chunk receives text, SHA-256, token count and source metadata. Hash-based embedding reuse is scoped by tenant, model and dimensions in PostgreSQL. Default batches contain eight chunks, configurable up to 32; only unique cache misses in the batch are embedded.

An embedding is a numerical representation of text that allows meaning-related text to be compared by distance. It is not a summary, an answer, or a confidence score. The current adapters use:

| Provider | Default model/profile | Dimensions and retrieval preparation |
|---|---|---|
| OpenAI | `text-embedding-3-small` | 1536; document and query texts sent to the embeddings API. |
| Gemini | `gemini-embedding-001` | 768; document/query task types differ; returned reduced vectors are unit-normalized. |
| Ollama | `nomic-embed-text:v1.5` | 768; prefixes `search_document:` and `search_query:` distinguish tasks. |

The implementation validates count, dimensions, finite components and nonzero vectors. Requests have bounded retries/timeouts. Provider/model identity is stored alongside each vector. Dimensions are fixed by provider in this implementation; a different dimension setting is rejected without matching schema/profile changes. Similar dimensions alone do not make different models compatible.

For each chunk, the worker writes encrypted text, encrypted provenance, the vector, model/dimensions, token count and a blind keyword index. Keyword tokens are normalized with simple English plural handling and stop-word removal, then HMAC-fingerprinted using tenant context. PostgreSQL indexes these keyed terms as a `tsvector` with GIN. The database need not see plaintext words to match the same terms from a query.

Publication is atomic: after all batches are present and chunk count matches, the worker activates the generation, marks the version `INDEXED`, completes the job and writes audit metadata. Retrieval joins only the active generation, so a partially built generation cannot leak into answers. Reindexing can retain the previous active generation while replacement work runs. Retryable failures return the job to `PENDING` with exponential delay/jitter, up to three claimed job attempts; terminal failures become `FAILED`. Embedding request retries are separate from whole-job retries. A process crash is recovered through lease expiry/reclaim.

## 3. Query pipeline, step by step

1. **Scope and request controls.** A conversation selects policy, as-of date, optional explicit version IDs, and optionally another policy for comparison. Authentication derives server-side tenant/role membership; conversation ownership is checked. Message routes enforce 10 requests/user/minute and two simultaneous requests per API process. Questions are capped at 4000 characters and 512 tokens. The route cancels on disconnect or its four-minute deadline.
2. **Idempotent run reservation.** `ChatService.answer()` locks the conversation and inserts `chat_runs` using an idempotency key and tenant/conversation-bound question fingerprint. A completed matching request replays its encrypted response; a changed question with the same key conflicts. Only one active run per conversation is permitted. Run leases are five minutes.
3. **Follow-up rewriting.** The LangGraph workflow starts with deterministic `rewriteQuery()`. It recognizes phrases such as “what about it?” and resolves them against bounded recent question memory. Memory stores up to six questions within 400 tokens, with individual questions limited to 160 tokens. Explicit new topics replace prior context. The model does not receive the entire chat transcript; assistant answers are never factual evidence.
4. **Version applicability before embedding.** `applicableVersions()` verifies policy visibility and selects versions by effective date and supersession, or explicit IDs. Undated/ambiguous selections require clarification. A superseded version does not become current again merely because its replacement expires or is archived. Selected versions must have a clean scan and active generation. A selected unavailable version produces an error rather than silently answering from older terms.
5. **Query embedding and cache.** Compatible versions use the active embedding profile. Redis keys HMAC tenant/model/dimensions/exact question and stores encrypted query vectors, default TTL 300 seconds. Cache operations are bounded to 250 ms; failures fall through to embedding. The cache contains neither retrieval results nor generated answers. Completed chat-run replay is a separate PostgreSQL idempotency mechanism.
6. **Semantic and lexical candidates.** Semantic SQL orders authorized active chunks by pgvector cosine distance (`<=>`) and matches model plus dimensions. The keyword branch generates the same tenant-keyed tokens and an OR `tsquery`, ranks with `ts_rank_cd`, and searches across all selected versions. Default candidate count is 20 per branch, capped at 40. If all selected versions use an older model, retrieval becomes keyword-only; if only some match, hybrid retrieval combines semantic results for matching versions with keyword results across all versions.
7. **Recheck and fusion.** Versions/generations are rechecked after query embedding to detect concurrent changes. Hybrid lists are deduplicated and combined by reciprocal rank fusion: each branch contributes `1/(60 + rank)`. A chunk high in both lists receives contributions from both. Rank fusion avoids needing semantic distances and lexical scores on one common scale.
8. **Local reranking and top K.** After decrypting candidates, `lexical-cosine-v2` scores query term coverage, cosine relevance, exact numeric identifiers and numbered-heading coverage. Its weights are 0.6, 0.25, 0.15 and 0.35 respectively. Fusion score is a tie-breaker. Default top K is eight. This is a deterministic heuristic, not a cross-encoder model; its score is not calibrated confidence.
9. **Evidence construction.** `columnEvidence()` tries to restore multi-column PDF reading order. `paragraphEvidence()` separates intact blocks and keeps short headings with following prose. Excerpts are reranked again, deduplicated and checked for suspicious instruction text. Evidence receives IDs such as S1/S2 and is packed into a default 2000-token budget. An excerpt that does not fit is skipped rather than truncated. The budget covers evidence accounting, not the complete model input with instructions/question.
10. **Pre-generation guards.** No evidence, a suspicious question or missing lexical topic support skips model generation and leads to abstention. A uniquely matching complete table can be quoted directly. These lexical and layout heuristics are conservative domain-specific checks, not complete semantic or injection classifiers.
11. **Structured generation.** Provider adapters receive the resolved question and source-ID/text evidence. The model returns JSON containing status `ANSWER`, `INSUFFICIENT_EVIDENCE` or `CONFLICT`, and at most four sourceId/quote pairs. OpenAI/Ollama streaming is buffered internally; Gemini uses a nonstreaming JSON response. No model tools or open-ended agent loop are present. The graph is a fixed rewrite → retrieve → generate → validate sequence.
12. **Quotation validation and conflict handling.** JSON must pass the strict schema. Every quote must refer to supplied evidence and match a contiguous passage after whitespace normalization, with narrowly allowed capitalization/article repair that restores source text. Sentence boundaries prevent selective removal of qualifications; paragraph excerpts may expand to their whole paragraph; tables must be quoted in full. Topic support is checked again. Invalid output abstains. A narrow deterministic rule can override the draft when identical waiting-period clauses have different integers with the same units in separate chunks. General conflicts depend on the model's proposed status and validator checks; they are not exhaustively proven.
13. **Final reauthorization and commit.** The session/identity is checked again. In a transaction, the service verifies current applicable versions, generation snapshot and all evidence chunks, including uncited evidence that could affect conflict/abstention. Concurrent archive/reindex/supersession produces a retry error. It stores encrypted user/assistant messages and encrypted replay response, updates bounded question memory and writes audit metadata atomically.
14. **Delivery.** SSE streams status events and heartbeats while processing. Only after validation and persistence does it emit answer paragraphs and the final structured response. Citations retain original document/version identity plus page/section/sheet/row metadata and an authenticated source URL. The server constructs the answer from verified quotations; it does not publish a free-form model essay.

Comparison executes the same workflow once per policy sequentially, then combines the separately validated quote answers and renumbers citations. It does not ask one model to infer comparative advice from a mixed corpus.

## 4. Techniques, tradeoffs and alternatives

These alternatives are design options, not features currently implemented or claims that one would improve this corpus without evaluation.

| Current choice | Benefit | Tradeoff | Alternative and when to evaluate it |
|---|---|---|---|
| Asynchronous API/worker ingestion | Upload response is independent of OCR/model latency; durable retry | Polling delay, job state and lease complexity | Synchronous processing for tiny trusted documents; managed queue/event workers for more throughput. Preserve atomic publication and idempotency. |
| API-proxied encrypted upload | Central validation and application encryption | Buffers up to 25 MiB per upload; storage I/O occurs during a DB transaction | Direct S3 presigned uploads plus quarantine scanning and authenticated server-side completion when upload throughput becomes a bottleneck. |
| Poppler + local English OCR | Simple/local text extraction and retained page identity | Weak complex-table/layout handling; mixed pages may evade OCR fallback | Layout-aware document extraction/OCR, language detection, better reading-order and table reconstruction; compare on the actual policy PDFs. |
| 650/90 token windows within sections | Bounded model input and some boundary context | Can cut long clauses; repeated overlap costs storage/embedding; many small sections remain small | Heading/recursive splitting, semantic boundaries, parent-child retrieval or neighbor expansion to retain conditions. |
| Dense embeddings | Retrieve semantic relationships beyond identical words | Model cost/latency, profile incompatibility, imperfect exact identifier/number matching | Sparse lexical retrieval alone for exact text tasks; learned sparse vectors, multi-vector retrieval or hybrid variants for more difficult corpora. |
| 768/1536 vector dimensions | Fixed compatible schema/profiles | Larger vectors increase storage/memory; dimensions alone do not establish quality | Benchmark another compatible profile; migrate, reembed in new generations and cut over deliberately. 1536 float components are roughly 6 KiB/vector vs 3 KiB for 768, before database/index overhead. |
| PostgreSQL + pgvector | RLS, metadata and vectors in one consistency domain | DB resources shared by chat, ingestion and search | A dedicated vector service when measured scale requires it; reproduce tenant filters, version consistency and deletion semantics carefully. |
| Blind keyword index | Avoid storing plaintext words in the lexical index | Frequency/position/equality leakage remains; basic stemming, no synonym understanding | Plaintext PostgreSQL full-text/BM25-style search in a trusted boundary for richer language analysis, or learned sparse retrieval after privacy review. |
| Hybrid RRF | Balances meaning and exact terms without score calibration | More candidate work; reranking can override fused order | Weighted fusion, learned ranking or semantic-only retrieval, compared using labelled questions. |
| Deterministic reranker | No extra model call/download, cheap and reproducible | Misses nuanced relevance, negatives and paraphrases | A cross-encoder scores query and passage jointly; benchmark quality against additional inference latency and compute. |
| 2000-token evidence budget | Caps input cost and narrows source exposure | May drop crucial conditions or make broad overviews incomplete | Larger evidence budget, per-topic coverage/diversity, hierarchical retrieval or staged summarization with preserved citations. |
| Exact quoted answers | Traceable source wording; avoids generated paraphrase claims | Less conversational; source correctness/OCR accuracy and relevance are still not guaranteed | Evidence-grounded synthesis with independent claim-level verification if readable summaries become a requirement. |
| Bounded question-only memory | Limits drift and stops previous answers becoming evidence | Rule-based follow-ups may miss complex references | LLM query rewriting or entity/topic tracking, while keeping factual evidence retrieval separate. |
| OpenAI/Gemini remote vs Ollama local | Configurable managed inference or local processing | Remote text transfer, cost and network dependence vs local compute/model constraints | Benchmark providers separately for embedding retrieval quality, citation validity, latency and throughput; do not assume a quality winner from size alone. |

pgvector supports exact search, HNSW and IVFFlat. HNSW trades more build time/memory for a strong speed/recall tradeoff; IVFFlat needs suitable data/partition training and tuning. The schema defines dimension-specific HNSW expression indexes. **Important code-review observation:** those indexes are on `embedding::vector(768)` / `embedding::vector(1536)`, while retrieval orders by uncast `embedding <=> ...`. Do not assume the existing SQL uses those ANN indexes. Confirm with `EXPLAIN (ANALYZE, BUFFERS)` on a representative corpus and use a matching indexed expression if appropriate. This was not benchmarked here.

Tenant filtering can also change ANN recall/performance; test selective scopes rather than only global search. Dedicated vector databases will not automatically solve version authorization or grounding.

## 5. Practical improvements to evaluate first

1. Establish labelled policy questions with expected applicable version, relevant chunk/page, complete quoted conditions, conflicts and abstentions. Existing retrieval metrics include recall, precision, MRR and nDCG; complement them with citation correctness, unsupported-answer rate and end-to-end latency.
2. Inspect actual PostgreSQL query plans before changing vector infrastructure. Measure candidate recall, filtering behavior and ingestion throughput.
3. Test extraction against multi-column PDFs, tables, mixed scanned/selectable pages and noisy OCR. Exact quotation validation checks indexed extraction, not fidelity to visual original pages.
4. Compare chunk sizes/overlap, parent-child retrieval, candidate count and evidence coverage together. Retrieval can find the right document but still lose a qualifying clause during chunking/context selection.
5. Evaluate a cross-encoder only if reranking errors justify its cost. The existing reranker and topic guard are strongly lexical.
6. Reindex old profiles if semantic retrieval of the full corpus is required after a provider change. Keyword fallback preserves access but not equivalent semantic behavior.

Security boundaries are tenant isolation, role checks and conversation ownership. Current advisors see all policies in their tenant; per-policy ACLs are not implemented. AES-GCM protects text payloads, but vectors and blind keyword patterns are database-readable. Do not describe this as fully encrypted semantic search. LocalStack is local service emulation; infrastructure definitions alone do not establish production readiness.

Primary background references: [pgvector documentation](https://github.com/pgvector/pgvector) for index/search tradeoffs, and [Sentence Transformers cross-encoder documentation](https://www.sbert.net/examples/cross_encoder/applications/README.html) for the alternative reranking architecture. Project behavior above is derived from repository source, not those external references.
