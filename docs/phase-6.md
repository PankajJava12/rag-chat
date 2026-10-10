# Phase 6 — LocalStack deployment preparation

The default application remains local: accounts, Ollama, PostgreSQL/pgvector, Redis, ClamAV and encrypted filesystem storage. This phase adds an opt-in LocalStack S3/SQS profile with encrypted local source recovery, transactional notification delivery, Terraform and CI. No AWS account was changed or production deployment performed.

## Run the LocalStack profile

Use Node 24 and Docker Compose v2. Keep the existing generated secrets and volumes:

```sh
npm ci
npm run setup
npm run localstack:up
```

Open http://localhost:8080 and use your existing local account. PDF, DOCX, XLSX and CSV uploads use the same scan/parse/embed/index pipeline, with encrypted original files now in S3. Existing filesystem documents can still be downloaded through the same explicit LocalStack-only fallback; they are not automatically copied to S3. API and worker share the original policy-files volume and encryption key.

LocalStack uses dummy credentials, loopback port 4566, only S3/SQS services and no Docker socket. Its image is pinned by digest. Version 4.12.0 is the archived community image: it avoids an account-token dependency but receives no new security patches. Use it only for isolated local validation with synthetic documents. A current supported LocalStack release and its required account configuration must be evaluated before broader emulator use.

Restart testing demonstrated that this archived community image does not restore S3/SQS state with `PERSISTENCE=1`. The overlay therefore explicitly uses an ephemeral emulator. Each new upload first writes an immutable encrypted recovery copy to the existing policy-files volume, then must successfully write S3 before upload completion. A missing S3 key can be read from this local copy; network/permission failures do not silently fall back. AWS never receives this fallback. Back up PostgreSQL, policy-files and the encryption key together; do not use `down -v` or replace the key. The emulator volume retains cache files only, not a promised durable AWS state snapshot. Earlier synthetic fixtures from before the mirror was implemented may lack source objects. New evidence records validate source recovery across a real reset. See [LocalStack persistence documentation](https://docs.localstack.cloud/aws/developer-tools/snapshots/persistence/).

```sh
# Stop gracefully, retaining all volumes.
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.localstack.yml down
# Restart with the same overlay whenever accessing documents stored in S3.
npm run localstack:up
```

## Storage and queue design

S3 keys contain tenant/version UUIDs; files are encrypted with AES-256-GCM and object-bound associated data before transmission. Bucket versioning, public-access blocking and server-side encryption are enabled. Conditional writes reject changed bytes under an immutable key and permit identical retries. LocalStack uses AES256 server encryption; the AWS template uses KMS. Emulation verifies API behavior, not the security implementation of AWS encryption or IAM.

Upload completion atomically inserts a PostgreSQL ingestion job and an outbox row. A restricted worker function leases pending notifications, publishes IDs only to SQS and marks successful delivery. Send failures retain the outbox entry with a delay; a crash after sending can duplicate a notification. PostgreSQL remains authoritative for tenant isolation, leases, retries and atomic index publication. SQS messages only wake the worker, and database polling continues during a queue outage. A malformed notification remains unacknowledged and reaches the DLQ after five deliveries. Failed ingestion jobs remain visible as FAILED in PostgreSQL; the notification DLQ is not the ingestion retry ledger.

Cloud SDK calls have connection/request deadlines and bounded retries. Structured error logs contain safe codes and job IDs, not document content. Readiness currently checks PostgreSQL/Redis and worker progress; S3/SQS outages surface through operation failures and notification logs, rather than independent readiness probes.

Migration 007 adds a forced-RLS outbox with no ordinary runtime table privileges. Only the worker role can claim/acknowledge notifications through fixed SECURITY DEFINER functions. API uploads cannot directly publish arbitrary queue messages.

## Reproduce validation

The host-based test uses the real local dependencies and the application API in-process; do not run it alongside the Docker worker because both would claim its fixture job:

```sh
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.localstack.yml stop worker
npm run db:migrate
npm run db:seed
npm run build
npm run test:localstack
docker compose --env-file .env.development -f docker-compose.yml -f docker-compose.localstack.yml start worker
npm run check
npm run test:integration
node scripts/smoke.mjs
npm run test:localstack:containers
```

The test creates synthetic records, verifies ciphertext/immutable retries, bucket controls, outbox publication, scanning and real Ollama embeddings in pgvector, authenticated source recovery, and actual poison-message DLQ redrive. Evidence is written to `docs/phase-6-demo.json`. The separate container smoke uploads through Nginx and waits for the actual Docker worker, then checks retrieval and source recovery. It writes `docs/phase-6-container-demo.json`. A persistence check is reproducible with `node --env-file=.env.development scripts/localstack-persistence.mjs --record`, a graceful LocalStack restart, and the same script without `--record`. This checks authenticated recovery through the deployed API, not persistence inside the emulator.

Terraform 1.14.9 and the locked AWS provider validate infrastructure independently:

```sh
terraform fmt -check -recursive infra
terraform -chdir=infra/localstack init
terraform -chdir=infra/localstack validate
# This root hardcodes dummy credentials and localhost endpoints only.
terraform -chdir=infra/localstack apply
terraform -chdir=infra/aws init -backend=false
terraform -chdir=infra/aws validate
# Mock provider only; no AWS API calls or resources.
terraform -chdir=infra/aws test
```

The emulator Terraform root manages a separate validation bucket and queue pair. The Compose bootstrap manages the application resources. The infrastructure workflow runs mocked AWS checks and a real LocalStack ingestion test; the release workflow builds image artifacts without publishing or deploying them.

## Future AWS handoff — deployment remains gated

`infra/aws` describes a two-AZ VPC, private ECS Fargate services, HTTPS ALB, private Multi-AZ RDS PostgreSQL, TLS ElastiCache, Cognito, KMS-encrypted/versioned S3, SQS/DLQ, ECR and CloudWatch. Region defaults to ap-south-1 and is configurable. IAM permissions omit document deletion; no retention deletion scheduler is introduced. Logs retain 90 days. API and worker use separate database roles and Secrets Manager inputs.

Terraform refuses ordinary plans/applies unless `deployment_approved` is explicitly true. Runtime configuration separately refuses production operation unless AWS approval, Cognito, S3/KMS, SQS and database/cache TLS settings are present. AWS endpoint overrides are rejected outside the local emulator profile. These gates are guards against accidental use; approval still requires a new user instruction.

Before any later production rollout, supply and validate:

- Approved residency, formal compliance and retention policies, load-tested SLOs and cost review.
- Encrypted, access-restricted remote Terraform state and locking; Redis authentication is sensitive and present in state. Never commit state or real tfvars.
- ACM certificate, DNS, image digests, separate API/worker secret JSON values, database roles and migrations using a one-off owner connection. Do not give owner credentials to serving tasks.
- RDS root CA trust with verified TLS in Node, pgvector extension availability, restored backup tests and key recovery procedures.
- Private embedding/generation services at the supplied endpoints. Terraform does not provision those model servers; permit their network access through the application security group. Model/profile dimensions must remain compatible with existing indexes.
- Cognito account provisioning and a browser login integration. Access-token verification exists, but the local email/password screen is not a live Cognito sign-in flow.
- Alarm delivery destinations, measured scaling rules, operational dashboards and live dependency checks. The template defines queue alarms but does not attach a notification destination.
- Live AWS integration and security verification. Mocked Terraform tests and LocalStack do not establish AWS service parity, IAM enforcement, production availability or compliance.

The next phase is performance/observability optimization. Production deployment is intentionally outstanding until those prerequisites and explicit authorization are satisfied.
