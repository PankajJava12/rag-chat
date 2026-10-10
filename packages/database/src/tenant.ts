import type { Pool, PoolClient } from "pg";
import { z } from "zod";
// Invoke only with tenant identity resolved from verified authentication, never a client-supplied header.
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  z.uuid().parse(tenantId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
