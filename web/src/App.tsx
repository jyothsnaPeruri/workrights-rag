import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { ask, warmUp, type Source } from "./api";
import { history, newId, titleFrom, type Conversation, type Turn } from "./storage";
import { adminLogin, loadProviderState, loadStats, setToken, type ProviderState, type UsageStats } from "./admin";
import { deleteDocument, listDocuments, uploadDocument, type UploadedDocument } from "./documents";

const STARTERS = [
  "How much annual leave do I get, and does it carry over?",
  "I've worked here 4 years — how much notice am I owed?",
  "Can my manager refuse a leave request?",
  "Do I still accrue sick leave during probation?",
];

/* ------------------------------------------------------------------ text -- */

/**
 * Some models (Groq's gpt-oss family) write citation markers with full-width
 * brackets, 【1】, regardless of what the prompt asks for. Normalise to [1] so
 * the parser and the "which sources were cited" check both see the same thing.
 */
const normaliseCitations = (text: string) => text.replace(/【\s*(\d+)\s*】/g, "[$1]");

/** Splits inline text into bold runs and citation markers. */
function inline(text: string, sources: Source[], onCite: (s: Source) => void) {
  return normaliseCitations(text)
    // Move markers after sentence punctuation and close up the space before
    // them, so "under the NES [3]." sets as "under the NES.³" rather than
    // leaving a gap and an orphaned full stop.
    .replace(/\s*((?:\[\d+\])+)\s*([.,;:])/g, "$2$1")
    .replace(/\s+(\[\d+\])/g, "$1")
    .split(/(\*\*[^*]+\*\*|\[\d+\])/g)
    .map((part, i) => {
      const bold = part.match(/^\*\*([^*]+)\*\*$/);
      if (bold) return <strong key={i}>{bold[1]}</strong>;

      const n = Number(part.match(/^\[(\d+)\]$/)?.[1]);
      const source = sources.find((s) => s.n === n);
      if (!source) return <span key={i}>{part}</span>;

      return (
        <button
          key={i}
          className="cite"
          onClick={() => onCite(source)}
          title={`${source.title}${source.heading ? ` — ${source.heading}` : ""}`}
          aria-label={`Show source ${n}: ${source.title}`}
        >
          {n}
        </button>
      );
    });
}

/**
 * Renders the answer as paragraphs and lists. The model is asked for plain
 * English with short paragraphs or bullets, so this handles exactly that —
 * a full Markdown parser would be a dependency for two features we use.
 */
function Body({ text, sources, onCite }: { text: string; sources: Source[]; onCite: (s: Source) => void }) {
  const blocks: Array<{ list: boolean; lines: string[] }> = [];

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      blocks.push({ list: false, lines: [] }); // paragraph break
      continue;
    }
    const isItem = /^\s*([-*•]|\d+[.)])\s+/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.lines.length && last.list === isItem) last.lines.push(line);
    else blocks.push({ list: isItem, lines: [line] });
  }

  return (
    <>
      {blocks
        .filter((block) => block.lines.length)
        .map((block, i) =>
          block.list ? (
            <ul key={i}>
              {block.lines.map((line, j) => (
                <li key={j}>{inline(line.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), sources, onCite)}</li>
              ))}
            </ul>
          ) : (
            <p key={i}>{inline(block.lines.join(" "), sources, onCite)}</p>
          ),
        )}
    </>
  );
}

