---
title: AI Advisor Assistant
type: overview
status: current
reviewed: 2026-10-10
---

# AI Advisor Assistant

AI Advisor Assistant is a tenant-aware insurance document application. Administrators upload PDF, DOCX, XLSX and UTF-8 CSV files; advisors ask questions scoped to a policy and effective date, optionally comparing two policies. Published answers contain server-verified source quotations/citations or explicit insufficient evidence. Quote validity does not establish complete insurance interpretation. [Product and implementation source](../README.md); [grounding source](../docs/project-walkthrough.md).

The workspace is a Node 24 / TypeScript npm monorepo with React web, Express API and an independent ingestion worker. Shared packages implement parsing, indexing, retrieval, chat, security and telemetry. PostgreSQL/pgvector stores durable state; Redis caches query embeddings. [Architecture](topics/architecture.md).

The README documents Docker with OpenAI as the current profile; base defaults remain Ollama, with native Gemini also supported. This wiki initialization inspected files and did not check running services. Phase 1–7 reports are local milestone evidence; AWS production deployment remains deferred. [Operations](topics/operations.md), [validation](topics/validation.md).

## Sources

- [README](../README.md)
- [Implementation walkthrough](../docs/project-walkthrough.md)
- [Package manifest](../package.json)

## Related

- [Ingestion](topics/ingestion.md), [retrieval and chat](topics/retrieval-and-chat.md), [security](topics/security.md)
- [Decisions](topics/decisions.md), [open questions](topics/open-questions.md)
