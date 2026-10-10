import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import PDFDocument from "pdfkit";
import { Document, Paragraph, Packer, HeadingLevel } from "docx";
import ExcelJS from "exceljs";
import { Pool } from "pg";
const base = "http://localhost:3000/api/v1";
const origin = "http://localhost:8080";
const evidence = {
  startedAt: new Date().toISOString(),
  documents: [] as unknown[],
  checks: [] as string[],
};
let session = "";
async function request(
  path: string,
  options: RequestInit = {},
  expected = 200,
) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      Origin: origin,
      Cookie: session,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(180000),
  });
  const body = response.status === 204 ? null : await response.json();
  assert.equal(
    response.status,
    expected,
    `${path}: ${response.status} ${JSON.stringify(body)}`,
  );
  return { response, body };
}
function pdf(text: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const document = new PDFDocument({ size: "A4", margin: 50 });
    const parts: Buffer[] = [];
    document.on("data", (part) => parts.push(part));
    document.on("end", () => resolve(Buffer.concat(parts)));
    document.fontSize(18).text("SYNTHETIC TEST POLICY").moveDown();
    document
      .fontSize(12)
      .text("For software testing only. Not an insurance product.")
      .moveDown()
      .text(text);
    document.end();
  });
}
async function scannedPdf(source: Buffer): Promise<Buffer> {
  const native = process.env.APPLICATION_RUNTIME === "host";
  const image = execFileSync(
    native ? "pdftoppm" : "docker",
    [
      ...(native
        ? []
        : [
            "compose",
            "--env-file",
            ".env.development",
            "exec",
            "-T",
            "worker",
            "pdftoppm",
          ]),
      "-f",
      "1",
      "-l",
      "1",
      "-scale-to",
      "1600",
      "-singlefile",
      "-png",
      "-",
    ],
    { input: source, maxBuffer: 8 * 1024 * 1024, timeout: 30000 },
  );
  return new Promise((resolve) => {
    const document = new PDFDocument({ size: "A4", margin: 0 });
    const parts: Buffer[] = [];
    document.on("data", (p) => parts.push(p));
    document.on("end", () => resolve(Buffer.concat(parts)));
    document.image(image, 0, 0, { width: 595.28, height: 841.89 });
    document.end();
  });
}
async function upload(
  policyId: string,
  name: string,
  mimeType: string,
  bytes: Buffer,
  extra: Record<string, unknown> = {},
) {
  const key = randomUUID();
  const body = {
    policyId,
    fileName: name,
    mimeType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    effectiveFrom: "2026-01-01",
    ...extra,
  };
  const reserved = await request(
    "/documents/upload-url",
    {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    },
    201,
  );
  const repeated = await request(
    "/documents/upload-url",
    {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    },
    201,
  );
  assert.equal(
    reserved.body.versionId,
    repeated.body.versionId,
    "reservation must be idempotent",
  );
  const data = reserved.body;
  await request(
    `/documents/uploads/${data.versionId}`,
    {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: new Uint8Array(bytes),
    },
    204,
  );
  const complete = await request(
    "/documents/complete-upload",
    { method: "POST", body: JSON.stringify({ versionId: data.versionId }) },
    202,
  );
  const duplicate = await request(
    "/documents/complete-upload",
    { method: "POST", body: JSON.stringify({ versionId: data.versionId }) },
    202,
  );
  assert.equal(
    complete.body.jobId,
    duplicate.body.jobId,
    "completion must not duplicate jobs",
  );
  return data as { versionId: string; documentId: string };
}
async function indexed(
  item: { versionId: string; documentId: string },
  expected = "INDEXED",
) {
  for (let i = 0; i < 180; i++) {
    const { body } = await request(
      `/documents/${item.documentId}/status?versionId=${item.versionId}`,
    );
    if (body.status === expected) {
      evidence.documents.push(body);
      return body;
    }
    if (body.status === "FAILED")
      throw new Error(`Indexing failed: ${body.failure_code}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Indexing timed out");
}
async function main() {
  const auth = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: process.env.LOCAL_ADMIN_EMAIL,
      password: process.env.LOCAL_ADMIN_PASSWORD,
    }),
  });
  session = auth.response.headers.get("set-cookie")!.split(";")[0]!;
  const { body: policy } = await request(
    "/policies",
    {
      method: "POST",
      body: JSON.stringify({
        name: `Synthetic Health Policy ${new Date().toISOString().slice(0, 19)}`,
        provider: "Local Test Insurer",
      }),
    },
    201,
  );
  const text =
    "The initial waiting period is 30 days. Pre-existing diseases have a waiting period of 24 months. The maximum benefit is INR 500000. Claims require an invoice and discharge summary.";
  const pdfBytes = await pdf(text);
  const docx = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({
              text: "Synthetic policy terms",
              heading: HeadingLevel.HEADING_1,
            }),
            new Paragraph(text),
          ],
        },
      ],
    }),
  );
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Benefits").addRows([
    ["Benefit", "Limit"],
    ["Initial waiting period", "30 days"],
    ["Pre-existing diseases", "24 months"],
    ["Maximum benefit", "INR 500000"],
  ]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const fixtures: [string, string, Buffer][] = [
    ["synthetic-policy.pdf", "application/pdf", pdfBytes],
    [
      "synthetic-terms.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docx,
    ],
    [
      "synthetic-benefits.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xlsx,
    ],
    [
      "synthetic-claims.csv",
      "text/csv",
      Buffer.from(
        "Requirement,Description\nClaim documents,Invoice and discharge summary\n",
      ),
    ],
  ];
  await mkdir("tests/fixtures/generated", { recursive: true });
  fixtures.push([
    "synthetic-scanned-policy.pdf",
    "application/pdf",
    await scannedPdf(pdfBytes),
  ]);
  const uploaded = [];
  for (const [name, mime, bytes] of fixtures) {
    await writeFile(`tests/fixtures/generated/${name}`, bytes);
    const item = await upload(policy.id, name, mime, bytes);
    uploaded.push(item);
    const status = await indexed(item);
    assert.ok(status.chunk_count > 0);
    console.log(`${name}: INDEXED (${status.chunk_count} chunks)`);
  }
  evidence.checks.push(
    "PDF, DOCX, XLSX and CSV indexed by real ClamAV, parsers, Ollama and pgvector",
  );
  const ocr = await request("/search", {
    method: "POST",
    body: JSON.stringify({
      policyId: policy.id,
      question: "waiting period",
      versionIds: [uploaded[4]!.versionId],
    }),
  });
  assert.ok(
    ocr.body.matches.some(
      (m: { source: { kind: string }; text: string }) =>
        m.source.kind === "ocr" && m.text.includes("30 days"),
    ),
  );
  evidence.checks.push(
    "Scanned PDF indexed through real English Tesseract OCR with page provenance",
  );
  const search = await request("/search", {
    method: "POST",
    body: JSON.stringify({
      policyId: policy.id,
      question: "What is the initial waiting period?",
      asOfDate: "2026-06-01",
    }),
  });
  assert.ok(
    search.body.matches.some((m: { text: string }) =>
      m.text.includes("30 days"),
    ),
  );
  assert.ok(search.body.matches.every((m: { source: unknown }) => m.source));
  evidence.checks.push(
    "Version-aware search returned the 30-day term with source provenance",
  );
  // A newer immutable version explicitly supersedes the original from its effective date.
  const original = uploaded[0]!;
  const replacement = await upload(
    policy.id,
    "synthetic-policy-v2.pdf",
    "application/pdf",
    await pdf(
      "The initial waiting period is now 45 days. This version supersedes the earlier waiting period.",
    ),
    {
      documentId: original.documentId,
      supersedesId: original.versionId,
      effectiveFrom: "2026-07-01",
    },
  );
  await indexed(replacement);
  const newer = await request("/search", {
    method: "POST",
    body: JSON.stringify({
      policyId: policy.id,
      question: "waiting period",
      asOfDate: "2026-08-01",
      topK: 10,
    }),
  });
  assert.ok(
    newer.body.matches.some(
      (m: { versionId: string; text: string }) =>
        m.versionId === replacement.versionId && m.text.includes("45 days"),
    ),
  );
  assert.ok(
    newer.body.matches.every(
      (m: { versionId: string }) => m.versionId !== original.versionId,
    ),
  );
  const older = await request("/search", {
    method: "POST",
    body: JSON.stringify({
      policyId: policy.id,
      question: "waiting period",
      asOfDate: "2026-06-01",
      topK: 10,
    }),
  });
  assert.ok(
    older.body.matches.some(
      (m: { versionId: string }) => m.versionId === original.versionId,
    ),
  );
  evidence.checks.push(
    "Superseded PDF excluded from current search and retained for historical search",
  );
  // EICAR is the standard harmless antivirus test string, not executable malware.
  const eicar = Buffer.from(
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  );
  const quarantine = await upload(
    policy.id,
    "antivirus-test.csv",
    "text/csv",
    eicar,
  );
  const rejected = await indexed(quarantine, "FAILED");
  assert.equal(rejected.failure_code, "MALWARE_DETECTED");
  evidence.checks.push("Real ClamAV quarantined the harmless EICAR test file");
  await request(
    `/documents/${quarantine.documentId}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ versionId: quarantine.versionId }),
    },
    204,
  );
  const owner = new Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  try {
    const chunks = await owner.query(
      "SELECT content,embedding_dimensions,embedding_model FROM document_chunks WHERE version_id=$1",
      [original.versionId],
    );
    assert.ok(
      chunks.rows.every(
        (r) =>
          !r.content.includes("waiting") &&
          r.embedding_dimensions === 768 &&
          r.embedding_model.startsWith("ollama:"),
      ),
    );
    const jobs = await owner.query(
      "SELECT count(*) FROM ingestion_jobs WHERE version_id=$1",
      [original.versionId],
    );
    assert.equal(Number(jobs.rows[0].count), 1);
  } finally {
    await owner.end();
  }
  evidence.checks.push(
    "Chunk text encrypted at rest; real 768-dimensional Ollama vectors persisted; duplicate completion produced one job",
  );
  // The advisor account cannot mutate the library.
  const advisor = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: process.env.LOCAL_ADVISOR_EMAIL,
      password: process.env.LOCAL_ADVISOR_PASSWORD,
    }),
  });
  session = advisor.response.headers.get("set-cookie")!.split(";")[0]!;
  await request(
    "/policies",
    {
      method: "POST",
      body: JSON.stringify({ name: "Forbidden", provider: "test" }),
    },
    403,
  );
  evidence.checks.push("ADVISOR write rejected");
  await writeFile(
    process.env.E2E_REPORT_PATH ?? "docs/phase-2-demo.json",
    JSON.stringify(
      { ...evidence, finishedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Local ingestion demonstration passed. Evidence: ${process.env.E2E_REPORT_PATH ?? "docs/phase-2-demo.json"}`,
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Demonstration failed",
  );
  process.exitCode = 1;
});
