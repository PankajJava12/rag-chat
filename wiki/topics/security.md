---
title: Security and authorization
type: topic
status: current
reviewed: 2026-10-10
---

# Security and authorization

The MVP has one tenant per user and ADMIN/ADVISOR roles with tenant-wide policy visibility. Every request resolves current membership/status from PostgreSQL; client tenant or role claims are not authoritative. Forced tenant RLS, tenant-aware relationships and repository filters protect data. Conversations additionally require owner/expiry checks; ADMIN cannot read another user's chat. [Phase 5 security](../../docs/phase-5.md).

Local login uses signed one-hour tokens and HttpOnly/SameSite cookies; cookie writes require an allowed Origin. Logout revokes the presented token at this API, including copied cookie/bearer reuse, while other sessions remain usable. Cognito verifies access tokens but needs account provisioning and live login/federation validation. Offline JWKS tests are not a live Cognito deployment. [Auth implementation](../../packages/security/src/auth.ts).

Originals, extracted text/provenance, messages/replay and memory are AES-GCM encrypted. Queryable metadata, vectors and blind-index patterns are still sensitive derived data. Runtime database roles have restricted privileges; audit is append-only for runtime roles, not operator-proof WORM storage. No production TLS/key-rotation/compliance certification is established by local evidence. [Security design and limits](../../docs/phase-5.md).

External AI requires explicit ALLOW_EXTERNAL_AI configuration; OpenAI/Gemini profiles can send questions/evidence and new extracted text outside the local runtime. This gate is configuration validation, not a firewall or anonymizer. Source text is untrusted; screening, quotation checks and plain-text rendering provide layered defenses with documented gaps. [Current config](../../packages/shared/src/config.ts).

Keep private .env files, logs, tokens, customer policy content and Terraform state out of this wiki. No automatic production deletion scheduler is implemented; archiving and conversation expiry have distinct semantics.

## Sources

- [Phase 5](../../docs/phase-5.md)
- [Approved MVP decisions](../../docs/phase-2-decisions.md)
- [Crypto](../../packages/security/src/crypto.ts), [tenant transactions](../../packages/database/src/tenant.ts)

## Related

[Decisions](decisions.md) · [Ingestion](ingestion.md) · [Open questions](open-questions.md)
