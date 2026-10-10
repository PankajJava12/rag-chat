import { readFileSync } from "node:fs";
import { columnEvidence } from "../../packages/chat/src/layout.js";
import {
  buildContext,
  completeTableDraft,
  validateDraft,
} from "../../packages/chat/src/grounding.js";
const match = {
  chunkId: "layout",
  documentId: "doc",
  documentName: "Uday",
  versionId: "version",
  version: 1,
  distance: 0.1,
  source: { kind: "paragraph", pageNumber: 13 },
  text: readFileSync("tests/fixtures/uday-escalation-layout.txt", "utf8"),
};
test("two-column PDF evidence preserves every word while isolating the complete escalation table", () => {
  const parts = columnEvidence(match);
  expect(parts).toHaveLength(3);
  expect(parts[0]!.source.kind).toBe("table");
  expect(parts[0]!.text).toContain("escalation1@hd");
  expect(parts[0]!.text).not.toContain("touchpoints");
  expect(parts.flatMap((p) => p.text.match(/\S+/g) ?? []).sort()).toEqual(
    (match.text.match(/\S+/g) ?? []).sort(),
  );
  const context = buildContext([match], 2000),
    table = context.evidence[0]!;
  const validated = validateDraft(
    JSON.stringify({
      status: "ANSWER",
      citations: [{ sourceId: table.sourceId, quote: table.text }],
    }),
    context.evidence,
    "escalation matrix",
  );
  expect(validated.insufficientEvidence).toBe(false);
  expect(validated.citations[0]!.source).toMatchObject({
    pageNumber: 13,
    layoutColumn: 2,
  });
  expect(validated.citations[0]!.quote).toBe(table.text);
  expect(
    validateDraft(
      JSON.stringify({
        status: "ANSWER",
        citations: [
          { sourceId: table.sourceId, quote: "Chief Manager: 10 working days" },
        ],
      }),
      context.evidence,
      "escalation matrix",
    ).insufficientEvidence,
  ).toBe(true);
});
test("ordinary paragraphs and single-column pages retain their original evidence", () => {
  expect(
    columnEvidence({ ...match, text: "Claims require an invoice." }),
  ).toEqual([{ ...match, text: "Claims require an invoice." }]);
});

test("explicit matrix requests quote the complete matching table and reject unrelated subjects or ambiguity", () => {
  const evidence = buildContext([match], 2000).evidence;
  const draft = completeTableDraft("escalation matrix", evidence);
  expect(draft).not.toBeNull();
  expect(
    validateDraft(draft!, evidence, "escalation matrix").insufficientEvidence,
  ).toBe(false);
  expect(completeTableDraft("dental escalation matrix", evidence)).toBeNull();
  expect(completeTableDraft("grace period", evidence)).toBeNull();
  expect(
    completeTableDraft("escalation matrix", [...evidence, evidence[0]!]),
  ).toBeNull();
});
