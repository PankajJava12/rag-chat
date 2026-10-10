import { randomBytes } from "node:crypto";
import { Document, Paragraph, Packer, HeadingLevel } from "docx";
import ExcelJS from "exceljs";
import {
  Vault,
  passwordHash,
  verifyPassword,
} from "../../packages/security/src/crypto.js";
import {
  validateBytes,
  fileType,
  MAX_UPLOAD_BYTES,
} from "../../packages/document-processing/src/validate.js";
import { parseDocument } from "../../packages/document-processing/src/parsers.js";
import { chunkSections } from "../../packages/document-processing/src/chunk.js";
import {
  applicableVersions,
  type VersionCandidate,
} from "../../packages/ingestion/src/retrieval.js";
import { validateVectors } from "../../packages/ai/src/embeddings.js";
const version = (
  changes: Partial<VersionCandidate> = {},
): VersionCandidate => ({
  id: "v1",
  document_id: "doc1",
  version: 1,
  effective_from: "2025-01-01",
  effective_to: null,
  supersedes_id: null,
  status: "INDEXED",
  active_generation_id: "gen",
  embedding_model: "local",
  scan_status: "CLEAN",
  ...changes,
});
test("encrypted content is bound to its tenant/object and rejects tampering", () => {
  const vault = new Vault(randomBytes(32).toString("hex")),
    source = Buffer.from("private policy limit 500000");
  const encrypted = vault.seal(source, "tenant-a:object");
  expect(encrypted.includes(source)).toBe(false);
  expect(vault.open(encrypted, "tenant-a:object")).toEqual(source);
  expect(() => vault.open(encrypted, "tenant-b:object")).toThrow();
  encrypted[40] = encrypted[40]! ^ 1;
  expect(() => vault.open(encrypted, "tenant-a:object")).toThrow();
});
test("passwords are salted and verified with scrypt", async () => {
  const first = await passwordHash("test-passphrase-long");
  expect(first).not.toContain("test-passphrase");
  expect(await verifyPassword("test-passphrase-long", first)).toBe(true);
  expect(await verifyPassword("wrong", first)).toBe(false);
  expect(await passwordHash("test-passphrase-long")).not.toBe(first);
});
test("MIME, signatures, size, active PDFs, and invalid UTF-8 are rejected", async () => {
  expect(() => fileType("policy.exe", "application/pdf")).toThrow();
  expect(() => fileType("../policy.pdf", "application/pdf")).toThrow();
  await expect(validateBytes(Buffer.from("fake"), "pdf")).rejects.toThrow(
    "FILE_SIGNATURE",
  );
  await expect(validateBytes(Buffer.from("x"), "docx")).rejects.toThrow(
    "FILE_SIGNATURE",
  );
  await expect(
    validateBytes(Buffer.from("%PDF-1.4 /JavaScript"), "pdf"),
  ).rejects.toThrow("UNSAFE_PDF");
  await expect(validateBytes(Buffer.from([255]), "csv")).rejects.toThrow(
    "CSV_REQUIRES_UTF8",
  );
  await expect(
    validateBytes(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "csv"),
  ).rejects.toThrow("INVALID_FILE_SIZE");
});
test("CSV retains headers, quoted commas, numeric units, and source rows", async () => {
  const rows = await parseDocument(
    Buffer.from('Benefit,Limit\n"Hospital, room","INR 5,000 per day"\n'),
    "csv",
  );
  expect(rows[0]).toMatchObject({
    text: "Benefit: Hospital, room | Limit: INR 5,000 per day",
    rowStart: 2,
    rowEnd: 2,
    kind: "table",
  });
});
test("DOCX extracts headings without executing or exposing HTML", async () => {
  const data = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({
              text: "Waiting periods",
              heading: HeadingLevel.HEADING_1,
            }),
            new Paragraph("The waiting period is 30 days."),
          ],
        },
      ],
    }),
  );
  await validateBytes(data, "docx");
  await expect(validateBytes(data, "xlsx")).rejects.toThrow(
    "OFFICE_TYPE_MISMATCH",
  );
  const sections = await parseDocument(data, "docx");
  expect(
    sections.some(
      (s) => s.text.includes("30 days") && s.sectionTitle === "Waiting periods",
    ),
  ).toBe(true);
});
test("XLSX keeps sheet, row, headers, dates, and cached formula values", async () => {
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet("Benefits");
  sheet.addRow(["Benefit", "Limit"]);
  sheet.addRow(["Accidental death", 500000]);
  const sections = await parseDocument(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    "xlsx",
  );
  expect(sections[0]).toMatchObject({
    sheetName: "Benefits",
    rowStart: 2,
    text: "Benefit: Accidental death | Limit: 500000",
  });
});
test("chunking keeps provenance and refuses to silently split an oversized table row", () => {
  const result = chunkSections([
    {
      text: "Waiting period is 30 days. ".repeat(500),
      pageNumber: 3,
      kind: "paragraph",
    },
  ]);
  expect(result.length).toBeGreaterThan(1);
  expect(
    result.every((c) => c.tokenCount <= 650 && c.metadata.pageNumber === 3),
  ).toBe(true);
  expect(() =>
    chunkSections([{ text: "amount ".repeat(1000), kind: "table" }]),
  ).toThrow("TABLE_ROW_TOO_LARGE");
});
test("supersession uses effective dates, including transitive replacement", () => {
  const rows = [
    version(),
    version({
      id: "v2",
      version: 2,
      supersedes_id: "v1",
      effective_from: "2026-01-01",
    }),
    version({
      id: "v3",
      version: 3,
      supersedes_id: "v2",
      effective_from: "2027-01-01",
    }),
  ];
  expect(applicableVersions(rows, "2025-06-01").map((v) => v.id)).toEqual([
    "v1",
  ]);
  expect(applicableVersions(rows, "2026-06-01").map((v) => v.id)).toEqual([
    "v2",
  ]);
  expect(applicableVersions(rows, "2027-06-01").map((v) => v.id)).toEqual([
    "v3",
  ]);
});
test("newer failed or unindexed applicable versions never fall back to outdated text", () => {
  const rows = [
    version(),
    version({
      id: "v2",
      version: 2,
      supersedes_id: "v1",
      effective_from: "2026-01-01",
      status: "FAILED",
      active_generation_id: null,
    }),
  ];
  expect(applicableVersions(rows, "2026-06-01").map((v) => v.id)).toEqual([
    "v2",
  ]);
});
test("overlapping or undated versions require clarification; explicit history is permitted", () => {
  const rows = [version(), version({ id: "v2", version: 2 })];
  expect(() => applicableVersions(rows, "2026-01-01")).toThrow(
    "VERSION_CLARIFICATION",
  );
  expect(
    applicableVersions(rows, "2026-01-01", ["v1"]).map((v) => v.id),
  ).toEqual(["v1"]);
  expect(() =>
    applicableVersions([version({ effective_from: null })], "2026-01-01"),
  ).toThrow("VERSION_CLARIFICATION");
  expect(() =>
    applicableVersions([version({ status: "ARCHIVED" })], "2026-01-01", ["v1"]),
  ).toThrow("VERSION_NOT_FOUND");
});
test("embedding validation fails closed for mismatched or invalid vectors", () => {
  expect(() => validateVectors([[1, 2]], 1, 768)).toThrow("INVALID_EMBEDDING");
  expect(() => validateVectors([Array(768).fill(0)], 1, 768)).toThrow(
    "INVALID_EMBEDDING",
  );
  expect(() => validateVectors([Array(768).fill(0.1)], 1, 768)).not.toThrow();
});
test.each([
  { status: "ARCHIVED", effective_to: null },
  { status: "INDEXED", effective_to: "2026-02-01" },
])(
  "archiving or expiry of a successor never resurrects its predecessor: %o",
  (change) => {
    const rows = [
      version(),
      version({
        id: "v2",
        version: 2,
        effective_from: "2026-01-01",
        supersedes_id: "v1",
        ...change,
      }),
    ];
    expect(applicableVersions(rows, "2026-06-01")).toEqual([]);
    expect(applicableVersions(rows, "2025-06-01").map((v) => v.id)).toEqual([
      "v1",
    ]);
  },
);
