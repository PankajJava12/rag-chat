import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const fixture = JSON.parse(
  await readFile("docs/phase-7-host-demo.json", "utf8"),
);
function spans(value) {
  if (!value || typeof value !== "object") return [];
  let items = [];
  if (value.spanId && value.name) items.push(value.name);
  for (const v of Object.values(value)) items.push(...spans(v));
  return items;
}
let names = [];
const traceDeadline = Date.now() + 20000;
while (Date.now() < traceDeadline) {
  const response = await fetch(
    `http://localhost:3200/api/traces/${fixture.completionTraceId}`,
  );
  if (response.ok) {
    names = spans(await response.json());
    if (
      names.includes("ingestion.attempt") &&
      names.includes("queue.publish") &&
      names.includes("embedding.document")
    )
      break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
assert(names.includes("ingestion.attempt"));
assert(names.includes("queue.publish"));
assert(names.includes("embedding.document"));
assert(names.some((n) => n.includes("complete-upload")));
const dashboards = await (
  await fetch("http://localhost:3002/api/search")
).json();
assert(dashboards.some((d) => d.uid === "advisor-local"));
const scrapeDeadline = Date.now() + 30000;
let targets;
while (Date.now() < scrapeDeadline) {
  targets = await (await fetch("http://localhost:9090/api/v1/targets")).json();
  if (
    targets.data.activeTargets.length === 2 &&
    targets.data.activeTargets.every((t) => t.health === "up")
  )
    break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.equal(targets.data.activeTargets.length, 2);
assert(targets.data.activeTargets.every((t) => t.health === "up"));
const report = {
  validatedAt: new Date().toISOString(),
  traceId: fixture.completionTraceId,
  spanNames: names,
  checks: [
    "One trace joins API upload completion, SQS publication and native ingestion worker",
    "Grafana dashboard provisioned",
    "Prometheus scrapes both native processes",
  ],
  alertDrill: false,
};
if (process.argv.includes("--alert-drill")) {
  const ready = await (
    await fetch("http://localhost:3001/health/ready")
  ).json();
  assert.equal(
    ready.busy,
    false,
    "Wait for active ingestion to finish before the drill",
  );
  try {
    execFileSync(process.execPath, ["scripts/host.mjs", "stop", "worker"], {
      stdio: "inherit",
    });
    const deadline = Date.now() + 90000;
    let firing = false;
    while (Date.now() < deadline) {
      const alerts = await (
        await fetch("http://localhost:9093/api/v2/alerts")
      ).json();
      if (
        alerts.some(
          (a) =>
            a.labels.alertname === "AdvisorProcessUnavailable" &&
            a.labels.job === "advisor-worker",
        )
      ) {
        firing = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    assert(firing, "Worker-down alert did not reach local Alertmanager");
    report.alertDrill = true;
    report.checks.push(
      "Real worker stop triggered a Prometheus alert delivered to local Alertmanager",
    );
  } finally {
    execFileSync(process.execPath, ["scripts/host.mjs", "start"], {
      stdio: "inherit",
    });
  }
  const deadline = Date.now() + 30000;
  let recovered = false;
  while (Date.now() < deadline) {
    const targets = await (
      await fetch("http://localhost:9090/api/v1/targets")
    ).json();
    if (targets.data.activeTargets.every((t) => t.health === "up")) {
      recovered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(recovered, "Worker scrape did not recover");
  report.checks.push("Worker restarted and scrape recovered");
}
await writeFile(
  "docs/phase-7-observability.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
