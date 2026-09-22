# Work Rights Q&A — a RAG demo over Australian employment law

Ask about leave, pay, notice or redundancy in plain English and get an answer with **citations you
can click and check**, drawn only from official Fair Work Ombudsman pages.

**Live demo:** _(add URL after deployment)_

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
  Browser ──────▶│ Azure Static Web Apps│  React + TypeScript (Vite)
                 └──────────┬───────────┘
                            │ HTTPS  (keys never reach the browser)
                 ┌──────────▼───────────┐
                 │  Azure App Service   │  Node + Express, SSE streaming
                 └─────┬──────────┬─────┘
                       │          │
        ┌──────────────▼───┐  ┌───▼──────────────────┐
        │ Azure AI Search  │  │  Azure OpenAI        │
        │ hybrid + semantic│  │  embeddings + chat   │
        │ reranker, 201    │  │  text-embedding-3-   │
        │ chunks           │  │  small, gpt-4.1-mini │
        └──────────────────┘  └──────────────────────┘
```

**Ingestion (offline, re-runnable):** fetch → clean → chunk → embed → index.
**Query (per request):** embed question → hybrid search → semantic rerank → diversify → generate.

## Retrieval quality

Measured against 20 hand-written questions in
[`knowledge-base/TEST-QUESTIONS.md`](knowledge-base/TEST-QUESTIONS.md):

| Retrieval strategy | Hit@1 | MRR |
| --- | --- | --- |
| Vector only | 80% | 0.877 |
| Hybrid (keyword + vector) | 65% | 0.813 |
| **Hybrid + semantic reranker** | **95%** | **0.975** |

Hybrid *alone* scores worse than vector alone — it widens the candidate pool with keyword matches,
including noisy ones. The reranker is a cross-encoder that reads question and passage together, so
it cleans up that wider pool. Either alone is worse than both.

20 questions is a small sample: 95% is 19/20, and a one-question difference is noise. The
80% → 95% gap is large enough to act on.

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
cp .env.example .env     # fill in your Azure endpoints and keys
npm run verify           # checks all three Azure services respond
npm run fetch-sources    # download and clean the knowledge base
npm run ingest           # chunk, embed, index  (~$0.0006)
npm run server           # API on :8787
npm run web              # UI on :5173
```

| Command | What it does |
| --- | --- |
| `npm run verify` | Smoke-tests Azure OpenAI and AI Search before anything else |
| `npm run fetch-sources` | Re-downloads the 23 source pages (rules change — wages every 1 July) |
| `npm run ingest` | Rebuilds the search index |
| `npm run search "…"` | Shows what retrieval returns, without generating an answer |
| `npm run ask "…"` | Full RAG answer in the terminal |
| `npm run evaluate` | Scores retrieval against the test questions |

`RETRIEVAL_MODE=vector\|hybrid\|semantic` switches strategy, which is how the table above was produced.

## Deployment

Azure DevOps pipeline ([`azure-pipelines.yml`](azure-pipelines.yml)): build and type-check once,
then deploy the API to App Service and the frontend to Static Web Apps as independent stages.

The evaluation suite is deliberately **not** in CI — it needs live credentials and costs money per
run, so it stays a manual gate before changing retrieval.

## Attribution

Contains information from the Fair Work Ombudsman,
© Fair Work Ombudsman [www.fairwork.gov.au](https://www.fairwork.gov.au), licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/legalcode).
Navigation, videos, glossary pop-ups and interactive widgets were removed and the remaining text
converted to Markdown; wording is unchanged. Per-page sources:
[`knowledge-base/SOURCES.md`](knowledge-base/SOURCES.md).

Built by [Jyothsna (Jo) Peruri](https://jyothsnaperuri.github.io/Jyothsna-portfolio/).
