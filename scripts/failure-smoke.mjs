import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const compose = ["compose", "--env-file", ".env.development"];
const base = "http://localhost:3000";
async function status(path) {
  return (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) }))
    .status;
}
try {
  execFileSync("docker", [...compose, "stop", "redis"], { stdio: "ignore" });
  assert.equal(await status("/health/live"), 200);
  assert.equal(await status("/health/ready"), 503);
} finally {
  execFileSync("docker", [...compose, "start", "redis"], { stdio: "ignore" });
}
let recovered = false;
for (let i = 0; i < 30; i++) {
  if ((await status("/health/ready")) === 200) {
    recovered = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(
  recovered,
  true,
  "API must recover automatically when Redis returns",
);
console.log(
  "Failure smoke passed: Redis outage fails readiness, liveness survives, readiness recovers.",
);
