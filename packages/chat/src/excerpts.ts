import type { RetrievalMatch } from "../../ingestion/src/retrieval.js";
// Use intact paragraph/list blocks from existing indexed text, retaining provenance.
export function paragraphEvidence(match: RetrievalMatch): RetrievalMatch[] {
  if (match.source.kind === "table") return [match];
  const text = match.text.replace(/\n(?=\s*\d+\)\s*[“"])/g, "\n\n");
  const blocks = text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (blocks.length <= 1) return [match];
  const excerpts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let block = blocks[i]!;
    // Keep short section headings with the paragraph they qualify.
    if (block.length < 100 && !/[.!?]$/.test(block) && i + 1 < blocks.length)
      block += "\n\n" + blocks[++i]!;
    excerpts.push(block);
  }
  return excerpts.map((text) => ({
    ...match,
    text,
    source: { ...match.source, extraction: "indexed-paragraphs-v1" },
  }));
}
