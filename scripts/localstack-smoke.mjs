import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
const base = "http://localhost:8080";
let cookie = "",
  completionTraceId;
async function call(path, body, status = 200) {
  const r = await fetch(base + "/api/v1" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      Cookie: cookie,
      "Idempotency-Key": randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, status, `${path} returned ${r.status}`);
  if (path === "/auth/login")
    cookie = r.headers.get("set-cookie").split(";")[0];
  if (path === "/documents/complete-upload")
    completionTraceId = r.headers.get("X-Trace-Id");
  return r.json();
}
await call("/auth/login", {
  email: process.env.LOCAL_ADMIN_EMAIL,
  password: process.env.LOCAL_ADMIN_PASSWORD,
});
const policy = await call(
  "/policies",
  {
    name: `LocalStack synthetic ${new Date().toISOString()}`,
    provider: "Synthetic",
  },
  201,
);
const bytes = Buffer.from(
  `clause,terms\nDOCKER-WAIT-001,"The initial waiting period is 30 days."\nFIXTURE-ID,"Synthetic fixture identifier ${randomUUID()}."\n`,
);
const v = await call(
  "/documents/upload-url",
  {
    policyId: policy.id,
    fileName: "docker-localstack-synthetic.csv",
    mimeType: "text/csv",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    effectiveFrom: "2026-01-01",
  },
  201,
);
const upload = await fetch(base + v.uploadUrl, {
  method: "PUT",
  headers: { Cookie: cookie, Origin: base, "Content-Type": "text/csv" },
  body: bytes,
  signal: AbortSignal.timeout(15000),
});
assert.equal(upload.status, 204);
await call("/documents/complete-upload", { versionId: v.versionId }, 202);
const deadline = Date.now() + 240000;
let indexed = false;
while (Date.now() < deadline) {
  const status = await call(`/documents/${v.documentId}/status`);
  assert.notEqual(status.status, "FAILED", JSON.stringify(status));
  if (status.status === "INDEXED") {
    indexed = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
assert(indexed, "Docker worker did not index within 240 seconds");
const found = await call("/search", {
  question: "DOCKER-WAIT-001 waiting period",
  policyId: policy.id,
  asOfDate: "2026-10-09",
  mode: "hybrid",
});
assert(found.matches.length > 0);
const sourcePath = `/api/v1/documents/${v.documentId}/source/${v.versionId}`;
const source = await fetch(base + sourcePath, {
  headers: { Cookie: cookie },
  signal: AbortSignal.timeout(15000),
});
assert.equal(source.status, 200);
assert.equal(await source.text(), bytes.toString());
await writeFile(
  process.env.SMOKE_REPORT ?? "docs/phase-6-container-demo.json",
  JSON.stringify(
    {
      validatedAt: new Date().toISOString(),
      environment:
        process.env.SMOKE_ENVIRONMENT ??
        "Docker API/worker/web, LocalStack S3/SQS, Ollama and pgvector",
      policyId: policy.id,
      versionId: v.versionId,
      documentId: v.documentId,
      completionTraceId,
      checks: [
        "Authenticated upload through web proxy",
        "Worker scanned, embedded and indexed S3 document",
        "Hybrid retrieval returned indexed evidence",
        "Authenticated source download matched original bytes",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log("LocalStack ingestion and retrieval smoke passed.");
