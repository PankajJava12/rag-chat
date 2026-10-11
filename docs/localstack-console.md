# Licensed LocalStack console

The main `docker-compose.localstack.yml` overlay uses licensed LocalStack 2026.9.1, pinned to the official image manifest digest resolved on October 10, 2026. Both the licensed image and `LOCALSTACK_AUTH_TOKEN` are required for the web console. The previous Community 4.12.0 image could run S3/SQS but could not connect to this console. The separate licensed overlay has been removed.

Sign in at https://app.localstack.cloud and obtain a Developer Auth Token from **Auth Tokens**. Your account needs an active license that includes the Resource Browser. Put the token in `.env.localstack` at the project root:

```dotenv
LOCALSTACK_AUTH_TOKEN=your-token
```

This file is ignored by Git. Restrict its permissions with `chmod 600 .env.localstack`. Do not paste the token into chat or commit it.

The existing instance has `PERSISTENCE=0`. Recreating it clears current emulator S3 objects and SQS messages. Preserve any needed emulator data before upgrading. The bootstrap script recreates the application bucket and queues; it does not restore their contents. PostgreSQL and local source recovery files are separate from the emulator.

From the project root, upgrade only LocalStack:

```sh
docker compose --env-file .env.development --env-file .env.localstack \
  -f docker-compose.yml -f docker-compose.localstack.yml \
  up -d --no-deps --wait localstack
```

Use the same environment files on subsequent Compose commands involving LocalStack. `npm run localstack:up` loads both files. CI instead supplies a CI Auth Token through the `LOCALSTACK_AUTH_TOKEN` repository secret; a Developer token is for your workstation. Historical phase runbooks omitted the token because they used the old Community image.

Check http://localhost:4566/_localstack/health, then open **LocalStack Instances → local instance → Resource Browser** in the web console. Use endpoint `http://localhost:4566` and region `ap-south-1`. Explore S3 bucket `advisor-policies-local` and SQS queues `advisor-ingestion` and `advisor-ingestion-dlq`.

References: [Auth Token](https://docs.localstack.cloud/aws/getting-started/auth-token/), [Docker images](https://docs.localstack.cloud/aws/customization/other-installations/docker-images/).

## Verification scope

On October 10, 2026, the upgrade session observed version 2026.9.1, Pro edition, successful trial license activation, running S3/SQS, and successful `10-resources.sh` initialization. The web console showed `advisor-policies-local` in `ap-south-1`; both queue names were confirmed through the CLI. The bucket and queues were empty before recreation. This was a runtime readiness check, not an application regression suite. On October 11, the same image and token configuration were consolidated into the main overlay; Compose configuration was checked with placeholder credentials. CI execution with its new secret remains unverified.
