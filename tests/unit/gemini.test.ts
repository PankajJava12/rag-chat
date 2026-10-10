import { loadConfig } from "../../packages/shared/src/config.js";
import { createEmbedder } from "../../packages/ai/src/embeddings.js";
import { createGenerator } from "../../packages/chat/src/generation.js";
const env = {
  DATABASE_URL: "postgresql://localhost/advisor",
  REDIS_URL: "redis://localhost:6379",
  CHAT_PROVIDER: "gemini",
  EMBEDDING_PROVIDER: "gemini",
  ALLOW_EXTERNAL_AI: "true",
  GEMINI_API_KEY: "synthetic-key",
};
const config = loadConfig(env);
afterEach(() => jest.restoreAllMocks());
test("Gemini requires external processing opt-in and a key, using the existing 768 dimension schema", () => {
  expect(() => loadConfig({ ...env, ALLOW_EXTERNAL_AI: "false" })).toThrow(
    "ALLOW_EXTERNAL_AI",
  );
  expect(() => loadConfig({ ...env, GEMINI_API_KEY: undefined })).toThrow(
    "GEMINI_API_KEY",
  );
  expect(config.EMBEDDING_DIMENSIONS).toBe(768);
});
test("Gemini preserves batch order, requests retrieval task types, and normalizes reduced embeddings", async () => {
  const vector = Array(768).fill(2);
  const mock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        embeddings: [{ values: vector }, { values: vector }],
      }),
    ),
  );
  const embedder = createEmbedder(config);
  const result = await embedder.embed(["first", "second"]);
  expect(result.vectors).toHaveLength(2);
  expect(Math.hypot(...result.vectors[0]!)).toBeCloseTo(1);
  const body = JSON.parse(String(mock.mock.calls[0]![1]!.body));
  expect(body.requests[0]).toMatchObject({
    outputDimensionality: 768,
    taskType: "RETRIEVAL_DOCUMENT",
    content: { parts: [{ text: "first" }] },
  });
  mock.mockResolvedValue(
    new Response(JSON.stringify({ embeddings: [{ values: vector }] })),
  );
  await embedder.embed(["question"], "query");
  expect(
    JSON.parse(String(mock.mock.calls[1]![1]!.body)).requests[0].taskType,
  ).toBe("RETRIEVAL_QUERY");
});
test("Gemini authentication failures do not retry or expose the provider response", async () => {
  const mock = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("private upstream error", { status: 403 }));
  await expect(createEmbedder(config).embed(["text"])).rejects.toMatchObject({
    code: "EMBEDDING_REQUEST_REJECTED",
  });
  expect(mock).toHaveBeenCalledTimes(1);
});
test("Gemini uses grounded structured output and reports token usage", async () => {
  const text = JSON.stringify({
    status: "INSUFFICIENT_EVIDENCE",
    citations: [],
  });
  const mock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10 },
      }),
    ),
  );
  const result = await createGenerator(config).generate(
    "Question?",
    [],
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    text,
    inputTokens: 40,
    outputTokens: 10,
    model: "gemini:gemini-2.5-flash",
  });
  const body = JSON.parse(String(mock.mock.calls[0]![1]!.body));
  expect(body.generationConfig).toMatchObject({
    responseMimeType: "application/json",
    responseJsonSchema: { type: "object" },
  });
  expect(body.systemInstruction.parts[0].text).toContain("evidence");
});
test("Gemini truncation is rejected without returning partial JSON", async () => {
  jest.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "MAX_TOKENS",
            content: { parts: [{ text: "partial" }] },
          },
        ],
      }),
    ),
  );
  await expect(
    createGenerator(config).generate(
      "Question?",
      [],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
});

test("Gemini quota backoff remains cancellable without sending another request", async () => {
  const controller = new AbortController();
  const mock = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: { details: [{ retryDelay: "30s" }] } }),
        { status: 429 },
      ),
    );
  const result = createEmbedder(config).embed(
    ["text"],
    "query",
    controller.signal,
  );
  setTimeout(() => controller.abort(), 10);
  await expect(result).rejects.toMatchObject({ code: "CHAT_CANCELLED" });
  expect(mock).toHaveBeenCalledTimes(1);
});
