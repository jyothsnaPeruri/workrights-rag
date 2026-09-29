// Abuse and cost controls for a public demo paid for by a personal Azure account.
//
// Two layers, doing different jobs:
//   - per-visitor rate limit: raises the cost of casual abuse. Bypassable by
//     anyone who changes IP, and that's accepted.
//   - global daily cap: bounds the bill absolutely. It doesn't care who you
//     are, so it can't be bypassed. This is the real protection.

import { search } from "../scripts/azure.mjs";

// Tunable without a code change, so limits can be tightened from the hosting
// dashboard if the demo ever gets unwanted attention.
export const LIMITS = {
  perVisitor: {
    max: Number(process.env.VISITOR_QUESTION_LIMIT ?? 15),
    windowMs: Number(process.env.VISITOR_WINDOW_MINUTES ?? 10) * 60 * 1000,
  },
  globalPerDay: Number(process.env.DAILY_QUESTION_CAP ?? 300),
  questionChars: 400,
};

// --- per-visitor, in memory -------------------------------------------------
// In-memory is the right trade-off here: this window is 10 minutes, so losing
// it on restart costs almost nothing, and it avoids a network call per request.

const visitors = new Map();

export function checkVisitor(ip) {
  const now = Date.now();
  const { windowMs, max } = LIMITS.perVisitor;

  // Opportunistic cleanup, so the map can't grow without bound.
  if (visitors.size > 5000) {
    for (const [key, times] of visitors) {
      if (times.every((t) => now - t >= windowMs)) visitors.delete(key);
    }
  }

  const recent = (visitors.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const retryAfterSec = Math.ceil((windowMs - (now - recent[0])) / 1000);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  visitors.set(ip, recent);
  return { allowed: true, remaining: max - recent.length };
}

// --- global daily cap, stored in Azure AI Search ----------------------------
// It has to survive restarts and be shared across instances. Free hosting has
// no durable disk and restarts often, so an in-process counter would reset and
// the cap would mean nothing. Rather than add Redis for a single row, this
// reuses the search service the app already depends on.

const USAGE_INDEX = "usage";

const today = () => new Date().toISOString().slice(0, 10);

// One row per day. `count` is questions (the name predates the other two);
// `visits` is page loads and `uploads` is documents indexed. Adding fields to
// an existing index is a non-breaking schema update, which is why PUT here is
// safe to run on every start-up.
export async function ensureUsageIndex() {
  await search.createIndex({
    name: USAGE_INDEX,
    fields: [
      { name: "id", type: "Edm.String", key: true },
      { name: "day", type: "Edm.String", filterable: true, sortable: true },
      { name: "count", type: "Edm.Int32" },
      { name: "visits", type: "Edm.Int32" },
      { name: "uploads", type: "Edm.Int32" },
    ],
  });
}

const readCount = async (day) => (await search.getDocument(USAGE_INDEX, day))?.count ?? 0;

// mergeOrUpload only touches the fields given, so each counter can be written
// independently without clobbering the others.
const writeCount = (day, count) => search.upload(USAGE_INDEX, [{ id: day, day, count }]);

// Read-then-write is not atomic, so two simultaneous requests can both read the
// same number and one increment is lost. At this traffic level the drift is a
// few requests a day against a cap of hundreds, which does not matter — and the
// failure direction is "slightly over the cap", never "charges more than the
// budget alert catches". A real system would use a store with atomic increment.
let cachedDay = null;
let cachedCount = 0;

/* --- visits and uploads: same pattern, no cap, flushed every few events --- */

const tallies = {
  visits: { day: null, n: 0, ready: null },
  uploads: { day: null, n: 0, ready: null },
};

async function bump(field, flushEvery) {
  const day = today();
  const t = tallies[field];
  if (t.day !== day) {
    // Single-flight initialisation. Several requests can arrive before the
    // first day's read completes; if each one re-read and reset the counter,
    // the others' increments would be lost — which is exactly what happened
    // with three page loads landing at once and only two being counted.
    t.day = day;
    t.n = 0;
    t.ready = search
      .getDocument(USAGE_INDEX, day)
      .then((doc) => {
        t.n += doc?.[field] ?? 0;
      })
      .catch(() => {});
  }
  await t.ready;
  t.n += 1;
  if (t.n % flushEvery === 0 || t.n === 1) {
    search
      .upload(USAGE_INDEX, [{ id: day, day, [field]: t.n }])
      .catch((error) => console.error(`${field} write failed:`, error.message));
  }
}

/** A page load: the front-end's warm-up call to /api/health, from a browser. */
export const recordVisit = () => bump("visits", 5);
export const recordUpload = () => bump("uploads", 1);

/** Per-day rows plus today / last 7 days / all-time totals, for the admin panel. */
export async function usageStats() {
  const result = await search.query(USAGE_INDEX, { search: "*", select: "day,count,visits,uploads", top: 400, orderby: "day desc" });
  const rows = result.value.map((r) => ({
    day: r.day,
    questions: r.count ?? 0,
    visits: r.visits ?? 0,
    uploads: r.uploads ?? 0,
  }));
  const dayNow = today();

  // Counters are flushed to the index every few events to save writes, so the
  // stored row for today can trail reality by a handful. The live numbers are
  // in memory on this process, so overlay them: the admin should never refresh
  // and see a count go backwards or lag what they just did.
  const live = {
    visits: tallies.visits.day === dayNow ? tallies.visits.n : 0,
    uploads: tallies.uploads.day === dayNow ? tallies.uploads.n : 0,
    questions: cachedDay === dayNow ? cachedCount : 0,
  };
  let todayRow = rows.find((r) => r.day === dayNow);
  if (!todayRow) {
    todayRow = { day: dayNow, questions: 0, visits: 0, uploads: 0 };
    rows.unshift(todayRow);
  }
  for (const k of ["visits", "uploads", "questions"]) todayRow[k] = Math.max(todayRow[k], live[k]);

  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const sum = (filter) =>
    rows.filter(filter).reduce(
      (acc, r) => ({ visits: acc.visits + r.visits, questions: acc.questions + r.questions, uploads: acc.uploads + r.uploads }),
      { visits: 0, questions: 0, uploads: 0 },
    );
  return {
    today: sum((r) => r.day === dayNow),
    last7: sum((r) => r.day >= weekAgo),
    all: sum(() => true),
    days: rows.slice(0, 30),
  };
}

// (declared above usageStats so it can read them)

export async function consumeGlobalQuota() {
  const day = today();
  if (day !== cachedDay) {
    cachedDay = day;
    cachedCount = await readCount(day);
  }

  if (cachedCount >= LIMITS.globalPerDay) return { allowed: false };

  cachedCount += 1;
  const used = cachedCount;
  // Persist every 5th request rather than every one: fewer writes, and losing
  // at most 4 counts on a restart is acceptable for a spending guard.
  if (used % 5 === 0 || used === 1) {
    writeCount(day, used).catch((error) => console.error("usage write failed:", error.message));
  }
  return { allowed: true, used, cap: LIMITS.globalPerDay };
}
