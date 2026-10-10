import { readFileSync } from "node:fs";
import {
  buildContext,
  validateDraft,
  type Match,
} from "../../packages/chat/src/grounding.js";
import { paragraphEvidence } from "../../packages/chat/src/excerpts.js";
import { localReranker } from "../../packages/ai/src/retrieval/ranking.js";
const matches = JSON.parse(
  readFileSync("tests/fixtures/wealth-excerpts.json", "utf8"),
) as Match[];
test("the actual numbered Sum Assured definition is quoted with its clause number and page", () => {
  const context = buildContext(
    localReranker.rank("Sum Assured", matches),
    2000,
    "Sum Assured",
  );
  const source = context.evidence.find((e) =>
    e.text.startsWith("49) “Sum Assured”"),
  )!;
  expect(source).toBeDefined();
  const quote = source.text.slice(source.text.indexOf("“Sum Assured”"));
  const answer = validateDraft(
    JSON.stringify({
      status: "ANSWER",
      citations: [{ sourceId: source.sourceId, quote }],
    }),
    context.evidence,
    "Sum Assured",
  );
  expect(answer.insufficientEvidence).toBe(false);
  expect(answer.citations[0]).toMatchObject({ source: { pageNumber: 9 } });
  expect(answer.citations[0]!.quote).toMatch(/^49\)/);
  expect(answer.citations[0]!.quote).toContain("terms and conditions");
});
test("a bounded overview context retains all three option sections ahead of unrelated pages", () => {
  const question = "Plan Options in short";
  const context = buildContext(
    localReranker.rank(question, matches).slice(0, 8),
    2000,
    question,
  );
  const choices = [
    "Invest Plus Option",
    "Premium Waiver Option",
    "Golden Years Benefit Option",
  ];
  const evidence = choices.map((choice) =>
    context.evidence.find(
      (e) => e.text.includes(choice) && /^\(?\d+\)|^Plan Options/.test(e.text),
    )!,
  );
  expect(evidence.every(Boolean)).toBe(true);
  expect(context.tokens).toBeLessThanOrEqual(2000);
  const answer = validateDraft(
    JSON.stringify({
      status: "ANSWER",
      citations: evidence.map((e) => ({ sourceId: e.sourceId, quote: e.text })),
    }),
    context.evidence,
    question,
  );
  expect(answer.insufficientEvidence).toBe(false);
  for (const choice of choices) expect(answer.answer).toContain(choice);
  expect(answer.answer).toContain("limited pay and regular pay only");
});
test("paragraph expansion retains negations and qualifiers, while invented values remain rejected", () => {
  const match = {
    ...matches[0]!,
    text: "Heading\n\nRoom rent is covered. Coverage is not available during the first 30 days.",
  };
  const excerpts = paragraphEvidence(match);
  const context = buildContext(excerpts, 2000, "Room rent");
  const source = context.evidence[0]!;
  const draft = (quote: string) =>
    JSON.stringify({
      status: "ANSWER",
      citations: [{ sourceId: source.sourceId, quote }],
    });
  const answer = validateDraft(
    draft("Room rent is covered."),
    context.evidence,
    "Room rent",
  );
  expect(answer.answer).toContain("not available during the first 30 days");
  expect(
    validateDraft(
      draft("Room rent is covered up to INR 7000."),
      context.evidence,
      "Room rent",
    ).insufficientEvidence,
  ).toBe(true);
});
