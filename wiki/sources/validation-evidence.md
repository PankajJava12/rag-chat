---
title: Recorded validation source inventory
type: source
status: historical
reviewed: 2026-10-10
---

# Recorded validation source inventory

These files are pre-existing milestone artifacts. Their existence is not a fresh pass; this initialization read the narrative report and inventoried report paths, without rerunning or independently auditing every JSON assertion.

| Evidence                                                           | Recorded purpose                                    |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| [Validation narrative](../../docs/validation.md)                   | Phase 2–7 results, scopes and known limits          |
| [Phase 2 ingestion](../../docs/phase-2-demo.json)                  | Parsing/indexing/versioning examples                |
| [Phase 3 chat](../../docs/phase-3-demo.json)                       | Eight initial real-model cases                      |
| [Phase 4 advanced](../../docs/phase-4-demo.json)                   | Comparison/memory and labelled retrieval evaluation |
| [Phase 4 new subject](../../docs/phase-4-new-topic-demo.json)      | New missing topic abstention                        |
| [Phase 4 third turn](../../docs/phase-4-third-turn-demo.json)      | Persisted changed topic                             |
| [Phase 4 chat regression](../../docs/phase-4-chat-regression.json) | Prior chat cases rerun at that milestone            |
| [Phase 5 security](../../docs/phase-5-demo.json)                   | API auth/revocation smoke                           |
| [Phase 5 RAG](../../docs/phase-5-rag-regression.json)              | Grounded answer/security regressions                |
| [Phase 6 emulator](../../docs/phase-6-demo.json)                   | S3/SQS/outbox/source recovery and DLQ               |
| [Phase 6 containers](../../docs/phase-6-container-demo.json)       | Actual Docker ingestion/source path                 |
| [Phase 7 host](../../docs/phase-7-host-demo.json)                  | Native/LocalStack source and indexing evidence      |
| [Phase 7 ingestion](../../docs/phase-7-ingestion.json)             | Native parser/OCR/ingestion examples                |
| [Phase 7 retrieval](../../docs/phase-7-performance.json)           | Small synthetic search timings                      |
| [Phase 7 chat](../../docs/phase-7-chat.json)                       | One measured PDF answer                             |
| [Phase 7 telemetry](../../docs/phase-7-observability.json)         | Metrics/dashboard/trace checks                      |
| [Phase 7 alert](../../docs/phase-7-alert.json)                     | Local alert delivery/recovery drill                 |

Preserve these records. New validation should describe its date, code/profile, corpus, dependencies, actual checks and limitations, with a new source note or clearly dated updated evidence. Never generalize local/emulator/offline tests into production certification.

## Sources

[Validation report](../../docs/validation.md); linked artifacts above.

## Related

[Validation synthesis](../topics/validation.md) · [Open questions](../topics/open-questions.md) · [Project sources](project-docs.md)
