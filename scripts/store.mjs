// The knowledge base and the app's counters, in PostgreSQL + pgvector.
//
// This replaced Azure AI Search when the Azure trial ended (Oct 2026). One table
// holds every chunk — the public Fair Work pages (scope 'public') and visitors'
// uploads (scope = their session id) — with a pgvector embedding for meaning
// and a generated tsvector for keywords. Retrieval fuses the two rankings.
//
// No ANN index on purpose: a few hundred chunks, always filtered by scope, is
// faster and exact as a sequential scan. An HNSW index would be the next step
// at tens of thousands of rows.

import pg from "pg";
import { env } from "./http.mjs";

export const DIMENSIONS = 768; // Gemini gemini-embedding-001, truncated (Matryoshka)

let pool;
export function db() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env("DATABASE_URL"),
      max: Number(process.env.DB_POOL_SIZE ?? 5),
      // Neon and most hosted Postgres require TLS; local development does not.
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "") ? false : { rejectUnauthorized: true },
    });
  }
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}

const SCHEMA = `
create extension if not exists vector;

create table if not exists chunks (
  id          text primary key,
  content     text not null,
  title       text not null,
  heading     text not null default '',
  url         text not null default '',
  source_file text not null,
  saved       text,
  scope       text not null default 'public',
  doc_id      text not null default 'public',
  expires_at  timestamptz,
  embedding   vector(${DIMENSIONS}) not null,
  tsv         tsvector generated always as (
                setweight(to_tsvector('english', title || ' ' || heading), 'A') ||
                setweight(to_tsvector('english', content), 'B')) stored
);
create index if not exists chunks_scope on chunks (scope);
create index if not exists chunks_tsv on chunks using gin (tsv);
create index if not exists chunks_expires on chunks (expires_at) where expires_at is not null;

create table if not exists usage_daily (
  day       date primary key,
  questions int not null default 0,
  visits    int not null default 0,
  uploads   int not null default 0
);
`;

export async function migrate() {
  await db().query(SCHEMA);
}

const toVector = (values) => `[${values.join(",")}]`;

const ROW = `id, content, title, heading, url, source_file as "sourceFile", saved, scope, doc_id as "docId"`;

/* -------------------------------------------------------------- search -- */

/**
 * Hybrid retrieval with Reciprocal Rank Fusion, in one SQL statement.
 *
 * Two rankings over the visible rows — cosine distance on the embedding, and
 * full-text rank on the tsvector — each contribute 1/(60 + rank). Vectors match
 * meaning; keywords catch exact terms like "21 days" or "redundancy pay" that
 * vectors blur. The text query ORs the question's words: AND-ing every word of
 * a natural-language question would match almost nothing.
 *
 * Visibility: the public corpus plus the caller's own uploads, or only their
 * uploads (`onlyOwn`, the agent's "search my documents" tool). Applied in SQL,
 * before ranking — isolation doesn't depend on the caller.
 */