/** Renders a source excerpt, turning Markdown pipe-tables back into real tables. */
function Excerpt({ text }: { text: string }) {
  const blocks: Array<{ table: boolean; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.table === isRow) last.lines.push(line);
    else blocks.push({ table: isRow, lines: [line] });
  }

  const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  return (
    <>
      {blocks.map((block, i) =>
        block.table ? (
          <table key={i} className="excerpt-table">
            <tbody>
              {block.lines.map((row, r) => (
                <tr key={r}>{cells(row).map((c, k) => (r === 0 ? <th key={k}>{c}</th> : <td key={k}>{c}</td>))}</tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p key={i} className="excerpt">
            {block.lines.join("\n").trim()}
          </p>
        ),
      )}
    </>
  );
}

/**
 * Admin sign-in. Only the model-provider switch sits behind it — visitors never
 * see this, and there is no visitor sign-up at all.
 */
function LoginDialog({ onDone, onClose }: { onDone: (state: ProviderState) => void; onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await adminLogin(username, password));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="panel login" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="panel-head">
          <strong>Admin sign-in</strong>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="login-note">
          Signing in only unlocks the model-provider switch. Visitors need no account.
        </p>

        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy || !username || !password}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/**
 * Shown before a visitor's first upload. People upload employment contracts and
 * payslips, so what happens to the file has to be said up front, not in a footer.
 */
function UploadNotice({ onAccept, onClose }: { onAccept: () => void; onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel notice-panel" role="dialog" aria-modal="true" aria-label="Before you upload" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <strong>Before you upload</strong>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <ul className="notice-list">
          <li>Your file's text is sent to Google (to index it) and Groq (to answer) — both third parties.</li>
          <li>It's stored for <strong>7 days</strong>, then deleted. You can delete it sooner from the side panel.</li>
          <li>It's tied to this browser only. Nobody else can search it — but this is a public demo, not a secure service.</li>
          <li>
            <strong>Don't upload anything you wouldn't email to a stranger.</strong> Remove names, addresses and
            salary figures if you can.
          </li>
          <li>Text-based PDF, TXT or Markdown, under 5 MB. Scanned images won't work.</li>
        </ul>
        <div className="notice-actions">
          <button className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={onAccept}>
            I understand — choose a file
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- app -- */

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chats, setChats] = useState<Conversation[]>(() => history.load());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSource, setOpenSource] = useState<Source | null>(null);
  const [asAt, setAsAt] = useState<string | null>(null);
  const [awake, setAwake] = useState(true);
  const [providerState, setProviderState] = useState<ProviderState | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showUploadNotice, setShowUploadNotice] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  // Escape closes the source panel — expected behaviour for any modal dialog.
  useEffect(() => {
    if (!openSource) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpenSource(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSource]);

  // Start waking the free-tier backend immediately, while the visitor reads the
  // intro — and say so if it's still cold, rather than looking broken.
  useEffect(() => {
    let cancelled = false;
    void warmUp().then((ok) => {
      if (cancelled || ok) return;
      setAwake(false);
      const retry = setInterval(async () => {
        if (await warmUp()) {
          setAwake(true);
          clearInterval(retry);
        }
      }, 5000);
      setTimeout(() => clearInterval(retry), 90_000);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Which providers this client may offer. Anonymous visitors get the default
  // and no list; an admin token unlocks the rest.
  useEffect(() => {
    loadProviderState()
      .then((state) => {
        setProviderState(state);
        setProvider((current) => current ?? state.default);
        setMode((current) => current ?? state.defaultMode ?? null);
      })
      .catch(() => {
        /* the health check already surfaces a server that isn't reachable */
      });
  }, []);

  // Usage stats are admin-only; refetch whenever admin state flips on.
  useEffect(() => {
    if (!providerState?.admin) {
      setStats(null);
      return;
    }
    loadStats().then(setStats).catch(() => setStats(null));
  }, [providerState?.admin]);

  useEffect(() => {
    listDocuments().then(setDocuments).catch(() => {
      /* server down is already surfaced by the health check */
    });
  }, []);

  function chooseFile() {
    // The notice is shown once per browser; after that, straight to the picker.
    let seen = false;
    try {
      seen = localStorage.getItem("workrights.uploadNoticeSeen") === "1";
    } catch {
      /* treat as not seen */
    }
    if (seen) fileInput.current?.click();
    else setShowUploadNotice(true);
  }

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const doc = await uploadDocument(file);
      setDocuments((all) => [...all, doc]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function removeDocument(id: string) {
    setError(null);
    try {
      await deleteDocument(id);
      setDocuments((all) => all.filter((d) => d.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that document.");
    }
  }

  function grow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  async function submit(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    const prior = turns;
    setError(null);
    setDraft("");
    grow(input.current);
    setBusy(true);
    setTurns([...prior, { role: "user", text: question }, { role: "assistant", text: "", streaming: true }]);

    // Accumulate the answer in plain variables as well as in state. React can
    // re-run a state updater, so anything with a side effect — minting an id,
    // writing to localStorage — must not live inside one. Doing that is what
    // produced two sidebar entries for a single conversation.
    let answer = "";
    let sources: Source[] | undefined;
    const patch = (fields: Partial<Turn>) =>
      setTurns((all) => [...all.slice(0, -1), { ...all[all.length - 1], ...fields }]);

    try {
      await ask(
        question,
        {
          onToken: (token) => {
            answer += token;
            patch({ text: answer });
          },
          onSources: (found) => {
            sources = found;
            patch({ sources: found });
            if (found[0]?.saved) setAsAt(found[0].saved);
          },
        },
        // Only send a provider when an admin has actually chosen a non-default
        // one; the server rejects the field from anyone else.
        providerState?.admin && provider && provider !== providerState.default ? provider : undefined,
        mode && mode !== providerState?.defaultMode ? mode : undefined,
      ).done;

      const finished: Turn[] = [
        ...prior,
        { role: "user", text: question },
        { role: "assistant", text: answer, sources },
      ];
      setTurns(finished);

      const id = activeId ?? newId();
      setActiveId(id);
      setChats(
        history.save({
          id,
          title: titleFrom(finished.find((t) => t.role === "user")?.text ?? question),
          turns: finished,
          updatedAt: Date.now(),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      // Keep a partial answer if tokens arrived; otherwise drop the empty pair.
      setTurns(
        answer
          ? [...prior, { role: "user", text: question }, { role: "assistant", text: answer, sources }]
          : prior,
      );
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  function startNewChat() {
    setTurns([]);
    setActiveId(null);
    setError(null);
    setSidebarOpen(false);
    input.current?.focus();
  }

  function openChat(chat: Conversation) {
    setTurns(chat.turns);
    setActiveId(chat.id);
    setError(null);
    setSidebarOpen(false);
  }

  function deleteChat(id: string) {
    setChats(history.remove(id));
    if (id === activeId) {
      setTurns([]);
      setActiveId(null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit(draft);
    }
  }

  return (
    <div className="app">
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="brand">
          <span className="mark" aria-hidden="true">
            WR
          </span>
          Work Rights Q&amp;A
        </div>

        <button className="newchat" onClick={startNewChat} disabled={busy}>
          <span aria-hidden="true">+</span> New chat
        </button>

        <p className="rail-label">Recent</p>
        {chats.length === 0 ? (
          <p className="rail-empty">Your past questions will appear here.</p>
        ) : (
          <ul className="chats">
            {chats.map((chat) => (
              <li key={chat.id} className={chat.id === activeId ? "active" : undefined}>
                <button className="chat-open" onClick={() => openChat(chat)} disabled={busy} title={chat.title}>
                  {chat.title}
                </button>
                <button
                  className="chat-del"
                  onClick={() => deleteChat(chat.id)}
                  disabled={busy}
                  aria-label={`Delete conversation: ${chat.title}`}
                  title="Delete"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="label">Your documents</p>
        {documents.length === 0 ? (
          <p className="rail-empty">Upload a contract or policy with the 📎 button and ask about it alongside the Fair Work pages.</p>
        ) : (
          <ul className="docs">
            {documents.map((doc) => (
              <li key={doc.id}>
                <span className="doc-name" title={doc.name}>
                  {doc.name}
                </span>
                <button className="chat-del" onClick={() => removeDocument(doc.id)} disabled={busy || uploading} aria-label={`Delete ${doc.name}`} title="Delete">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {providerState?.admin && (
          <div className="stats">
            <p className="label">
              Usage
              <button className="refresh" onClick={() => loadStats().then(setStats).catch(() => {})} aria-label="Refresh stats" title="Refresh">
                ↻
              </button>
            </p>
            {stats ? (
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Today</th>
                    <th>7 days</th>
                    <th>All</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Visits", "visits"],
                      ["Questions", "questions"],
                      ["Uploads", "uploads"],
                    ] as const
                  ).map(([label, key]) => (
                    <tr key={key}>
                      <th>{label}</th>
                      <td>{stats.today[key]}</td>
                      <td>{stats.last7[key]}</td>
                      <td>{stats.all[key]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="rail-empty">Loading…</p>
            )}
            <p className="rail-empty stats-note">Visits are page loads, not unique people — no cookies, nothing stored about anyone.</p>
          </div>
        )}

        <div className="rail-foot">
          {providerState?.admin ? (
            <button
              className="linky"
              onClick={() => {
                setToken(null);
                setProvider(providerState.default);
                setProviderState({ ...providerState, admin: false, providers: [] });
              }}
            >
              Sign out (admin)
            </button>
          ) : (
            providerState?.adminAvailable && (
              <button className="linky" onClick={() => setShowLogin(true)}>
                Admin sign-in
              </button>
            )
          )}

          {chats.length > 0 && (
            <button
              className="linky"
              onClick={() => {
                setChats(history.clear());
                setTurns([]);
                setActiveId(null);
              }}
              disabled={busy}
            >
              Clear history
            </button>
          )}
          <p>Chats are saved in this browser only — never sent to a server.</p>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button
            className="hamburger"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="Conversations"
            aria-expanded={sidebarOpen}
          >
            ☰
          </button>
          <div className="brand compact">
            <span className="mark" aria-hidden="true">
              WR
            </span>
            Work Rights Q&amp;A
          </div>
          <span className="tag">Unofficial demo</span>
        </div>

      <div className="thread">
        <div className="column">
          {turns.length === 0 ? (
            <div className="welcome">
              <h1>What would you like to know?</h1>
              <p>
                Ask about Australian workplace entitlements in plain English. Every answer comes only from official
                Fair Work Ombudsman pages, with sources you can open and check.
              </p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s} onClick={() => submit(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="turn user">
                  <div className="text">
                    <p className="label">You asked</p>
                    {turn.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="turn assistant">
                  <div className="body">
                    {turn.text ? (
                      (() => {
                        // Only count sources the answer actually cited. A refusal
                        // cites nothing, and listing five unrelated sources under
                        // "I couldn't find that" reads as a bug.
                        const shown = normaliseCitations(turn.text);
                        const cited = (turn.sources ?? []).filter((s) => shown.includes(`[${s.n}]`));
                        return (
                          <>
                            <p className="label">
                              Answer
                              {!turn.streaming && (
                                <span className="grounded">
                                  {cited.length
                                    ? `grounded in ${cited.length} source${cited.length === 1 ? "" : "s"}`
                                    : "no matching source"}
                                </span>
                              )}
                            </p>
                            <Body text={turn.text} sources={turn.sources ?? []} onCite={setOpenSource} />
                            {turn.streaming && <span className="caret" />}
                            {!turn.streaming && cited.length > 0 && (
                              <div className="refs">
                                <p className="refs-title">Sources</p>
                                <ul>
                                  {cited.map((s) => (
                                    <li key={s.n}>
                                      <button onClick={() => setOpenSource(s)}>
                                        <span className="n">{s.n}</span>
                                        <span className="ref-text">
                                          {s.uploaded ? "Your document: " : ""}
                                          {s.title}
                                          {s.heading ? ` — ${s.heading}` : ""}
                                        </span>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      <>
                        <p className="label">Answer</p>
                        <span className="pending" aria-label="Searching the documents">
                          <i />
                          <i />
                          <i />
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ),
            )
          )}
          <div ref={bottom} />
        </div>
      </div>

      <div className="dock">
        <div className="column" style={{ paddingTop: 0 }}>
          {!awake && (
            <p className="notice" role="status">
              Waking the server — this free demo sleeps when nobody's using it and takes about 30 seconds to start.
              You can type your question now.
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(draft);
            }}
          >
            <textarea
              ref={input}
              rows={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                grow(e.target);
              }}
              onKeyDown={onKeyDown}
              placeholder="Ask a question…"
              maxLength={400}
              disabled={busy}
              aria-label="Your question"
            />
            <div className="composer-bar">
              <div className="composer-tools">
                <button
                  type="button"
                  className="attach"
                  onClick={chooseFile}
                  disabled={busy || uploading || documents.length >= 3}
                  aria-label="Upload a document"
                  title={documents.length >= 3 ? "Maximum 3 documents — delete one first" : "Upload a PDF, TXT or MD to ask about"}
                >
                  {uploading ? <span className="pending" aria-label="Uploading"><i /><i /><i /></span> : "📎"}
                </button>
                <input ref={fileInput} type="file" accept=".pdf,.txt,.md" onChange={onFileChosen} hidden />
              {/* Model picker sits with the input, like a chat client's model
                  menu. Visitors never see it: the server only accepts a
                  provider from a signed-in admin. */}
              {providerState?.admin && providerState.providers.length > 0 ? (
                <label className="model-pick">
                  <span className="model-pick-label">Model</span>
                  <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
                    {providerState.providers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.label}
                        {p.name === providerState.default ? " · default" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {/* Anyone can choose the retrieval strategy. "Agentic" lets the model
                  run several searches (better on multi-part questions, slower);
                  "Standard" is one search. */}
              {providerState?.modes?.length ? (
                <label className="model-pick" title="Standard: fastest, one lookup. Agent: plans and runs several lookups, best for multi-part questions.">
                  <span className="model-pick-label">Mode</span>
                  <select value={mode ?? ""} onChange={(e) => setMode(e.target.value)} disabled={busy}>
                    {providerState.modes.map((m) => (
                      <option key={m} value={m}>
                        {m === "agent" ? "Agent" : "Standard"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              </div>
              <button className="send" type="submit" disabled={busy || !draft.trim()} aria-label="Send">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </form>

          <p className="footnote">
            General information only — not legal advice. Confirm at{" "}
            <a href="https://www.fairwork.gov.au" target="_blank" rel="noreferrer">
              fairwork.gov.au
            </a>{" "}
            or call 13 13 94.
            {/* The CC BY-NC licence requires attribution, a link to the licence,
                a statement of changes, and no implication of endorsement. */}
            <span className="fine">
              Unofficial demo, not endorsed by the Fair Work Ombudsman. Content ©&nbsp;Fair Work Ombudsman,{" "}
              <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noreferrer">
                CC&nbsp;BY-NC&nbsp;4.0
              </a>
              , reformatted; wording unchanged.
              {asAt && <> As at {asAt}.</>} Built by{" "}
              <a href="https://jyothsnaperuri.github.io/Jyothsna-portfolio/" target="_blank" rel="noreferrer">
                Jyothsna&nbsp;(Jo)&nbsp;Peruri
              </a>
              .
            </span>
          </p>
        </div>
      </div>

      </div>

      {showUploadNotice && (
        <UploadNotice
          onClose={() => setShowUploadNotice(false)}
          onAccept={() => {
            try {
              localStorage.setItem("workrights.uploadNoticeSeen", "1");
            } catch {
              /* shown again next time, which is fine */
            }
            setShowUploadNotice(false);
            fileInput.current?.click();
          }}
        />
      )}

      {showLogin && (
        <LoginDialog
          onClose={() => setShowLogin(false)}
          onDone={(state) => {
            setProviderState(state);
            setProvider(state.default);
            setMode(state.defaultMode ?? null);
            setShowLogin(false);
          }}
        />
      )}

      {openSource && (
        <div className="overlay" onClick={() => setOpenSource(null)}>
          <div className="panel" role="dialog" aria-modal="true" aria-label="Source passage" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <strong>
                {openSource.uploaded ? "Your document: " : ""}
                {openSource.title}
                {openSource.heading ? ` — ${openSource.heading}` : ""}
              </strong>
              <button onClick={() => setOpenSource(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <Excerpt text={openSource.excerpt} />
            {openSource.uploaded ? (
              <p className="login-note">From a document you uploaded. It stays in this browser's session only.</p>
            ) : (
              <a href={openSource.url} target="_blank" rel="noreferrer">
                Read the full page on fairwork.gov.au →
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
