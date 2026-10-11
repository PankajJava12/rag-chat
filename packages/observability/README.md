# Observability

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package records operational evidence for API, ingestion, retrieval and model work. It provides structured logs, OpenTelemetry spans and Prometheus metrics. Collection/export is configured at startup; dashboards and alert definitions live in [docker/observability](../../docker/observability/).

## Main files

| File                                 | Responsibility                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/logger.ts](src/logger.ts)       | `createLogger()` builds a Pino logger with service identity, active trace/span IDs and redaction of selected credential fields.                    |
| [src/telemetry.ts](src/telemetry.ts) | Shared registry, latency/usage/cache/job/readiness/backlog/chat/context metrics, `observed()` stage instrumentation and trace propagation helpers. |
| [src/init.ts](src/init.ts)           | Conditionally starts OpenTelemetry export and a `/metrics` HTTP listener; validates collector/bind settings and provides `closeTelemetry()`.       |

## How it is used

[API middleware](../../apps/api/src/app.ts) records request IDs, route/method/status, duration and traces. [Ingestion](../ingestion/README.md), [AI](../ai/README.md) and [chat](../chat/README.md) instrument operations and provider token usage. Job trace context is propagated through PostgreSQL/SQS notification handling into worker processing.

The worker updates readiness and ingestion backlog gauges. Chat records answer/abstention/failure outcomes and evidence-context token counts. Redis cache operations report hit, miss and error counters.

## Configuration and interpretation

`TRACING_ENABLED` enables the Node SDK and OTLP trace exporter. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` must use one of the explicitly allowed local/container collector hosts. `METRICS_ENABLED` enables the metrics listener, with `METRICS_PORT` and `METRICS_BIND_HOST` controlling its address. These startup settings are read directly by `init.ts`; `OTEL_SERVICE_NAME` identifies the service.

Prometheus scrapes metrics; Grafana displays dashboards; Tempo stores exported traces; Alertmanager handles configured alerts. See the [operations wiki](../../wiki/topics/operations.md) and [root runbook](../../README.md) for the native/container monitoring overlays.

Cost counters use reported tokens and operator-supplied per-million-token rates. They are estimates and exclude infrastructure; they are not live billing reconciliation. Logger redaction covers selected fields, so callers must still avoid logging document text, questions or secrets. This library does not independently prove correctness or production readiness.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
