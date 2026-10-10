# Phase 7 validation

Validated locally on 9 October 2026. **76 unit tests and 41 integration tests passed (117 total)**, alongside lint, TypeScript checks, builds and zero reported runtime dependency vulnerabilities. The previously documented moderate development dependency findings remain. Lockfile artifact-version metadata was repaired without changing the pinned root dependencies.

The API, worker and Vite now run as native processes on this Mac. Their Docker containers were removed; definitions and dependency volumes remain. Forty-two encrypted source files were copied and authenticated before switching storage. Native ingestion passed PDF, DOCX, XLSX, CSV and a scanned PDF using real English OCR, with versioning/idempotency/isolation and malware checks in [ingestion evidence](phase-7-ingestion.json). A unique fixture also required fresh Ollama document embeddings and successful pgvector retrieval/source recovery through the host application: [host evidence](phase-7-host-demo.json).

Thirty authenticated retrieval requests at concurrency two measured **35.2 ms warm P95**, with **585.2 ms** for the uncached request. This covers one synthetic policy and a warm tenant-scoped encrypted query cache. It does not validate production corpus size, 1,000 users, answer P95 or availability targets. See [performance measurements](phase-7-performance.json).

A real local-model PDF question returned the cited 30-day waiting-period answer in **18.6 seconds**, with first SSE progress at **17 ms**. This is one synthetic question, not a P95 benchmark; it does not meet a five-second answer target in that sample. CSV and an unpunctuated-heading PDF fixture abstained in earlier checks, documenting conservative quote-selection/boundary limits rather than claiming universal answer quality. See [chat measurement](phase-7-chat.json).

A real distributed trace joins API upload completion, SQS publication, source/scan/parse and native worker embedding stages. Prometheus scrapes both native processes; Grafana is provisioned; all six alert rules validate. An idle-worker stop triggered a real Prometheus alert delivered to local Alertmanager, and worker/scrape recovery passed. No external notifications were sent. See [trace/dashboard evidence](phase-7-observability.json) and [alert drill](phase-7-alert.json). Final traces omit automatic host identity and command-line resource metadata. A trace lookup initially OOM-killed the 256 MiB Tempo container; bounded query concurrency and a 512 MiB limit fixed the repeated lookup. This is local validation rather than a production sizing guarantee.

Details and startup commands are in [Phase 7](phase-7.md). Monitoring/dependencies remain Docker services; serving application processes do not use their Docker images. AWS production deployment remains deferred. Earlier sections below preserve milestone history.

---

# Phase 6 validation

Validated locally on 9 October 2026. **71 unit tests and 40 integration tests passed (111 total)**, with lint, TypeScript checks, builds and zero reported runtime dependency vulnerabilities. Existing security smoke checks passed against the rebuilt containers. The full development dependency audit retains the previously documented moderate findings.

The LocalStack S3/SQS demonstration passed encrypted authenticated uploads, immutable conditional-write retries, bucket versioning/public-access/encryption settings, transactional outbox publication, real ClamAV parsing/Ollama embeddings/pgvector indexing, source recovery and poison-message DLQ redrive. See [emulator evidence](phase-6-demo.json).

An emulator restart exposed absent S3 state restoration in the pinned community image. The profile now keeps an encrypted filesystem recovery copy of new uploads and uses an initialization-aware health check. Authenticated recovery of identical source bytes after a real emulator reset passed. Production S3 has no local fallback.

The actual Docker API, worker and Nginx also passed a separate upload/index/retrieve/download flow. All eight long-running Compose services are healthy. See [container evidence](phase-6-container-demo.json). These synthetic checks do not validate model answer quality or performance SLOs.

Both Terraform roots validate. Two AWS mock-provider tests verify infrastructure security settings and the production approval gate; no AWS API calls or deployment occurred. The LocalStack root provisions a separate validation bucket and queue pair. Linux/Mac signed provider checksums are locked for reproducible CI. CI workflows are configured but have not run on GitHub.

