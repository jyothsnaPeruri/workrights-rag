// Answer-level evaluation: direct pipeline vs agent.
//
// evaluate.mjs scores *retrieval* (did the right document come back). This
// scores *answers*: does the final text contain the expected fact? A judge
// model reads the expected answer and the produced answer and says yes or no.
// Judging with a model is imperfect, so the judge is asked a narrow question
// ("does it state X"), not "is this a good answer", and every verdict is
// printed so a human can spot-check disagreements.
//
// Usage:  npm run evaluate:answers            (both modes, judge = azure)
//         npm run evaluate:answers -- direct   (one mode)
//         JUDGE_PROVIDER=free npm run evaluate:answers

import { readFile } from "node:fs/promises";
import { answerAgentic } from "./agent.mjs";
import { answerQuestion } from "./answer.mjs";
import { getProvider } from "./providers.mjs";

const FILE = new URL("../knowledge-base/TEST-QUESTIONS.md", import.meta.url);
const CANDIDATE_PROVIDER = process.env.CANDIDATE_PROVIDER ?? "free";
// Judge with a different model family than the candidate where possible, so a
// model isn't marking its own homework.
const JUDGE_PROVIDER = process.env.JUDGE_PROVIDER ?? (getProvider("azure").configured() ? "azure" : "free");

async function loadQuestions() {
  const text = await readFile(FILE, "utf8");
  const answerable = [...text.matchAll(/\*\*Q(\d+):\*\*\s*(.+?)\n\*\*A:\*\*\s*([\s\S]+?)\n\*\*File:\*\*/g)].map(
    ([, n, q, a]) => ({ id: `Q${n}`, set: "standard", question: q.trim(), expect: a.replace(/\s+/g, " ").trim() }),
  );
  const hard = [...text.matchAll(/\*\*H(\d+):\*\*\s*(.+?)\n\*\*Expect:\*\*\s*(.+)/g)].map(([, n, q, e]) => ({
    id: `H${n}`,
    set: "hard",
    question: q.trim(),
    expect: e.trim(),
  }));
  return [...answerable, ...hard];
}

async function judge(question, expected, answer) {
  const judgeModel = getProvider(JUDGE_PROVIDER);
  const { text } = await judgeModel.chat(
    [
      {
        role: "system",
        content:
          "You are a strict grader. Reply with exactly YES or NO. Answer YES only if the candidate answer states every fact in the expected answer (numbers must match; wording may differ). Extra correct material is fine. Hedging that omits a required fact is NO.",
      },
      {
        role: "user",
        content: `Question: ${question}\n\nExpected facts: ${expected}\n\nCandidate answer:\n${answer}\n\nDoes the candidate state every expected fact? YES or NO.`,
      },
    ],
    { maxTokens: 5 },
  );
  return /^\s*yes/i.test(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The free tier meters tokens per minute. A visitor-facing call gives up after
// a few seconds (and degrades); a batch evaluation should simply wait it out,
// otherwise the run dies a third of the way through and measures nothing.
async function patiently(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!error.rateLimited || attempt >= 12) throw error;
      const m = /try again in ([\d.]+)(ms|s)/i.exec(error.message);
      const wait = m ? parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1) + 1000 : 15_000;
      process.stdout.write(`  (rate limited — waiting ${Math.ceil(wait / 1000)}s)\n`);
      await sleep(wait);
    }
  }
}

async function run(mode, item) {
  const t0 = Date.now();
  const opts = { provider: CANDIDATE_PROVIDER };
  const result = await patiently(() =>
    mode === "agent" ? answerAgentic(item.question, opts) : answerQuestion(item.question, opts),
  );
  const seconds = (Date.now() - t0) / 1000 - (result.waited ?? 0);
  const correct = await judge(item.question, item.expect, result.answer);
  return { correct, seconds, calls: result.calls ?? 1, searches: result.steps?.length ?? 1, mode: result.mode ?? mode };
}

const modes = process.argv[2] ? [process.argv[2]] : ["direct", "agent"];
const questions = await loadQuestions();
console.log(`Candidate: ${CANDIDATE_PROVIDER} · Judge: ${JUDGE_PROVIDER} · ${questions.length} questions\n`);

const table = {};
for (const mode of modes) {
  const rows = [];
  for (const item of questions) {
    const r = await run(mode, item);
    rows.push({ ...item, ...r });
    await sleep(mode === "agent" ? 12_000 : 5_000); // stay under the per-minute token budget
    const fallback = r.mode === "direct-fallback" ? " (fell back)" : "";
    console.log(`${mode.padEnd(6)} ${r.correct ? "PASS" : "FAIL"}  ${item.id.padEnd(3)} ${r.seconds.toFixed(1)}s ${r.calls} call(s) ${r.searches} search(es)${fallback}  ${item.question.slice(0, 70)}`);
  }
  const by = (set) => rows.filter((r) => set === "all" || r.set === set);
  const pct = (list) => `${list.filter((r) => r.correct).length}/${list.length}`;
  const avg = (list, k) => (list.reduce((s, r) => s + r[k], 0) / list.length).toFixed(1);
  table[mode] = {
    standard: pct(by("standard")),
    hard: pct(by("hard")),
    all: pct(by("all")),
    latency: `${avg(rows, "seconds")}s`,
    calls: avg(rows, "calls"),
    fallbacks: rows.filter((r) => r.mode === "direct-fallback").length,
  };
  console.log();
}

console.log("".padEnd(14) + modes.map((m) => m.padStart(12)).join(""));
for (const k of ["standard", "hard", "all", "latency", "calls", "fallbacks"]) {
  console.log(k.padEnd(14) + modes.map((m) => String(table[m][k]).padStart(12)).join(""));
}
