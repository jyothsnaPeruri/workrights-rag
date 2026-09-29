// CLI: npm run ask:agent "your question"  — runs the agentic pipeline and shows its steps.
import { answerAgentic } from "./agent.mjs";
const question = process.argv.slice(2).join(" ");
if (!question) { console.error('Usage: npm run ask:agent "question"'); process.exit(1); }
const t0 = Date.now();
const r = await answerAgentic(question, { provider: process.env.CANDIDATE_PROVIDER ?? "free" });
console.log(`\nQ: ${question}\n`);
console.log(r.answer);
console.log(`\n-- mode ${r.mode} · ${r.calls} model call(s) · ${((Date.now()-t0)/1000).toFixed(1)}s`);
for (const s of r.steps) console.log(`   ${s.tool}("${s.query}")`);
console.log(`   ${r.sources.length} excerpt(s) gathered`);
