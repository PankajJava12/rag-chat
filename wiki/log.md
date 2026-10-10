# Wiki maintenance log

Append new dated entries; preserve prior history. Dates use the project/user calendar (Asia/Kolkata). Entries record source inspection separately from executable validation.

## [2026-10-10] ingest | Initialize project wiki

- Read Karpathy's LLM Wiki gist and inspected existing project Markdown sources, package/scripts inventory, selected provider configuration and retrieval code.
- Created the [index](index.md), [overview](overview.md), nine topic pages, four source inventories/notes, two templates and [maintenance schema](AGENTS.md). Added root AGENTS.md and a README entry point.
- Retained docs/ in place as the source collection; did not ingest sample policy contents or private environment files.
- Distinguished superseded Phase 1/2 plans, Phase 7 native/Ollama history and README's current documented Docker/OpenAI profile. Recorded keyword fallback, scoped historical results and missing timeout evidence in [open questions](topics/open-questions.md).
- Verification: formatting and a local Markdown link/catalog check are recorded in the following lint entry once completed. No application tests or live runtime checks were run for initialization.

## [2026-10-10] lint | Initial wiki verification

- Prettier formatted the 19 wiki pages and root AGENTS.md.
- Local link/catalog/schema check passed: 251 local links resolved, every wiki page appeared in the index and had an inbound link, and content pages contained review metadata plus Sources/Related sections.
- Confirmed current reranker identity in source as lexical-cosine-v2 and absence of the conditional model-timeout-debug.json artifact.
- Application behavior was unchanged; historical tests/benchmarks were not rerun. README's added wiki links point to the verified index and schema.
