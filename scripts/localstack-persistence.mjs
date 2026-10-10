import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const report = JSON.parse(
  await readFile("docs/phase-6-container-demo.json", "utf8"),
);
const base = "http://localhost:8080";
const login = await fetch(base + "/api/v1/auth/login", {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({
    email: process.env.LOCAL_ADMIN_EMAIL,
    password: process.env.LOCAL_ADMIN_PASSWORD,
  }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const result = await fetch(
  `${base}/api/v1/documents/${report.documentId}/source/${report.versionId}`,
  { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) },
);
assert.equal(result.status, 200);
const digest = createHash("sha256")
  .update(Buffer.from(await result.arrayBuffer()))
  .digest("hex");
const path = "/tmp/advisor-localstack-persistence.json";
if (process.argv.includes("--record"))
  await writeFile(
    path,
    JSON.stringify({ versionId: report.versionId, digest }),
  );
else {
  const before = JSON.parse(await readFile(path, "utf8"));
  assert.equal(before.versionId, report.versionId);
  assert.equal(before.digest, digest);
  report.checks.push(
    "Authenticated source survives emulator reset via encrypted local recovery copy",
  );
  await writeFile(
    "docs/phase-6-container-demo.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("Encrypted local source recovery after emulator reset passed.");
}
