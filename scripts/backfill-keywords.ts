import { ingestionRuntime } from "../packages/ingestion/src/runtime.js";
import { backfillKeywords } from "../packages/ingestion/src/backfill-keywords.js";
import { z } from "zod";
async function main() {
  const tenant = z.uuid().parse(process.argv[2] ?? process.env.LOCAL_TENANT_ID),
    runtime = ingestionRuntime(false);
  try {
    console.log(
      `Keyword index updated: ${await backfillKeywords(runtime.pool, runtime.vault, tenant)} chunks`,
    );
  } finally {
    runtime.closeCache();
    await runtime.pool.end();
  }
}
main().catch(() => {
  console.error(
    "Keyword backfill failed; check tenant, encryption key and migration.",
  );
  process.exitCode = 1;
});
