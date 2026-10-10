/** Binary relevance metrics; expected IDs come from human-labelled fixtures, never model scores. */
export function retrievalMetrics(
  actual: string[],
  relevant: string[],
  k: number,
) {
  const truth = new Set(relevant),
    ranked = [...new Set(actual)].slice(0, k);
  const hits = ranked.filter((id) => truth.has(id)).length;
  const first = ranked.findIndex((id) => truth.has(id));
  const dcg = ranked.reduce(
    (n, id, i) => n + (truth.has(id) ? 1 / Math.log2(i + 2) : 0),
    0,
  );
  const ideal = Array.from(
    { length: Math.min(k, truth.size) },
    (_, i) => 1 / Math.log2(i + 2),
  ).reduce((a, b) => a + b, 0);
  return {
    recall: truth.size ? hits / truth.size : 0,
    precision: hits / k,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg: ideal ? dcg / ideal : 0,
  };
}
