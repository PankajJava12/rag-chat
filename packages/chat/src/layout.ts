import type { RetrievalMatch } from "../../ingestion/src/retrieval.js";
// Recover reading order from indexed pdftotext -layout output. No stored index changes.
export function columnEvidence(match: RetrievalMatch): RetrievalMatch[] {
  if (match.source.kind !== "paragraph" || !match.source.pageNumber)
    return [match];
  const lines = match.text.split("\n");
  const width = Math.max(...lines.map((l) => l.length));
  if (lines.length < 12 || width < 90) return [match];
  const candidates = [];
  for (let x = Math.floor(width * 0.4); x < width * 0.68; x++) {
    let support = 0,
      crossing = 0;
    for (const line of lines) {
      if (!line.slice(0, x - 4).trim() || !line.slice(x + 4).trim()) continue;
      if (/^\s*$/.test(line.slice(x - 2, x + 3))) support++;
      else crossing++;
    }
    candidates.push({ x, support, crossing, score: support - 2 * crossing });
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0]!;
  if (best.support < 8 || best.crossing > best.support * 0.15) return [match];
  const seam = candidates
    .filter((c) => c.score === best.score)
    .map((c) => c.x)
    .sort((a, b) => a - b);
  const split = seam[Math.floor(seam.length / 2)]!;
  const columns: string[][] = [[], []];
  for (const line of lines) {
    let at = split;
    if (/\S/.test(line.slice(split - 1, split + 1))) {
      // Never split a word. Find a nearby gutter, or keep the whole line intact.
      const gaps = [...line.matchAll(/ {2,}/g)].filter(
        (g) => Math.abs(g.index - split) <= 8,
      );
      const gap = gaps.sort(
        (a, b) => Math.abs(a.index - split) - Math.abs(b.index - split),
      )[0];
      if (!gap) {
        columns[0]!.push(line.trimEnd());
        continue;
      }
      at = gap.index + Math.floor(gap[0].length / 2);
    }
    columns[0]!.push(line.slice(0, at).trimEnd());
    columns[1]!.push(line.slice(at).trimEnd());
  }
  const parts = columns
    .map((column, i) => {
      const nonempty = column.filter((l) => l.trim());
      const indent = Math.min(
        ...nonempty.map((l) => l.length - l.trimStart().length),
      );
      const text = column
        .map((l) => l.slice(indent))
        .join("\n")
        .trim();
      const table =
        /Email ID/i.test(text) && /Desig/i.test(text) && /Resp/i.test(text);
      return {
        ...match,
        text,
        source: {
          ...match.source,
          layoutColumn: i + 1,
          extraction: "indexed-columns-v1",
          kind: table ? "table" : "paragraph",
        },
      };
    })
    .filter((p) => p.text)
    .flatMap((p) => {
      if (p.source.kind !== "table") return [p];
      // A numbered prose clause following a table belongs to a separate excerpt.
      const nextClause = p.text.search(/\n\s*\([ivx]+\)\s+[A-Z]/);
      if (nextClause < 0) return [p];
      return [
        { ...p, text: p.text.slice(0, nextClause).trim() },
        {
          ...p,
          text: p.text.slice(nextClause).trim(),
          source: { ...p.source, kind: "paragraph" },
        },
      ];
    });
  // Keep complete tables within the bounded context ahead of adjacent prose.
  return parts.sort(
    (a, b) =>
      Number(b.source.kind === "table") - Number(a.source.kind === "table"),
  );
}
