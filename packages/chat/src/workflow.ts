import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import {
  buildContext,
  completeTableDraft,
  validateDraft,
  suspicious,
  hasTopicSupport,
  waitingPeriodConflict,
  type Evidence,
  type Match,
} from "./grounding.js";
import { rewriteQuery, type Memory } from "./memory.js";
import type { Generator } from "./generation.js";
export interface WorkflowResult {
  draft: string;
  query: string;
  usedHistory: boolean;
  context: ReturnType<typeof buildContext>;
  result: ReturnType<typeof validateDraft>;
  inputTokens: number;
  outputTokens: number;
  stages: string[];
}
export async function runRagWorkflow(options: {
  question: string;
  memory: Memory;
  budget: number;
  generator: Generator;
  signal: AbortSignal;
  status: (s: string) => void;
  retrieve: (query: string) => Promise<Match[]>;
}): Promise<WorkflowResult> {
  const State = Annotation.Root({ data: Annotation<WorkflowResult>() });
  const step =
    (
      name: string,
      work: (
        s: WorkflowResult,
      ) => Promise<Partial<WorkflowResult>> | Partial<WorkflowResult>,
    ) =>
    async (s: typeof State.State) => {
      options.signal.throwIfAborted();
      options.status(name);
      const update = await work(s.data);
      return {
        data: { ...s.data, ...update, stages: [...s.data.stages, name] },
      };
    };
  const graph = new StateGraph(State)
    .addNode(
      "rewriting",
      step("rewriting", () => {
        const rewrite = rewriteQuery(options.question, options.memory);
        return { query: rewrite.query, usedHistory: rewrite.usedHistory };
      }),
    )
    .addNode(
      "retrieving",
      step("retrieving", async (s) => ({
        context: buildContext(
          await options.retrieve(s.query),
          options.budget,
          s.query,
        ),
      })),
    )
    .addNode(
      "generating",
      step("generating", async (s) => {
        if (
          !s.context.evidence.length ||
          suspicious(options.question) ||
          !hasTopicSupport(
            s.query,
            s.context.evidence.map((e) => e.text),
          )
        )
          return {};
        const tableDraft = completeTableDraft(s.query, s.context.evidence);
        if (tableDraft) return { draft: tableDraft };
        const generated = await options.generator.generate(
          s.query,
          s.context.evidence.filter(
            (e) =>
              e.source.extraction !== "indexed-paragraphs-v1" ||
              hasTopicSupport(s.query, [e.text]),
          ),
          options.signal,
        );
        return {
          draft: generated.text,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens,
        };
      }),
    )
    .addNode(
      "validating",
      step("validating", (s) => ({
        result: validateDraft(
          !suspicious(options.question)
            ? (waitingPeriodConflict(s.query, s.context.evidence) ?? s.draft)
            : s.draft,
          s.context.evidence,
          s.query,
        ),
      })),
    )
    .addEdge(START, "rewriting")
    .addEdge("rewriting", "retrieving")
    .addEdge("retrieving", "generating")
    .addEdge("generating", "validating")
    .addEdge("validating", END)
    .compile();
  const initial: WorkflowResult = {
    draft: "{}",
    query: options.question,
    usedHistory: false,
    context: { evidence: [] as Evidence[], tokens: 0 },
    result: validateDraft("{}", []),
    inputTokens: 0,
    outputTokens: 0,
    stages: [],
  };
  return (
    await graph.invoke(
      { data: initial },
      { signal: options.signal, recursionLimit: 8 },
    )
  ).data;
}
