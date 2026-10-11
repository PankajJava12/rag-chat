# AI and retrieval utilities

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package provides embedding adapters and reusable retrieval utilities. Ingestion uses it to index documents; retrieval uses it to represent questions and rank candidate passages. Chat generation adapters live in [chat](../chat/README.md), not here.

## Main files

| File                                                   | Responsibility                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/embeddings.ts](src/embeddings.ts)                 | `Embedder` interface, OpenAI/Gemini/Ollama adapters, vector validation, bounded retry/timeouts, document/query purpose handling and usage instrumentation.        |
| [src/query-cache.ts](src/query-cache.ts)               | Optional Redis query-embedding cache: tenant/model/dimension/question fingerprints, encrypted values, TTL, bounded cache operations and fallback on cache errors. |
| [src/retrieval/keywords.ts](src/retrieval/keywords.ts) | Shared normalization, stop words and simple plural handling; tenant-keyed HMAC terms for blind `tsvector`/`tsquery` generation.                                   |
| [src/retrieval/ranking.ts](src/retrieval/ranking.ts)   | Reciprocal rank fusion and `lexical-cosine-v2`, a deterministic reranker based on term coverage, cosine relevance, numeric identifiers and heading coverage.      |
| [src/evaluation/metrics.ts](src/evaluation/metrics.ts) | Binary relevance metrics: recall, precision, reciprocal rank and nDCG from labelled expected IDs.                                                                 |

## How it is used

[Ingestion runtime](../ingestion/src/runtime.ts) constructs the configured embedder and optionally wraps query embedding with Redis caching. The ingestion pipeline embeds batches of chunk texts, using a separate PostgreSQL cache for document embedding reuse. Retrieval calls `embedQuery()` when available, or embeds the question with query purpose directly.

The implementation uses 1536 dimensions for OpenAI and 768 for Gemini/Ollama. Gemini sends distinct retrieval task types and normalizes reduced vectors; Ollama prefixes document/query inputs. Vectors are checked for expected count, dimensions, finite values and nonzero content.

The retrieval package combines semantic and keyword candidates using RRF, then optionally applies the local reranker. Chat context construction can rerank finer excerpts again. Ranking scores are ordering signals, not confidence probabilities; the reranker is not a learned cross-encoder.

## Boundaries and configuration

Model identity and dimensions must match between question and document vectors. Changing provider does not reembed existing documents; retrieval may use their keyword indexes until reindexing. Blind keyword indexing hides plaintext lexemes, but still exposes matching/frequency/position patterns to the database.

Provider settings, external-AI gates, candidate counts and cache settings are defined in [shared config](../shared/src/config.ts). This package is imported by backend code; it has no standalone HTTP server. See [retrieval and chat](../../wiki/topics/retrieval-and-chat.md) for the full pipeline.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
