---
title: Retrieval and grounded chat
type: topic
status: current
reviewed: 2026-10-10
---

# Retrieval and grounded chat

Requests authenticate and resolve policy/version applicability before retrieval. Chat reserves an idempotent run; only one active run per conversation is allowed. A bounded deterministic question-topic memory supports follow-ups without using old assistant answers as evidence. A fixed LangGraph sequence runs rewrite → retrieve → generate → validate. [Walkthrough, Query pipeline](../../docs/project-walkthrough.md).

Semantic retrieval matches pgvector model/dimensions; lexical retrieval uses tenant-keyed HMAC terms and PostgreSQL full-text ranking. Hybrid search fuses ranks with RRF (k=60), then uses a deterministic lexical/cosine/heading heuristic. The walkthrough describes lexical-cosine-v2, superseding Phase 4's v1 description. Default final top K is eight and evidence budget 2000 tokens per policy; configuration remains authoritative. [Ranking code](../../packages/ai/src/retrieval/ranking.ts).

Provider changes do not make old vectors compatible. Current retrieval can combine semantic results for matching versions with keyword results across selected versions; when none match, it uses keyword-only retrieval. This preserves older generations without implying they were reembedded. [Retrieval implementation](../../packages/ingestion/src/retrieval.ts).

Redis stores encrypted query embeddings with tenant/model/dimension-bound keys (default TTL 300 seconds), not passages or generated answers. Cache failure falls through to fresh embeddings; authorization and version checks still run. [Query cache](../../packages/ai/src/query-cache.ts).

Generation returns structured evidence selections. The server verifies source IDs, exact quotations and boundaries, then rechecks authorization and version/generation snapshots before atomic persistence. SSE publishes progress while working, and validated answer text after checks. Completed idempotency replay uses PostgreSQL history; it is separate from the Redis cache. Comparisons validate each policy's evidence independently and do not infer which policy is better. [Chat flow](../../docs/phase-3.md); [comparison/memory extensions](../../docs/phase-4.md).

Exact quotation proves provenance, not relevance or full policy completeness. Layout/topic/injection heuristics may miss evidence or abstain on valid wording. Representative policy-quality evaluation remains open.

## Sources

- [Implementation walkthrough](../../docs/project-walkthrough.md)
- [Chat service](../../packages/chat/src/service.ts), [workflow](../../packages/chat/src/workflow.ts), [grounding](../../packages/chat/src/grounding.ts)
- [Source code inventory](../sources/code.md)

## Related

[Ingestion](ingestion.md) · [API](api.md) · [Validation](validation.md) · [Open questions](open-questions.md)
