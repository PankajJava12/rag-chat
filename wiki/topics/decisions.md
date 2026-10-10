---
title: Project decisions and boundaries
type: topic
status: current
reviewed: 2026-10-10
---

# Project decisions and boundaries

The source for approved MVP decisions is [phase-2-decisions.md](../../docs/phase-2-decisions.md), dated 2026-10-08. Later implementation/runbook changes are distinguished below.

| Decision                                                 | Basis / current boundary                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| One tenant per user, ADMIN/ADVISOR, tenant-wide policies | Approved MVP; finer policy ACLs/multi-membership deferred                               |
| Owner-only conversations                                 | Enforced beyond tenant checks, including for ADMIN                                      |
| Immutable terms with date/supersession                   | Upload order is not legal precedence; ambiguous applicability requires clarification    |
| PDF/DOCX/XLSX/UTF-8 CSV, English OCR, 25 MiB upload      | Approved local scope; no legacy DOC/XLS conversion                                      |
| Retention configurable; no automatic production deletion | Conversation expiry defaults to 90 days; archive retains bytes                          |
| ap-south-1 configurable                                  | Initial AWS region; deployment/residency/compliance still need authorization/validation |
| Local accounts plus Cognito verifier                     | Local demonstration implementation; live Cognito UI/federation outstanding              |
| Extractive verified answers and bounded graph            | Implemented grounding tradeoff; does not guarantee semantic completeness                |
| PostgreSQL durable queue, optional SQS hints             | Implemented local/cloud-emulator architecture                                           |
| Multiple AI profiles, current documented Docker/OpenAI   | README/config describe supported profiles; private runtime settings were not inspected  |
| Production AWS deployment deferred                       | Terraform/runtime gates and separate future authorization required                      |

Sources for later boundaries: [Phase 3](../../docs/phase-3.md), [Phase 5](../../docs/phase-5.md), [Phase 6](../../docs/phase-6.md), [README](../../README.md).

Production targets of 1,000 concurrent users, retrieval P95 below 300 ms, answer P95 below five seconds and 99.9% availability are unvalidated goals from the original plan. The local evidence does not establish them. [Original plan](../../docs/plan.md); [measured scope](validation.md).

Record future accepted decisions with date, evidence, affected pages and remaining conditions. Do not infer product approval from a draft or historical aspiration.

## Sources

- [Approved decisions](../../docs/phase-2-decisions.md)
- [Historical plan](../../docs/plan.md)
- [Project documentation inventory](../sources/project-docs.md)

## Related

[Security](security.md) · [Open questions](open-questions.md) · [Maintenance log](../log.md)
