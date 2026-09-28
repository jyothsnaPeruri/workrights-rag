// Visitor document uploads.
//
// A visitor can upload a contract or policy and ask questions across it and
// the Fair Work pages together. Uploaded chunks live in the same index as the
// free knowledge base, tagged with the visitor's session id in `scope`;
// retrieval filters on scope server-side, so isolation does not depend on the
// UI behaving. Documents expire after RETENTION_DAYS and are swept hourly.
//
// Everything here runs on the free bundle (Gemini embeddings), because that is
// the index uploads live in. Embedding and answering cost $0; the scarce
// resource is the 50 MB Free-tier index, hence the storage cap and eviction.

import { createHash, randomUUID } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { search } from "../scripts/azure.mjs";
import { chunkDocument } from "../scripts/chunk.mjs";
import { PROVIDERS } from "../scripts/providers.mjs";

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

/* ------------------------------------------------------------- queries -- */

const index = () => provider.index();

async function listIds(filter, top = 1000, orderby) {
  const result = await search.query(index(), { search: "*", filter, select: "id", top, orderby });
  return result.value.map((doc) => doc.id);
}

async function deleteIds(ids) {
  for (let i = 0; i < ids.length; i += 500) {
    await search.upload(
      index(),
      ids.slice(i, i + 500).map((id) => ({ id, "@search.action": "delete" })),
    );
  }
}

async function uploadedChunkCount() {
  const result = await search.query(index(), {
    search: "*",
    filter: "scope ne 'public'",
    top: 0,
    count: true,
  });
  return result["@odata.count"] ?? 0;
}

/* ------------------------------------------------------------- public -- */

// Azure AI Search is eventually consistent: chunks uploaded a moment ago may
// not show up in a query for a second or two. A visitor who uploads and then
// immediately asks would be routed to the wrong index. So the server remembers
// which sessions it has ingested for, and only falls back to querying the
// index for sessions it hasn't seen (e.g. after a restart).
const sessionsWithDocs = new Map(); // session -> true/false

export async function sessionHasDocuments(session) {
  if (sessionsWithDocs.has(session)) return sessionsWithDocs.get(session);
  const has = (await listDocuments(session)).length > 0;
  sessionsWithDocs.set(session, has);
  return has;
}

/** One row per document a visitor has uploaded, newest last. */
export async function listDocuments(session) {
  const result = await search.query(index(), {
    search: "*",
    filter: `scope eq '${session}'`,
    select: "docId,title,heading,expiresAt",
    top: 1000,
  });
  const byDoc = new Map();
  for (const row of result.value) {
    const doc = byDoc.get(row.docId) ?? { id: row.docId, name: row.title, chunks: 0, expiresAt: row.expiresAt };
    doc.chunks += 1;
    byDoc.set(row.docId, doc);
  }
  return [...byDoc.values()];
}

export async function deleteDocument(session, docId) {
  // The session is part of the filter, so a visitor can only delete their own.
  await deleteIds(await listIds(`scope eq '${session}' and docId eq '${docId.replace(/'/g, "")}'`));
  sessionsWithDocs.delete(session); // unknown now; re-check on next ask
}

export async function deleteSession(session) {
  await deleteIds(await listIds(`scope eq '${session}'`));
  sessionsWithDocs.set(session, false);
}

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

  await search.upload(
    index(),
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

  // Don't report success until the chunks are actually searchable. Azure AI
  // Search indexes asynchronously; without this, a visitor who uploads and
  // immediately asks gets an answer that ignores the file they just added.
  await waitUntilVisible(session, docId, chunks.length);

  sessionsWithDocs.set(session, true);
  return { id: docId, name, chunks: chunks.length, expiresAt };
}

async function waitUntilVisible(session, docId, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await search.query(index(), {
      search: "*",
      filter: `scope eq '${session}' and docId eq '${docId}'`,
      top: 0,
      count: true,
    });
    if ((result["@odata.count"] ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Not fatal: the document will appear shortly; the UI just won't be able to
  // use it for the very next question.
  console.warn(`upload ${docId} not fully visible after ${timeoutMs}ms`);
}

/* ------------------------------------------------------------ hygiene -- */

/** Removes every uploaded chunk past its expiry. Called hourly and at start-up. */
export async function sweepExpired() {
  const now = new Date().toISOString();
  const ids = await listIds(`scope ne 'public' and expiresAt lt ${now}`);
  if (ids.length) await deleteIds(ids);
  return ids.length;
}

/**
 * Keeps total uploaded chunks under the global cap by dropping the documents
 * closest to expiry first. Storage is the one scarce resource on the free tier.
 */
async function evictIfNeeded(incoming) {
  let total = await uploadedChunkCount();
  while (total + incoming > UPLOAD_LIMITS.maxUploadedChunks) {
    const [oldest] = await search
      .query(index(), {
        search: "*",
        filter: "scope ne 'public'",
        select: "scope,docId",
        orderby: "expiresAt asc",
        top: 1,
      })
      .then((r) => r.value);
    if (!oldest) break;
    await deleteDocument(oldest.scope, oldest.docId);
    total = await uploadedChunkCount();
  }
}
