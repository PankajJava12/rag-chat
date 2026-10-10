import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
const embeddingProvider = process.env.EMBEDDING_PROVIDER;
const providerName = { gemini: "Gemini", openai: "OpenAI", ollama: "Ollama" }[
  embeddingProvider
];
if (!providerName)
  throw new Error("Select EMBEDDING_PROVIDER before importing samples");
const origin = "http://localhost:8080",
  base = origin + "/api/v1";
const directory = resolve(process.argv[2] ?? "docs/samples");
// Demo applicability date; callers may supply the contractual effective date.
const effectiveFrom =
  process.argv[3] ??
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
const manifestPath = resolve(`.local/${embeddingProvider}-samples.json`);
await mkdir(".local", { recursive: true });
let manifest = {};
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const save = () =>
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
const login = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({
    email: process.env.LOCAL_ADMIN_EMAIL,
    password: process.env.LOCAL_ADMIN_PASSWORD,
  }),
});
if (!login.ok) throw new Error(`Login failed: ${login.status}`);
const cookie = login.headers.get("set-cookie").split(";")[0];
async function post(path, body, key = randomUUID()) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
for (const fileName of (await readdir(directory))
  .filter((name) => name.endsWith(".pdf"))
  .sort()) {
  const bytes = await readFile(resolve(directory, fileName));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = fileName + ":" + sha256;
  let entry = manifest[key];
  if (!entry) {
    const policy = await post("/policies", {
      name:
        fileName.replace(/\.pdf$/, "").replace(/-/g, " ") +
        ` (${providerName} sample)`,
      provider: fileName.startsWith("HDFC") ? "HDFC Life" : "Max Life",
    });
    entry = manifest[key] = {
      fileName,
      sha256,
      policyId: policy.id,
      effectiveFrom,
      uploadKey: randomUUID(),
      completeKey: randomUUID(),
    };
    await save();
  }
  if (!entry.versionId) {
    const upload = await post(
      "/documents/upload-url",
      {
        policyId: entry.policyId,
        fileName,
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
        sha256,
        effectiveFrom: entry.effectiveFrom,
      },
      entry.uploadKey,
    );
    Object.assign(entry, upload);
    await save();
  }
  if (!entry.completed) {
    const upload = await fetch(origin + entry.uploadUrl, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/pdf",
      },
      body: bytes,
    });
    if (!upload.ok)
      throw new Error(`Upload failed: ${fileName} ${upload.status}`);
    await post(
      "/documents/complete-upload",
      { versionId: entry.versionId },
      entry.completeKey,
    );
    entry.completed = true;
    await save();
  }
  console.log(
    JSON.stringify({
      fileName,
      documentId: entry.documentId,
      versionId: entry.versionId,
      status: "inserted",
    }),
  );
}
console.log(`Insertion manifest: ${manifestPath}`);
