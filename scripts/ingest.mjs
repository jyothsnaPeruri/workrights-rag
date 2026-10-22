// Step 2 of the RAG pipeline: chunk -> embed -> index.
//
// Runs offline, not per request. Re-runnable: it recreates the index from
// scratch, so refreshing the knowledge base is `npm run fetch-sources && npm run ingest`.
//
// Usage: npm run ingest

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { chunkDocument, parseFrontmatter } from "./chunk.mjs";
import { PROVIDERS } from "./providers.mjs";
import { closeDb, countChunks, migrate, replacePublicCorpus } from "./store.mjs";

const KB_DIR = new URL("../knowledge-base/", import.meta.url);
const EMBED_BATCH = 50; // inputs per embeddings call
const UPLOAD_BATCH = 100; // documents per index call (Azure's limit is 1000)

// A hash of the source file + position gives a stable id, so re-ingesting
// replaces rather than duplicates.
const documentId = (file, position) =>
  createHash("sha1").update(`${file}#${position}`).digest("hex");

async function main() {
  // The corpus is embedded with Gemini; queries use the same model (retrieve.mjs).
  const models = PROVIDERS.free;
  await migrate();
  console.log(`Embedding with ${models.embeddingModel()} (${models.dimensions}-dim) into Postgres\n`);

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
        scope: "public",
        docId: "public",
        expiresAt: null,
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

  // 3. Embed in batches.
  console.log(`Embedding ${documents.length} chunks...`);
  let tokens = 0;
  for (let i = 0; i < documents.length; i += EMBED_BATCH) {
    const batch = documents.slice(i, i + EMBED_BATCH);
    const vectors = await models.embed(batch.map((doc) => doc.content));
    batch.forEach((doc, j) => {
      doc.vector = vectors[j];
    });
    tokens += batch.reduce((sum, doc) => sum + Math.ceil(doc.content.length / 4), 0);
    process.stdout.write(`  ${Math.min(i + EMBED_BATCH, documents.length)}/${documents.length}\r`);
  }

  // 3. Swap the public corpus in one transaction: readers see the old set until
  //    commit and the new set after, never an empty or half-written one.
  console.log(`\nWriting to Postgres...`);
  await replacePublicCorpus(documents);
  console.log(`\nDone. ${await countChunks("public")} public chunks.`);
  console.log(`Approx ${tokens.toLocaleString()} tokens embedded (free tier).`);
  await closeDb();
}

// Guarded: this script deletes and rebuilds an index, so it must only ever run
// when invoked directly. Without this, merely importing the module — a test, a
// tooling scan, an editor's auto-import — would destroy the live index.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
} else {
  throw new Error("ingest.mjs is a CLI script; run it with `npm run ingest`, do not import it.");
}
