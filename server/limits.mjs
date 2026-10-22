// Abuse and cost controls for a public demo paid for by a personal Azure account.
//
// Two layers, doing different jobs:
//   - per-visitor rate limit: raises the cost of casual abuse. Bypassable by
//     anyone who changes IP, and that's accepted.
//   - global daily cap: bounds the bill absolutely. It doesn't care who you
//     are, so it can't be bypassed. This is the real protection.


import { consumeQuestion, increment, migrate, usageRows } from "../scripts/store.mjs";

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

// --- global daily cap and usage counters, stored in Postgres ----------------
// They have to survive restarts and be shared across instances; free hosting
// restarts often. Postgres makes each one a single atomic statement: the cap
// check and the increment happen together, so concurrent requests can't both
// slip past the limit (the race the Azure-backed counter had to tolerate).


const today = () => new Date().toISOString().slice(0, 10);

/** Creates tables on start-up; safe to run every time. */
export const ensureUsageIndex = migrate;

export const consumeGlobalQuota = async () => ({
  ...(await consumeQuestion(LIMITS.globalPerDay)),
  cap: LIMITS.globalPerDay,
});

/** A page load: the front-end's warm-up call to /api/health, from a browser. */
export const recordVisit = () => increment("visits");
export const recordUpload = () => increment("uploads");

/** Per-day rows plus today / last 7 days / all-time totals, for the admin panel. */
export async function usageStats() {
  const rows = await usageRows();
  const dayNow = today();
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