LocalStack 4.12.0 is an archived pinned community image for isolated synthetic testing. Emulator API behavior does not certify AWS IAM, cryptography, durability, compliance or production readiness. Future AWS deployment remains gated and requires separate authorization and the prerequisites in [Phase 6](phase-6.md). Earlier milestone sections below record their original state and limits.

---

# Phase 5 validation

Validated locally on 8 October 2026. **60 unit tests and 37 real PostgreSQL/Redis integration tests passed (97 total)**. Lint, backend/React type checks, production builds and Docker API/proxy/health smoke checks passed. Production dependency auditing reported **zero vulnerabilities**; this does not cover the existing development-tool advisory backlog.

Security coverage includes actual locally generated RSA signatures for Cognito issuer/client/access-token/expiry/tampering checks, local cookie/bearer replay after logout, database-authoritative tenant/role resolution, disabled accounts, malformed authorization headers, ADMIN-only tenant audit reads, append-only audit privileges, user/tenant mutation denial, Unicode instruction obfuscation and external-AI opt-in. Disabling an account during generation rejects publication, saves no messages and marks the run FAILED.

The rebuilt local Docker environment passed seven API security smoke assertions: advisor audit denial, admin audit access, logout, copied cookie rejection, copied bearer rejection, another session remaining usable and advisor logout. Output is in [Phase 5 security evidence](phase-5-demo.json). No credentials or tokens are saved in the report.

All eight real local PDF-to-RAG regression cases passed: waiting-period and claims answers, missing dental benefit abstention, instruction override rejection, superseding-version answer, historical-version answer, conflicting-source response and exclusion of instruction-bearing source content. Evidence, citations and timings are preserved in [Phase 5 RAG regression](phase-5-rag-regression.json), retaining the earlier Phase 3/4 artifacts. Model-backed answers took approximately **5.1–31.0 seconds** in this synthetic run; this does not establish performance SLOs or general answer quality.

