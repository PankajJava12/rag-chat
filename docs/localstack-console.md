# Licensed LocalStack console

The existing Community 4.12.0 setup runs S3/SQS but cannot connect to the current licensed web console. The optional `docker-compose.localstack-licensed.yml` overlay uses the official current licensed image, pinned to its manifest digest resolved on October 10, 2026.

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
  -f docker-compose.localstack-licensed.yml \
  up -d --no-deps --wait localstack
```

Use the same overlay and environment files on subsequent Compose commands involving LocalStack so it remains on the licensed image.

Check http://localhost:4566/_localstack/health, then open **LocalStack Instances → local instance → Resource Browser** in the web console. Use endpoint `http://localhost:4566` and region `ap-south-1`. Explore S3 bucket `advisor-policies-local` and SQS queues `advisor-ingestion` and `advisor-ingestion-dlq`.

References: [Auth Token](https://docs.localstack.cloud/aws/getting-started/auth-token/), [Docker images](https://docs.localstack.cloud/aws/customization/other-installations/docker-images/).
