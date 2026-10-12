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

## [2026-10-11] maintenance | Document database terminal connection

- Added a "Connecting via terminal" section to [packages/database/README.md](../../packages/database/README.md) describing the three available PostgreSQL roles (`advisor_app`, `advisor_owner`, `advisor_worker`), their privilege boundaries, `psql` command patterns using env-var URL references, and the `docker compose exec` fallback.
- Added a "Database terminal access" subsection to [wiki/topics/operations.md](operations.md) summarising the three roles and linking to the full instructions.
- Source: [.env.example](../../.env.example) role/variable names; [packages/database/src/connections.ts](../../packages/database/src/connections.ts) pool configuration. Credentials not copied into wiki; README instructs readers to read from `.env.development`.
- Documentation-only change; no application behavior, migrations or architectural decisions changed.

## [2026-10-12] maintenance | Enable persistent application restart

- Added `restart: unless-stopped` to PostgreSQL, Redis, Ollama, ClamAV, API, worker and web in base Compose, and LocalStack in its overlay. Kept migration/model initialization jobs without automatic restart.
- Updated README reboot guidance and operations wiki with manual-stop semantics and the limits of dependency orchestration during Docker restarts.
- Validated merged OpenAI/LocalStack Compose configuration using placeholder values and `/dev/null` as the environment file; no private environment files were read. Formatting and diff whitespace checks passed.
- Applied the policy directly to seven existing application containers without recreation/image upgrades, then started dependencies and API/worker/web. PostgreSQL, Redis, ClamAV, LocalStack, API and worker reported healthy; final web readiness recorded in the operations page. Migration remained exited with restart policy `no`. No reboot test or application regression suite was run.

## [2026-10-12] maintenance | Investigate push workflow failures

- Inspected current GitHub run/job logs and workflow, generation, grounding, parser and test source. RAG failures repeatedly occurred on claims abstention; the exact model draft was unavailable. Infrastructure lacked its CI license token; user added the repository secret and the retry passed that gate.
- Bound local Ollama intact excerpt quotes to source IDs during constrained decoding, retaining abstention and server validation. Added a schema regression test for wrong-source, partial and modified quotes. Preserved failed synthetic chat reports as CI artifacts, added failure service diagnostics and guarded infrastructure cleanup before environment setup.
- Updated retrieval and validation pages. Fresh local check passed lint/type/build and 89 unit tests; local synthetic PDF extraction/model reproduction passed claims grounding. No private environment files or customer policies were read. Remote end-to-end completion remains to be verified.
- Follow-up: licensed infrastructure retry and branch infrastructure checks passed. Synthetic-only model diagnostics in the PR run showed an `INSUFFICIENT_EVIDENCE` draft citing both the actual claims sentence and an unrelated disclaimer; schema constraints alone were insufficient. Filtered unrelated intact paragraphs before generation, retaining qualifications and the complete context for validation/conflicts; added a regression test. Final remote verification pending.
- Final implementation commit `808f0fa`: local lint/type/build and 90 unit tests passed; GitHub PR RAG run 38262190272 and infrastructure run 38262190228 both passed their complete workflows. Added links and validation scope to the validation page in a documentation-only follow-up.
