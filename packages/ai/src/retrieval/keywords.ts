import type { Vault } from "../../../security/src/crypto.js";
// Versioned normalization must be shared by indexing, query and reranking.
export const KEYWORD_PROFILE = "blind-en-v1";
const stop = new Set(
  "a an and are as at be by can could do does for from had has have how i in is it its may me of on or our please should that the their them there these this to was were what when which who why will with would you your about policy policies document documents".split(
    " ",
  ),
);
export function terms(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*/gu) ?? []
  )
    .filter((word) => !stop.has(word) && word.length <= 80)
    .map((word) =>
      word.length > 4 && word.endsWith("ies")
        ? word.slice(0, -3) + "y"
        : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
          ? word.slice(0, -1)
          : word,
    );
}
function keyed(text: string, tenant: string, vault: Vault) {
  return terms(text)
    .slice(0, 8000)
    .map((word) => vault.fingerprint(word, `${tenant}:${KEYWORD_PROFILE}`));
}
export function keywordVector(text: string, tenant: string, vault: Vault) {
  // Only generated hex strings and integer positions enter the tsvector representation.
  const positions = new Map<string, number[]>();
  keyed(text, tenant, vault).forEach((word, i) => {
    const list = positions.get(word) ?? [];
    if (list.length < 256) list.push(i + 1);
    positions.set(word, list);
  });
  return [...positions]
    .map(([word, list]) => `'${word}':${list.join(",")}`)
    .join(" ");
}
export function keywordQuery(text: string, tenant: string, vault: Vault) {
  return [...new Set(keyed(text, tenant, vault))]
    .slice(0, 32)
    .map((word) => `'${word}'`)
    .join(" | ");
}
