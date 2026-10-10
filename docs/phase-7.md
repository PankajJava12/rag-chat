# Phase 7 — native application, optimization and observability

API, ingestion worker and Vite now run directly on this Mac, serving the existing localhost:8080 URL. Their Docker containers were removed; Dockerfile and base Compose definitions remain available for future use. PostgreSQL/pgvector, Redis, Ollama, ClamAV and LocalStack remain Docker dependencies. Monitoring uses a separate Compose project. AWS deployment remains deferred.

## Native operation

The migration preserved and authenticated 42 encrypted source files from host storage and the original policy-files volume. Originals and Docker volumes remain intact. The active host directory is `.local/host-documents`; `.env.host` preserves the original account, signing and encryption secrets and targets dependency loopback ports. It is ignored and mode 0600. Separate `.env.host-api` and `.env.host-worker` files keep owner/admin credentials out of serving processes, and the worker receives neither the session-signing key nor API database credentials. Parent shell secrets are not forwarded to these children. New LocalStack uploads keep the same encrypted filesystem recovery protection as Phase 6.

```sh
# One-time parser tools on Apple Silicon macOS:
brew install poppler tesseract
npm ci
npm run setup
# Start dependencies only; do not run unrestricted Compose up or localstack:up.
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.localstack.yml up -d --wait postgres redis ollama clamav localstack
docker compose --env-file .env.development run --rm model-init
npm run db:migrate
npm run db:seed
npm run build
npm run host:prepare
npm run observability:up
npm run host:start
```

`host:start` is idempotent and waits for readiness. It starts compiled API/worker code and Vite on port 8080 as detached processes, with private logs/PIDs under `.local/host`. It does not configure macOS login services: after reboot, restart Docker dependencies and run `host:start`. After backend edits run `host:stop`, build, then start. Vite reloads frontend edits. `host:stop` gracefully stops only these registered processes; `npm run host:stop -- worker` through npm argument forwarding, or `node scripts/host.mjs stop worker`, stops just the worker. `host:status` reports registered PIDs.

Do not recreate the API/worker/web containers while host services own their ports. To export additional original encrypted files before removing old containers, stop them and copy `/data/documents/.` from the API into `.local/container-documents`, then run `host:prepare`. Copies are authenticated with the unchanged encryption key; collisions with different plaintext fail instead of overwriting.

## Query caching and retrieval

Redis caches only query embeddings for 300 seconds (configurable up to 900). Keys use a secret HMAC over tenant, exact question, model profile and dimensions. Values are encrypted AES-GCM with key-bound associated data. Raw questions and vectors are not stored in readable Redis entries. Each tenant/model profile has a separate cache space; document embeddings bypass this cache and retain existing tenant/profile/content-hash batch reuse in PostgreSQL.

Every query still checks policy authorization and applicable versions before cache access and rechecks versions/generations in the retrieval transaction. Retrieved policy passages and chat answers are never cached. A newly effective unindexed version still blocks the query. Redis reads/writes have a 250 ms deadline; corrupt entries and cache outages fall back to fresh embeddings. Cache optimization removes repeated model embedding calls without relaxing tenant or version enforcement.

Existing hybrid RRF, bounded candidate counts, reranking, pooling and context budgets remain. PostgreSQL query spans separate retrieval database time from embedding time. No new ANN settings or index changes are asserted to improve a corpus that has not been measured at production size.

## Metrics, traces and dashboards

Native services bind to loopback. Metrics are on 127.0.0.1:9464 (API) and :9465 (worker), separate from the user API/proxy. Metrics include request latency/error counts, RAG stages, cache hits/errors, ingestion attempts/backlog, dependency readiness, model tokens, selected context tokens, persisted chat outcomes, memory and event-loop lag. Labels contain bounded operations/routes/outcomes rather than tenants, document IDs or question text.

Manual OpenTelemetry spans cover HTTP, retrieval/database, embedding, generation, queue publication and ingestion source/scan/parse. Incoming client trace headers are ignored. A generated W3C trace parent is saved transactionally with each ingestion job and notification; the worker restores it from the database, joining API and worker spans. Untrusted SQS hints cannot select a job or supply its trusted trace context. Pino logs correlate trace/span IDs. Automatic host/process resource detection is disabled to omit hostnames, owner names and command-line data. Failure spans record safe error codes; they do not record exception text, SQL, filenames, prompts or document content. Export is restricted to configured local collector addresses and has a deadline.

