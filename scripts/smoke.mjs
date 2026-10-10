import assert from "node:assert/strict";
for (const base of ["http://localhost:3000", "http://localhost:8080"]) {
  const ready = await fetch(`${base}/health/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(ready.status, 200);
  assert.deepEqual((await ready.json()).checks, {
    postgres: "up",
    redis: "up",
  });
  const platform = await fetch(`${base}/api/v1/platform`);
  assert.equal((await platform.json()).phase, 7);
}
const page = await fetch("http://localhost:8080");
assert.equal(page.status, 200);
assert.match(await page.text(), /AI Advisor Assistant/);
console.log(
  "Application smoke checks passed: API, reverse proxy, database, Redis, frontend.",
);
