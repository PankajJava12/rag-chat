# Authentication and cryptography

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package establishes verified user identity and supplies cryptographic primitives used throughout the backend. Role checks, database RLS, conversation ownership and final source validation work together; encryption alone does not authorize access.

## Main files

| File                           | Responsibility                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/auth.ts](src/auth.ts)     | `Authentication`, local login/session verification, Cognito access-token verification, server-side membership/disabled/revocation checks, logout and role checks. |
| [src/crypto.ts](src/crypto.ts) | `Vault` AES-256-GCM encryption/decryption with context binding, SHA-256 hashes, keyed fingerprints and scrypt password hashing/verification.                      |

## How it is used

The [API](../../apps/api/README.md) constructs `Authentication` from validated configuration. Verified identity contains user ID, tenant ID and ADMIN/ADVISOR role. Local authentication signs/verifies JWTs and checks passwords with scrypt; Cognito mode verifies access tokens and maps the subject to server-side membership. Local authentication is disabled in production.

Document-management mutations require administrator authorization. Advisors access their tenant's policy scope; conversations additionally require ownership. [Database](../database/README.md) sets transaction-local tenant context for forced RLS, and chat also sets owner context. Tenant IDs supplied by an arbitrary client header are not identity.

[Ingestion storage](../ingestion/README.md) uses `Vault` for original files, chunk content and source metadata. [Chat](../chat/README.md) encrypts messages, question memory and replay responses. [AI query caching](../ai/README.md) encrypts cached vectors and uses fingerprints; keyword indexing uses tenant-keyed fingerprints of normalized words.

## Boundaries

AES-GCM authenticates ciphertext and binds it to a context such as tenant/object identity. The vault expects a configured 32-byte key represented in hex. SHA-256 is used for integrity/content identity; HMAC fingerprints are used where keyed equality is needed; passwords use salted scrypt rather than a fast content hash.

Current policy visibility is tenant-wide for advisors; per-policy ACLs are not implemented. Stored document vectors and blind keyword equality/frequency patterns remain visible to the database, even though text payloads are encrypted. Prompt/quote checks belong to chat and do not replace authentication.

Configuration names and startup gates are defined in [shared config](../shared/src/config.ts). Keep actual keys and credentials in private configuration, never in documentation. See [security wiki](../../wiki/topics/security.md) for the combined access boundary.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
