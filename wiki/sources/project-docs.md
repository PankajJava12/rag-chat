---
title: Project documentation source inventory
type: source
status: mixed
reviewed: 2026-10-10
---

# Project documentation source inventory

The existing docs/ collection and root README are the source layer for this wiki. They remain in place. Files were inspected on 2026-10-10; historical statements retain their original milestone scope. The walkthrough is itself an interpretation of code, so follow its code references when exact behavior matters.

| Source                                                     | Scope and how to use it                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [README](../../README.md)                                  | Main runbook and current documented Docker/OpenAI profile; no live-state guarantee    |
| [Project walkthrough](../../docs/project-walkthrough.md)   | 2026-10-10 implementation/code map, ingestion/query sequence and tradeoffs            |
| [Architecture](../../docs/architecture.md)                 | Historical Phase 1 design, explicitly superseded in several areas                     |
| [Plan](../../docs/plan.md)                                 | Historical request/targets/approvals; its Phase 2 next action is outdated             |
| [Phase 2 decisions](../../docs/phase-2-decisions.md)       | Approved MVP boundaries and local ingestion architecture                              |
| [Phase 3](../../docs/phase-3.md)                           | Extractive chat, idempotency, streaming and initial provider/memory scope             |
| [Phase 4](../../docs/phase-4.md)                           | Hybrid search, reranking, topic memory, comparisons and small-corpus evaluation       |
| [Phase 5](../../docs/phase-5.md)                           | Auth/revocation/RLS/audit and external-AI/security limits                             |
| [Phase 6](../../docs/phase-6.md)                           | S3/SQS emulator, recovery mirror and gated AWS handoff                                |
| [Phase 7](../../docs/phase-7.md)                           | Native/Ollama milestone, caching/telemetry and measurements                           |
| [API contracts](../../docs/api-contracts.md)               | Narrative routes with successive phase additions; verify generated schema/code        |
| [Validation](../../docs/validation.md)                     | Chronological local milestone outcomes, not current rerun results                     |
| [Timeout investigation](../../docs/model-timeout-debug.md) | 2026-10-08 local model load/deadline analysis; conditional missing evidence reference |
| [LocalStack console](../../docs/localstack-console.md)     | Optional licensed overlay instructions, not verified activation                       |

Additional artifacts: [OpenAPI](../../docs/openapi.json), [system diagram](../../docs/system-design.drawio), phase JSON reports and preview images. [Evidence inventory](validation-evidence.md) identifies useful reports. Sample policy PDFs are application test/input material; they were not ingested into this project wiki or interpreted as insurance advice.

## Synthesized pages

[Overview](../overview.md), [architecture](../topics/architecture.md), [ingestion](../topics/ingestion.md), [retrieval](../topics/retrieval-and-chat.md), [security](../topics/security.md), [operations](../topics/operations.md), [API](../topics/api.md), [decisions](../topics/decisions.md), [validation](../topics/validation.md), [gaps](../topics/open-questions.md).

## Sources

The table above is the source catalog; additions should preserve original paths and record inspection dates. See [LLM Wiki approach](llm-wiki.md).

## Related

[Code evidence](code.md) · [Maintenance instructions](../AGENTS.md)
