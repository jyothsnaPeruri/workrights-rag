// Step 2 of the RAG pipeline: chunk -> embed -> index.
//
// Runs offline, not per request. Re-runnable: it recreates the index from
// scratch, so refreshing the knowledge base is `npm run fetch-sources && npm run ingest`.
//
// Usage: npm run ingest

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { chunkDocument, parseFrontmatter } from "./chunk.mjs";
import { embed, env, search } from "./azure.mjs";

const KB_DIR = new URL("../knowledge-base/", import.meta.url);
const EMBED_BATCH = 50; // inputs per embeddings call
const UPLOAD_BATCH = 100; // documents per index call (Azure's limit is 1000)
const VECTOR_DIMENSIONS = 1536; // must match text-embedding-3-small

/**
 * The index schema. `searchable` fields get full-text (keyword) indexing;
 * the vector field powers semantic similarity. Having both is what makes
 * hybrid search possible later — keyword catches exact terms like "21 days"
 * that vectors sometimes miss.
 */
function indexDefinition(name) {
  return {
    name,
    fields: [
      { name: "id", type: "Edm.String", key: true, filterable: true },
      { name: "content", type: "Edm.String", searchable: true, analyzer: "en.microsoft" },
      { name: "title", type: "Edm.String", searchable: true, filterable: true, facetable: true },
      { name: "heading", type: "Edm.String", searchable: true },
      { name: "url", type: "Edm.String", filterable: true },
      { name: "sourceFile", type: "Edm.String", filterable: true },
      { name: "saved", type: "Edm.String", filterable: true },
      {
        name: "vector",
        type: "Collection(Edm.Single)",
        searchable: true,
        dimensions: VECTOR_DIMENSIONS,
        vectorSearchProfile: "default-profile",
      },
    ],
    vectorSearch: {
      // HNSW is an approximate-nearest-neighbour graph: sub-linear search at the
      // cost of a tiny recall loss. Cosine matches how OpenAI embeddings are normalised.
      algorithms: [{ name: "default-hnsw", kind: "hnsw", hnswParameters: { metric: "cosine", m: 4, efConstruction: 400, efSearch: 500 } }],
      profiles: [{ name: "default-profile", algorithm: "default-hnsw" }],
    },
    semantic: {
      configurations: [
        {
          name: "default-semantic",
          prioritizedFields: {
            titleField: { fieldName: "title" },
            prioritizedContentFields: [{ fieldName: "content" }],
          },
        },
      ],
    },
  };
}

// Azure document keys allow only letters, digits, _, -, =. A hash of the source
// file + position gives a stable id, so re-ingesting updates rather than duplicates.
const documentId = (file, position) =>
  createHash("sha1").update(`${file}#${position}`).digest("hex");

async function main() {
  const indexName = env("AZURE_SEARCH_INDEX");

  // 1. Chunk every document.
  const files = (await readdir(KB_DIR)).filter((f) => f.endsWith(".md") && !/^(SOURCES|TEST-QUESTIONS)\.md$/.test(f)).sort();
  const documents = [];

  for (const file of files) {
    const { meta, body } = parseFrontmatter(await readFile(new URL(file, KB_DIR), "utf8"));
    const chunks = chunkDocument(meta.title, body);
    chunks.forEach((chunk, i) => {
      documents.push({
        id: documentId(file, i),
        content: chunk.content,
        title: meta.title,
        heading: chunk.heading,
        url: meta.url,
        sourceFile: file,
        saved: meta.saved,
      });
    });
    console.log(`  ${file.padEnd(46)} ${String(chunks.length).padStart(3)} chunks`);
  }

  const lengths = documents.map((d) => d.content.length);
  console.log(
    `\n${files.length} files -> ${documents.length} chunks ` +
      `(avg ${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)}, ` +
      `min ${Math.min(...lengths)}, max ${Math.max(...lengths)} chars)`,
  );

  // 2. Recreate the index. Deleting first guarantees the schema matches this
  //    script rather than whatever an earlier run left behind.
  console.log(`\nRecreating index "${indexName}"...`);
  await search.deleteIndex();
  await search.createIndex(indexDefinition(indexName));

  // 3. Embed in batches.
  console.log(`Embedding ${documents.length} chunks...`);
  let tokens = 0;
  for (let i = 0; i < documents.length; i += EMBED_BATCH) {
    const batch = documents.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map((doc) => doc.content));
    batch.forEach((doc, j) => {
      doc.vector = vectors[j];
    });
    tokens += batch.reduce((sum, doc) => sum + Math.ceil(doc.content.length / 4), 0);
    process.stdout.write(`  ${Math.min(i + EMBED_BATCH, documents.length)}/${documents.length}\r`);
  }

  // 4. Upload.
  console.log(`\nUploading to Azure AI Search...`);
  for (let i = 0; i < documents.length; i += UPLOAD_BATCH) {
    const result = await search.upload(documents.slice(i, i + UPLOAD_BATCH));
    const failed = result.value.filter((r) => !r.status);
    if (failed.length) throw new Error(`${failed.length} documents failed: ${failed[0].errorMessage}`);
  }

  // The index is eventually consistent — give it a moment before counting.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log(`\nDone. ${await search.count()} documents in the index.`);
  console.log(`Approx ${tokens.toLocaleString()} tokens embedded (~$${((tokens / 1e6) * 0.02).toFixed(4)}).`);
}

await main();
