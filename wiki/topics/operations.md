---
title: Run profiles and observability
type: topic
status: mixed
reviewed: 2026-10-11
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
