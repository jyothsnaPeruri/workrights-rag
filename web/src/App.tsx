import { useEffect, useRef, useState, type FormEvent } from "react";
import { ask, warmUp, type Source } from "./api";

interface Message {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
}

const EXAMPLES = [
  "How much annual leave do I get?",
  "How much notice after 4 years?",
  "Can my boss refuse my leave request?",
  "Do I get sick leave on probation?",
];

/**
 * Renders a source excerpt, turning Markdown pipe-tables back into real tables.
 * The notice-period and redundancy-pay tables are often the whole answer, and
 * raw `| 1 year or less | 1 week |` rows are hard to read in a popup.
 */
function Excerpt({ text }: { text: string }) {
  const blocks: Array<{ table: boolean; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.table === isRow) last.lines.push(line);
    else blocks.push({ table: isRow, lines: [line] });
  }

  const cells = (row: string) =>
    row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

  return (
    <>
      {blocks.map((block, i) =>
        block.table ? (
          <table key={i} className="excerpt-table">
            <tbody>
              {block.lines.map((row, r) => (
                <tr key={r}>
                  {cells(row).map((cell, c) => (r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>))}
                </tr>
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
 * Renders answer text, turning [1] markers into clickable citation chips.
 * Only citations the model actually used become buttons — a marker pointing at
 * a source that wasn't returned stays as plain text rather than breaking.
 */
function AnswerText({ text, sources, onCite }: { text: string; sources: Source[]; onCite: (s: Source) => void }) {
  return (
    <>
      {/* Pull any space before a citation marker into the marker, so
          "notice [1]." renders as "notice¹." rather than "notice 1 ." */}
      {text.replace(/\s+(\[\d+\])/g, "$1").split(/(\[\d+\])/g).map((part, i) => {
        const n = Number(part.match(/^\[(\d+)\]$/)?.[1]);
        const source = sources.find((s) => s.n === n);
        if (!source) return <span key={i}>{part}</span>;
        return (
          <button
            key={i}
            className="cite"
            onClick={() => onCite(source)}
            title={`${source.title}${source.heading ? ` > ${source.heading}` : ""}`}
          >
            {n}
          </button>
        );
      })}
    </>
  );
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSource, setOpenSource] = useState<Source | null>(null);
  const [asAt, setAsAt] = useState<string | null>(null);
  const [awake, setAwake] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  // Start waking the free-tier backend immediately, while the visitor reads the
  // intro — and tell them if it's still cold, rather than looking broken.
  useEffect(() => {
    let cancelled = false;
    setAwake(true);
    void warmUp().then((ok) => {
      if (cancelled || ok) return;
      setAwake(false);
      // Keep trying; the server usually answers within ~40 seconds.
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

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Escape closes the source panel — expected behaviour for any modal dialog.
  useEffect(() => {
    if (!openSource) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSource(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSource]);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setError(null);
    setQuestion("");
    setBusy(true);
    setMessages((all) => [...all, { role: "user", text: trimmed }, { role: "assistant", text: "" }]);

    // Every update rewrites the last message, which is the streaming answer.
    const updateAnswer = (change: (m: Message) => Message) =>
      setMessages((all) => [...all.slice(0, -1), change(all[all.length - 1])]);

    try {
      await ask(trimmed, {
        onToken: (token) => updateAnswer((m) => ({ ...m, text: m.text + token })),
        onSources: (sources) => {
          updateAnswer((m) => ({ ...m, sources }));
          if (sources[0]?.saved) setAsAt(sources[0].saved);
        },
      }).done;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      // Drop the empty answer bubble, but keep a partial one if tokens arrived.
      setMessages((all) => (all[all.length - 1].text ? all : all.slice(0, -2)));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(question);
  }

  return (
    <div className="app">
      <header>
        <h1>
          <span aria-hidden="true">⚖️</span> Work Rights Q&amp;A
        </h1>
        <p>
          Ask about Australian workplace entitlements in plain English. Every answer is drawn from the Fair Work
          Ombudsman website, with sources you can check.
        </p>
        <p className="disclaimer">
          <strong>Unofficial demo.</strong> Not affiliated with, endorsed by or connected to the Fair Work Ombudsman.
          General information only — not legal advice. Always confirm at{" "}
          <a href="https://www.fairwork.gov.au" target="_blank" rel="noreferrer">
            fairwork.gov.au
          </a>{" "}
          or call the Fair Work Infoline on 13 13 94.
          {asAt && <> Information as at {asAt}.</>}
        </p>
      </header>

      <main className="chat">
        {messages.length === 0 ? (
          <div className="empty">
            <p>Try one of these:</p>
            <div className="examples">
              {EXAMPLES.map((example) => (
                <button key={example} onClick={() => submit(example)} disabled={busy}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, i) => (
            <article key={i} className={`bubble ${message.role}`}>
              {message.role === "user" ? (
                message.text
              ) : message.text ? (
                <>
                  <AnswerText text={message.text} sources={message.sources ?? []} onCite={setOpenSource} />
                  {/* Only show the source list if the answer actually cited something.
                      A refusal ("that isn't in these documents") citing nothing looked
                      broken when five unrelated sources were listed underneath it. */}
                  {message.sources?.some((s) => message.text.includes(`[${s.n}]`)) && (
                    <ul className="sources">
                      {message.sources
                        .filter((s) => message.text.includes(`[${s.n}]`))
                        .map((source) => (
                          <li key={source.n}>
                            <button className="source-link" onClick={() => setOpenSource(source)}>
                              [{source.n}] {source.title}
                              {source.heading ? ` > ${source.heading}` : ""}
                            </button>
                          </li>
                        ))}
                    </ul>
                  )}
                </>
              ) : (
                <span className="thinking">Searching the Fair Work documents…</span>
              )}
            </article>
          ))
        )}
        <div ref={bottom} />
      </main>

      {!awake && (
        <p className="waking" role="status">
          Waking the server up — this free demo sleeps when nobody's using it, and takes about 30
          seconds to start. You can type your question now.
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about leave, pay, notice, redundancy…"
          maxLength={400}
          disabled={busy}
          aria-label="Your question"
        />
        <button type="submit" disabled={busy || !question.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>

      <footer>
        Contains information from the Fair Work Ombudsman, © Fair Work Ombudsman{" "}
        <a href="https://www.fairwork.gov.au" target="_blank" rel="noreferrer">
          www.fairwork.gov.au
        </a>
        , licensed under{" "}
        <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noreferrer">
          CC BY-NC 4.0
        </a>
        . Text was reformatted; wording unchanged. Built by{" "}
        <a href="https://jyothsnaperuri.github.io/Jyothsna-portfolio/" target="_blank" rel="noreferrer">
          Jyothsna (Jo) Peruri
        </a>
        .
      </footer>

      {openSource && (
        <div className="overlay" onClick={() => setOpenSource(null)}>
          <div className="panel" role="dialog" aria-label="Source passage" onClick={(e) => e.stopPropagation()}>
            <header>
              <strong>
                [{openSource.n}] {openSource.title}
                {openSource.heading ? ` > ${openSource.heading}` : ""}
              </strong>
              <button onClick={() => setOpenSource(null)} aria-label="Close">
                ✕
              </button>
            </header>
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
