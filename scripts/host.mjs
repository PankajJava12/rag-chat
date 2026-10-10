import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, open, stat } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve("."),
  dir = resolve(".local/host"),
  file = resolve(dir, "processes.json");
await mkdir(dir, { recursive: true });
const command = process.argv[2] ?? "status";
let processes = [];
try {
  processes = JSON.parse(await readFile(file, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const alive = (p) => {
  try {
    process.kill(p.pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (command === "stop") {
  const selected = process.argv[3]
    ? processes.filter((p) => p.name === process.argv[3])
    : processes;
  for (const p of selected) if (alive(p)) process.kill(-p.pid, "SIGTERM");
  const deadline = Date.now() + 15000;
  while (selected.some(alive) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  if (selected.some(alive))
    throw new Error(
      "Host shutdown still in progress; retry status before starting.",
    );
  await writeFile(
    file,
    JSON.stringify(processes.filter((p) => !selected.includes(p))) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "Host application processes stopped. Dependency containers retained.",
  );
} else if (command === "start") {
  await stat(".env.host");
  if (process.platform === "darwin") {
    try {
      const outputs = await import("node:fs/promises");
      await outputs.stat("/opt/homebrew/bin/pdftotext");
      await outputs.stat("/opt/homebrew/bin/tesseract");
    } catch {
      throw new Error(
        "Install native parser tools: brew install poppler tesseract",
      );
    }
  }
  const commands = [
    ["api", ["--env-file=.env.host-api", "dist/apps/api/src/server.js"]],
    [
      "worker",
      ["--env-file=.env.host-worker", "dist/apps/worker/src/worker.js"],
    ],
    [
      "web",
      [
        "node_modules/vite/bin/vite.js",
        "--config",
        "apps/web/vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        "8080",
        "--strictPort",
      ],
    ],
  ];
  processes = processes.filter(alive);
  for (const [name, args] of commands) {
    if (processes.some((p) => p.name === name && alive(p))) continue;
    const log = await open(resolve(dir, `${name}.log`), "a", 0o600);
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TMPDIR: process.env.TMPDIR,
        OTEL_SERVICE_NAME: `advisor-${name}`,
        METRICS_PORT: name === "worker" ? "9465" : "9464",
      },
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await log.close();
    processes.push({ name, pid: child.pid });
  }
  await writeFile(file, JSON.stringify(processes, null, 2) + "\n", {
    mode: 0o600,
  });
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (processes.some((p) => !alive(p)))
      throw new Error(
        "Host service exited during startup; inspect .local/host logs.",
      );
    try {
      const states = await Promise.all(
        [
          "http://127.0.0.1:3000/health/ready",
          "http://127.0.0.1:3001/health/ready",
          "http://127.0.0.1:8080/",
        ].map((url) => fetch(url, { signal: AbortSignal.timeout(1500) })),
      );
      if (states.every((r) => r.ok)) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for native listeners and dependency readiness. */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready)
    throw new Error("Host readiness timed out; inspect .local/host logs.");
  console.log(
    "Host API :3000, worker :3001 and web http://localhost:8080 started. Logs: .local/host/*.log",
  );
} else if (command === "status")
  console.log(
    processes
      .map(
        (p) => `${p.name}: ${alive(p) ? "running" : "stopped"} (PID ${p.pid})`,
      )
      .join("\n") || "No host processes registered.",
  );
else throw new Error("Use start, stop or status.");
