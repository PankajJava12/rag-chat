import { createHmac } from "node:crypto";
import { createClient } from "redis";
import type { Embedder } from "./embeddings.js";
import { validateVectors } from "./embeddings.js";
import { Vault } from "../../security/src/crypto.js";
import { cacheEvents } from "../../observability/src/telemetry.js";
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<unknown>;
}
export function queryCache(
  base: Embedder,
  vault: Vault,
  secret: string,
  store: CacheStore,
  ttl = 300,
): Embedder {
  return {
    ...base,
    async embedQuery(tenantId, question, signal) {
      const key =
        "advisor:query:v1:" +
        createHmac("sha256", secret)
          .update(
            JSON.stringify([tenantId, base.model, base.dimensions, question]),
          )
          .digest("hex");
      if (signal?.aborted) throw signal.reason;
      try {
        const cached = await store.get(key);
        if (cached) {
          const vectors: unknown = JSON.parse(
            vault.open(Buffer.from(cached, "base64"), key).toString(),
          );
          validateVectors(vectors, 1, base.dimensions);
          cacheEvents.inc({ result: "hit" });
          return { vectors, inputTokens: 0 };
        }
        cacheEvents.inc({ result: "miss" });
      } catch {
        cacheEvents.inc({ result: "read_error" });
      }
      const result = await base.embed([question], "query", signal);
      try {
        await store.set(
          key,
          vault
            .seal(Buffer.from(JSON.stringify(result.vectors)), key)
            .toString("base64"),
          ttl,
        );
      } catch {
        cacheEvents.inc({ result: "write_error" });
      }
      return result;
    },
  };
}
export function redisQueryCache(url: string) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1000,
      reconnectStrategy: (retries) => Math.min(100 * (retries + 1), 2000),
    },
  });
  client.on("error", () => undefined);
  void client.connect().catch(() => undefined);
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cache deadline")), 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    store: {
      get: (key: string) => bounded(client.get(key)),
      set: (key: string, value: string, ttl: number) =>
        bounded(client.set(key, value, { EX: ttl })),
    },
    close: () => {
      if (client.isOpen) client.destroy();
    },
  };
}
