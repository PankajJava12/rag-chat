---
title: Run profiles and observability
type: topic
status: mixed
reviewed: 2026-10-12
---

# Run profiles and observability

The [root README](../../README.md) is the detailed setup/runbook. Its introduction describes Docker/OpenAI as the current application profile; this is documented configuration, not a live status check. Phase 7 records an earlier native/Ollama migration. Keep those dates/scopes distinct.

| Profile              | Application / dependencies                                      | Configuration boundary                                                     |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Docker/OpenAI        | Container API/worker/Nginx, LocalStack and Docker data services | README uses base + LocalStack + OpenAI overlays; PostgreSQL host port 5433 |
| Base Docker/Ollama   | Container API/worker/Nginx and local model service              | Base Compose defaults; source storage volume policy-files                  |
| Native host          | Compiled Node API/worker and Vite; Docker dependencies          | host:prepare then host:start; .local/host-documents                        |
| Development watchers | API/worker/Vite watchers, Docker dependencies                   | .env.development; web port 5173                                            |

Normal web URL is localhost:8080 and API is localhost:3000. Shared ports and corpus storage make mode changes deliberate. Preserve the encryption key and make encrypted originals available to the selected backend; profiles do not automatically share source directories. host:prepare regenerates private host configuration from development settings, so use the full README procedure when changing providers. [README run modes](../../README.md).

### Automatic container restart

Persistent application services (`postgres`, `redis`, `ollama`, `clamav`, `api`, `worker`, `web`, and the LocalStack overlay's `localstack`) use `restart: unless-stopped`, matching monitoring. They restart after Docker restarts when previously running; an explicit manual stop remains stopped until started again. `migrate` and `model-init` retain the default `no` policy because they are one-time jobs. Compose health/dependency conditions apply during `compose up`; Docker daemon restarts do not rerun that orchestration, so use the README startup procedure when readiness or initialization needs checking. [Base Compose](../../docker-compose.yml), [LocalStack overlay](../../docker-compose.localstack.yml), [monitoring Compose](../../docker-compose.observability.yml), [Docker restart policy documentation](https://docs.docker.com/engine/containers/start-containers-automatically/).

On October 12, configuration validation with placeholder values confirmed these policies in the merged OpenAI/LocalStack profile. The seven existing application containers had their live policies updated with `docker update`; this does not recreate containers or upgrade their images. All seven were started and reported healthy, including web. No reboot test or application regression suite was performed.

### Database terminal access

Three PostgreSQL roles are available for direct inspection: `advisor_app` (runtime, RLS enforced), `advisor_owner` (DDL/migrations, no RLS) and `advisor_worker` (ingestion jobs). Use `psql "$DATABASE_URL"` with the relevant variable from `.env.development`, or exec into the container with `docker compose exec postgres psql -U advisor_owner -d advisor` if `psql` is not installed locally. Full connection instructions are in the [database package README](../../packages/database/README.md#connecting-via-terminal).

### Database web access

The separate `advisor-tools` Compose project runs pgAdmin 9.18 at `http://localhost:5050`, attached to the existing `ai-advisor-assistant_default` network. `npm run tools:up` creates a random initial login password in the ignored `.local/pgadmin/password` file, preserves it thereafter, and starts the service with readiness checking. The login is `admin@advisor.example.com`; the password is supplied through a Compose secret. The host directory is mode 0700; the mounted file is mode 0644 so the container user can read it. Saved settings persist in a named volume. [Tools Compose](../../docker-compose.tools.yml), [setup script](../../scripts/tools-setup.mjs), [npm scripts](../../package.json).

The first startup imports a server pointing to `postgres:5432`, database `advisor`, role `advisor_owner`; the user supplies the existing database password when connecting. This role has administrative access across tenants, so the browser can modify data as well as inspect it. Application-encrypted contents remain encrypted. The tools stack reuses PostgreSQL and requires its network to exist; remove the tools container before removing the application network. [Server definition](../../docker/pgadmin/servers.json), [README procedure](../../README.md#database-browser-pgadmin), [base database configuration](../../docker-compose.yml), [encryption implementation](../../packages/security/src/crypto.ts).

October 12 runtime verification: `advisor-tools-pgadmin-1` reported healthy; `/misc/ping` and the published localhost login page returned HTTP 200. The pgAdmin configuration database contained the expected server entry, and a TCP connection from pgAdmin to `postgres:5432` succeeded. An initial `.local` login identifier was rejected by pgAdmin email validation; the final configuration uses `admin@advisor.example.com`. Authenticated database browsing remains user verification; no database credentials or customer rows were read. [Maintenance evidence](../log.md#2026-10-12-maintenance--add-pgadmin-tools-group).

| Embedding provider | Default model          | Dimensions |
| ------------------ | ---------------------- | ---------- |
| OpenAI             | text-embedding-3-small | 1536       |
| Gemini             | gemini-embedding-001   | 768        |
| Ollama             | nomic-embed-text:v1.5  | 768        |

These are repository defaults, not model recommendations. Matching dimensions do not make models compatible. Changing a semantic index profile requires compatible schema/indexing; old profiles may remain keyword-searchable. [Configuration](../../packages/shared/src/config.ts); [embeddings](../../packages/ai/src/embeddings.ts).

LocalStack S3/SQS notifications retain PostgreSQL as job authority. The main LocalStack overlay now pins licensed version 2026.9.1 and requires LOCALSTACK_AUTH_TOKEN. Local commands load the ignored .env.localstack file; CI uses a repository secret containing a CI token. PERSISTENCE remains 0, so new uploads retain an encrypted local recovery mirror and emulator recreation clears S3/SQS contents. The separate licensed overlay was removed. [Compose source](../../docker-compose.localstack.yml), [package script](../../package.json), [CI configuration](../../.github/workflows/infrastructure.yml). The October 10 upgrade session verified trial activation, health/initialization, bucket visibility in the console and queue names; this was not an application regression run. [Phase 6](../../docs/phase-6.md); [licensed console instructions](../../docs/localstack-console.md).

Monitoring uses Prometheus, Grafana, Tempo and Alertmanager. Native monitoring targets host processes; container OpenAI monitoring adds the Docker overlay. API/worker metric ports and trace networking differ by profile. Logs/spans avoid policy text and secrets. Usage counters/optional configured price estimates are not a billing ledger. [Phase 7 telemetry](../../docs/phase-7.md); [current Docker telemetry instructions](../../README.md).

## Sources

- [README](../../README.md), [OpenAI overlay](../../docker-compose.openai.yml)
- [Phase 6](../../docs/phase-6.md), [Phase 7](../../docs/phase-7.md)
- [Host launcher](../../scripts/host.mjs), [source inventory](../sources/project-docs.md)

## Related

[Retrieval profiles](retrieval-and-chat.md) · [Validation](validation.md) · [Security](security.md)
