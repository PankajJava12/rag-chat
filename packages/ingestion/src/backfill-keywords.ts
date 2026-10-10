import type { Pool } from "pg";
import type { Vault } from "../../security/src/crypto.js";
import { withTenant } from "../../database/src/tenant.js";
import {
  KEYWORD_PROFILE,
  keywordVector,
} from "../../ai/src/retrieval/keywords.js";
export async function backfillKeywords(
  pool: Pool,
  vault: Vault,
  tenantId: string,
) {
  let count = 0;
  while (true) {
    const updated = await withTenant(pool, tenantId, async (c) => {
      const rows = await c.query(
        "SELECT id,content FROM document_chunks WHERE tenant_id=$1 AND keyword_profile IS DISTINCT FROM $2 ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
        [tenantId, KEYWORD_PROFILE],
      );
      for (const row of rows.rows)
        await c.query(
          "UPDATE document_chunks SET keyword_vector=$2::tsvector,keyword_profile=$3 WHERE tenant_id=$4 AND id=$1",
          [
            row.id,
            keywordVector(
              vault.openText(row.content, `${tenantId}:${row.id}`),
              tenantId,
              vault,
            ),
            KEYWORD_PROFILE,
            tenantId,
          ],
        );
      return rows.rowCount ?? 0;
    });
    count += updated;
    if (!updated) return count;
  }
}
