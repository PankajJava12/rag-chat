# Project wiki index

Start with [overview](overview.md). This wiki is a maintained knowledge layer over existing project documentation/code, inspired by [Karpathy's LLM Wiki](sources/llm-wiki.md). It describes the project; it is separate from the application's uploaded policy knowledge base. Initial sources were reviewed on 2026-10-10; component guides were source-reviewed on 2026-10-11. Runtime status was not checked.

## Project topics

| Page                                               | Summary                                                         |
| -------------------------------------------------- | --------------------------------------------------------------- |
| [Overview](overview.md)                            | Product purpose, scope and documented run profile               |
| [Architecture](topics/architecture.md)             | Processes, shared code, durable data and local component guides |
| [Ingestion and versioning](topics/ingestion.md)    | Upload, scan, parsing, indexing, leases and applicable versions |
| [Retrieval and chat](topics/retrieval-and-chat.md) | Hybrid/profile-aware search, memory, grounding and replay       |
| [Security](topics/security.md)                     | Identity, roles, RLS, encryption and audit boundaries           |
| [Operations](topics/operations.md)                 | Docker/native profiles, models, storage and telemetry           |
| [API](topics/api.md)                               | Main HTTP surface and contract ownership                        |
| [Validation](topics/validation.md)                 | Recorded evidence, measurement scope and verification commands  |
| [Decisions](topics/decisions.md)                   | Approved MVP choices and production boundaries                  |
| [Open questions](topics/open-questions.md)         | Source differences, deferred work and missing evidence          |

## Source notes

| Page                                                  | Summary                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| [Project documentation](sources/project-docs.md)      | Existing Markdown source catalog with historical/current scope |
| [Implementation evidence](sources/code.md)            | Source code/config paths for verification                      |
| [Validation evidence](sources/validation-evidence.md) | Recorded phase artifacts and their limits                      |
| [LLM Wiki provenance](sources/llm-wiki.md)            | External approach and project adaptation                       |

## Maintenance

- [AGENTS.md](AGENTS.md): schema, ingest/query/maintenance workflow and citation rules.
- [Log](log.md): append-only record of wiki evolution.
- [Topic template](templates/topic.md): new project concept/analysis page.
- [Source template](templates/source.md): source provenance and synthesis links.

Example requests: “Ingest docs/new-design.md into the wiki”; “Update the retrieval page after this change”; “Answer from the wiki and save the analysis”; “Lint the wiki for broken links and stale claims.” Read the schema before carrying them out.
