import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ask, warmUp, type Source } from "./api";
import { history, newId, titleFrom, type Conversation, type Turn } from "./storage";

const STARTERS = [
  "How much annual leave do I get, and does it carry over?",
  "I've worked here 4 years — how much notice am I owed?",
  "Can my manager refuse a leave request?",
  "Do I still accrue sick leave during probation?",
];

/* ------------------------------------------------------------------ text -- */

/** Splits inline text into bold runs and citation markers. */
function inline(text: string, sources: Source[], onCite: (s: Source) => void) {
  return text
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
      await ask(question, {
        onToken: (token) => {
          answer += token;
          patch({ text: answer });
        },
        onSources: (found) => {
          sources = found;
          patch({ sources: found });
          if (found[0]?.saved) setAsAt(found[0].saved);
        },
      }).done;

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

        <div className="rail-foot">
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
                        const cited = (turn.sources ?? []).filter((s) => turn.text.includes(`[${s.n}]`));
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
            <button className="send" type="submit" disabled={busy || !draft.trim()} aria-label="Send">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
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

      {openSource && (
        <div className="overlay" onClick={() => setOpenSource(null)}>
          <div className="panel" role="dialog" aria-modal="true" aria-label="Source passage" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <strong>
                {openSource.title}
                {openSource.heading ? ` — ${openSource.heading}` : ""}
              </strong>
              <button onClick={() => setOpenSource(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <Excerpt text={openSource.excerpt} />
            <a href={openSource.url} target="_blank" rel="noreferrer">
              Read the full page on fairwork.gov.au →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
