// Step 3 of the RAG pipeline: retrieval.
//
// This is the "R" in RAG, kept deliberately separate from answer generation so
// the two can be debugged independently. If a final answer is wrong, the first
// question is always "did retrieval hand the model the right text?" — and this
// module is how you find out.

import { embed, search } from "./azure.mjs";

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
 * Hybrid search: keyword and vector search run together and Azure fuses the two
 * rankings (Reciprocal Rank Fusion). Then we rebalance for document diversity.
 *
 * Hybrid matters because vectors are weak exactly where this data is strongest:
 * tables and figures. "How much redundancy pay for 4 years" ranked the actual
 * pay table 3rd under pure vector search — the surrounding prose *about*
 * redundancy pay embedded better than the table *of* redundancy pay. Adding the
 * keyword arm moved the table to 1st.
 */
export async function retrieve(question, top = TOP_K, mode = process.env.RETRIEVAL_MODE ?? "semantic") {
  const [vector] = await embed([question]);
  const candidates = top * CANDIDATE_MULTIPLIER;

  const query = {
    vectorQueries: [{ kind: "vector", vector, fields: "vector", k: candidates }],
    select: "content,title,heading,url,sourceFile,saved",
    top: candidates,
  };
  if (mode !== "vector") {
    query.search = question; // keyword arm
    query.queryType = "simple";
  }
  if (mode === "semantic") {
    // Azure's L2 reranker: a cross-encoder re-scores the fused top results by
    // reading question and passage together, rather than comparing two
    // independently-produced vectors.
    query.queryType = "semantic";
    query.semanticConfiguration = "default-semantic";
  }

  const result = await search.query(query);

  const hits = result.value.map((doc) => ({
    score: doc["@search.score"],
    content: doc.content,
    title: doc.title,
    heading: doc.heading,
    url: doc.url,
    sourceFile: doc.sourceFile,
    saved: doc.saved,
  }));

  return diversify(hits, top);
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
