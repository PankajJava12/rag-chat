---
title: Validation evidence and limits
type: topic
status: mixed
reviewed: 2026-10-10
---

# Validation evidence and limits

This page summarizes recorded local results; no application tests or live services were run during wiki initialization on 2026-10-10. The newest milestone section in [docs/validation.md](../../docs/validation.md) records Phase 7 tests on 2026-10-09: 76 unit and 41 integration tests, lint/typechecks/builds, and a runtime dependency audit. These counts are historical and must not be presented as a fresh check of current files.

| Recorded evidence      | Result and scope                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Phase 7 retrieval      | 30 requests, concurrency two, one synthetic policy; warm P95 35.2 ms and uncached request 585.2 ms |
| Phase 7 chat           | One synthetic PDF waiting-period answer, 18.6 s completion and 17 ms first SSE progress            |
| Phase 7 ingestion      | PDF/DOCX/XLSX/CSV/scanned PDF; actual local services and source recovery                           |
| Phase 7 observability  | API-to-worker trace and local alert delivery/recovery                                              |
| Phase 4 retrieval      | Eight labelled queries; semantic/hybrid/reranked modes tied, no improvement demonstrated           |
| Phase 6 infrastructure | LocalStack integration and mocked AWS Terraform security checks; no AWS deployment                 |

Source: [validation report](../../docs/validation.md), with individual files catalogued in [evidence inventory](../sources/validation-evidence.md). Small synthetic regressions do not validate representative policy quality, production corpus/concurrency, P95 chat or availability. Existing development-dependency findings and quote-boundary abstentions remain historical limitations; a new audit/evaluation is needed for current status.

Choose checks by change: npm run check for lint/type/unit/build; test:integration for real DB/Redis; test:e2e for ingestion; test:chat/test:advanced for real-model regressions; test:security for auth; LocalStack/performance/telemetry scripts for those boundaries. Commands depend on profile/env and create fixtures. Read their source/runbooks first; failure/alert drills stop dependencies or an idle worker and should be scheduled separately from active traffic. [Package scripts](../../package.json); [Phase 7 validation procedure](../../docs/phase-7.md).

For Markdown-only wiki changes, check formatting, local links, index coverage and source consistency. Record actual outcomes in [log.md](../log.md).

## Sources

- [Validation report](../../docs/validation.md)
- [Evidence inventory](../sources/validation-evidence.md)
- [Unit tests](../../tests/unit/retrieval.test.ts), [integration tests](../../tests/integration/ingestion.test.ts)

## Related

[Open questions](open-questions.md) · [Operations](operations.md) · [Decisions](decisions.md)
