import { randomBytes, randomUUID } from "node:crypto";
import {
  queryCache,
  type CacheStore,
} from "../../packages/ai/src/query-cache.js";
import type { Embedder } from "../../packages/ai/src/embeddings.js";
import { Vault } from "../../packages/security/src/crypto.js";
import {
  registry,
  observed,
  recordUsage,
} from "../../packages/observability/src/telemetry.js";
const secret = randomBytes(32).toString("hex"),
  vault = new Vault(secret);
function fixture() {
  const values = new Map<string, string>(),
    base: Embedder = {
      model: "fixture:v1",
      dimensions: 3,
      embed: jest.fn(async () => ({ vectors: [[1, 2, 3]], inputTokens: 5 })),
    };
  const store: CacheStore = {
    get: jest.fn(async (key) => values.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      values.set(key, value);
    }),
  };
  return {
    values,
    base,
    store,
    cached: queryCache(base, vault, secret, store, 60),
  };
}
test("query cache hides question/vectors and partitions tenant/model profiles", async () => {
  const f = fixture(),
    tenant = randomUUID(),
    question = "Private coverage phrase";
  await f.cached.embedQuery!(tenant, question);
  expect((await f.cached.embedQuery!(tenant, question)).inputTokens).toBe(0);
  expect(f.base.embed).toHaveBeenCalledTimes(1);
  const [key, value] = [...f.values.entries()][0]!;
  expect(key).not.toContain(question);
  expect(value).not.toContain("[1,2,3]");
  expect(vault.open(Buffer.from(value, "base64"), key).toString()).toBe(
    "[[1,2,3]]",
  );
  expect(f.store.set).toHaveBeenCalledWith(key, value, 60);
  await f.cached.embedQuery!(randomUUID(), question);
  expect(f.base.embed).toHaveBeenCalledTimes(2);
  const different = queryCache(
    { ...f.base, model: "fixture:v2" },
    vault,
    secret,
    f.store,
  );
  await different.embedQuery!(tenant, question);
  expect(f.base.embed).toHaveBeenCalledTimes(3);
});
test("corrupted ciphertext and Redis outage fail open to fresh embeddings", async () => {
  const f = fixture(),
    tenant = randomUUID();
  await f.cached.embedQuery!(tenant, "query");
  for (const key of f.values.keys()) f.values.set(key, "corrupt");
  await f.cached.embedQuery!(tenant, "query");
  expect(f.base.embed).toHaveBeenCalledTimes(2);
  (f.store.get as jest.Mock).mockRejectedValue(new Error("Redis unavailable"));
  (f.store.set as jest.Mock).mockRejectedValue(new Error("Redis unavailable"));
  expect((await f.cached.embedQuery!(tenant, "query")).vectors).toEqual([
    [1, 2, 3],
  ]);
});
test("document embeddings bypass the query cache and canceled requests do not read it", async () => {
  const f = fixture();
  await f.cached.embed(["document"], "document");
  expect(f.store.get).not.toHaveBeenCalled();
  const c = new AbortController();
  c.abort();
  await expect(
    f.cached.embedQuery!(randomUUID(), "query", c.signal),
  ).rejects.toBeDefined();
  expect(f.store.get).not.toHaveBeenCalled();
});
test("metrics use bounded stage labels and never include failure messages", async () => {
  await expect(
    observed("fixture.stage", async () => {
      throw new Error("Sensitive secret question");
    }),
  ).rejects.toThrow();
  recordUsage("ollama", "embedding", 12);
  const metrics = await registry.metrics();
  expect(metrics).toContain('operation="fixture.stage",outcome="error"');
  expect(metrics).not.toContain("Sensitive secret question");
  expect(metrics).toContain("advisor_model_tokens_total");
});
test("cost counters require supplied API prices and exclude local Ollama", async () => {
  const previous = process.env.EMBEDDING_INPUT_USD_PER_MILLION;
  process.env.EMBEDDING_INPUT_USD_PER_MILLION = "3";
  try {
    recordUsage("ollama", "embedding", 1000000);
    const before = await registry.metrics();
    expect(before).not.toMatch(
      /advisor_model_estimated_usd_total\{[^}]*purpose="embedding"[^}]*\} [1-9]/,
    );
    recordUsage("openai", "embedding", 1000000);
    const after = await registry.metrics();
    expect(after).toMatch(
      /advisor_model_estimated_usd_total\{[^}]*purpose="embedding"[^}]*\} 3/,
    );
  } finally {
    if (previous === undefined)
      delete process.env.EMBEDDING_INPUT_USD_PER_MILLION;
    else process.env.EMBEDDING_INPUT_USD_PER_MILLION = previous;
  }
});
