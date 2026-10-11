# Grounded policy chat

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package turns a scoped user question into a persisted, cited answer. It coordinates conversation ownership, bounded question memory, retrieval, generation and evidence validation. Answers are constructed from verified quotations; missing or invalid evidence leads to abstention.

## Main files

| File                                   | Responsibility                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/service.ts](src/service.ts)       | `ChatService`: conversation create/list/detail, owner transactions, idempotent run reservation/replay, policy comparison, final source checks, encrypted persistence, memory updates and audit. |
| [src/workflow.ts](src/workflow.ts)     | Fixed LangGraph sequence: rewriting → retrieving → generating → validating; stage events and cancellation checks.                                                                               |
| [src/memory.ts](src/memory.ts)         | Bounded recent-question memory and deterministic follow-up rewriting; previous assistant answers are not evidence.                                                                              |
| [src/generation.ts](src/generation.ts) | OpenAI/Gemini/Ollama chat adapters, structured response requests, output limits, timeout/retry handling and token instrumentation.                                                              |
| [src/grounding.ts](src/grounding.ts)   | Prompt/schema, evidence budget, suspicious-text/topic guards, table shortcut, quotation validation, citation formatting and a narrow waiting-period conflict rule.                              |
| [src/layout.ts](src/layout.ts)         | Heuristic reading-order recovery for multi-column PDF text and selected table-like content.                                                                                                     |
| [src/excerpts.ts](src/excerpts.ts)     | Paragraph/list excerpts with short headings retained alongside the text they qualify.                                                                                                           |

## How it is used

The [API entry point](../../apps/api/src/server.ts) constructs `ChatService` with a pool, vault, embedder, generator and retrieval/context settings. [Chat routes](../../apps/api/src/routes/chat.ts) provide verified identity, scope, cancellation signal, progress callback and a final authorization callback.

The service loads bounded question memory, invokes the workflow and retrieves through [ingestion](../ingestion/README.md). For comparisons it executes one workflow per policy sequentially and combines the separately validated results. Generation receives the resolved question plus source-labelled evidence, not the full chat transcript.

The model proposes JSON status and source/quote pairs. Validation checks that quotes belong to evidence and retain sentence/paragraph boundaries and complete tables. The server formats the final answer. Before commit it rechecks applicable version sets, generations and all context evidence; concurrent source changes produce a retry error. User/assistant messages, replay response and memory are encrypted.

## Boundaries

This is a bounded workflow, not an open-ended tool-using agent. Lexical relevance guards, layout recovery and conflict checks have limited scope. Validating a quotation against extracted text does not independently verify OCR fidelity or guarantee that all relevant conditions were retrieved.

Default retrieval/context/output limits come from [shared config](../shared/src/config.ts). Provider streaming is buffered internally; the API exposes answer text only after validation and persistence. See [retrieval and chat](../../wiki/topics/retrieval-and-chat.md).

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
