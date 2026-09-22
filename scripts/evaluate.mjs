// Measures retrieval quality against the hand-written questions in
// knowledge-base/TEST-QUESTIONS.md.
//
// Why this exists: "it seemed to work when I tried it" is not an answer. This
// prints two standard information-retrieval numbers so changes to chunking or
// search strategy can be compared objectively instead of by vibes.
//
//   Hit@1  - the expected document was the single best result
//   Hit@5  - the expected document appeared anywhere in the top 5
//   MRR    - Mean Reciprocal Rank: 1.0 if always first, 0.5 if always second,
//            0.33 if always third. Rewards ranking the right answer higher,
//            not just including it somewhere.
//
// Usage: npm run evaluate

import { readFile } from "node:fs/promises";
import { retrieve, TOP_K } from "./retrieve.mjs";

const QUESTIONS_FILE = new URL("../knowledge-base/TEST-QUESTIONS.md", import.meta.url);

/** Reads the question / answer / file triples out of the Markdown test file. */
async function loadQuestions() {
  const text = await readFile(QUESTIONS_FILE, "utf8");
  const pattern = /\*\*Q(\d+):\*\*\s*(.+?)\n\*\*A:\*\*\s*([\s\S]+?)\n\*\*File:\*\*\s*(\S+)/g;
  return [...text.matchAll(pattern)].map(([, n, question, answer, file]) => ({
    n: Number(n),
    question: question.trim(),
    answer: answer.replace(/\s+/g, " ").trim(),
    expected: file.trim(),
  }));
}

const questions = await loadQuestions();
if (questions.length === 0) throw new Error("No questions parsed from TEST-QUESTIONS.md");

console.log(`Evaluating retrieval on ${questions.length} questions (top ${TOP_K})\n`);

const results = [];
for (const q of questions) {
  const hits = await retrieve(q.question);
  const rank = hits.findIndex((hit) => hit.sourceFile === q.expected) + 1; // 0 = not found
  results.push({ ...q, rank, hits });

  const mark = rank === 1 ? "PASS" : rank > 0 ? `#${rank}  ` : "MISS";
  console.log(`${mark}  Q${String(q.n).padStart(2)}  ${q.question}`);
  if (rank !== 1) {
    console.log(`        expected: ${q.expected}`);
    console.log(`        returned: ${hits.map((h) => h.sourceFile).join(", ") || "(nothing)"}`);
  }
}

const hit1 = results.filter((r) => r.rank === 1).length;
const hit5 = results.filter((r) => r.rank > 0).length;
const mrr = results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / results.length;
const pct = (n) => `${n}/${results.length} (${Math.round((n / results.length) * 100)}%)`;

console.log(`\n${"-".repeat(64)}`);
console.log(`Hit@1 (correct document ranked first): ${pct(hit1)}`);
console.log(`Hit@${TOP_K} (correct document in top ${TOP_K}):     ${pct(hit5)}`);
console.log(`MRR:                                   ${mrr.toFixed(3)}`);

const failures = results.filter((r) => r.rank !== 1);
if (failures.length) {
  console.log(`\nWorth investigating (${failures.length}):`);
  for (const f of failures) {
    console.log(`  Q${f.n}: ${f.question}`);
    console.log(`       want ${f.expected}, got ${f.hits[0]?.sourceFile ?? "nothing"} (rank ${f.rank || "none"})`);
  }
}
