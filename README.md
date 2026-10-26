# Work Rights Q&A — a RAG demo over Australian employment law

Ask about leave, pay, notice or redundancy in plain English and get an answer with **citations you
can click and check**, drawn only from official Fair Work Ombudsman pages.

**Live demo:** https://jyothsnaperuri.github.io/workrights-rag/  
_(frontend on GitHub Pages; the API runs on Azure App Service)_

> Unofficial learning project. Not affiliated with, endorsed by or connected to the Fair Work
> Ombudsman. General information only — not legal advice.

---

## Why this exists

Most "AI chatbot" demos are a thin wrapper around a model that answers from memory — which means
it can be confidently, invisibly wrong. This one answers **only** from 23 official documents, cites
every claim, and says "I don't know" when the answer isn't there.

## Architecture

```
                 ┌──────────────────────┐
  Browser ──────▶│    GitHub Pages      │  React + TypeScript (Vite)
                 └──────────┬───────────┘
                            │ HTTPS  (keys never reach the browser)
                 ┌──────────▼───────────┐
                 │   Render (free)      │  Node + Express, SSE streaming
                 └─────┬──────────┬─────┘
                       │          │
        ┌──────────────▼───┐  ┌───▼──────────────────┐
        │ Neon Postgres +  │  │ Gemini (embeddings)  │
        │ pgvector · 201   │  │ Groq (answers)       │
        │ chunks + usage   │  │ both free tiers      │
        └──────────────────┘  └──────────────────────┘
```

**Ingestion (offline, re-runnable):** fetch → clean → chunk → embed → one-transaction corpus swap.
**Query (per request):** embed question → pgvector search → diversify → generate (or the agent loop).

Everything above is free with no expiry. It was originally built on **Azure OpenAI + Azure AI Search**,
deployed by Azure DevOps to App Service and Static Web Apps; when the Azure trial ended in October 2026
the knowledge base moved to Postgres + pgvector and the API to Render — see *Moving off Azure* below.
The Azure pipeline is kept in the repo (`azure-pipelines.yml`, trigger disabled) as a record.

## Moving off Azure

The trial ending disabled every Azure resource at once: the App Service stopped, AI Search was
disabled, Azure OpenAI rejected its keys. The replacement took a day and measured *better*:

| Retrieval | Where | Hit@1 | MRR |
| --- | --- | --- | --- |
| Hybrid + semantic reranker | Azure AI Search | 19/20 | 0.975 |
| **Vector only** | **Postgres + pgvector** | **20/20** | **1.000** |
| Hybrid (vector + full-text, RRF) | Postgres | 14/20 | 0.817 |

Hybrid without a reranker hurts, exactly as it did on Azure: the keyword arm pulls in pages that
share common words. So the default is plain vector search, and `RETRIEVAL_MODE=hybrid` stays available
for comparison. Two things got simpler in the move: the corpus is swapped in one transaction (no empty
index between delete and rebuild), and the daily question cap is one atomic `INSERT … ON CONFLICT …
WHERE` statement, removing a read-then-write race the Azure-backed counter had to tolerate.

## Agentic mode

