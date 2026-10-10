import { useCallback, useEffect, useState, type FormEvent } from "react";
type User = { id: string; tenantId: string; role: "ADMIN" | "ADVISOR" };
type Policy = { id: string; name: string; provider: string };
type DocumentRow = {
  document_id: string;
  policy_id: string;
  name: string;
  policy_name: string;
  version_id: string;
  version: number;
  status: string;
  failure_code: string | null;
  chunk_count: number;
  effective_from: string;
  embedding_model: string | null;
  job?: { attempts: number; processed_chunks: number; input_tokens: number };
};
type Match = {
  chunkId: string;
  text: string;
  documentName: string;
  version: number;
  source: {
    pageNumber?: number;
    sectionTitle?: string;
    sheetName?: string;
    rowStart?: number;
  };
  distance: number;
};
async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof File
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code ?? "REQUEST_FAILED");
  return result;
}
const messages: Record<string, string> = {
  INVALID_CREDENTIALS: "The email or password is incorrect.",
  VERSION_CLARIFICATION_REQUIRED:
    "More than one policy version may apply. Choose a specific version below or resolve its supersession before searching.",
  APPLICABLE_VERSION_NOT_INDEXED:
    "The applicable version has not been indexed. Wait for processing or retry the failed document.",
  INVALID_INPUT: "Please check the required fields and upload details.",
  MALWARE_DETECTED: "This file was quarantined after malware was detected.",
  UPLOAD_CHECKSUM_MISMATCH:
    "The uploaded file did not match its checksum. Please select it again.",
  ORIGIN_NOT_ALLOWED:
    "Open this application through its configured local address.",
};
export function DocumentLibrary() {
  const [user, setUser] = useState<User | null>(null),
    [checking, setChecking] = useState(true),
    [email, setEmail] = useState("admin@advisor.local"),
    [password, setPassword] = useState("");
  const [policies, setPolicies] = useState<Policy[]>([]),
    [documents, setDocuments] = useState<DocumentRow[]>([]),
    [policyId, setPolicyId] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [file, setFile] = useState<File | null>(null);
  const [policyName, setPolicyName] = useState(""),
    [provider, setProvider] = useState(""),
    [effectiveFrom, setEffectiveFrom] = useState(
      new Date().toISOString().slice(0, 10),
    );
  const [previous, setPrevious] = useState(""),
    [question, setQuestion] = useState(""),
    [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10)),
    [explicitVersion, setExplicitVersion] = useState(""),
    [matches, setMatches] = useState<Match[] | null>(null);
  const [authMode, setAuthMode] = useState("local");
  const showError = (e: unknown) => {
    const code = e instanceof Error ? e.message : "REQUEST_FAILED";
    setError(messages[code] ?? code.replaceAll("_", " ").toLowerCase());
  };
  const refresh = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api("/policies"), api("/documents")]);
      setPolicies(p.items);
      setDocuments(d.items);
      setPolicyId((current) => current || p.items[0]?.id || "");
    } catch (e) {
      if (
        e instanceof Error &&
        ["AUTHENTICATION_REQUIRED", "INVALID_TOKEN"].includes(e.message)
      )
        setUser(null);
      else showError(e);
    }
  }, []);
  useEffect(() => {
    void api("/auth/config")
      .then((v) => setAuthMode(v.mode))
      .catch(() => undefined);
    void api("/auth/me")
      .then((v) => setUser(v.user))
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [user, refresh]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  const login = (event: FormEvent) => {
    event.preventDefault();
    void action(async () => {
      const result = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setUser(result.user);
      setPassword("");
    });
  };
  const upload = (event: FormEvent) => {
    event.preventDefault();
    void action(async () => {
      if (!file || !policyId) throw new Error("Choose a policy and a file.");
      if (file.size > 25 * 1024 * 1024)
        throw new Error("Files must be no larger than 25 MiB.");
      const types: Record<string, string> = {
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        csv: "text/csv",
      };
      const mimeType = types[file.name.split(".").pop()!.toLowerCase()];
      if (!mimeType) throw new Error("Choose PDF, DOCX, XLSX, or CSV.");
      const sha256 = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        ),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const prior = documents.find((d) => d.version_id === previous);
      const reservation = await api("/documents/upload-url", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          policyId,
          fileName: file.name,
          mimeType,
          sizeBytes: file.size,
          sha256,
          effectiveFrom,
          ...(prior
            ? { documentId: prior.document_id, supersedesId: prior.version_id }
            : {}),
        }),
      });
      const uploaded = await fetch(reservation.uploadUrl, {
        method: "PUT",
        headers: reservation.requiredHeaders,
        body: file,
        credentials: "same-origin",
      });
      if (!uploaded.ok) {
        const body = await uploaded.json();
        throw new Error(body.error?.code ?? "UPLOAD_FAILED");
      }
      await api("/documents/complete-upload", {
        method: "POST",
        body: JSON.stringify({ versionId: reservation.versionId }),
      });
      setNotice(
        "Upload received. Scanning, extraction, and indexing will continue in the background.",
      );
      await refresh();
    });
  };
  if (checking)
    return (
      <section className="library-panel" role="status">
        Checking your session…
      </section>
    );
  if (!user)
    return (
      <section className="library-panel login-panel">
        <span className="badge light">LOCAL WORKSPACE</span>
        <h2>Sign in to your policy library.</h2>
        <p>Your account controls which tenant's policies you can access.</p>
        {authMode === "local" ? (
          <form onSubmit={login}>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button className="primary-button" disabled={busy}>
              Sign in
            </button>
            <small>
              Use the local account created during setup. Credentials are stored
              in your local configuration file.
            </small>
          </form>
        ) : (
          <p>
            This environment requires a Cognito access token. Use the documented
            API client authentication flow.
          </p>
        )}
        {error && (
          <p role="alert" className="error-note">
            {error}
          </p>
        )}
      </section>
    );
  return (
    <div className="library">
      <div className="library-toolbar">
        <span className="pill up">{user.role} · Tenant workspace</span>
        <button
          className="refresh"
          onClick={() =>
            void action(async () => {
              await api("/auth/logout", { method: "POST" });
              setUser(null);
              setDocuments([]);
              setMatches(null);
            })
          }
        >
          Sign out
        </button>
      </div>
      {error && (
        <p role="alert" className="error-note">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success-note">
          {notice}
        </p>
      )}
      {user.role === "ADMIN" && (
        <div className="library-forms">
          <section className="library-panel">
            <h2>1. Choose a policy</h2>
            <label>
              Policy
              <select
                value={policyId}
                onChange={(e) => {
                  setPolicyId(e.target.value);
                  setPrevious("");
                  setExplicitVersion("");
                  setMatches(null);
                }}
              >
                <option value="">Select a policy</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.provider}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>Create a policy</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    const policy = await api("/policies", {
                      method: "POST",
                      body: JSON.stringify({ name: policyName, provider }),
                    });
                    await refresh();
                    setPolicyId(policy.id);
                    setPolicyName("");
                    setProvider("");
                    setNotice(
                      "Policy created. You can upload its documents now.",
                    );
                  });
                }}
              >
                <label>
                  Policy name
                  <input
                    value={policyName}
                    onChange={(e) => setPolicyName(e.target.value)}
                    required
                    maxLength={200}
                  />
                </label>
                <label>
                  Insurance provider
                  <input
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    required
                    maxLength={200}
                  />
                </label>
                <button className="refresh" disabled={busy}>
                  Create policy
                </button>
              </form>
            </details>
          </section>
          <section className="library-panel">
            <h2>2. Upload a document</h2>
            <form onSubmit={upload}>
              <label>
                Policy file
                <input
                  type="file"
                  accept=".pdf,.docx,.xlsx,.csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  required
                />
              </label>
              <div className="form-grid">
                <label>
                  Effective from
                  <input
                    type="date"
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Supersedes
                  <select
                    value={previous}
                    onChange={(e) => setPrevious(e.target.value)}
                  >
                    <option value="">New document</option>
                    {documents
                      .filter(
                        (d) =>
                          d.policy_id === policyId &&
                          !["PENDING_UPLOAD", "ARCHIVED"].includes(d.status),
                      )
                      .map((d) => (
                        <option key={d.version_id} value={d.version_id}>
                          {d.name} · v{d.version}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <div className="upload-footer">
                <small>PDF, DOCX, XLSX, CSV · up to 25 MiB</small>
                <button className="primary-button" disabled={busy || !policyId}>
                  {busy ? "Working…" : "Upload & index"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      <section className="library-panel">
        <div className="section-heading">
          <h2>Document versions</h2>
          <button className="refresh" onClick={() => void refresh()}>
            ↻ Refresh
          </button>
        </div>
        <p className="subtitle">
          Status updates automatically. Archiving removes a version from search
          and keeps its source file.
        </p>
        {!documents.length ? (
          <p className="empty-copy">
            No documents yet. Create a policy and upload its first document.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="document-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Version / effective date</th>
                  <th>Status</th>
                  <th>Index</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.version_id}>
                    <td>
                      <strong>{d.name}</strong>
                      <small>{d.policy_name}</small>
                    </td>
                    <td>
                      v{d.version}
                      <small>{d.effective_from}</small>
                    </td>
                    <td>
                      <span
                        className={`pill ${d.status === "INDEXED" ? "up" : d.status === "FAILED" ? "down" : ""}`}
                      >
                        {d.status}
                      </span>
                      {d.failure_code && (
                        <small className="failure-code">{d.failure_code}</small>
                      )}
                    </td>
                    <td>
                      {d.chunk_count} chunks
                      {d.job && (
                        <small>
                          {d.job.input_tokens} input tokens · attempt{" "}
                          {d.job.attempts}
                        </small>
                      )}
                    </td>
                    <td>
                      {user.role === "ADMIN" && (
                        <div className="row-actions">
                          {["FAILED", "INDEXED"].includes(d.status) && (
                            <button
                              className="refresh"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await api(
                                    `/documents/${d.document_id}/reindex`,
                                    {
                                      method: "POST",
                                      headers: {
                                        "Idempotency-Key": crypto.randomUUID(),
                                      },
                                      body: JSON.stringify({
                                        versionId: d.version_id,
                                      }),
                                    },
                                  );
                                  await refresh();
                                })
                              }
                            >
                              {d.status === "FAILED" ? "Retry" : "Reindex"}
                            </button>
                          )}
                          {d.status !== "ARCHIVED" && (
                            <button
                              className="refresh"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await api(
                                    `/documents/${d.document_id}/archive`,
                                    {
                                      method: "POST",
                                      body: JSON.stringify({
                                        versionId: d.version_id,
                                      }),
                                    },
                                  );
                                  setNotice(
                                    "Version archived. Its source file is retained.",
                                  );
                                  await refresh();
                                })
                              }
                            >
                              Archive
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="library-panel">
        <h2>Verify the indexed evidence</h2>
        <p className="subtitle">
          Search retrieves source excerpts from the applicable policy version.
          It does not generate an insurance answer.
        </p>
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const result = await api("/search", {
                method: "POST",
                body: JSON.stringify({
                  question,
                  policyId,
                  asOfDate: asOf,
                  ...(explicitVersion ? { versionIds: [explicitVersion] } : {}),
                }),
              });
              setMatches(result.matches);
            });
          }}
        >
          {user.role === "ADVISOR" && (
            <label>
              Policy
              <select
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
              >
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="form-grid">
            <label>
              Policy effective on
              <input
                type="date"
                required
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </label>
            <label>
              Version selection
              <select
                value={explicitVersion}
                onChange={(e) => setExplicitVersion(e.target.value)}
              >
                <option value="">Use effective date and supersession</option>
                {documents
                  .filter(
                    (d) => d.status === "INDEXED" && d.policy_id === policyId,
                  )
                  .map((d) => (
                    <option key={d.version_id} value={d.version_id}>
                      {d.name} · v{d.version} (explicit historical version)
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label>
            Question
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What is the waiting period?"
              maxLength={4000}
              required
            />
          </label>
          <button className="primary-button" disabled={busy || !policyId}>
            Search policy evidence
          </button>
        </form>
        {matches && (
          <div className="evidence-results">
            {matches.length ? (
              matches.map((match) => (
                <article key={match.chunkId}>
                  <span className="badge light">
                    {match.documentName} · VERSION {match.version}
                    {match.source.pageNumber
                      ? ` · PAGE ${match.source.pageNumber}`
                      : ""}
                    {match.source.sheetName
                      ? ` · ${match.source.sheetName} · ROW ${match.source.rowStart}`
                      : ""}
                  </span>
                  <p>{match.text}</p>
                </article>
              ))
            ) : (
              <p>
                No indexed evidence is available for this policy and effective
                date.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
