# Phase 5 — Enterprise security, local validation

This phase hardens the existing ADMIN/ADVISOR, tenant-filtered RAG workflow. Local accounts and Ollama remain the defaults. No AWS deployment or live Cognito account is required.

## Authentication and authorization

Local login issues a one-hour HS256 token with a random session identifier. Cookie authentication uses HttpOnly, SameSite=Strict cookies and an allowed Origin for mutations. The development HTTP cookie is intentionally not Secure; production startup remains blocked. A malformed Authorization header cannot silently fall back to cookies. Tokens require a valid signature, issuer, audience and expiry.

Logout records a SHA-256 digest of the exact token in PostgreSQL and clears the cookie. Both copied cookies and bearer tokens then fail, including across API instances/restarts sharing that database. Other sessions remain active. There is no refresh-token flow for local accounts. Revocation records are retained; an operator can later remove expired entries, without deleting policy documents. Database outages fail authentication closed.

The Cognito adapter verifies RSA signatures, configured user-pool issuer, app client and `token_use=access` using aws-jwt-verify. Signed local JWKS fixtures test signature tampering, incorrect issuer/client/use and expiry. Cognito subjects must be provisioned into the local users table by an operator; token role/tenant claims are never authority. Cognito logout here revokes that access token **at this API only**; provider refresh-token revocation, hosted login, federation and live AWS/LocalStack validation remain future work. See [AWS token verification documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html).

Every authenticated request resolves current account status, role and tenant from PostgreSQL. Chat additionally rechecks authorization immediately before saving a generated answer or returning an idempotent replay. A disabled account or revoked token detected during generation causes a failed run with no saved messages or published answer. This check does not promise atomic cancellation of a revocation racing after the final check; already completed requests cannot be recalled.

Forced tenant RLS, explicit retrieval tenant filters, composite foreign keys and owner-only conversation/message/run policies remain enforced. ADMIN does not gain access to another user's chat content. The schema has one tenant per user for this MVP; policy visibility is tenant-wide.

## Least privilege and audit

Migration `006_enterprise_security.sql` removes direct user-table privileges and tenant-configuration mutations from advisor_app. Account provisioning, role changes and retention configuration require operator credentials, which are absent from the API/worker containers. Authentication uses narrow fixed-query SECURITY DEFINER functions, with explicit trusted search paths, `pg_temp` last and PUBLIC execution revoked. See [PostgreSQL function security documentation](https://www.postgresql.org/docs/current/sql-createfunction.html).

`GET /api/v1/admin/audit-logs?limit=50&before=<ISO timestamp>` returns tenant-scoped metadata only: actor/resource IDs, action, request ID and timestamp. Limit is 1–100; `before` is exclusive. It records its own use. Login/logout, document operations, search, chat operations and authenticated 403/404 denials are recorded without questions, policy text, passwords or tokens. Anonymous authentication failures remain structured HTTP security logs; they cannot be attributed safely to an authenticated tenant. Denial-audit write failures produce `audit_write_failed` logs; no protected content is released by the denial.

Runtime roles cannot update/delete audit records. This is application-level append-only storage, not a tamper-evident or WORM audit system: database operators still have authority. Audit visibility does not include private conversation content. Per-IP login and per-account/API/chat limits remain enabled. The single-process limiter is suitable for this local instance; shared distributed limits belong in the scale phase.

## PII and prompt-injection boundaries

Original files, chunk text, source metadata, messages, replay responses and conversation memory remain AES-256-GCM encrypted with scoped associated data. Keys stay outside the database in ignored local environment files. Structured log fields avoid user text and secrets. Embeddings and blind keyword indexes are derived data, not anonymization; tenant isolation and local storage remain necessary. Local host-volume encryption, TLS, KMS rotation and formal compliance are not claimed.

`ALLOW_EXTERNAL_AI=false` is the default. Selecting an OpenAI provider or a remote Ollama hostname fails startup configuration validation unless explicitly enabled. Allowed local hostnames are localhost, 127.0.0.1, ::1, ollama and host.docker.internal. Do not map these names to remote hosts. This is an operator configuration boundary, not a network firewall. Opt-in permits policy/customer text to leave the local environment; it requires a reviewed data-processing policy and is not a PII anonymizer. Default Compose remains local.

Injection screening now normalizes Unicode compatibility characters and removes invisible formatting characters before applying the existing instruction-pattern checks. Suspicious questions/passages are excluded, model output must contain server-validated complete source quotations, arbitrary model actions/tools are unavailable, and React renders answers as plain text. Heuristic screening cannot detect every adversarial prompt or establish semantic correctness; customer-specific adversarial evaluation is still required.

## Reproduce

```sh
npm run check
npm run db:migrate
npm run test:integration
docker compose --env-file .env.development up -d --build --wait
npm run test:security
node scripts/smoke.mjs
npm run test:chat
```

Security smoke uses generated local accounts from `.env.development`, emits only check names/statuses, and writes `docs/phase-5-demo.json`. It never writes cookie/token/password values. Unit Cognito tests use generated RSA keys and cached public JWKS with no network calls. LocalStack validation precedes any future AWS deployment.
