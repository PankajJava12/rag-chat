import { getEncoding } from "js-tiktoken";
import { hash } from "../../security/src/crypto.js";
import type { ParsedSection } from "./parsers.js";
import { AppError } from "../../shared/src/errors.js";
const encoding = getEncoding("cl100k_base");
export interface Chunk {
  text: string;
  hash: string;
  tokenCount: number;
  metadata: Omit<ParsedSection, "text">;
}
export function chunkSections(
  sections: ParsedSection[],
  size = 650,
  overlap = 90,
): Chunk[] {
  if (size < 100 || overlap < 0 || overlap >= size)
    throw new AppError("INVALID_CHUNK_CONFIGURATION");
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const { text, ...metadata } = section;
    const paragraphs = text.split(/\n\s*\n/);
    let pending = "";
    const emit = (value: string) => {
      const tokens = encoding.encode(value);
      if (metadata.kind === "table" && tokens.length > size)
        throw new AppError("TABLE_ROW_TOO_LARGE");
      for (let i = 0; i < tokens.length; i += size - overlap) {
        const part = tokens.slice(i, i + size);
        const content = encoding.decode(part);
        chunks.push({
          text: content,
          hash: hash(content),
          tokenCount: part.length,
          metadata,
        });
        if (i + size >= tokens.length) break;
      }
    };
    for (const paragraph of paragraphs) {
      if (
        pending &&
        encoding.encode(`${pending}\n\n${paragraph}`).length > size
      ) {
        emit(pending);
        const tail = encoding.encode(pending).slice(-overlap);
        pending = overlap ? encoding.decode(tail) : "";
      }
      pending = pending ? `${pending}\n\n${paragraph}` : paragraph;
    }
    if (pending) emit(pending);
  }
  if (chunks.length > 10000) throw new AppError("CHUNK_LIMIT");
  return chunks;
}
