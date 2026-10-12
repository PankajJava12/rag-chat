import { observed, recordUsage } from "../../observability/src/telemetry.js";
import OpenAI from "openai";
import type { Logger } from "pino";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../../shared/src/config.js";
import { AppError } from "../../shared/src/errors.js";
import { SYSTEM_PROMPT, outputSchema, type Evidence } from "./grounding.js";
// Bind intact excerpts to their source IDs during local constrained decoding.
// Longer/raw chunks retain free quotation selection and server-side validation.
export function ollamaOutputSchema(evidence: Evidence[]) {
  if (!evidence.length) return outputSchema;
  const citations = evidence.map((e) => ({
    type: "object",
    properties: {
      sourceId: { type: "string", const: e.sourceId },
      quote:
        e.text.length >= 8 &&
        e.text.length <= 3000 &&
        (e.source.extraction === "indexed-paragraphs-v1" ||
          e.source.kind === "table")
          ? { type: "string", const: e.text }
          : { type: "string", minLength: 8, maxLength: 3000 },
    },
    required: ["sourceId", "quote"],
    additionalProperties: false,
  }));
  return {
    ...outputSchema,
    properties: {
      ...outputSchema.properties,
      citations: { type: "array", items: { anyOf: citations }, maxItems: 4 },
    },
  };
}
export interface Generation {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}
export interface Generator {
  model: string;
  generate(
    question: string,
    evidence: Evidence[],
    signal: AbortSignal,
  ): Promise<Generation>;
}
function createGeneratorInternal(config: Config, logger?: Logger): Generator {
  const model =
    config.CHAT_PROVIDER === "ollama"
      ? config.OLLAMA_CHAT_MODEL
      : config.CHAT_PROVIDER === "gemini"
        ? config.GEMINI_MODEL
        : config.OPENAI_MODEL;
  const openai =
    config.CHAT_PROVIDER === "openai"
      ? new OpenAI({
          apiKey: config.OPENAI_API_KEY,
          maxRetries: 0,
          timeout: config.CHAT_TIMEOUT_MS,
        })
      : undefined;
  return {
    model: `${config.CHAT_PROVIDER}:${model}`,
    async generate(question, evidence, signal) {
      const started = performance.now();
      let frameCount = 0;
      const input = JSON.stringify({
        question,
        evidence: evidence.map((e) => ({ sourceId: e.sourceId, text: e.text })),
      });
      const bounded = AbortSignal.any([
        signal,
        AbortSignal.timeout(config.CHAT_TIMEOUT_MS),
      ]);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          let text = "",
            inputTokens = 0,
            outputTokens = 0,
            completed = false;
          if (openai) {
            const stream = await openai.responses.create(
              {
                model,
                store: false,
                instructions: SYSTEM_PROMPT,
                input,
                text: {
                  format: {
                    type: "json_schema",
                    name: "policy_evidence",
                    strict: true,
                    schema: outputSchema,
                  },
                },
                max_output_tokens: config.CHAT_MAX_OUTPUT_TOKENS,
                stream: true,
              },
              { signal: bounded },
            );
            for await (const event of stream) {
              if (event.type === "response.output_text.delta")
                text += event.delta;
              if (event.type === "response.completed") {
                completed = true;
                inputTokens = event.response.usage?.input_tokens ?? 0;
                outputTokens = event.response.usage?.output_tokens ?? 0;
              }
              if (text.length > 24000)
                throw new AppError("MODEL_OUTPUT_LIMIT", 502);
            }
          } else if (config.CHAT_PROVIDER === "gemini") {
            const { $schema: _schema, ...schema } = outputSchema;
            void _schema;
            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": config.GEMINI_API_KEY!,
                },
                signal: bounded,
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                  contents: [{ role: "user", parts: [{ text: input }] }],
                  generationConfig: {
                    temperature: 0,
                    maxOutputTokens: config.CHAT_MAX_OUTPUT_TOKENS,
                    thinkingConfig: { thinkingBudget: 0 },
                    responseMimeType: "application/json",
                    responseJsonSchema: schema,
                  },
                }),
              },
            );
            if (!response.ok)
              throw new AppError(
                "MODEL_UNAVAILABLE",
                503,
                response.status === 429 || response.status >= 500,
              );
            const result = (await response.json()) as {
              candidates?: {
                content?: { parts?: { text?: string; thought?: boolean }[] };
                finishReason?: string;
              }[];
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
              };
            };
            const candidate = result.candidates?.[0];
            if (candidate?.finishReason === "MAX_TOKENS")
              throw new AppError("MODEL_OUTPUT_LIMIT", 502);
            text =
              candidate?.content?.parts
                ?.filter((p) => !p.thought)
                .map((p) => p.text ?? "")
                .join("") ?? "";
            if (text.length > 24000)
              throw new AppError("MODEL_OUTPUT_LIMIT", 502);
            completed = candidate?.finishReason === "STOP" && text.length > 0;
            inputTokens = result.usageMetadata?.promptTokenCount ?? 0;
            outputTokens = result.usageMetadata?.candidatesTokenCount ?? 0;
          } else {
            const response = await fetch(
              `${config.OLLAMA_CHAT_URL ?? config.OLLAMA_URL}/api/chat`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: bounded,
                body: JSON.stringify({
                  model,
                  stream: true,
                  format: ollamaOutputSchema(evidence),
                  keep_alive: "5m",
                  messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: input },
                  ],
                  options: {
                    temperature: 0,
                    seed: 42,
                    num_ctx: 4096,
                    num_thread: 4,
                    num_batch: 128,
                    num_predict: config.CHAT_MAX_OUTPUT_TOKENS,
                  },
                }),
              },
            );
            if (!response.ok || !response.body)
              throw new AppError(
                "MODEL_UNAVAILABLE",
                503,
                response.status === 429 || response.status >= 500,
              );
            const reader = response.body.getReader(),
              decoder = new TextDecoder();
            let pending = "";
            const consume = (line: string) => {
              if (!line.trim()) return;
              const frame = JSON.parse(line);
              frameCount++;
              if (frame.error)
                throw new AppError("MODEL_UNAVAILABLE", 503, true);
              text += frame.message?.content ?? "";
              if (frame.done) {
                if (frame.done_reason === "length")
                  throw new AppError("MODEL_OUTPUT_LIMIT", 502);
                completed = true;
                inputTokens = frame.prompt_eval_count ?? 0;
                outputTokens = frame.eval_count ?? 0;
              }
              if (text.length > 24000)
                throw new AppError("MODEL_OUTPUT_LIMIT", 502);
            };
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                pending += decoder.decode(value, { stream: true });
                if (pending.length > 64000)
                  throw new AppError("MODEL_OUTPUT_LIMIT", 502);
                let newline;
                while ((newline = pending.indexOf("\n")) >= 0) {
                  consume(pending.slice(0, newline));
                  pending = pending.slice(newline + 1);
                }
              }
              consume(pending + decoder.decode());
            } finally {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          }
          if (!completed) throw new AppError("MODEL_INCOMPLETE", 502, true);
          logger?.info(
            {
              model,
              durationMs: Math.round(performance.now() - started),
              inputTokens,
              outputTokens,
              frameCount,
            },
            "model_completed",
          );
          return {
            text,
            inputTokens,
            outputTokens,
            model: `${config.CHAT_PROVIDER}:${model}`,
          };
        } catch (error) {
          if (signal.aborted) throw new AppError("CHAT_CANCELLED", 499);
          if (bounded.aborted) {
            logger?.warn(
              {
                model,
                durationMs: Math.round(performance.now() - started),
                frameCount,
                timeoutMs: config.CHAT_TIMEOUT_MS,
              },
              "model_timeout",
            );
            throw new AppError("MODEL_TIMEOUT", 504, true);
          }
          const retryable =
            error instanceof AppError
              ? error.retryable
              : error instanceof OpenAI.APIError
                ? error.status === 429 || (error.status ?? 500) >= 500
                : true;
          if (!retryable || attempt === 1)
            throw error instanceof AppError
              ? error
              : new AppError("MODEL_UNAVAILABLE", 503, true);
          await delay(300 + Math.random() * 200, undefined, {
            signal: bounded,
          });
        }
      }
      throw new AppError("MODEL_UNAVAILABLE", 503, true);
    },
  };
}

export function createGenerator(config: Config, logger?: Logger): Generator {
  const base = createGeneratorInternal(config, logger);
  return {
    ...base,
    generate: (...args) =>
      observed("generation.answer", async () => {
        const result = await base.generate(...args);
        recordUsage(
          config.CHAT_PROVIDER,
          "generation",
          result.inputTokens,
          result.outputTokens,
        );
        return result;
      }),
  };
}
