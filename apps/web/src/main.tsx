import { AdvisorChat } from "./AdvisorChat";
import { DocumentLibrary } from "./DocumentLibrary";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import "./styles.css";
const healthSchema = z.object({
  status: z.enum(["ready", "degraded"]),
  checks: z.object({
    postgres: z.enum(["up", "down"]),
    redis: z.enum(["up", "down"]),
  }),
});
type Health = z.infer<typeof healthSchema>;
function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [checked, setChecked] = useState<string>();
  const [tab, setTab] = useState("Overview");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch("/health/ready", {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
        cache: "no-store",
      });
      const result = healthSchema.parse(await response.json());
      if (signal?.aborted) return;
      setHealth(result);
      setError(false);
      setChecked(new Date().toLocaleTimeString());
    } catch {
      if (signal?.aborted) return;
      setError(true);
      setHealth(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const status = loading
    ? "Checking services"
    : error
      ? "Connection unavailable"
      : health?.status === "ready"
        ? "Foundation ready"
        : "Dependencies unavailable";
  return (
    <div className="layout">
      <aside>
        <a className="brand" href="/" aria-label="AI Advisor home">
          <span className="mark">
            A<span>✦</span>
          </span>
          <span>
            Advisor<span className="brand-sub">KNOWLEDGE WORKSPACE</span>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">AA</span>
          <div>
            AI Advisor Assistant<small>Local workspace</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {["Overview", "Document library", "Advisor chat"].map((name, i) => (
            <button
              key={name}
              className={tab === name ? "nav-item active" : "nav-item"}
              onClick={() => setTab(name)}
            >
              <span aria-hidden="true">{["◫", "▤", "◌"][i]}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="small-dot" /> Development environment
          <p>Phase 07 · Optimization & observability</p>
        </div>
      </aside>
      <main>
        <header>
          <span>
            Workspace <span className="slash">/</span> {tab}
          </span>
          <span className="environment">LOCAL DEVELOPMENT</span>
        </header>
        <section className="content">
          <div className="title-row">
            <div>
              <p className="eyebrow">YOUR POLICY KNOWLEDGE, CONNECTED</p>
              <h1>
                {tab === "Overview"
                  ? "Your policy knowledge starts here."
                  : tab}
              </h1>
              <p className="subtitle">
                A trusted workspace for insurance knowledge and informed
                conversations.
              </p>
            </div>
            <span className="phase">
              PHASE <strong>07</strong>
              <span>of 07</span>
            </span>
          </div>
          {tab === "Overview" ? (
            <>
              <section className="hero">
                <div>
                  <span className="badge">GROUNDED POLICY CHAT</span>
                  <h2>
                    Build trust into
                    <br />
                    every answer.
                  </h2>
                  <p>
                    Bring your policy documents into one secure place.
                    <br />
                    Ask questions using your indexed documents
                    <br />
                    and verify the evidence behind every policy.
                  </p>
                  <a className="hero-link" href="#roadmap">
                    Explore the implementation plan <span>↗</span>
                  </a>
                </div>
                <div
                  className="diagram"
                  aria-label="Planned document-to-answer workflow"
                >
                  <div className="diagram-card">
                    ▤{" "}
                    <span>
                      Policy documents<small>Your source of truth</small>
                    </span>
                  </div>
                  <div className="connector" />
                  <div className="diagram-center">
                    ✦ <span>AI Advisor</span>
                  </div>
                  <div className="connector" />
                  <div className="diagram-card">
                    ☑{" "}
                    <span>
                      Grounded answers
                      <small>Evidence with every response</small>
                    </span>
                  </div>
                </div>
              </section>
              <div className="section-heading">
                <h2>System readiness</h2>
                <button
                  className="refresh"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  ↻ {loading ? "Checking…" : "Refresh status"}
                </button>
              </div>
              <p className="status-line" role="status">
                {status}
                {checked && !error && !loading ? ` · Checked ${checked}` : ""}
              </p>
              <div className="services">
                {[
                  [
                    "API connection",
                    error ? "down" : health ? "up" : null,
                    "Express · TypeScript",
                  ],
                  [
                    "Policy database",
                    health?.checks.postgres,
                    "PostgreSQL · pgvector",
                  ],
                  ["Cache service", health?.checks.redis, "Redis"],
                ].map(([name, value, detail]) => (
                  <article className="service" key={name}>
                    <div>
                      <span className="service-icon">
                        {name === "Policy database"
                          ? "▥"
                          : name === "Cache service"
                            ? "ϟ"
                            : "⌘"}
                      </span>
                      <span
                        className={`pill ${loading ? "" : value === "up" ? "up" : "down"}`}
                      >
                        {loading
                          ? "Checking"
                          : value === "up"
                            ? "Connected"
                            : "Unavailable"}
                      </span>
                    </div>
                    <h3>{name}</h3>
                    <p>{detail}</p>
                  </article>
                ))}
              </div>
              <section id="roadmap" className="roadmap">
                <div className="section-heading">
                  <h2>From foundation to policy intelligence</h2>
                  <span className="muted">IMPLEMENTATION ROADMAP</span>
                </div>
                <div className="steps">
                  {[
                    [
                      "01",
                      "Foundation",
                      "Application, database & cache",
                      "Validated",
                    ],
                    [
                      "02",
                      "Document ingestion",
                      "Upload, parse & index policies",
                      "Validated",
                    ],
                    [
                      "03",
                      "Grounded conversations",
                      "Ask questions. Verify sources.",
                      "Validated",
                    ],
                    [
                      "04",
                      "Advanced retrieval",
                      "Follow up. Compare policies.",
                      "Validated",
                    ],
                    [
                      "05",
                      "Enterprise security",
                      "Private access & revocable sessions",
                      "Validated",
                    ],
                    [
                      "06",
                      "LocalStack deployment",
                      "Validate storage & queue adapters",
                      "Validated",
                    ],
                    [
                      "07",
                      "Optimization & observability",
                      "Measure retrieval and service health",
                      "Current phase",
                    ],
                  ].map(([number, title, description, state]) => (
                    <article key={number}>
                      <span className="step-number">{number}</span>
                      <span className="step-state">{state}</span>
                      <h3>{title}</h3>
                      <p>{description}</p>
                    </article>
                  ))}
                </div>
                <p className="later">
                  API, worker and web run on this Mac. AWS production remains
                  deferred.
                </p>
              </section>
            </>
          ) : tab === "Document library" ? (
            <DocumentLibrary />
          ) : (
            <AdvisorChat />
          )}
          <footer>
            AI Advisor Assistant <span>Evidence first. Always.</span>
          </footer>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
