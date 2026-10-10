---
title: Open questions, contradictions and gaps
type: topic
status: mixed
reviewed: 2026-10-10
---

# Open questions, contradictions and gaps

## Resolved source differences

| Difference                                                         | Wiki treatment and evidence                                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan says continue Phase 2; later docs cover Phases 1–7            | Treat plan as preserved historical request, not the current backlog. [Plan](../../docs/plan.md), [README](../../README.md)                                                                   |
| Phase 1 architecture fixes vectors at 1536                         | Explicitly superseded; current provider config supports OpenAI 1536 and Gemini/Ollama 768. [Architecture warning](../../docs/architecture.md), [config](../../packages/shared/src/config.ts) |
| Phase 7 says native/Ollama; README says current Docker/OpenAI      | Preserve Phase 7 as milestone history; use current README for documented run profile. Neither proves live runtime state. [Phase 7](../../docs/phase-7.md), [README](../../README.md)         |
| Phase 3 standalone memory/vectors versus later hybrid/topic memory | Later workflow/code adds bounded rewriting and keyword search. [Phase 4](../../docs/phase-4.md), [walkthrough](../../docs/project-walkthrough.md)                                            |
| Phase 4 reranker v1 versus walkthrough v2                          | Use inspected code/current walkthrough; retain v1 as prior design. [Ranking](../../packages/ai/src/retrieval/ranking.ts)                                                                     |
| Narrative says incompatible embeddings require reindex             | Semantic compatibility does; current code also supports keyword fallback without rewriting old vectors. [Retrieval](../../packages/ingestion/src/retrieval.ts)                               |
| Initial logout description only clears cookie                      | Phase 5 adds API token revocation. [Contracts](../../docs/api-contracts.md), [security design](../../docs/phase-5.md)                                                                        |

## Remaining work / missing evidence

- Representative customer-reviewed retrieval/answer dataset, difficult paraphrases and policy completeness evaluation. Small synthetic results cannot settle quality. [Validation](validation.md).
- Production load/availability/cost budgets, backup restore and key recovery, TLS/KMS/compliance and live AWS/Cognito integration. Follow the [Phase 6 handoff prerequisites](../../docs/phase-6.md); deployment remains gated.
- Finer policy ACLs, multiple memberships, distributed quotas and retention cleanup are deferred areas, not implied commitments. [Decisions](decisions.md).
- The timeout investigation conditionally mentions model-timeout-debug.json, which is absent from the inspected docs inventory. Do not cite a successful same-policy reproduction from that note. [Investigation](../../docs/model-timeout-debug.md).
- The licensed LocalStack overlay documents an optional console path; its live activation and account entitlement were not verified. [Console source](../../docs/localstack-console.md).
- Live provider/runtime readiness and current test/audit status need a new check if requested; wiki creation does not establish them.

## Sources

[Documentation inventory](../sources/project-docs.md) · [Code inventory](../sources/code.md) · [Validation evidence](../sources/validation-evidence.md)

## Related

[Overview](../overview.md) · [Operations](operations.md) · [Validation](validation.md)