export async function hybridSearch({ vector, text, scope, onlyOwn = false, k = 24, mode = "hybrid" }) {
  const visible = onlyOwn ? "scope = $3" : "(scope = 'public' or scope = $3)";
  const useText = mode !== "vector" && text;
  const sql = `
    with vec as (
      select id, row_number() over (order by embedding <=> $1::vector) as r
      from chunks where ${visible}
      order by embedding <=> $1::vector limit $4
    ),
    q as (select to_tsquery('english', replace(plainto_tsquery('english', $2)::text, '&', '|')) as query),
    txt as (
      select id, row_number() over (order by ts_rank_cd(tsv, q.query) desc) as r
      from chunks, q
      where ${useText ? "tsv @@ q.query and" : "false and"} ${visible}
      order by ts_rank_cd(tsv, q.query) desc limit $4
    )
    select ${ROW},
           coalesce(1.0 / (60 + vec.r), 0) + coalesce(1.0 / (60 + txt.r), 0) as score
    from chunks c
    left join vec using (id)
    left join txt using (id)
    where vec.id is not null or txt.id is not null
    order by score desc
    limit $4`;
  const { rows } = await db().query(sql, [toVector(vector), text ?? "", scope ?? "", k]);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** Nearest chunks from one visitor's own uploads only (reserved context slots). */
export async function nearestOwn({ vector, scope, k }) {
  const { rows } = await db().query(
    `select ${ROW}, 1 - (embedding <=> $1::vector) as score
     from chunks where scope = $2 order by embedding <=> $1::vector limit $3`,
    [toVector(vector), scope, k],
  );
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/* ------------------------------------------------------------- writing -- */

const INSERT_COLUMNS = ["id", "content", "title", "heading", "url", "source_file", "saved", "scope", "doc_id", "expires_at", "embedding"];

async function insertChunks(client, chunks) {
  for (let i = 0; i < chunks.length; i += 100) {
    const batch = chunks.slice(i, i + 100);
    const values = [];
    const params = [];
    batch.forEach((c, j) => {
      const base = j * INSERT_COLUMNS.length;
      values.push(`(${INSERT_COLUMNS.map((_, n) => `$${base + n + 1}`).join(",")})`);
      params.push(c.id, c.content, c.title, c.heading ?? "", c.url ?? "", c.sourceFile, c.saved ?? null,
        c.scope ?? "public", c.docId ?? "public", c.expiresAt ?? null, toVector(c.vector));
    });
    await client.query(
      `insert into chunks (${INSERT_COLUMNS.join(",")}) values ${values.join(",")}
       on conflict (id) do update set content = excluded.content, embedding = excluded.embedding,
         title = excluded.title, heading = excluded.heading, url = excluded.url, saved = excluded.saved`,
      params,
    );
  }
}

/**
 * Replaces the whole public corpus in one transaction. Readers see the old set
 * until commit and the new set after — never an empty or half-written index,
 * which was the gap the Azure delete-then-recreate approach had to accept.
 */
export async function replacePublicCorpus(chunks) {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query("delete from chunks where scope = 'public'");
    await insertChunks(client, chunks.map((c) => ({ ...c, scope: "public", docId: "public" })));
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function insertUploadChunks(chunks) {
  const client = await db().connect();
  try {
    await client.query("begin");
    await insertChunks(client, chunks);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function countChunks(scope = "public") {
  const { rows } = await db().query("select count(*)::int as n from chunks where scope = $1", [scope]);
  return rows[0].n;
}

/* ------------------------------------------------------------- uploads -- */

export async function listUploads(scope) {
  const { rows } = await db().query(
    `select doc_id as id, min(title) as name, count(*)::int as chunks, min(expires_at) as "expiresAt"
     from chunks where scope = $1 group by doc_id order by min(expires_at)`,
    [scope],
  );
  return rows;
}

export async function deleteUpload(scope, docId) {
  await db().query("delete from chunks where scope = $1 and doc_id = $2", [scope, docId]);
}

export async function deleteScope(scope) {
  await db().query("delete from chunks where scope = $1", [scope]);
}

export async function sweepExpiredUploads() {
  const { rowCount } = await db().query("delete from chunks where scope <> 'public' and expires_at < now()");
  return rowCount;
}

export async function countUploadedChunks() {
  const { rows } = await db().query("select count(*)::int as n from chunks where scope <> 'public'");
  return rows[0].n;
}

/** The uploaded document closest to expiry, for oldest-first eviction. */
export async function oldestUpload() {
  const { rows } = await db().query(
    "select scope, doc_id as \"docId\" from chunks where scope <> 'public' order by expires_at asc limit 1",
  );
  return rows[0] ?? null;
}

/* -------------------------------------------------------------- usage -- */

/**
 * Counts a question against today's cap and returns whether it's allowed.
 * One atomic statement: the increment only happens while under the cap, so two
 * simultaneous requests can't both slip past it — the read-then-write race the
 * Azure-backed counter had to tolerate is gone.
 */
export async function consumeQuestion(cap) {
  const { rows } = await db().query(
    `insert into usage_daily (day, questions) values (current_date, 1)
     on conflict (day) do update set questions = usage_daily.questions + 1
       where usage_daily.questions < $1
     returning questions`,
    [cap],
  );
  return rows.length ? { allowed: true, used: rows[0].questions } : { allowed: false };
}

export async function increment(field) {
  if (!["visits", "uploads"].includes(field)) throw new Error(`Unknown counter: ${field}`);
  await db().query(
    `insert into usage_daily (day, ${field}) values (current_date, 1)
     on conflict (day) do update set ${field} = usage_daily.${field} + 1`,
  );
}

export async function usageRows(days = 400) {
  const { rows } = await db().query(
    `select to_char(day, 'YYYY-MM-DD') as day, questions, visits, uploads
     from usage_daily order by day desc limit $1`,
    [days],
  );
  return rows;
}
