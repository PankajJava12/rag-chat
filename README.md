# AI Advisor Assistant

A tenant-aware insurance policy assistant built with Node.js, React, PostgreSQL/pgvector and Redis. Upload PDF, DOCX, XLSX or UTF-8 CSV documents, index them asynchronously, and ask questions in **Advisor chat**. Answers contain verified quotations and citations to authorized, applicable document versions. The assistant abstains when it cannot verify evidence.

The project covers Phases 1–7. The current application runs in **Docker with OpenAI chat and embeddings**. The native Gemini profile remains available as an alternative. The full Docker application also supports **Ollama** with the base definitions. AWS production deployment remains deferred; LocalStack provides local S3/SQS validation. See [phase coverage](#implementation-phases) for implemented features and remaining boundaries.

## Project wiki

Start at [wiki/index.md](wiki/index.md) for the maintained project overview, architecture, ingestion/retrieval flows, decisions, operations and source-linked validation history. Existing `docs/` files remain the source collection. [Wiki maintenance instructions](wiki/AGENTS.md) define how agents ingest sources, answer questions, track contradictions and keep the index/log current.

## Choose how to run

Run commands from the repository root. Use only one application mode at a time: API port 3000 and web port 8080 are shared.

| Mode                        | Application processes                         | Dependencies                                                      | AI provider                             | Web URL                                 |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Native host (current setup) | Node API/worker and Vite on your computer     | Docker PostgreSQL, Redis, ClamAV, LocalStack; optional monitoring | Gemini, or optional Ollama              | [localhost:8080](http://localhost:8080) |
| Full Docker                 | API, worker and Nginx web in containers       | Docker PostgreSQL, Redis, ClamAV and Ollama; optional LocalStack  | Ollama by default                       | [localhost:8080](http://localhost:8080) |
| Development watchers        | API/worker/frontend watchers on your computer | Docker dependencies                                               | Provider selected in `.env.development` | [localhost:5173](http://localhost:5173) |

Host files are stored in `.local/host-documents`; development watchers use `.local/documents` by default; Docker uses the `policy-files` volume. These directories do not automatically share source files. The modes can share PostgreSQL, so changing storage modes against an existing corpus requires preserving the encryption key and making its encrypted originals available in the selected storage backend. Keep the LocalStack overlay enabled for documents stored through that profile.

## Prerequisites and initial setup

- Node.js **24.x**, npm, and Docker with Compose v2 (Docker Desktop on macOS).
- For native API/worker operation: Poppler and Tesseract. On Apple Silicon macOS, install with `brew install poppler tesseract`; the host launcher checks `/opt/homebrew/bin` for these tools. Docker application images include parser tools.
- Internet access for the initial dependency/image/model downloads; Gemini also requires an API key and ongoing outbound access.
- Enough Docker memory for PostgreSQL, ClamAV, and optional Ollama/monitoring. ClamAV has a 2 GiB limit and Ollama a 2500 MiB limit. Initial antivirus readiness and model downloads can take several minutes.

```sh
npm ci
npm run setup
```

Setup creates private `.env.development` and `.env.test` files and generates database, account, signing and encryption secrets. Existing credentials are preserved. Use `LOCAL_ADMIN_EMAIL` / `LOCAL_ADMIN_PASSWORD` or the separate `LOCAL_ADVISOR_*` credentials from `.env.development`; the default admin email is `admin@advisor.local`, with a generated password. Never commit these files. [`.env.example`](.env.example) documents available settings.

## Run locally: native host with Gemini

### First-time configuration

After initial setup, edit the ignored `.env.development` file to include the following. Replace the placeholder privately; do not put an actual key in this README.

```dotenv
CHAT_PROVIDER=gemini
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=your-private-key
GEMINI_MODEL=gemini-2.5-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_DIMENSIONS=768
ALLOW_EXTERNAL_AI=true
CHAT_MAX_OUTPUT_TOKENS=2048
```

The external-AI gate explicitly enables sending resolved questions/retrieved evidence to Gemini for chat and extracted new-document text for embeddings. The current workspace is already configured. For a fresh installation, start dependencies, migrate/seed, build, and generate host configuration:

```sh
brew install poppler tesseract
docker compose --env-file .env.development --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml up -d --wait postgres redis clamav localstack
npm run db:migrate
npm run db:seed
npm run build
npm run host:prepare
npm run observability:up
npm run host:start
```

`host:prepare` generates `.env.host`, `.env.host-api` and `.env.host-worker` from `.env.development`, selects LocalStack storage/queue and enables caching/telemetry. It copies and authenticates existing encrypted sources from `.local/documents` and `.local/container-documents` into `.local/host-documents`. It does not reindex documents. The restricted API/worker files omit administrative credentials; the worker also excludes the session signing key.

**Existing installations:** `host:prepare` regenerates the host environment files. Before running it again, ensure `.env.development` contains the settings and unchanged secrets you intend to preserve. For a provider change, update the source configuration, stop the host services, prepare the host configuration, then restart them.

### Restart after a reboot

Persistent Docker services use `restart: unless-stopped` and return when Docker starts if they were previously running. Explicitly stopped containers stay stopped; `migrate` and `model-init` remain one-time jobs. Docker restart policies do not repeat Compose's dependency readiness checks. Native host processes still need `host:start`.

Once configured and built, use:

```sh
docker compose --env-file .env.development --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml up -d --wait postgres redis clamav localstack
npm run observability:up
npm run host:start
npm run host:status
```

Open [http://localhost:8080](http://localhost:8080). The launcher starts detached processes and waits for readiness; it is not a macOS login service. Logs and registered PIDs are in `.local/host`.

### Stop, rebuild and diagnose

```sh
npm run host:status
npm run host:stop
npm run build
npm run host:start
```

Frontend edits reload through Vite. Backend/parser changes require a build and restart. Stop just one service with `node scripts/host.mjs stop api` or `node scripts/host.mjs stop worker`, then use `npm run host:start` to start missing processes.

```sh
tail -n 100 .local/host/api.log
tail -n 100 .local/host/worker.log
docker compose --env-file .env.development --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml ps
curl -fsS http://localhost:3000/health/ready
curl -fsS http://localhost:3001/health/ready
```

`host:stop` leaves dependency containers running. To stop those dependencies and monitoring while retaining data:

```sh
npm run host:stop
docker compose --env-file .env.development --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml down
docker compose -f docker-compose.observability.yml down
```

### Optional native Ollama profile

For fully local inference, set `CHAT_PROVIDER=ollama`, `EMBEDDING_PROVIDER=ollama`, `OLLAMA_CHAT_MODEL=qwen2.5:1.5b`, `OLLAMA_MODEL=nomic-embed-text:v1.5`, `OLLAMA_URL=http://localhost:11434`, `EMBEDDING_DIMENSIONS=768`, and `ALLOW_EXTERNAL_AI=false` in `.env.development`. Start the model server and initialize its models before preparing/restarting the host services:

```sh
docker compose --env-file .env.development up -d --wait ollama
docker compose --env-file .env.development run --rm model-init
```

CPU inference and cold model loading can be slow. The current Gemini runtime does not require Ollama. Its runtime container was removed while Docker definitions and model volumes were retained. To remove a subsequently started Ollama container without deleting its model volume:

```sh
docker compose --env-file .env.development rm --stop --force ollama
```

## Run Docker with OpenAI chat and embeddings

The OpenAI overlay keeps the base Ollama definitions intact and starts only the selected application services, so Ollama/model-init are not required. It preserves the current corpus using `.local/host-documents` as the encrypted source/recovery directory and the LocalStack S3/SQS overlay. Existing generations are not reindexed; profiles other than OpenAI continue through keyword retrieval, while new uploads use OpenAI embeddings.

The private, ignored `.env.docker-openai` file preserves existing database/account/encryption secrets and selects:

```dotenv
CHAT_PROVIDER=openai
EMBEDDING_PROVIDER=openai
OPENAI_MODEL=gpt-4.1
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
ALLOW_EXTERNAL_AI=true
OPENAI_API_KEY=
```

Set `OPENAI_API_KEY` privately in that file before starting the API/worker. Both services need the key. This profile enables sending questions/retrieved evidence and newly ingested document text to OpenAI. Do not copy a key into source control or the shell command.

Docker Compose 2.24.4 or newer is required for the overlay's `!override` entries. Install/setup steps are above. Stop the native/iTerm API, worker and web processes with Ctrl+C in their tabs before starting the Docker app (the detached host launcher does not track iTerm processes). Then run:

```sh
docker compose --env-file .env.docker-openai --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml -f docker-compose.openai.yml up -d --build --wait postgres redis clamav localstack migrate api worker web
```

Open [http://localhost:8080](http://localhost:8080). API health is [localhost:3000/health/ready](http://localhost:3000/health/ready). The OpenAI overlay publishes PostgreSQL on **localhost:5433** to avoid another local project's port 5432; within Docker it remains `postgres:5432`. ClamAV, Redis and LocalStack retain the ports in the service table below. Worker health is internal to Docker. The OpenAI overlay enables API/worker metrics on the private Docker network and exports traces to Tempo. After starting the application, start monitoring with its Docker overlay:

```sh
docker compose -f docker-compose.observability.yml -f docker-compose.observability-docker.yml up -d
```

Open [Grafana](http://localhost:3002/d/advisor-local) and [Prometheus targets](http://localhost:9090/targets). Prometheus scrapes `api:9464` and `worker:9465`; Tempo shares the application network for trace exports. Metrics ports are not published to the host by this Docker profile. The monitoring overlay requires the application's `ai-advisor-assistant_default` network, so start the application first. Use both monitoring Compose files for subsequent monitoring restarts/shutdowns; the single-file monitoring profile still targets native host processes.

Use the same three Compose files and environment for subsequent operations:

```sh
docker compose --env-file .env.docker-openai --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml -f docker-compose.openai.yml ps
docker compose --env-file .env.docker-openai --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml -f docker-compose.openai.yml logs --tail=100 api worker
docker compose --env-file .env.docker-openai --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml -f docker-compose.openai.yml down
```

After changing the API key or model configuration, rerun the startup command to recreate affected containers. Keep volumes and the encryption key; do not use `down -v`. A blank key prevents API/worker initialization. Image builds and dependency startup can run before the key is supplied; those steps alone do not mean the application is ready.

## Run the full application in Docker

The existing Compose definitions explicitly select **Ollama embeddings** and include Ollama/model initialization dependencies. They do not forward Gemini API/model settings to application containers. Changing only `.env.development` to Gemini is therefore insufficient for full Docker operation. Use the following Ollama commands with the preserved definitions; native Gemini instructions are above.

### Start the base Docker stack

After `npm ci` and `npm run setup`, stop native application processes if running. Override the chat provider for this invocation so an existing Gemini host configuration does not change the Docker chat provider:

```sh
npm run host:stop
CHAT_PROVIDER=ollama ALLOW_EXTERNAL_AI=false docker compose --env-file .env.development up -d --build --wait
```

Compose builds the API/worker/web images, starts PostgreSQL/Redis/ClamAV/Ollama, downloads missing models through `model-init`, and runs migrations and account seeding through `migrate`. Application containers start after their required dependencies are ready. There is no separate host migration/build step for this mode.

Open [http://localhost:8080](http://localhost:8080) and sign in using the generated local credentials. The base stack uses encrypted filesystem storage in `policy-files` and durable PostgreSQL jobs. Redis is a cache, not the authoritative ingestion queue.

### Start Docker with LocalStack S3/SQS

Use the overlay for local AWS service emulation:

```sh
npm run host:stop
CHAT_PROVIDER=ollama ALLOW_EXTERNAL_AI=false docker compose --env-file .env.development --env-file .env.localstack -f docker-compose.yml -f docker-compose.localstack.yml up -d --build --wait
```

This enables encrypted S3 originals and SQS notifications, while PostgreSQL remains authoritative for jobs, leases and retries. New uploads retain an encrypted filesystem recovery copy. LocalStack uses dummy local credentials and requires no AWS account. Its pinned archived community image is ephemeral: the volume does not guarantee S3/SQS state restoration after a reset. Back up PostgreSQL, source recovery files and the encryption key together. See [Phase 6](docs/phase-6.md).

### Inspect, rebuild and stop Docker

For the base stack:

```sh
docker compose --env-file .env.development ps
docker compose --env-file .env.development logs --tail=100 api worker
docker compose --env-file .env.development logs --tail=50 migrate model-init clamav
CHAT_PROVIDER=ollama ALLOW_EXTERNAL_AI=false docker compose --env-file .env.development up -d --build --wait
docker compose --env-file .env.development down
```

When using LocalStack, include `-f docker-compose.yml -f docker-compose.localstack.yml` in each Compose command, including restart and shutdown. Reuse the same environment/secrets and volumes. `down` retains named volumes; **`down -v` deletes them**. Do not use it for a corpus you intend to keep.

The base observability Compose stack scrapes **native** API/worker metrics via `host.docker.internal`. The OpenAI application and monitoring overlays above enable container telemetry; the preserved base Ollama application profile does not enable it automatically.

## Run local development watchers

This profile uses `.env.development`, port 5173, and `.local/documents` by default. Set `BIND_HOST=127.0.0.1` in `.env.development` to keep API/worker listeners on loopback. Use it in an appropriate development storage profile; do not switch the current corpus to it without making its encrypted sources available.

```sh
npm run host:stop
docker compose --env-file .env.development stop api worker web
docker compose --env-file .env.development up -d --wait postgres redis clamav
npm run db:migrate
npm run db:seed
npm run build
npm run dev
```

For Ollama, also start `ollama` and run `model-init` as described above. For Gemini, configure its private key and the external-AI gate before starting. If you configure LocalStack storage/queue, start LocalStack with its overlay as well. Open [http://localhost:5173](http://localhost:5173). Stop watchers with Ctrl+C. Parser threads use compiled code, so rebuild after parser changes.

## Localhost services and URLs

Ports are bound to loopback. HTTP links are browser/API endpoints; PostgreSQL, Redis and ClamAV use their own protocols and have no browser UI. Optional services are available only when started.

| Service                   | Local address / URL                                                                          | Purpose and availability                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application web           | [http://localhost:8080](http://localhost:8080)                                               | Sign-in, document library, upload/index status and advisor chat; native host or full Docker.                                                                    |
| Development web           | [http://localhost:5173](http://localhost:5173)                                               | Frontend with development reloads; `npm run dev` only.                                                                                                          |
| API                       | [http://localhost:3000](http://localhost:3000)                                               | Authenticated document, policy and chat endpoints; the root is not a dashboard. See [API contracts](docs/api-contracts.md).                                     |
| API liveness              | [http://localhost:3000/health/live](http://localhost:3000/health/live)                       | Confirms the API process is alive.                                                                                                                              |
| API readiness             | [http://localhost:3000/health/ready](http://localhost:3000/health/ready)                     | Checks database/Redis and required migrations; returns 503 when unavailable.                                                                                    |
| Worker liveness           | [http://localhost:3001/health/live](http://localhost:3001/health/live)                       | Ingestion worker process health; native host/watchers only, port is not published by base Compose.                                                              |
| Worker readiness          | [http://localhost:3001/health/ready](http://localhost:3001/health/ready)                     | Worker dependency/progress health; native host/watchers only. Docker uses this endpoint internally.                                                             |
| PostgreSQL / pgvector     | `postgresql://localhost:5432/advisor` (OpenAI overlay: `localhost:5433`)                     | Stores accounts, policies, versions, encrypted chunks/history, vectors, durable jobs and audit events. Use a PostgreSQL client with the configured credentials. |
| Redis                     | `redis://localhost:6379`                                                                     | Bounded query-embedding cache and supporting runtime cache operations; use a Redis client.                                                                      |
| ClamAV                    | `tcp://localhost:3310`                                                                       | Malware scanning before parsing/indexing; clamd protocol, no web page.                                                                                          |
| Ollama                    | [http://localhost:11434/api/tags](http://localhost:11434/api/tags)                           | Lists local models; chat/embedding REST service, available only in the Ollama profile. Removed from the active Gemini runtime.                                  |
| LocalStack                | [http://localhost:4566/_localstack/health](http://localhost:4566/_localstack/health)         | Local S3/SQS gateway and emulator health; LocalStack overlay only.                                                                                              |
| LocalStack initialization | [http://localhost:4566/_localstack/init/ready](http://localhost:4566/_localstack/init/ready) | Confirms bootstrap bucket/queue initialization.                                                                                                                 |
| Grafana                   | [http://localhost:3002](http://localhost:3002)                                               | Monitoring UI with anonymous local Viewer access; observability stack only.                                                                                     |
| Advisor dashboard         | [http://localhost:3002/d/advisor-local](http://localhost:3002/d/advisor-local)               | API/retrieval/cache/ingestion/model usage charts.                                                                                                               |
| Prometheus                | [http://localhost:9090](http://localhost:9090)                                               | Metrics queries, scrape targets and alert rules; observability stack only.                                                                                      |
| Alertmanager              | [http://localhost:9093](http://localhost:9093)                                               | Local active-alert inspection; no email/Slack delivery configured.                                                                                              |
| Tempo                     | [http://localhost:3200/ready](http://localhost:3200/ready)                                   | Trace backend readiness; inspect application traces through Grafana.                                                                                            |
| OTLP trace receiver       | `http://localhost:4318/v1/traces`                                                            | HTTP POST ingestion endpoint for application trace exports; not a browser dashboard.                                                                            |
| API metrics               | [http://localhost:9464/metrics](http://localhost:9464/metrics)                               | Prometheus-format native API metrics; enabled by the host profile.                                                                                              |
| Worker metrics            | [http://localhost:9465/metrics](http://localhost:9465/metrics)                               | Prometheus-format native worker metrics; enabled by the host profile.                                                                                           |

For native operation, the monitoring bridge targets Docker Desktop on macOS. Linux needs an explicit host-network monitoring configuration; the provided scraper configuration is not a universal Linux setup.

## Use the application and insert documents

1. Sign in and create a policy with its insurer name.
2. Select a PDF, DOCX, XLSX or UTF-8 CSV file, up to **25 MiB**. Legacy DOC/XLS files are rejected.
3. Set the effective date. To replace a document, explicitly select the version it supersedes.
4. Click **Upload & index**. Status progresses through UPLOADED → PROCESSING → INDEXED, or FAILED with a safe failure code.
5. Open **Advisor chat**, select the policy, effective date and optionally an explicit historical version, then create a conversation.
6. Ask a question and expand citations to inspect source passages or download the original. Select **Compare with** for a two-policy comparison.
7. Reopen private saved conversations to recover completed answers after a disconnect. **Stop** cancels an in-flight request.

An ambiguous version requires clarification. An applicable unindexed newer version blocks retrieval rather than returning superseded terms. Archiving removes a version from search and retains its source file; no retention deletion scheduler is enabled.

### Insert sample PDFs without reindexing

For the Docker OpenAI profile, with all application services ready:

```sh
node --env-file=.env.docker-openai scripts/insert-samples.mjs docs/samples 2026-10-10
```

This inserts new document versions using `OPENAI_EMBEDDING_MODEL`; watch their status in the document library until every version is INDEXED. Do not change the embedding profile in place for existing vectors. The importer records `.local/openai-samples.json` to make reruns idempotent.

With the native Gemini application running:

```sh
node --env-file=.env.host scripts/insert-samples.mjs docs/samples 2026-10-09
```

Each PDF creates a separate sample policy and a new document through the authenticated upload pipeline. The optional date is a demo applicability date; use an appropriate effective date for your documents. The private `.local/gemini-samples.json` manifest prevents duplicate insertion on reruns. The importer supports Gemini, OpenAI and Ollama, using provider-specific policy labels and manifests. It never selects existing documents for reindexing. After a deliberate database reset, remove stale `.local/*-samples.json` manifests before running it again.

The Gemini sample import originally contained nine indexed PDFs and 783 chunks. On 2026-10-10 the application database was reset and all nine PDFs indexed afresh with `openai:text-embedding-3-small`: 783 chunks, each with 1536-dimensional vectors and CLEAN scan status. Normal insertion preserves existing generations; the explicitly requested full database reset removed the previous corpus. Semantic retrieval uses only matching embedding profiles; documents with other profiles use their existing keyword indexes. Mixed libraries use hybrid retrieval without reindexing. Keyword-only retrieval has less semantic recall and requires an existing keyword index.

At query time, chat separates strongly aligned PDF columns and intact numbered definitions/paragraphs from stored text. It ranks question-specific excerpts and preserves table spacing. Explicit matrix requests can quote a matching table directly, with the original chunk/page validated before publication. These fixes require no reindexing. Verified examples include Uday's escalation matrix (page 13), Click 2 Wealth's Sum Assured definition (page 9), and its three plan options (pages 10–11).

## Implementation phases

These are implemented local milestones, not a claim that every original production target is complete. Historical phase documents/reports record the provider and environment used at that milestone; current Gemini operation is described above.

| Phase                              | Scope                                                        | Delivered locally                                                                                                     | Details                                         |
| ---------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1 — Foundation                     | Monorepo, API/frontend, PostgreSQL/pgvector, Redis, Docker   | Workspace, migrations, tenant database foundations, logging and dependency health checks                              | [Architecture](docs/architecture.md)            |
| 2 — Ingestion                      | Upload, scanning, parsing/OCR, chunking, embeddings/indexing | Authenticated immutable versions, encrypted sources/chunks, leased durable jobs, atomic indexing and source retrieval | [Approved decisions](docs/phase-2-decisions.md) |
| 3 — RAG chatbot                    | Semantic retrieval, grounding, citations and streaming       | Private persisted chats, verified quotations, abstention, cancellation and publication checks                         | [Phase 3](docs/phase-3.md)                      |
| 4 — Advanced retrieval             | Hybrid search, reranking, memory, LangGraph and comparison   | RRF retrieval, local reranking, bounded extractive topic memory, two-policy comparison and evaluation                 | [Phase 4](docs/phase-4.md)                      |
| 5 — Security                       | Tenancy, RBAC, RLS, audit and adversarial defenses           | Revocable local sessions, least-privilege roles, ADMIN audit access, injection screening and external-AI gate         | [Phase 5](docs/phase-5.md)                      |
| 6 — Deployment preparation         | S3/SQS, Terraform and CI                                     | LocalStack adapters, recovery copies, transactional outbox, infrastructure templates and mocked AWS validation        | [Phase 6](docs/phase-6.md)                      |
| 7 — Optimization and observability | Caching, telemetry, measurements and operations              | Native launcher, encrypted query cache, metrics/traces, dashboards, local alerts and synthetic performance checks     | [Phase 7](docs/phase-7.md)                      |

### Phase 1 — Foundation

Node.js/TypeScript workspaces separate API, worker, web and shared packages. PostgreSQL holds durable metadata and vectors; Redis supplies cache operations. Compose provides reproducible local dependencies, liveness/readiness checks and bounded logging. Migrations use checksums, advisory locks and transactions. Foundation validation covers type/lint/unit checks, real database/cache connectivity and tenant RLS. The [original architecture](docs/architecture.md) is historical; later approved decisions supersede its assumptions and original dimension/index design.

### Phase 2 — Document ingestion

Upload reservation, binary upload and completion enforce tenant/role access, checksums and immutable document identity. ClamAV scans before bounded parsing; Poppler extracts PDF text and English Tesseract handles image-only pages. DOCX, XLSX and CSV retain paragraph/row provenance. Chunking respects headings and rows, and embeddings publish as complete atomic generations. Ninety-second leases renew every 20 seconds; fenced writes, retries and embedding batch reuse handle worker crashes. Supersession/effective-date checks prevent stale answers. [Phase 2 decisions](docs/phase-2-decisions.md) describe format limits and [ingestion evidence](docs/phase-2-demo.json) records real pipeline validation. S3/SQS integration arrived in Phase 6.

### Phase 3 — Grounded RAG chat

Authenticated chat resolves authorized versions, retrieves evidence, builds bounded context and asks the model for structured evidence selections. Exact quote/source checks precede atomic persistence and streamed publication. Missing or unverifiable evidence produces abstention; private conversation ownership, idempotency and cancellation protect turns. Original validation used real Ollama; Gemini is now also available. See [chat API/workflow](docs/phase-3.md) and [demo evidence](docs/phase-3-demo.json).

### Phase 4 — Advanced retrieval

Hybrid retrieval combines semantic candidates and tenant-keyed keyword indexes using reciprocal rank fusion, with optional local reranking. A LangGraph workflow uses bounded extractive topic memory for follow-ups and fresh retrieval for every answer. Two-policy comparison validates each policy separately and identifies incomplete evidence. Evaluation records Recall@K, precision, MRR and nDCG on synthetic queries. Current mixed-provider fallback and PDF excerpt ranking extend this retrieval path. See [design and limits](docs/phase-4.md) and [evaluation evidence](docs/phase-4-demo.json).

### Phase 5 — Security

Local logout revokes persisted sessions. ADMIN/ADVISOR membership is resolved server-side; forced tenant RLS, owner-only conversations and restricted API/worker database roles enforce access. ADMIN-only audits, authorization rechecks before publication, Unicode/instruction screening and the external-AI gate add defenses. Tests cover cross-tenant access, copied-session revocation and malicious prompts/sources. Cognito verification has offline fixtures; hosted login/federation and live user-pool integration remain unvalidated. See [security boundaries](docs/phase-5.md) and [security evidence](docs/phase-5-demo.json).

### Phase 6 — LocalStack and deployment preparation

Encrypted S3 storage and SQS notifications use a transactional database outbox. Duplicate notifications cannot select unauthorized jobs; PostgreSQL remains the durable retry/lease ledger. LocalStack reset recovery uses encrypted original-file mirrors. Terraform describes future AWS infrastructure and CI validates/builds artifacts without deploying them. Real LocalStack tests exercise storage, queues, recovery and poison-message DLQ behavior. AWS deployment, live IAM verification, restore/rollback drills and production identity integration remain outstanding. See [setup and deployment boundaries](docs/phase-6.md) and [container evidence](docs/phase-6-container-demo.json).

### Phase 7 — Native operation, optimization and observability

The host launcher separates restricted API/worker environments and preserves encrypted originals. Redis query-embedding cache entries use tenant/profile-scoped HMAC keys and encrypted values, with bounded timeouts and fresh-call fallback. OpenTelemetry spans join API/worker ingestion; Prometheus/Grafana expose latency, cache, ingestion and model usage, while Alertmanager receives local alerts. Synthetic retrieval/chat measurements and an alert drill validate local behavior. Representative customer-corpus quality, 1,000-user concurrency, availability SLOs and production telemetry access controls remain unvalidated. Token counters are not a billing ledger; Gemini cost estimation is not implemented. See [operation and measurements](docs/phase-7.md) and [host evidence](docs/phase-7-host-demo.json).

## Validation commands

For deterministic development checks, with PostgreSQL/Redis available and `.env.test` configured:

```sh
npm run check
npm run test:integration
npm audit --omit=dev --audit-level=high
```

The latest code validation after Gemini/PDF retrieval fixes passed lint, typecheck, build, **88 unit tests** and **17 chat integration tests**. Live Gemini checks verified the three sample questions described above. These results are separate from historical phase reports; this README-only update does not rerun application tests.

The original real pipeline demos use `.env.development` and create synthetic policy records. Run them against the matching Ollama application profile; the ingestion demo explicitly asserts Ollama embeddings. Do not run them blindly against the active Gemini profile or represent old reports as fresh Gemini results.

```sh
npm run test:e2e
npm run test:chat
npm run test:advanced
npm run test:security
node scripts/smoke.mjs
```

- `test:e2e`: real PDF/DOCX/XLSX/CSV/OCR ingestion, encrypted chunks, vectors, upload idempotency, supersession, EICAR rejection and ADVISOR restrictions; [Phase 2 report](docs/phase-2-demo.json).
- `test:chat`: real model answers, citations, abstention, injection rejection, versions, streaming and ownership; [Phase 3 report](docs/phase-3-demo.json).
- `test:advanced`: follow-ups, comparisons and labelled retrieval metrics; [Phase 4 report](docs/phase-4-demo.json).
- `test:security`: local session revocation and role/audit checks; [Phase 5 report](docs/phase-5-demo.json).

Integration tests mock parser/model/scanner boundaries for deterministic failure cases but use real PostgreSQL/Redis. `node scripts/failure-smoke.mjs` deliberately stops/restarts Redis; run it separately from other tests and active work. `npm run db:keywords` is a tenant-scoped keyword backfill for older documents, not routine startup; new ingestion builds keyword indexes automatically.

For the running native LocalStack/monitoring profile:

```sh
SMOKE_REPORT=docs/phase-7-host-demo.json node --env-file=.env.host scripts/localstack-smoke.mjs
npm run test:performance
node scripts/observability-smoke.mjs
```

The performance script measures a small synthetic retrieval workload, not production load. An optional `--alert-drill` on the observability smoke temporarily stops an idle worker and restores it; run only when no ingestion is active. For dedicated LocalStack/Terraform validation, follow the worker-isolation instructions in [Phase 6](docs/phase-6.md). Historical results and limitations are collected in [validation.md](docs/validation.md).

## Configuration, security and operating limits

Protect and back up `STORAGE_ENCRYPTION_KEY` with the database and encrypted source files: losing/changing it makes existing content unreadable. No key-rotation workflow or automatic retention deletion exists. Source bytes, extracted text/source metadata and chat payloads use AES-256-GCM; metadata and vectors remain queryable. Full disk-at-rest protection depends on encrypted host/Docker volumes. Local HTTP and emulated services are development boundaries, not production compliance certification.

Membership and roles come from the database after token verification, never a request-supplied tenant ID. Passwords use scrypt; sessions use signed expiring HttpOnly/SameSite cookies, origin checks and persisted revocation. Sensitive queries enforce tenant filters and forced RLS, with source/version authorization rechecked before publication. Logs contain safe IDs/codes/timings, not questions, document text or credentials. Scan failures fail closed.

New documents use the configured embedding provider/profile: Ollama Nomic uses 768 dimensions, Gemini uses normalized 768 dimensions, and the OpenAI adapter uses 1536. Existing incompatible profiles retain their generations and use keyword fallback; semantic retrieval requires matching profiles. Do not relabel stored embeddings or change weights behind an existing model identity. A deliberate future semantic migration needs an explicit new profile and controlled reindex; the current sample insertion performs no such migration.

Chat defaults are 8 retrieved chunks, 2000 context tokens, 512 question tokens/4000 characters, 768 output tokens, a 180-second generation deadline and a 240-second total request deadline. The current Gemini host uses 2048 output tokens (maximum 4096); incomplete model output is rejected. Limits permit two concurrent requests and ten questions/minute/account, with one in-flight turn per conversation. A crashed turn becomes retryable with a new key after its five-minute lease. History is bounded to 100 complete turns and the tenant's retention period.

Streaming sends progress/heartbeats immediately, then publishes only validated, persisted answer paragraphs/citations. Failed reindexing preserves the previous active generation; retry/reindex requests require idempotency keys. Quarantined documents cannot be retried into the index. API liveness remains available during dependency outages; readiness checks database/Redis, while scanner/model/storage outages surface through safe operation failures and retries.

Ollama, Gemini and OpenAI chat/embedding adapters are available in code. OpenAI embeddings have been verified live through the fresh sample ingestion. OpenAI chat has protocol tests; successful live chat generation has not been established for the currently selected model. Provider selection and external processing require explicit configuration; the base Docker embedding profile remains Ollama, while the OpenAI overlay selects OpenAI for both providers. Consult [configuration variables](.env.example), [API contracts](docs/api-contracts.md), [OpenAPI](docs/openapi.json), [project plan](docs/plan.md) and [validation history](docs/validation.md) for further details.

LocalStack now uses the licensed 2026.9.1 image. Before starting a LocalStack profile, configure your Developer Auth Token in the Git-ignored `.env.localstack` file. See [LocalStack console setup](docs/localstack-console.md).
