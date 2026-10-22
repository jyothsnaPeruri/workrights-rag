// Visitor document uploads.
//
// A visitor can upload a contract or policy and ask questions across it and
// the Fair Work pages together. Uploaded chunks live in the same Postgres table
// as the knowledge base, tagged with the visitor's session id in `scope`;
// retrieval filters on scope in SQL, so isolation does not depend on the UI
// behaving. Documents expire after RETENTION_DAYS and are swept hourly.
//
// Embeddings are Gemini, the same model as the corpus. The scarce resource is
// the free database's storage, hence the per-visitor limits, the global chunk
// cap and oldest-first eviction.

import { createHash, randomUUID } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkDocument } from "../scripts/chunk.mjs";
import { PROVIDERS } from "../scripts/providers.mjs";
import {
  countUploadedChunks,
  deleteScope,
  deleteUpload,
  insertUploadChunks,
  listUploads,
  oldestUpload,
  sweepExpiredUploads,
} from "../scripts/store.mjs";

const provider = PROVIDERS.free;

export const UPLOAD_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  docsPerSession: 3,
  chunksPerDoc: 250, // ~60 pages of dense text
  retentionDays: Number(process.env.UPLOAD_RETENTION_DAYS ?? 7),
  // Global ceiling on uploaded chunks across all visitors. At ~3 KB per chunk
  // (768 floats + text) this is ~30 MB, leaving headroom under the 50 MB tier
  // for the knowledge base itself. Oldest documents are evicted past it.
  maxUploadedChunks: Number(process.env.UPLOAD_MAX_CHUNKS ?? 10_000),
};

export class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Session ids come from the browser; only a well-formed UUID is accepted. */
export function validSession(value) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

/* ------------------------------------------------------------- parsing -- */

async function toPages(name, buffer) {
  if (/\.pdf$/i.test(name)) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  }
  if (/\.(txt|md)$/i.test(name)) return [buffer.toString("utf8")];
  throw new UploadError(415, "Only PDF, TXT and Markdown files are supported.");
}

/* ------------------------------------------------------------- public -- */

/** One row per document a visitor has uploaded. */
export const listDocuments = (session) => listUploads(session);

/** Postgres reads its own writes, so this is just a query — no cache needed. */
export async function sessionHasDocuments(session) {
  return (await listUploads(session)).length > 0;
}

// The session is part of the filter, so a visitor can only delete their own.
export const deleteDocument = (session, docId) => deleteUpload(session, docId);
export const deleteSession = (session) => deleteScope(session);

/**
 * Parses, chunks, embeds and indexes one file for one session.
 * Returns the document summary the UI lists.
 */
export async function ingestUpload(session, filename, buffer) {
  const existing = await listDocuments(session);
  if (existing.length >= UPLOAD_LIMITS.docsPerSession) {
    throw new UploadError(409, `You can have ${UPLOAD_LIMITS.docsPerSession} documents at a time. Delete one first.`);
  }

  const name = filename.slice(0, 120);
  const pages = await toPages(name, buffer);
  const chunks = pages.flatMap((text, i) =>
    chunkDocument(name, text).map((chunk) => ({ page: i + 1, heading: chunk.heading, content: chunk.content })),
  );
  if (chunks.length === 0) {
    throw new UploadError(422, "No readable text found. Scanned (image-only) PDFs aren't supported.");
  }
  if (chunks.length > UPLOAD_LIMITS.chunksPerDoc) {
    throw new UploadError(413, "That document is too long for this demo. Try one under about 60 pages.");
  }

  // Make room before spending embedding quota on it.
  await evictIfNeeded(chunks.length);

  const vectors = await provider.embed(chunks.map((c) => c.content));
  const docId = randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_LIMITS.retentionDays * 86_400_000).toISOString();

  await insertUploadChunks(
    chunks.map((chunk, i) => ({
      // Deterministic per session+doc+position: a retried upload overwrites
      // rather than duplicates.
      id: createHash("sha1").update(`${session}#${docId}#${i}`).digest("hex"),
      content: chunk.content,
      title: name,
      // Prefer the document's own section heading; fall back to the page.
      heading: chunk.heading || (pages.length > 1 ? `page ${chunk.page}` : ""),
      url: "",
      sourceFile: `upload:${docId}`,
      saved: new Date().toISOString().slice(0, 10),
      scope: session,
      docId,
      expiresAt,
      vector: vectors[i],
    })),
  );

  return { id: docId, name, chunks: chunks.length, expiresAt };
}


/* ------------------------------------------------------------ hygiene -- */

/** Removes every uploaded chunk past its expiry. Called hourly and at start-up. */
export const sweepExpired = sweepExpiredUploads;

/**
 * Keeps total uploaded chunks under the global cap by dropping the documents
 * closest to expiry first. Storage is the one scarce resource on the free tier.
 */
async function evictIfNeeded(incoming) {
  while ((await countUploadedChunks()) + incoming > UPLOAD_LIMITS.maxUploadedChunks) {
    const oldest = await oldestUpload();
    if (!oldest) break;
    await deleteUpload(oldest.scope, oldest.docId);
  }
}
