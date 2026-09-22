// Abuse and cost controls for a public demo paid for by a personal Azure account.
//
// Two layers, doing different jobs:
//   - per-visitor rate limit: raises the cost of casual abuse. Bypassable by
//     anyone who changes IP, and that's accepted.
//   - global daily cap: bounds the bill absolutely. It doesn't care who you
//     are, so it can't be bypassed. This is the real protection.

import { env, search as searchApi } from "../scripts/azure.mjs";

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
const SEARCH_API_VERSION = "2024-07-01";

const usageUrl = (suffix) =>
  `${env("AZURE_SEARCH_ENDPOINT")}/indexes/${USAGE_INDEX}${suffix}?api-version=${SEARCH_API_VERSION}`;

const today = () => new Date().toISOString().slice(0, 10);

export async function ensureUsageIndex() {
  const response = await fetch(usageUrl(""), {
    method: "PUT",
    headers: searchApi.headers(),
    body: JSON.stringify({
      name: USAGE_INDEX,
      fields: [
        { name: "id", type: "Edm.String", key: true },
        { name: "day", type: "Edm.String", filterable: true },
        { name: "count", type: "Edm.Int32" },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Could not create usage index: ${await response.text()}`);
}

async function readCount(day) {
  const response = await fetch(usageUrl(`/docs/${day}`), { headers: searchApi.headers() });
  if (response.status === 404) return 0;
  if (!response.ok) throw new Error(`Usage read failed: ${response.status}`);
  return (await response.json()).count ?? 0;
}

async function writeCount(day, count) {
  const response = await fetch(usageUrl("/docs/index"), {
    method: "POST",
    headers: searchApi.headers(),
    body: JSON.stringify({ value: [{ "@search.action": "mergeOrUpload", id: day, day, count }] }),
  });
  if (!response.ok) throw new Error(`Usage write failed: ${response.status}`);
}

// Read-then-write is not atomic, so two simultaneous requests can both read the
// same number and one increment is lost. At this traffic level the drift is a
// few requests a day against a cap of hundreds, which does not matter — and the
// failure direction is "slightly over the cap", never "charges more than the
// budget alert catches". A real system would use a store with atomic increment.
let cachedDay = null;
let cachedCount = 0;

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