The stack remains available at [localhost:8080](http://localhost:8080). Cognito was tested with offline public JWKS fixtures, not a live user pool. Provider refresh-token revocation, hosted login/federation, LocalStack, AWS production deployment, TLS/KMS operations and formal compliance remain unvalidated. See [Phase 5 design and boundaries](phase-5.md).

---

# Phase 4 validation

Validated locally on 8 October 2026. **47 unit tests and 29 integration tests passed (76 total)**, with lint, backend/React type checks, production builds, migration/backfill checks, runtime dependency audit (zero vulnerabilities), and final Docker/API/proxy smoke checks.

The real advanced workflow passed five end-to-end cases: room-rent answer, anaphoric follow-up, missing dental benefit abstention, two-policy waiting-period comparison, and a partial claims comparison with explicit insufficient evidence for the second policy. Two PDFs and eight CSV clause rows were uploaded through ClamAV, parsing, real Ollama embeddings and pgvector. All five returned citations were independently checked against the known uploaded PDF wording and version/page provenance. See [Phase 4 demo](phase-4-demo.json).

A sixth check ran on the final rebuilt API: “Does it cover dental?” after a claims comparison abstained for both policies with zero generator input/output tokens. It proves that a new missing subject cannot borrow relevance from prior conversation wording. See [final follow-up evidence](phase-4-new-topic-demo.json). A seventh check then asked “What about its limit?” and confirmed that the new dental topic remained active, with both policies abstaining and no generation. See [third-turn evidence](phase-4-third-turn-demo.json). Both additional cases are included in subsequent `npm run test:advanced` runs.

Eight labelled retrieval queries, including two natural-language queries without clause identifiers, were evaluated in three modes:

| Mode                       | Recall@3 | Precision@3 | MRR@3 | Binary nDCG@3 |
| -------------------------- | -------- | ----------- | ----- | ------------- |
| Semantic only              | 1.0      | 0.333       | 1.0   | 1.0           |
| Hybrid RRF                 | 1.0      | 0.333       | 1.0   | 1.0           |
| Hybrid plus local reranker | 1.0      | 0.333       | 1.0   | 1.0           |

Each query has one relevant chunk and returns three, hence Precision@3 is one third even when the relevant chunk ranks first. The modes tied on this small fixture set: **no retrieval improvement was demonstrated**. This is a regression gate, not a representative quality benchmark. Larger customer-reviewed datasets, difficult paraphrases, multi-document questions and stronger reranker/model comparisons remain necessary.

All eight Phase 3 real-model regressions also passed: direct/claims answers, absent benefit, instruction override, supersession, historical date, conflict and instruction-bearing source exclusion. Current outputs are preserved separately in [chat regression evidence](phase-4-chat-regression.json); the prior Phase 3 artifact below is retained.

Model validation exposed three weaknesses in the small local model: inconsistent answer/abstention status, unrelated but source-valid answers, and addition of a leading article to an otherwise exact quote. Status instructions were clarified; conservative lexical topic checks now run before generation and after quote selection; harmless case/leading-article differences align to original whole source clauses. Changed values, negations, conditions and incomplete clauses remain rejected. A narrow deterministic check catches identical waiting-period clauses with differing integer values and the same units, without altering qualifiers. These protections can abstain on valid synonyms and do not guarantee full semantic correctness or completeness.

The advanced run took **3.2–133.3 seconds per request**, including a slow first model-backed answer. Warm Phase 3 model-backed regressions took approximately 6.8–17.7 seconds; deterministic exclusions were faster. These CPU-only, lightly loaded synthetic runs do not validate P95/concurrency/availability SLOs.

Browser verification confirmed Phase 4 controls, fixed comparison scope, saved history, separate policy terms, globally numbered PDF/page citations, and authenticated source links. See [browser preview](phase-4-preview.png). Details and run commands are in [Phase 4 architecture](phase-4.md). The stack remains local; LocalStack and AWS deployment are deferred.

---

# Phase 3 validation

Validated locally on 8 October 2026. **35 unit tests and 26 integration tests passed (61 total)**, along with lint, backend/React type checks, production builds and final container/proxy HTTP smoke checks.

The real local RAG demonstration passed all eight cases: waiting-period answer, claims-document answer, missing dental benefit abstention, instruction-override abstention, superseding-version answer, historical-version answer, conflicting-source response and exclusion of an instruction-bearing document. The test starts with a real PDF upload through ClamAV, parsing, Ollama embeddings and pgvector, then calls the real local chat model. SSE status/delta/done, saved history and cross-owner denial also passed. Full outputs, citations, token counts and timings are in [phase-3-demo.json](phase-3-demo.json).

Model-backed requests in this run took **5.5–32.9 seconds**. Deterministic refusals/exclusions took 1.2–1.5 seconds. These are small synthetic examples, not P95 latency or quality benchmarks. The first untuned cold-model attempt timed out, leading to a four-thread CPU configuration and bounded 4096-token context. An adversarial attempt originally elicited irrelevant but source-valid quotes; a deterministic override guard was added and regression-tested. These findings reinforce that quote validity alone is not semantic answer correctness.

Generation defaults to Ollama `qwen2.5:1.5b` (986 MB); embeddings remain `nomic-embed-text:v1.5`. The optional OpenAI adapter passed mocked Responses/structured-stream protocol tests; no live OpenAI request was sent. Chat source/message payloads are encrypted; no host-volume/TLS/production certification is implied. The broader local security and development dependency limitations below still apply.

Desktop browser verification also passed: create a scoped chat, submit a question, receive the 45-day answer from PDF version 2, expand its page-1 citation and display the authenticated download link. The saved [chat preview](phase-3-preview.jpg) shows the actual result.

See [Phase 3 architecture, API and limits](phase-3.md). This section records the prior milestone; Phase 4 validation is above. LocalStack and AWS deployment remain deferred.

---

# Phase 2 validation (prior milestone)

Validated locally on 8 October 2026 on Apple Silicon with Docker Compose. This validates local ingestion and evidence retrieval; it is not production certification or an answer-generation evaluation.

| Check                                               | Result                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint, backend/React TypeScript, production builds | Passed                                                                                                                                        |
| Unit tests                                          | 21 passed                                                                                                                                     |
| PostgreSQL/pgvector and Redis integration tests     | 16 passed                                                                                                                                     |
| Real end-to-end ingestion                           | PDF, DOCX, XLSX, CSV and image-only PDF all reached INDEXED                                                                                   |
| English OCR                                         | Real Poppler/Tesseract extracted the scanned PDF and retained page provenance                                                                 |
| Embeddings and indexing                             | Real Ollama embeddings, 768 dimensions, persisted in pgvector                                                                                 |
| Version selection                                   | Current retrieval excluded superseded PDF; historical retrieval retained it; archived/expired successors cannot resurrect superseded versions |
| Malware handling                                    | Real ClamAV rejected the harmless EICAR test fixture; no chunks indexed                                                                       |
| Idempotency and recovery                            | Duplicate completion, lease fencing/exhaustion, resumable embedding batches and failed reindex preservation passed                            |
| Isolation and authorization                         | Restricted database roles/RLS, tenant read/write boundaries, conversation ownership, ADVISOR write rejection and cookie origin checks passed  |
| HTTP container smoke                                | Passed for API, Nginx proxy and frontend                                                                                                      |
| Redis outage/recovery                               | Readiness became 503, liveness stayed 200, readiness recovered                                                                                |
| Runtime npm audit                                   | 0 vulnerabilities reported                                                                                                                    |

The real end-to-end run is recorded in [phase-2-demo.json](phase-2-demo.json), including version IDs, chunk counts, scan status and index timestamps. It completed at 08:24:46 UTC. The synthetic corpus remains in the local library for inspection. The EICAR fixture was archived after confirming rejection; the evidence records its failure state before archival.

The final rebuilt stack also passed HTTP smoke checks after replacing the API container. Nginx refreshes Docker service DNS to avoid retaining an obsolete container address. Desktop browser verification confirmed the indexed library and retrieved the superseding PDF's 45-day excerpt with version/page provenance; [phase-2-preview.jpg](phase-2-preview.jpg) records that view.

The model used was `nomic-embed-text:v1.5`, observed Ollama digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`. Treat model weights and embedding dimensions as an immutable profile; a model change requires reindexing. Tests exercise real database/Redis boundaries. Deterministic integration failure scenarios substitute parser, scanner and embedder boundaries; the separate end-to-end run uses the real services throughout.

## Known limits

- Phase 2 returned retrieved excerpts; Phase 3 now adds model-selected, verified quotations. Broad answer-quality evaluation remains outstanding. No LocalStack or AWS deployment occurred. Cognito and OpenAI adapters have not been tested against live cloud accounts.
- Original files and extracted text/source metadata are encrypted with AES-256-GCM. Queryable database metadata and vectors require encrypted host/Docker volumes for full at-rest coverage; host encryption could not be confirmed. Local connections use loopback HTTP. Production TLS, key management/rotation, compliance, penetration testing, restore drills and load/SLO validation remain outstanding.
- No automatic production document deletion or conversation cleanup scheduler runs. Conversation expiry is enforced on access; configurable retention defaults to 90 days.
- Worker readiness checks database/Redis and polling. Scanner/model outages surface through retryable document failures. File size is limited to 25 MiB; additional page, row, expansion, extraction and processing limits protect the local worker.
- The full development dependency audit retains 20 moderate findings in the `sprintf-js`/Jest configuration chain. These development packages are removed from runtime images. A critical `shell-quote` advisory was resolved by a pinned override. Do not claim a clean full-tree audit.
- CI is configured, but has not run on GitHub. Equivalent checks ran locally. Browser verification used the desktop viewport; no full accessibility or browser/device matrix audit has run.

## Reproduce

```sh
npm ci
npm run setup
docker compose --env-file .env.development up -d --build --wait
npm run check
npm run test:integration
npm run test:e2e
node scripts/smoke.mjs
node scripts/failure-smoke.mjs
npm audit --omit=dev --audit-level=high
```

The end-to-end test creates named synthetic policies and leaves them for inspection. The failure smoke deliberately stops/restarts this project's local Redis; run it separately from other tests and active development traffic. Services remain at http://localhost:8080. Credentials are in the generated, ignored `.env.development`; see the [README](../README.md).