Migration 008 adds trace fields and a worker-only aggregate metrics function. It exposes counts/ages, not tenant identifiers; API roles cannot execute it. Readiness requires this migration. A trace lookup exceeded the initial 256 MiB collector limit. Tempo now has a 512 MiB ceiling, a 256 MiB Go heap budget and query concurrency/sharding of two; the repeated lookup passed. These are local resource settings, not production sizing. See [Tempo query tuning](https://grafana.com/docs/tempo/latest/operations/backend_search/). Trace storage retains 24 hours; Prometheus retains seven days. Local monitoring is HTTP and is not production access control/compliance certification.

- Application: http://localhost:8080
- Grafana dashboard: http://localhost:3002/d/advisor-local — anonymous local Viewer
- Prometheus targets/rules: http://localhost:9090
- Alertmanager: http://localhost:9093
- Tempo trace API: http://localhost:3200

This Compose configuration targets Docker Desktop on macOS, whose `host.docker.internal` bridge can reach native loopback services. Linux requires an explicit host-network monitoring configuration; do not silently expose native metrics on public interfaces to accommodate a bridge.

Alerts cover unavailable processes, degraded dependencies, elevated 5xx rates, generation near its deadline, exhausted ingestion retries and aged backlog. Thresholds are provisional. Prometheus delivers alerts to the local Alertmanager UI; no Slack/email/cloud messages are configured. See [Prometheus alerting](https://prometheus.io/docs/alerting/latest/overview/) and [OpenTelemetry exporters](https://opentelemetry.io/docs/languages/js/exporters/).

## Usage and cost accounting

Model token counters use reported successful-call usage. Failed/canceled attempts may incur unreported usage, so these counters are not a billing ledger. Ollama incurs no API token charges, but local CPU, energy and infrastructure costs still exist. Optional OpenAI estimates use operator-supplied USD-per-million input/output prices and exclude storage/network/cloud costs; defaults are zero and mean pricing is unconfigured. No cloud model was invoked for this phase. Set these environment values and restart the host API/worker when actual approved prices are available:

```text
EMBEDDING_INPUT_USD_PER_MILLION
GENERATION_INPUT_USD_PER_MILLION
GENERATION_OUTPUT_USD_PER_MILLION
```

## Reproduce and interpret validation

```sh
npm run check
npm run test:integration
node scripts/smoke.mjs
node --env-file=.env.host scripts/security-smoke.mjs
SMOKE_REPORT=docs/phase-7-host-demo.json node --env-file=.env.host scripts/localstack-smoke.mjs
npm run test:performance
node scripts/observability-smoke.mjs --alert-drill
node --env-file=.env.host scripts/chat-performance.mjs
```

The alert drill temporarily stops only an idle host worker, verifies actual Prometheus-to-Alertmanager delivery, then restarts it in a finally block and verifies scrape recovery. Run it when no ingestion is active. The unique synthetic ingestion fixture forces fresh document embeddings and verifies a real distributed trace. Unit tests cover cache encryption/profile isolation/corruption/outage/cancellation, and integration tests cover worker-only aggregate permissions.

The performance script uses 30 authenticated searches at concurrency two against one synthetic policy. It measures HTTP retrieval, including authorization, embedding/cache and SQL, and confirms monitoring targets. This is a small local regression measurement, not a representative corpus/load benchmark or production SLO validation. The separate real-model chat check records first SSE progress, completion latency, model usage and citations; it does not establish P95 chat latency.

A representative customer-reviewed corpus, 1,000 concurrent users, restore drills, cost budgets, production telemetry access controls, broader retrieval-quality evals and availability measurements remain outstanding. Increasing candidate sizes, connection pools, worker count or model size without those measurements can worsen memory contention and tail latency. This phase supplies measurable local behavior and operational controls; it does not validate the original production scale targets.

A first CSV chat fixture completed with abstention despite containing the waiting-period term. CSV sources require complete row quotations. A PDF fixture with an unpunctuated heading also abstained, while a fixture with an explicit sentence boundary produced the cited answer. Strict quote-boundary validation can reject otherwise relevant passages; this conservative limitation remains. That result is retained as a quality limitation; the separate natural-language PDF check does not prove all formats or policy questions will be answered.