By default the model drives retrieval: it gets `search_fair_work` (and `search_my_documents` when
you've uploaded something) and a loop — it decides which searches to run, splits a multi-part
question, retries with different words when results are thin, and stops when it has enough. The
first round must search; four rounds maximum; any failure falls back to the direct pipeline.

Measured with an answer-level LLM judge over 20 standard + 7 hard multi-part questions:

| | Direct pipeline | Agent |
| --- | --- | --- |
| Standard (20) | 18/20 | 18/20 |
| Hard, multi-part (7) | 6/7 | **7/7** |
| All (27) | 89% | **93%** |
| Median latency | 2.1 s | 2.3 s |
| Model calls / question | 1.0 | 2.1 |

The agent's gain is concentrated in multi-part questions — the case a single search structurally
loses. It costs twice the model calls (though only ~10% more median latency), and on Groq's free tier (8,000 tokens/minute) that matters,
so it degrades: brief retry → direct pipeline → "service busy". `ANSWER_MODE=direct` reverts.
`npm run evaluate:answers` reproduces the table.

## Retrieval quality

Measured against 20 hand-written questions in
[`knowledge-base/TEST-QUESTIONS.md`](knowledge-base/TEST-QUESTIONS.md) — current stack is in the
*Moving off Azure* table above (20/20). The original Azure-era experiment, kept because it's instructive:

| Retrieval strategy (Azure AI Search) | Hit@1 | MRR |
| --- | --- | --- |
| Vector only | 80% | 0.877 |
| Hybrid (keyword + vector) | 65% | 0.813 |
| **Hybrid + semantic reranker** | **95%** | **0.975** |

Hybrid *alone* scores worse than vector alone — it widens the candidate pool with keyword matches,
including noisy ones; a cross-encoder reranker cleans that pool up. 20 questions is a small sample:
a one-question difference is noise; the 80% → 95% and 65% → 100% gaps are large enough to act on.

## Upload your own document

Visitors can upload a contract or policy (text-based PDF, TXT or Markdown, ≤5 MB) and ask
questions answered from **their document and the Fair Work pages together**, each claim cited to
its source:

> *Your contract provides 2 weeks' notice, while the NES minimum after 4 years of service is
> 3 weeks* — [1] your document, clause 7 · [4] Fair Work, Minimum notice period

It explains what the document says and what the rules say; it does not judge whether the
document is lawful, which it leaves to the Fair Work Infoline.

- **Isolation:** every chunk carries a `scope` — `public` for the Fair Work pages, or the
  visitor's anonymous session id. Retrieval filters on scope *before* ranking, server-side, so one
  visitor can never retrieve another's file. No account, nothing identifying collected.
- **Reserved seats:** the semantic reranker will rank the official notice-period table above a
  visitor's own contract clause — correct by its lights, wrong for someone asking about "my
  contract". Two context slots are guaranteed to their own document.
- **Privacy:** a notice before the first upload states that the text goes to Google and Groq,
  that it's kept 7 days, and that this is a public demo. Delete per document or all at once;
  expired chunks are swept hourly; document content is never logged.
- **Limits:** 3 documents per visitor, ~60 pages each, 10 uploads/hour per IP, and a global cap
  on uploaded chunks with oldest-first eviction — the 50 MB free-tier index is the scarce resource.
- **Consistency:** Azure AI Search indexes asynchronously, so the upload endpoint waits until the
  chunks are actually searchable before reporting success.

## Notable implementation details

- **Chunks carry their heading path.** Every chunk is prefixed with `Document > Heading`, so a
  passage reading "4 weeks, based on ordinary hours" still says what it is about. Cheap, large effect.
- **Short sections merge rather than drop.** A 57-character section — "Sick and carer's leave isn't
  paid out when employment ends" — is an entire answer. An early minimum-length filter deleted it.
- **Per-document cap on results.** Nearest-neighbour search optimises for similarity, not coverage;
  without a cap, one topic fills every slot and a two-part question loses its second half.
- **Stable chunk IDs** (hash of file + position) so re-ingesting updates in place instead of
  duplicating the index.
- **Full index rebuild** on every ingest, so a shrinking document can't leave orphaned chunks
  quoting deleted text.
- **Cost controls:** 15 questions/10 min per visitor, 300/day globally (counter stored in Azure AI
  Search so it survives restarts), 400-char question limit, origin lock, plus an Azure budget alert.

## Running locally

```bash
npm install
createdb workrights && psql -d workrights -c 'create extension vector'   # local Postgres with pgvector
cp .env.example .env     # DATABASE_URL, Groq and Gemini keys, admin credentials
npm run verify           # checks Postgres, Gemini and Groq respond
npm run fetch-sources    # download and clean the knowledge base
npm run ingest           # chunk, embed, write to Postgres (free)
./demo.sh                # API on :8787 and UI on :5173, opens the browser
```

| Command | What it does |
| --- | --- |
| `npm run verify` | Smoke-tests Postgres + pgvector, Gemini and Groq before anything else |
| `npm run fetch-sources` | Re-downloads the 23 source pages (rules change — wages every 1 July) |
| `npm run ingest` | Rebuilds the knowledge base in Postgres (one-transaction swap) |
| `npm run search "…"` | Shows what retrieval returns, without generating an answer |
| `npm run ask "…"` | Full RAG answer in the terminal |
| `npm run evaluate` | Scores retrieval against the test questions |

`RETRIEVAL_MODE=vector|hybrid` switches strategy (`vector` is the default).

## Deployment

- **Frontend:** GitHub Pages, built and published by `.github/workflows/pages.yml` on every push to `web/`.
- **API:** Render free plan from `render.yaml` (New → Blueprint). Secrets are entered in the Render
  dashboard; the API URL the frontend calls is the `API_URL` repository variable.
- **Keep-alive:** `.github/workflows/keep-alive.yml` pings `/api/health` every 10 minutes during Sydney
  daytime only — Render's 750 free instance-hours a month are shared across the account.

The evaluation suites are deliberately **not** in CI — they need live model credentials and the free
tiers' per-minute limits, so they stay manual gates before changing retrieval or the prompt.

## Attribution

Contains information from the Fair Work Ombudsman,
© Fair Work Ombudsman [www.fairwork.gov.au](https://www.fairwork.gov.au), licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/legalcode).
Navigation, videos, glossary pop-ups and interactive widgets were removed and the remaining text
converted to Markdown; wording is unchanged. Per-page sources:
[`knowledge-base/SOURCES.md`](knowledge-base/SOURCES.md).

Built by [Jyothsna (Jo) Peruri](https://jyothsnaperuri.github.io/Jyothsna-portfolio/).
