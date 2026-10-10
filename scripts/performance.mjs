import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const base = "http://localhost:8080",
  fixture = JSON.parse(await readFile("docs/phase-7-host-demo.json", "utf8"));
const login = await fetch(base + "/api/v1/auth/login", {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({
    email: process.env.LOCAL_ADMIN_EMAIL,
    password: process.env.LOCAL_ADMIN_PASSWORD,
  }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const question = `DOCKER-WAIT-001 waiting period benchmark ${randomUUID()}`;
async function search() {
  const start = performance.now();
  const r = await fetch(base + "/api/v1/search", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question,
      policyId: fixture.policyId,
      asOfDate: "2026-10-09",
      mode: "hybrid",
    }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert(body.matches.length);
  return {
    durationMs: performance.now() - start,
    traceId: r.headers.get("X-Trace-Id"),
  };
}
const cold = await search();
const samples = [];
const concurrency = 2,
  requests = 30;
for (let i = 0; i < requests; i += concurrency) {
  const results = await Promise.all(
    Array.from({ length: concurrency }, search),
  );
  samples.push(...results.map((r) => r.durationMs));
}
const sorted = samples.toSorted((a, b) => a - b),
  percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
const metrics = await (await fetch("http://localhost:9464/metrics")).text();
assert.match(metrics, /advisor_query_cache_total\{[^}]*result="hit"/);
const targets = await (
  await fetch("http://localhost:9090/api/v1/targets")
).json();
assert(
  targets.data.activeTargets
    .filter((t) => t.labels.job.startsWith("advisor-"))
    .every((t) => t.health === "up"),
);
const report = {
  validatedAt: new Date().toISOString(),
  environment: "Native API/worker/Vite; real local pgvector, Redis and Ollama",
  scope:
    "Synthetic policy retrieval; end-to-end model answer latency and production concurrency are not measured",
  requests,
  concurrency,
  coldRequestMs: cold.durationMs,
  warm: {
    minMs: sorted[0],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
  },
  traceId: cold.traceId,
  checks: [
    "Authenticated fresh-version retrieval for every request",
    "Query cache hit recorded",
    "Prometheus scrapes API and worker",
  ],
  provisionalRetrievalTargetMs: 300,
  targetMet: percentile(0.95) < 300,
};
await writeFile(
  "docs/phase-7-performance.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
