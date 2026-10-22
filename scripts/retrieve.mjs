// Step 3 of the RAG pipeline: retrieval.
//
// This is the "R" in RAG, kept deliberately separate from answer generation so
// the two can be debugged independently. If a final answer is wrong, the first
// question is always "did retrieval hand the model the right text?" — and this
// module is how you find out.

import { PROVIDERS } from "./providers.mjs";
import { hybridSearch, nearestOwn } from "./store.mjs";

export const TOP_K = 8;

// Nearest-neighbour search optimises for similarity, not coverage. Ask a
// two-part question ("notice AND redundancy pay") and the dominant topic can
// fill every slot with near-duplicates from one document, starving the other
// half of the question. Capping per document forces breadth.
//
// Set to 3, not 2: a cap of 2 cut off the redundancy-pay table, which is the
// chunk that actually answers the question. Diversity must not evict answers.
const MAX_PER_DOCUMENT = 3;

// Fetch extra candidates so there is something left to promote after the cap
// drops the crowded ones.
const CANDIDATE_MULTIPLIER = 3;

// When a visitor has uploaded a document, this many of the final slots are
// reserved for their best-matching chunks. The semantic reranker optimises for
// relevance to the question and will happily rank the official notice-period
// table above the visitor's own contract clause — correct by its lights, but
// someone who uploads a contract and asks about "my contract" must have it
// consulted. Measured: the contract chunk ranked 8th of 24 under vector search
// and was reranked out of the top 8 entirely.
const RESERVED_FOR_UPLOADS = 2;

/**
 * Keeps the highest-scoring chunks while allowing at most MAX_PER_DOCUMENT from
 * any one source file. Anything dropped by the cap is added back at the end if
 * there is room, so we never return fewer results than we could.
 */
function diversify(hits, top) {
  const perDocument = new Map();
  const selected = [];
  const overflow = [];

  for (const hit of hits) {
    const used = perDocument.get(hit.sourceFile) ?? 0;
    if (used < MAX_PER_DOCUMENT && selected.length < top) {
      perDocument.set(hit.sourceFile, used + 1);
      selected.push(hit);
    } else {
      overflow.push(hit);
    }
  }
  return selected.concat(overflow.slice(0, Math.max(0, top - selected.length)));
}

/**
 * Retrieval in Postgres. Default "vector": exact pgvector cosine search, then
 * rebalanced for document diversity. "hybrid" adds a full-text arm fused with
 * Reciprocal Rank Fusion (see store.mjs).
 *
 * Measured on the 20 test questions after moving off Azure (Oct 2026):
 *   vector  Hit@1 20/20, MRR 1.000
 *   hybrid  Hit@1 14/20, MRR 0.817  — the keyword arm pulls in pages that share
 *           common words, the same failure hybrid-without-reranker had on Azure.
 * So vector is the default; hybrid stays available for comparison.
 *
 * The index is built with Gemini embeddings, so the question is always embedded
 * with Gemini too — vectors from different models aren't comparable. The
 * `provider` choice only affects which model writes the answer.
 *
 * Azure's "semantic" reranker went with the Azure trial; any other mode value
 * (including the old "semantic") falls back to vector.
 */
export async function retrieve(
  question,
  { top = TOP_K, mode = process.env.RETRIEVAL_MODE ?? "vector", scope, onlyOwn = false } = {},
) {
  const vector = await PROVIDERS.free.embedQuery(question);
  const candidates = top * CANDIDATE_MULTIPLIER;

  const hits = await hybridSearch({
    vector,
    text: question,
    scope,
    onlyOwn,
    k: candidates,
    mode: mode === "hybrid" ? "hybrid" : "vector",
  });

  if (!scope || onlyOwn) return diversify(hits, top);

  // Reserve seats for the visitor's own document(s): ranking optimises for
  // relevance to the question and will happily put the official notice-period
  // table above the visitor's own contract clause — correct by its lights, but
  // someone asking about "my contract" must have it consulted.
  const own = await nearestOwn({ vector, scope, k: RESERVED_FOR_UPLOADS });
  if (own.length === 0) return diversify(hits, top);

  const ownIds = new Set(own.map((h) => h.id));
  const rest = diversify(hits.filter((h) => !ownIds.has(h.id)), top - own.length);
  // Own-document chunks first, so they take citations [1] and [2].
  return [...own, ...rest];
}

// --- CLI: npm run search "your question here" -------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    console.error('Usage: npm run search "how much annual leave do I get"');
    process.exit(1);
  }

  const hits = await retrieve(question);
  console.log(`\nQ: ${question}\n`);
  hits.forEach((hit, i) => {
    // Strip the "Title > Heading" prefix we added at ingest time; it is shown
    // separately, and repeating it makes the preview harder to read.
    const preview = hit.content.split("\n\n").slice(1).join(" ").replace(/\s+/g, " ");
    console.log(`${i + 1}. [${hit.score.toFixed(4)}] ${hit.sourceFile}`);
    console.log(`   ${hit.title}${hit.heading ? ` > ${hit.heading}` : ""}`);
    console.log(`   ${preview.slice(0, 160)}${preview.length > 160 ? "..." : ""}\n`);
  });
}
