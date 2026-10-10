import { chatRequest } from "./chat-request.js";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import PDFDocument from "pdfkit";
import { retrievalMetrics } from "../../packages/ai/src/evaluation/metrics.js";
const base = "http://localhost:8080/api/v1",
  origin = "http://localhost:8080";
let cookie = "";
const sourceTexts = new Map<string, string>();
const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();
const report = {
  startedAt: new Date().toISOString(),
  model: "",
  policyId: "",
  documents: [] as unknown[],
  answers: [] as unknown[],
  checks: [] as string[],
  comparisonPolicyId: "",
  evaluation: [] as unknown[],
  qualityChecks: { answerCases: 0, verifiedQuotes: 0 },
};
async function call(path: string, body?: unknown, expected = 200) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Idempotency-Key": randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(240000),
  });
  const value = await r.json();
  assert.equal(r.status, expected, `${path}: ${JSON.stringify(value)}`);
  return { r, value };
}
async function upload(
  policyId: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const bytes = await new Promise<Buffer>((resolve) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50 }),
      parts: Buffer[] = [];
    pdf.on("data", (p) => parts.push(p));
    pdf.on("end", () => resolve(Buffer.concat(parts)));
    pdf
      .fontSize(16)
      .text("Synthetic Advanced Retrieval Policy")
      .moveDown()
      .fontSize(12)
      .text("For software testing only. Not an insurance product.")
      .moveDown()
      .text(content);
    pdf.end();
  });
  const { value: v } = await call(
    "/documents/upload-url",
    {
      policyId,
      fileName: "advanced-terms.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      effectiveFrom: "2026-01-01",
      ...extra,
    },
    201,
  );
  const r = await fetch(base + `/documents/uploads/${v.versionId}`, {
    method: "PUT",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/pdf",
    },
    body: new Uint8Array(bytes),
  });
  assert.equal(r.status, 204);
  await call("/documents/complete-upload", { versionId: v.versionId }, 202);
  for (let n = 0; n < 150; n++) {
    const { value: s } = await call(
      `/documents/${v.documentId}/status?versionId=${v.versionId}`,
    );
    if (s.status === "INDEXED") {
      report.documents.push(s);
      sourceTexts.set(
        v.versionId,
        "Synthetic Advanced Retrieval Policy For software testing only. Not an insurance product. " +
          content,
      );
      return v;
    }
    assert.notEqual(s.status, "FAILED", s.failure_code);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Index timeout");
}
async function conversation(
  policyId: string,
  versionIds?: string[],
  asOfDate = "2026-10-08",
) {
  return (
    await call(
      "/conversations",
      { policyId, asOfDate, ...(versionIds ? { versionIds } : {}) },
      201,
    )
  ).value;
}
async function ask(id: string, question: string) {
  const started = performance.now();
  const r = await chatRequest(base + `/conversations/${id}/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(240000),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = r.body!.getReader(),
    decoder = new TextDecoder();
  let data = "",
    firstEventMs = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!firstEventMs) firstEventMs = Math.round(performance.now() - started);
    data += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(data, /event: status/);
  assert.doesNotMatch(data, /event: error/);
  const done = data.split("\n\n").find((b) => b.startsWith("event: done\n"));
  assert.ok(done, "missing final event");
  const answer = JSON.parse(done.slice(done.indexOf("data: ") + 6));
  assert.ok(answer.tokenUsage.inputTokens > 0 || answer.insufficientEvidence);
  for (const citation of answer.citations) {
    const source = sourceTexts.get(citation.versionId);
    assert.ok(
      source && normalizeText(source).includes(normalizeText(citation.quote)),
      "Quote must occur verbatim in its known uploaded PDF version",
    );
    assert.equal(citation.source.pageNumber, 1);
    report.qualityChecks.verifiedQuotes++;
  }
  report.model = answer.model;
  report.answers.push({ question, ...answer, firstEventMs });
  console.log(
    `${question} -> ${answer.insufficientEvidence ? "ABSTAIN" : answer.conflict ? "CONFLICT" : "ANSWER"} (${answer.processingTimeMs} ms)`,
  );
  return answer;
}
async function csvUpload(policyId: string, bytes: Buffer) {
  const { value: v } = await call(
    "/documents/upload-url",
    {
      policyId,
      fileName: "retrieval-schedules.csv",
      mimeType: "text/csv",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      effectiveFrom: "2026-01-01",
    },
    201,
  );
  const put = await fetch(base + `/documents/uploads/${v.versionId}`, {
    method: "PUT",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "text/csv" },
    body: new Uint8Array(bytes),
  });
  assert.equal(put.status, 204);
  await call("/documents/complete-upload", { versionId: v.versionId }, 202);
  for (let n = 0; n < 150; n++) {
    const { value: status } = await call(
      `/documents/${v.documentId}/status?versionId=${v.versionId}`,
    );
    if (status.status === "INDEXED") {
      report.documents.push(status);
      return v;
    }
    assert.notEqual(status.status, "FAILED", status.failure_code);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CSV index timeout");
}
async function main() {
  const login = await call("/auth/login", {
    email: process.env.LOCAL_ADMIN_EMAIL,
    password: process.env.LOCAL_ADMIN_PASSWORD,
  });
  cookie = login.r.headers.getSetCookie()[0]!.split(";")[0]!;
  const stamp = new Date().toISOString().slice(0, 19);
  const policy = (
    await call(
      "/policies",
      { name: `Horizon Advanced ${stamp}`, provider: "Synthetic Test Insurer" },
      201,
    )
  ).value;
  const other = (
    await call(
      "/policies",
      { name: `Summit Advanced ${stamp}`, provider: "Synthetic Test Insurer" },
      201,
    )
  ).value;
  report.policyId = policy.id;
  report.comparisonPolicyId = other.id;
  const first = await upload(
    policy.id,
    "The initial waiting period is 30 days.\n\nRoom rent is limited to INR 5000 per day.\n\nPre-existing diseases have a waiting period of 24 months.\n\nClaims require an invoice and a discharge summary.",
  );
  const second = await upload(
    other.id,
    "The initial waiting period is 15 days.\n\nRoom rent is limited to INR 7000 per day.\n\nPre-existing diseases have a waiting period of 12 months.",
  );
  const c = await conversation(policy.id);
  const rent = await ask(c.id, "What is the room rent benefit?");
  assert.match(rent.answer, /5000/);
  assert.equal(rent.usedHistory, false);
  const followup = await ask(c.id, "What about its limit?");
  assert.equal(followup.usedHistory, true);
  assert.match(followup.answer, /5000/);
  assert.equal(followup.citations[0].versionId, first.versionId);
  const absent = await ask(c.id, "What is the dental coverage limit?");
  assert.equal(absent.insufficientEvidence, true);
  const compared = (
    await call(
      "/conversations",
      {
        policyId: policy.id,
        comparisonPolicyId: other.id,
        asOfDate: "2026-10-08",
      },
      201,
    )
  ).value;
  const comparison = await ask(
    compared.id,
    "What is the initial waiting period?",
  );
  assert.match(comparison.answer, /30 days/);
  assert.match(comparison.answer, /15 days/);
  assert.equal(comparison.conflict, false);
  assert.equal(comparison.comparison.length, 2);
  assert.ok(
    comparison.citations.some(
      (x: { versionId: string }) => x.versionId === first.versionId,
    ),
  );
  assert.ok(
    comparison.citations.some(
      (x: { versionId: string }) => x.versionId === second.versionId,
    ),
  );
  const partial = await ask(
    compared.id,
    "What documents are required for claims?",
  );
  assert.equal(partial.comparison[0].insufficientEvidence, false);
  assert.equal(partial.comparison[1].insufficientEvidence, true);
  assert.ok(
    partial.citations.every(
      (x: { versionId: string }) => x.versionId === first.versionId,
    ),
  );
  const newSubject = await ask(compared.id, "Does it cover dental?");
  assert.equal(newSubject.usedHistory, true);
  assert.equal(newSubject.citations.length, 0);
  assert.equal(newSubject.tokenUsage.inputTokens, 0);
  assert.ok(
    newSubject.comparison.every(
      (p: { insufficientEvidence: boolean }) => p.insufficientEvidence,
    ),
  );
  const thirdTurn = await ask(compared.id, "What about its limit?");
  assert.equal(thirdTurn.usedHistory, true);
  assert.equal(thirdTurn.citations.length, 0);
  assert.equal(thirdTurn.tokenUsage.inputTokens, 0);
  const reopened = (await call(`/conversations/${c.id}`)).value;
  assert.equal(reopened.messages.length, 6);
  assert.equal(reopened.messages[3].usedHistory, true);
  const evaluationPolicy = (
    await call(
      "/policies",
      {
        name: `Retrieval Evaluation ${stamp}`,
        provider: "Synthetic Test Insurer",
      },
      201,
    )
  ).value;
  const labels = [
    [
      "R-17",
      "Emergency ambulance reimbursement schedule is limited to INR 2000 per event.",
      "R-17 ambulance reimbursement",
    ],
    [
      "R-18",
      "Emergency ambulance reimbursement schedule is limited to INR 4000 per event.",
      "R-18 ambulance reimbursement",
    ],
    [
      "D-21",
      "Dental accident schedule covers extraction following a covered accident only.",
      "D-21 dental accident extraction",
    ],
    [
      "D-22",
      "Dental illness schedule excludes routine cleaning and cosmetic treatment.",
      "D-22 routine dental cleaning",
    ],
    [
      "C-31",
      "Claim filing schedule requires an invoice and discharge summary within 30 days.",
      "C-31 claim invoice deadline",
    ],
    [
      "C-32",
      "Claim appeal schedule requires a written objection within 60 days.",
      "C-32 appeal written objection",
    ],
    [
      "M-41",
      "Maternity schedule has a waiting period of 36 months.",
      "How long is the wait for maternity benefits?",
    ],
    [
      "M-42",
      "Newborn schedule requires enrollment within 90 days of birth.",
      "By when should a newborn be enrolled after birth?",
    ],
  ];
  await csvUpload(
    evaluationPolicy.id,
    Buffer.from(
      "Clause,Terms\n" +
        labels.map(([code, text]) => `${code},${text}`).join("\n") +
        "\n",
    ),
  );
  const all = (
    await call("/search", {
      policyId: evaluationPolicy.id,
      asOfDate: "2026-10-08",
      question: "schedule",
      mode: "keyword",
      rerank: false,
      topK: 10,
    })
  ).value;
  assert.equal(all.diagnostics.keywordReady, true);
  assert.equal(all.matches.length, 8);
  for (const mode of ["semantic", "hybrid", "hybrid-reranked"]) {
    const cases: {
      question: string | undefined;
      expectedClause: string | undefined;
      metrics: ReturnType<typeof retrievalMetrics>;
      retrieved: { chunkId: string; text: string }[];
    }[] = [];
    for (const [code, , question] of labels) {
      const relevant = all.matches
        .filter((m: { text: string }) => m.text.includes(code!))
        .map((m: { chunkId: string }) => m.chunkId);
      assert.equal(relevant.length, 1);
      const { value: found } = await call("/search", {
        policyId: evaluationPolicy.id,
        asOfDate: "2026-10-08",
        question,
        topK: 3,
        mode: mode === "semantic" ? "semantic" : "hybrid",
        rerank: mode === "hybrid-reranked",
      });
      assert.equal(found.diagnostics.keywordReady, true);
      cases.push({
        question,
        expectedClause: code,
        metrics: retrievalMetrics(
          found.matches.map((m: { chunkId: string }) => m.chunkId),
          relevant,
          3,
        ),
        retrieved: found.matches.map(
          (m: { text: string; chunkId: string }) => ({
            chunkId: m.chunkId,
            text: m.text,
          }),
        ),
      });
    }
    const average = Object.fromEntries(
      ["recall", "precision", "mrr", "ndcg"].map((key) => [
        key,
        cases.reduce(
          (n, c) => n + c.metrics[key as keyof typeof c.metrics],
          0,
        ) / cases.length,
      ]),
    );
    report.evaluation.push({
      mode,
      k: 3,
      caseCount: cases.length,
      average,
      cases,
    });
    if (mode === "hybrid-reranked") {
      assert.ok(average.recall! >= 0.875, "Hybrid Recall@3 regression");
      assert.ok(average.mrr! >= 0.75, "Hybrid MRR regression");
    }
  }
  report.qualityChecks.answerCases = report.answers.length;
  report.checks.push(
    "Two real PDF policies and eight CSV clause rows uploaded, scanned, embedded and indexed",
    "Real local generation: room-rent answer, anaphoric follow-up, absent benefit abstention",
    "Two-policy comparison with separately validated quotes and globally numbered citations",
    "Partial comparison labels insufficient evidence for the unsupported policy",
    "History reopened with context metadata; no raw memory exposed",
    "Eight labelled retrieval queries: semantic baseline, hybrid RRF and local reranker ablation; Recall@3/MRR gates",
  );
  await writeFile(
    "docs/phase-4-demo.json",
    JSON.stringify(
      { ...report, finishedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  console.log("Phase 4 local advanced retrieval demonstration passed.");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
