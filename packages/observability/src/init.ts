import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { createServer, type Server } from "node:http";
import { registry } from "./telemetry.js";
let sdk: NodeSDK | undefined, server: Server | undefined;
if (process.env.TRACING_ENABLED === "true") {
  const url =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    "http://127.0.0.1:4318/v1/traces";
  if (
    ![
      "127.0.0.1",
      "localhost",
      "[::1]",
      "tempo",
      "host.docker.internal",
    ].includes(new URL(url).hostname)
  )
    throw new Error("Tracing requires an explicit local collector");
  sdk = new NodeSDK({
    autoDetectResources: false,
    serviceName: process.env.OTEL_SERVICE_NAME ?? "advisor-local",
    traceExporter: new OTLPTraceExporter({ url, timeoutMillis: 2000 }),
  });
  sdk.start();
}
if (process.env.METRICS_ENABLED === "true") {
  const port = Number(process.env.METRICS_PORT ?? 9464);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid metrics port");
  const host = process.env.METRICS_BIND_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host))
    throw new Error("Invalid metrics bind host");
  server = createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    void registry
      .metrics()
      .then((value) => {
        res.setHeader("Content-Type", registry.contentType);
        res.end(value);
      })
      .catch(() => res.writeHead(503).end());
  }).listen(port, host);
}
export async function closeTelemetry() {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await sdk?.shutdown();
}
