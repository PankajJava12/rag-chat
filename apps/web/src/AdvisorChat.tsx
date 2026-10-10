import { useEffect, useRef, useState, type FormEvent } from "react";
type Policy = { id: string; name: string; provider: string };
type Conversation = {
  id: string;
  policy_id: string;
  comparison_policy_id?: string;
  comparison_policy_name?: string;
  policy_name?: string;
  as_of_date: string;
  version_ids?: string[];
  created_at: string;
};
type Citation = {
  number: number;
  policyName?: string;
  documentName: string;
  version: number;
  sourceUrl: string;
  quote: string;
  source: {
    kind?: string;
    pageNumber?: number;
    sectionTitle?: string;
    sheetName?: string;
    rowStart?: number;
    rowEnd?: number;
  };
};
type Message = {
  id: string;
  role: "user" | "assistant";
  question?: string;
  answer?: string;
  citations?: Citation[];
  insufficientEvidence?: boolean;
  conflict?: boolean;
  processingTimeMs?: number;
  model?: string;
  usedHistory?: boolean;
};
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    credentials: "same-origin",
  });
  if (response.status === 204) return null;
  const result = await response
    .json()
    .catch(() => ({ error: { code: "SERVICE_UNAVAILABLE" } }));
  if (!response.ok) throw new Error(result.error?.code ?? "REQUEST_FAILED");
  return result;
}
const errorText: Record<string, string> = {
  INVALID_CREDENTIALS: "The email or password is incorrect.",
  VERSION_CLARIFICATION_REQUIRED:
    "More than one version may apply. Start a chat with a specific document version, or resolve its supersession in the library.",
  APPLICABLE_VERSION_NOT_INDEXED:
    "The applicable policy version is not indexed yet. Check its status in the document library.",
  VERSION_CHANGED_RETRY:
    "The policy changed while answering. Please ask again to use the updated documents.",
  CHAT_ALREADY_RUNNING:
    "A question is already processing in this chat. Wait for it to finish or start another chat.",
  CHAT_RETRY_WITH_NEW_KEY:
    "This request was interrupted. Ask the question again to retry.",
  CHAT_CAPACITY_REACHED: "The local model is busy. Please try again shortly.",
  CHAT_RATE_LIMITED:
    "Too many questions in a short time. Please wait a minute.",
  MODEL_UNAVAILABLE:
    "The chat model is unavailable. Check that Ollama and the configured chat model are running, then retry.",
  MODEL_TIMEOUT:
    "The local model timed out while loading or generating an answer. Retry once; if it happens again, check the local model service and Docker memory.",
  CONVERSATION_NOT_FOUND:
    "This conversation is unavailable or has expired. Start a new chat.",
};
export function AdvisorChat() {
  const [signedIn, setSignedIn] = useState(false),
    [checking, setChecking] = useState(true),
    [email, setEmail] = useState("admin@advisor.local"),
    [password, setPassword] = useState("");
  const [policies, setPolicies] = useState<Policy[]>([]),
    [documents, setDocuments] = useState<
      {
        policy_id: string;
        version_id: string;
        name: string;
        version: number;
        status: string;
      }[]
    >([]);
  const [policyId, setPolicyId] = useState(""),
    [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10)),
    [comparisonId, setComparisonId] = useState(""),
    [versionId, setVersionId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [current, setCurrent] = useState<Conversation | null>(null),
    [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [draft, setDraft] = useState(""),
    [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const showError = (e: unknown) => {
    const code = e instanceof Error ? e.message : "REQUEST_FAILED";
    setError(errorText[code] ?? code.replaceAll("_", " ").toLowerCase());
  };
  async function refresh() {
    const [p, d, c] = await Promise.all([
      api("/policies"),
      api("/documents"),
      api("/conversations"),
    ]);
    if (!mounted.current) return;
    setPolicies(p.items);
    setDocuments(d.items);
    setConversations(c.items);
    setPolicyId((old) => old || p.items[0]?.id || "");
  }
  useEffect(() => {
    mounted.current = true;
    void api("/auth/me")
      .then(() => {
        if (mounted.current) {
          setSignedIn(true);
          void refresh().catch(showError);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setChecking(false);
      });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, draft, stage]);
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setPassword("");
      setSignedIn(true);
      await refresh();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }
  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const c = await api("/conversations", {
        method: "POST",
        body: JSON.stringify({
          policyId,
          asOfDate: asOf,
          ...(comparisonId ? { comparisonPolicyId: comparisonId } : {}),
          ...(versionId ? { versionIds: [versionId] } : {}),
        }),
      });
      setCurrent(c);
      setMessages([]);
      setQuestion("");
      setDraft("");
      await refresh();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }
  async function open(c: Conversation) {
    setBusy(true);
    setError("");
    setDraft("");
    try {
      const result = await api(`/conversations/${c.id}`);
      setCurrent(result);
      setMessages(result.messages);
      setQuestion("");
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!current || !question.trim()) return;
    const text = question.trim(),
      id = current.id;
    setBusy(true);
    setError("");
    setStage("Finding policy evidence…");
    setDraft("");
    const abort = new AbortController();
    controller.current = abort;
    let done = false;
    try {
      const response = await fetch(`/api/v1/conversations/${id}/messages`, {
        method: "POST",
        credentials: "same-origin",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ question: text }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.error?.code ?? "SERVICE_UNAVAILABLE");
      }
      if (!response.body) throw new Error("STREAM_UNAVAILABLE");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          buffer += decoder.decode(item.value, { stream: true });
          if (buffer.length > 100000) throw new Error("STREAM_TOO_LARGE");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const type = block.match(/^event: (.+)$/m)?.[1],
              data = block.match(/^data: (.+)$/m)?.[1];
            if (!data) continue;
            const value = JSON.parse(data);
            if (type === "status")
              setStage(
                (
                  {
                    retrieving: "Finding policy evidence…",
                    generating: "Reading the relevant policy passages…",
                    validating: "Checking citations…",
                    replayed: "Recovering your saved answer…",
                  } as Record<string, string>
                )[value.stage] ?? "Preparing your answer…",
              );
            if (type === "delta") setDraft((old) => old + value.text);
            if (type === "error") throw new Error(value.code);
            if (type === "done") {
              done = true;
              setMessages((old) => [
                ...old,
                { id: crypto.randomUUID(), role: "user", question: text },
                { ...value, role: "assistant" },
              ]);
              setQuestion("");
              setDraft("");
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!done) throw new Error("STREAM_INTERRUPTED");
      await refresh();
    } catch (e) {
      if (mounted.current) {
        setDraft("");
        if (abort.signal.aborted)
          setError(
            "Stopped. No partial answer is shown. Reopen this chat to check whether an answer finished saving.",
          );
        else showError(e);
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        setStage("");
      }
      controller.current = null;
    }
  }
  if (checking) return <p role="status">Checking your session…</p>;
  if (!signedIn)
    return (
      <section className="library-panel login-panel">
        <span className="eyebrow">YOUR POLICY WORKSPACE</span>
        <h2>Sign in to ask your policies.</h2>
        <p>Use the local account created during setup.</p>
        <form onSubmit={login}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="primary-button" disabled={busy}>
            Sign in
          </button>
        </form>
        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  const selectedPolicy = policies.find((p) => p.id === current?.policy_id);
  return (
    <div className="chat-workspace">
      <div className="chat-topline">
        <span className="pill up">PRIVATE POLICY CHAT</span>
        <span>Visible only to your account</span>
      </div>
      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}
      <div className="chat-layout">
        <section className="library-panel chat-controls">
          <h2>Start a conversation</h2>
          <form onSubmit={start}>
            <label>
              Policy
              <select
                value={policyId}
                onChange={(e) => {
                  setPolicyId(e.target.value);
                  setVersionId("");
                  setComparisonId("");
                }}
                required
                disabled={busy}
              >
                <option value="">Choose a policy</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Compare with (optional)
              <select
                value={comparisonId}
                disabled={busy}
                onChange={(e) => {
                  setComparisonId(e.target.value);
                  setVersionId("");
                }}
              >
                <option value="">One policy</option>
                {policies
                  .filter((p) => p.id !== policyId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Effective on
              <input
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label>
              Document scope
              <select
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                disabled={busy || Boolean(comparisonId)}
              >
                <option value="">All applicable policy documents</option>
                {documents
                  .filter(
                    (d) => d.policy_id === policyId && d.status !== "ARCHIVED",
                  )
                  .map((d) => (
                    <option key={d.version_id} value={d.version_id}>
                      {d.name} · v{d.version} (explicit version)
                    </option>
                  ))}
              </select>
            </label>
            <button className="primary-button" disabled={busy || !policyId}>
              New conversation
            </button>
          </form>
          <p className="chat-hint">
            The policy and effective date stay fixed for this conversation.
            Explicit versions are historical selections.
          </p>
          <h3>Your conversations</h3>
          <div className="conversation-list">
            {conversations.map((c) => (
              <button
                className={
                  c.id === current?.id
                    ? "conversation-item selected"
                    : "conversation-item"
                }
                key={c.id}
                disabled={busy}
                onClick={() => void open(c)}
              >
                <strong>
                  {c.policy_name}
                  {c.comparison_policy_name
                    ? ` vs ${c.comparison_policy_name}`
                    : ""}
                </strong>
                <small>
                  Effective {c.as_of_date} ·{" "}
                  {new Date(c.created_at).toLocaleDateString()}
                </small>
              </button>
            ))}
            {!conversations.length && (
              <p className="chat-hint">
                Your saved conversations will appear here.
              </p>
            )}
          </div>
        </section>
        <section className="library-panel chat-panel">
          <div className="chat-heading">
            <span className="eyebrow">EVIDENCE FIRST</span>
            <h2>
              {current
                ? `${selectedPolicy?.name ?? "Policy conversation"}${current.comparison_policy_id ? ` vs ${policies.find((p) => p.id === current.comparison_policy_id)?.name ?? "comparison policy"}` : ""}`
                : "Ask. Read. Verify."}
            </h2>
            <p>
              {current
                ? `Effective ${current.as_of_date}${current.version_ids?.length ? " · Explicit document version" : " · Applicable policy versions"}`
                : "Choose a policy to get answers with verifiable source passages."}
            </p>
          </div>
          <div
            className="chat-transcript"
            aria-label="Conversation messages"
            aria-live="polite"
          >
            {!messages.length && (
              <div className="chat-welcome">
                <span>✦</span>
                <h3>Answers you can trace to the source.</h3>
                <p>
                  Ask about waiting periods, benefits, exclusions, or claim
                  documents. When the evidence is missing or conflicting, the
                  assistant will say so.
                </p>
                <small>
                  Answers quote policy wording. Follow-up questions can use the
                  recent topic. Comparisons show each policy’s evidence
                  separately.
                </small>
              </div>
            )}
            {messages.map((m) => (
              <article key={m.id} className={`chat-message ${m.role}`}>
                <div className="message-label">
                  {m.role === "user" ? "You" : "AI Advisor"}
                  {m.insufficientEvidence
                    ? " · Insufficient evidence"
                    : m.conflict
                      ? " · Conflicting sources"
                      : ""}
                </div>
                <p
                  className={`answer-text${m.citations?.some((c) => c.source.kind === "table") ? " table-answer" : ""}`}
                >
                  {m.question ?? m.answer}
                </p>
                {m.usedHistory && (
                  <small>Used the recent conversation topic.</small>
                )}
                {m.citations?.length ? (
                  <div className="chat-citations">
                    {m.citations.map((c) => (
                      <details key={c.number}>
                        <summary>
                          [{c.number}]{" "}
                          {c.policyName ? `${c.policyName} · ` : ""}
                          {c.documentName} · v{c.version}
                          {c.source.pageNumber
                            ? ` · page ${c.source.pageNumber}`
                            : ""}
                          {c.source.sheetName ? ` · ${c.source.sheetName}` : ""}
                          {c.source.rowStart
                            ? ` · row ${c.source.rowStart}`
                            : ""}
                        </summary>
                        <blockquote
                          className={
                            c.source.kind === "table"
                              ? "table-quote"
                              : undefined
                          }
                        >
                          {c.quote}
                        </blockquote>
                        {c.source.sectionTitle && (
                          <small>{c.source.sectionTitle}</small>
                        )}
                        <a href={c.sourceUrl}>Download cited source</a>
                      </details>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
            {busy && stage && (
              <p className="chat-progress" role="status">
                <span className="small-dot" /> {stage}
              </p>
            )}
            {draft && (
              <article className="chat-message assistant">
                <p className="answer-text">{draft}</p>
              </article>
            )}
            <div ref={bottom} />
          </div>
          <form className="chat-composer" onSubmit={send}>
            <label htmlFor="chat-question">Your policy question</label>
            <textarea
              id="chat-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What is the waiting period for pre-existing diseases?"
              maxLength={4000}
              required
              disabled={!current || busy}
              rows={3}
            />
            <div>
              <small>
                Verify the cited wording before advising a customer.
              </small>
              {busy && controller.current ? (
                <button
                  type="button"
                  className="refresh"
                  onClick={() => controller.current?.abort()}
                >
                  Stop
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={!current || busy || !question.trim()}
                >
                  Ask AI Advisor <span aria-hidden="true">↑</span>
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
