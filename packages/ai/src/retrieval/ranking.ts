import { terms } from "./keywords.js";
export interface Ranked {
  chunkId: string;
  text: string;
  distance: number;
  fusionScore?: number;
  rerankScore?: number;
  semanticRank?: number;
  keywordRank?: number;
}
export function reciprocalRankFusion<T extends { id: string }>(
  semantic: T[],
  keyword: T[],
  k = 60,
) {
  const result = new Map<
    string,
    T & { fusionScore: number; semanticRank?: number; keywordRank?: number }
  >();
  for (const [list, kind] of [
    [semantic, "semanticRank"],
    [keyword, "keywordRank"],
  ] as const)
    list.forEach((row, i) => {
      const value: T & {
        fusionScore: number;
        semanticRank?: number;
        keywordRank?: number;
      } = result.get(row.id) ?? { ...row, fusionScore: 0 };
      value.fusionScore += 1 / (k + i + 1);
      value[kind] = i + 1;
      result.set(row.id, value);
    });
  return [...result.values()].sort(
    (a, b) => b.fusionScore - a.fusionScore || a.id.localeCompare(b.id),
  );
}
export interface Reranker {
  name: string;
  rank<T extends Ranked>(question: string, matches: T[]): T[];
}
// Deterministic local second-stage reranker: query coverage, exact identifiers and cosine relevance.
// Scores are ranking signals, never calibrated confidence. No additional model download is required.
export const localReranker: Reranker = {
  name: "lexical-cosine-v2",
  rank(question, matches) {
    const query = [
      ...new Set(terms(question.replace(/\bin short\b|\bbriefly\b/gi, ""))),
    ];
    const headingQuery = query.filter(
      (t) => !(t === "plan" && query.includes("option")),
    );
    return matches
      .map((m) => {
        const doc = new Set(terms(m.text)),
          coverage = query.length
            ? query.filter((t) => doc.has(t)).length / query.length
            : 0;
        const identifiers = query.filter((t) => /[0-9]/.test(t)),
          exact = identifiers.length
            ? identifiers.filter((t) => doc.has(t)).length / identifiers.length
            : 0;
        const headings = m.text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length < 100 && /^(?:\(\d+\)|\d+[).])\s+/.test(l));
        const headingCoverage = Math.max(
          0,
          ...headings.map((l) => {
            const words = new Set(terms(l));
            return headingQuery.length
              ? headingQuery.filter((t) => words.has(t)).length /
                  headingQuery.length
              : 0;
          }),
        );
        const cosine = Math.max(0, Math.min(1, 1 - m.distance));
        return {
          ...m,
          rerankScore:
            0.6 * coverage +
            0.25 * cosine +
            0.15 * exact +
            0.35 * headingCoverage,
        };
      })
      .sort(
        (a, b) =>
          (b.rerankScore ?? 0) - (a.rerankScore ?? 0) ||
          (b.fusionScore ?? 0) - (a.fusionScore ?? 0) ||
          a.chunkId.localeCompare(b.chunkId),
      );
  },
};
