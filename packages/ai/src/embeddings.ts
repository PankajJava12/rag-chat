import { observed, recordUsage } from "../../observability/src/telemetry.js";
import OpenAI from "openai";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../../shared/src/config.js";
import { AppError } from "../../shared/src/errors.js";
export interface EmbeddingResult {
  vectors: number[][];
  inputTokens: number;
}
export interface Embedder {
  embedQuery?(
    tenantId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<EmbeddingResult>;
  model: string;
  dimensions: number;
  embed(
    texts: string[],
    purpose?: "document" | "query",
    signal?: AbortSignal,
  ): Promise<EmbeddingResult>;
}
export function validateVectors(
  vectors: unknown,
  count: number,
  dimensions: number,
): asserts vectors is number[][] {
  if (
    !Array.isArray(vectors) ||
    vectors.length !== count ||
    vectors.some(
      (v) =>
        !Array.isArray(v) ||
        v.length !== dimensions ||
        v.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
        v.every((n) => n === 0),
    )
  )
    throw new AppError("INVALID_EMBEDDING_RESPONSE", 502, true);
}
function createEmbedderInternal(config: Config): Embedder {
  const dimensions = config.EMBEDDING_PROVIDER === "openai" ? 1536 : 768;
  const model = `${config.EMBEDDING_PROVIDER}:${config.EMBEDDING_PROVIDER === "ollama" ? config.OLLAMA_MODEL : config.EMBEDDING_PROVIDER === "gemini" ? config.GEMINI_EMBEDDING_MODEL : config.OPENAI_EMBEDDING_MODEL}`;
  const openai =
    config.EMBEDDING_PROVIDER === "openai"
      ? new OpenAI({
          apiKey: config.OPENAI_API_KEY,
          maxRetries: 0,
          timeout: 60000,
        })
      : undefined;
  return {
    model,
    dimensions,
    async embed(texts, purpose = "document", signal) {
      if (!texts.length) return { vectors: [], inputTokens: 0 };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let vectors: unknown;
          let inputTokens = 0;
          if (openai) {
            const result = await openai.embeddings.create(
              {
                model: config.OPENAI_EMBEDDING_MODEL,
                input: texts,
                dimensions,
                encoding_format: "float",
              },
              { signal },
            );
            vectors = result.data
              .sort((a, b) => a.index - b.index)
              .map((d) => d.embedding);
            inputTokens = result.usage.total_tokens;
          } else if (config.EMBEDDING_PROVIDER === "gemini") {
            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.GEMINI_EMBEDDING_MODEL)}:batchEmbedContents`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": config.GEMINI_API_KEY!,
                },
                body: JSON.stringify({
                  requests: texts.map((text) => ({
                    model: `models/${config.GEMINI_EMBEDDING_MODEL}`,
                    content: { parts: [{ text }] },
                    taskType:
                      purpose === "query"
                        ? "RETRIEVAL_QUERY"
                        : "RETRIEVAL_DOCUMENT",
                    outputDimensionality: dimensions,
                  })),
                }),
                signal: signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
                  : AbortSignal.timeout(60000),
              },
            );
            if (response.status === 429 && attempt < 2) {
              // A short exponential retry cannot recover a per-minute quota.
              // Respect Google's retry guidance while the ingestion lease renews.
              const error = (await response.json().catch(() => ({}))) as {
                error?: { details?: { retryDelay?: string }[] };
              };
              const retryDelay = error.error?.details?.find(
                (d) => d.retryDelay,
              )?.retryDelay;
              const seconds = Number(
                response.headers.get("retry-after") ??
                  retryDelay?.replace(/s$/, "") ??
                  60,
              );
              await delay(
                Math.min(
                  60000,
                  Math.max(
                    1000,
                    (Number.isFinite(seconds) ? seconds : 60) * 1000,
                  ),
                ),
                undefined,
                { signal },
              );
            }
            if (!response.ok)
              throw new AppError(
                "EMBEDDING_REQUEST_REJECTED",
                502,
                response.status === 429 || response.status >= 500,
              );
            const result = (await response.json()) as {
              embeddings?: { values: unknown }[];
              usageMetadata?: { totalTokenCount?: number };
            };
            vectors = result.embeddings?.map((e) => e.values);
            inputTokens = result.usageMetadata?.totalTokenCount ?? 0;
            validateVectors(vectors, texts.length, dimensions);
            // Reduced Gemini embeddings need unit normalization for cosine retrieval.
            vectors = vectors.map((v) => {
              const norm = Math.hypot(...v);
              return v.map((n) => n / norm);
            });
          } else {
            const response = await fetch(`${config.OLLAMA_URL}/api/embed`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: config.OLLAMA_MODEL,
                input: texts.map(
                  (t) =>
                    `${purpose === "query" ? "search_query" : "search_document"}: ${t}`,
                ),
                truncate: false,
                keep_alive: "10m",
              }),
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
                : AbortSignal.timeout(60000),
            });
            if (!response.ok)
              throw new AppError(
                response.status === 400
                  ? "EMBEDDING_INPUT_REJECTED"
                  : "EMBEDDING_UNAVAILABLE",
                502,
                response.status === 429 || response.status >= 500,
              );
            const result = (await response.json()) as {
              embeddings: unknown;
              prompt_eval_count?: number;
            };
            vectors = result.embeddings;
            inputTokens = result.prompt_eval_count ?? 0;
          }
          validateVectors(vectors, texts.length, dimensions);
          return { vectors, inputTokens };
        } catch (error) {
          if (signal?.aborted) throw new AppError("CHAT_CANCELLED", 499);
          const retryable =
            error instanceof AppError
              ? error.retryable
              : error instanceof OpenAI.APIError
                ? error.status === 429 || (error.status ?? 500) >= 500
                : true;
          if (!retryable)
            throw error instanceof AppError
              ? error
              : new AppError("EMBEDDING_REQUEST_REJECTED", 502);
          if (attempt === 2)
            throw new AppError("EMBEDDING_UNAVAILABLE", 503, true);
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 200),
          );
        }
      }
      throw new AppError("EMBEDDING_UNAVAILABLE", 503, true);
    },
  };
}

export function createEmbedder(config: Config): Embedder {
  const base = createEmbedderInternal(config);
  return {
    ...base,
    embed: (texts, purpose = "document", signal) =>
      observed(
        purpose === "query" ? "embedding.query" : "embedding.document",
        async () => {
          const result = await base.embed(texts, purpose, signal);
          recordUsage(
            config.EMBEDDING_PROVIDER,
            "embedding",
            result.inputTokens,
          );
          return result;
        },
      ),
  };
}
