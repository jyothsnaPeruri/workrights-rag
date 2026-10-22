// Checks every service the app depends on, before anything is built on top.
//   npm run verify
// Postgres (knowledge base + counters), Gemini (embeddings), Groq (answers).

import { PROVIDERS } from "./providers.mjs";
import { closeDb, countChunks, db, migrate } from "./store.mjs";

const checks = [
  ["Postgres + pgvector", async () => {
    await migrate();
    const { rows } = await db().query("select extversion from pg_extension where extname = 'vector'");
    return `pgvector ${rows[0]?.extversion ?? "missing"}, ${await countChunks("public")} public chunks`;
  }],
  ["Gemini embeddings", async () => {
    const v = await PROVIDERS.free.embedQuery("How much annual leave do I get?");
    return `${v.length} dimensions`;
  }],
  ["Groq chat", async () => {
    const r = await PROVIDERS.free.chat([{ role: "user", content: "Reply with exactly the word: ready" }]);
    return `replied "${r.text.trim()}"`;
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log(`PASS  ${name}\n      ${await fn()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message.slice(0, 200)}`);
  }
}
await closeDb();
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
