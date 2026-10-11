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

## [2026-10-11] maintenance | Consolidate licensed LocalStack

- Inspected the main/licensed Compose files, package startup script, README, console runbook and infrastructure workflow; did not read private environment files. Moved the pinned licensed image and required token into the main overlay, removed the redundant licensed overlay, and updated local commands plus CI secret configuration.
- Refreshed operations, open questions and documentation source inventory. Preserved old phase reports as historical evidence and recorded their Community/no-token discrepancy.
- Added the October 10 upgrade session readiness evidence to the console runbook, scoped to trial activation, S3/SQS health, initialization and resource visibility. This does not validate application regressions or future license entitlement.
- October 11 validation: Compose configuration with placeholder credentials and local wiki link checks; no container restart, CI execution or application regression suite. CI requires the LOCALSTACK_AUTH_TOKEN repository secret containing a CI token.

## [2026-10-11] maintenance | Add app and package guides

- Source-reviewed application entry points/routes, worker flow, frontend entry points, backend symbols, processing/configuration, database helpers, runtime/storage composition and telemetry. Did not read private environment files or sample policy contents.
- Added README.md to all three apps and eight packages, explaining purpose, main files, integration points, configuration/use and implementation boundaries with local source links. Existing docs/ remain unchanged.
- Updated architecture links, code/documentation source inventories and index navigation. No application behavior or architectural decision changed; retained unresolved issues already recorded in the wiki.
- Validation: component coverage, local Markdown links, wiki catalog/schema and Prettier formatting checks. No application tests, services or historical benchmarks were rerun for this documentation-only task.
