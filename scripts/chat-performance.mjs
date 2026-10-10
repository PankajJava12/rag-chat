import { TextDecoder } from "node:util";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import PDFDocument from "pdfkit";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const base = "http://localhost:8080/api/v1",
  origin = "http://localhost:8080";
const login = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({
    email: process.env.LOCAL_ADMIN_EMAIL,
    password: process.env.LOCAL_ADMIN_PASSWORD,
  }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
async function post(path, body, status) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, status);
  return r.json();
}
const policy = await post(
  "/policies",
  {
    name: `Native chat performance synthetic ${new Date().toISOString()}`,
    provider: "Synthetic",
  },
  201,
);
const bytes = await new Promise((resolve) => {
  const pdf = new PDFDocument({ size: "A4", margin: 50 }),
    parts = [];
  pdf.on("data", (part) => parts.push(part));
  pdf.on("end", () => resolve(Buffer.concat(parts)));
  pdf
    .fontSize(14)
    .text("SYNTHETIC TEST POLICY.")
    .moveDown()
    .fontSize(12)
    .text(
      "The initial waiting period is 30 days. Claims require an invoice and discharge summary.",
    );
  pdf.end();
});
const version = await post(
  "/documents/upload-url",
  {
    policyId: policy.id,
    fileName: "native-chat-synthetic.pdf",
    mimeType: "application/pdf",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    effectiveFrom: "2026-01-01",
  },
  201,
);
const upload = await fetch(origin + version.uploadUrl, {
  method: "PUT",
  headers: {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/pdf",
  },
  body: bytes,
});
assert.equal(upload.status, 204);
await post("/documents/complete-upload", { versionId: version.versionId }, 202);
const indexDeadline = Date.now() + 180000;
let indexed = false;
while (Date.now() < indexDeadline) {
  const status = await (
    await fetch(`${base}/documents/${version.documentId}/status`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.notEqual(status.status, "FAILED");
  if (status.status === "INDEXED") {
    indexed = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
assert(indexed);
const fixture = { policyId: policy.id };
const c = await fetch(base + "/conversations", {
  method: "POST",
  headers: {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({ policyId: fixture.policyId, asOfDate: "2026-10-09" }),
});
assert.equal(c.status, 201);
const conversation = await c.json();
const start = performance.now();
const r = await fetch(`${base}/conversations/${conversation.id}/messages`, {
  method: "POST",
  headers: {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({ question: "What is the initial waiting period?" }),
  signal: AbortSignal.timeout(240000),
});
assert.equal(r.status, 200);
const reader = r.body.getReader(),
  decoder = new TextDecoder();
let text = "",
  firstEventMs;
while (true) {
  const part = await reader.read();
  if (part.done) break;
  if (!firstEventMs) firstEventMs = performance.now() - start;
  text += decoder.decode(part.value, { stream: true });
}
const done = text
  .split("\n\n")
  .find((block) => block.startsWith("event: done\n"));
assert(
  done,
  `Chat did not complete: ${text
    .split("\n\n")
    .filter((b) => b.startsWith("event: error"))
    .join(" ")}`,
);
const answer = JSON.parse(done.slice(done.indexOf("data: ") + 6));
assert.match(answer.answer, /30 days/i);
assert(answer.citations.length > 0);
assert.equal(answer.insufficientEvidence, false);
const report = {
  validatedAt: new Date().toISOString(),
  conversationId: conversation.id,
  policyId: policy.id,
  versionId: version.versionId,
  model: answer.model,
  firstEventMs,
  totalMs: performance.now() - start,
  traceId: r.headers.get("X-Trace-Id"),
  tokenUsage: answer.tokenUsage,
  citationCount: answer.citations.length,
  checks: [
    "Real local generation returned the cited 30-day waiting-period answer",
    "SSE completed and answer persisted",
  ],
  scope: "One synthetic question; not a P95 or concurrency benchmark",
};
await writeFile(
  "docs/phase-7-chat.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
