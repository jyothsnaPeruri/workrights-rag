// Agentic RAG: the model drives retrieval.
//
// The direct pipeline (answer.mjs) runs one fixed search and writes. Here the
// model gets search tools and a loop: it decides which searches to run, splits
// a multi-part question into several, retries when results look thin, and
// stops when it has enough. Same index, same reranker, same citations — the
// loop is the new part.
//
// Costs that the direct pipeline doesn't have: 2-4 model calls per question,
// a few seconds more latency, and the possibility of looping — hence the hard
// step cap and the fallback to the direct pipeline on any failure.

import { answerQuestion, SYSTEM_PROMPT } from "./answer.mjs";
import { getProvider } from "./providers.mjs";
import { retrieve } from "./retrieve.mjs";

const MAX_ROUNDS = 4; // tool-calling rounds before we force an answer
const MAX_CALLS_PER_ROUND = 3;
// Four rather than five: every excerpt is re-sent on each round, and on the
// free tier tokens per minute are the binding constraint.
const RESULTS_PER_SEARCH = 4;

const AGENT_INSTRUCTIONS = `
You have search tools. You MUST search before answering — never answer from memory.
- Break a question with several parts into one search per part.
- If results don't contain what you need, search again with different words.
- If the user has uploaded documents, search those too when the question is about their own situation ("my contract", "my award").
- Stop searching once you have what you need, then answer. Every claim must cite an excerpt number in plain ASCII square brackets, e.g. [3].
- Excerpt numbers are global across all your searches: [1] always refers to the same excerpt.`;

function tools(hasOwnDocuments) {
  const list = [
    {
      type: "function",
      function: {
        name: "search_fair_work",
        description:
          "Search the official Fair Work Ombudsman pages on Australian workplace entitlements: leave, pay, notice, redundancy, dismissal, casual work, parental leave, flexible work.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "A focused search query for one topic." } },
          required: ["query"],
        },
      },
    },
  ];
  if (hasOwnDocuments) {
    list.push({
      type: "function",
      function: {
        name: "search_my_documents",
        description: "Search the documents the user uploaded (their contract, policy or award).",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "What to look for in the user's documents." } },
          required: ["query"],
        },
      },
    });
  }
  return list;
}

/**
 * Same return shape as answerQuestion, plus `steps` (the searches the agent
 * ran) and `calls` (model calls used). Falls back to the direct pipeline if
 * anything goes wrong, so a visitor never sees an agent failure.
 */
export async function answerAgentic(question, { onToken, provider, scope, hasOwnDocuments = false } = {}) {
  const models = getProvider(provider);
  const sources = []; // global, numbered from 1, deduplicated by content
  const seen = new Map();
  const steps = [];
  let calls = 0;

  const addSources = (hits) =>
    hits.map((hit) => {
      if (seen.has(hit.content)) return seen.get(hit.content);
      const entry = { n: sources.length + 1, ...hit };
      sources.push(entry);
      seen.set(hit.content, entry);
      return entry;
    });

  async function runTool(call) {
    const query = String(call.args?.query ?? "").slice(0, 300);
    if (!query) return "Empty query.";
    const own = call.name === "search_my_documents";
    steps.push({ tool: call.name, query });
    const hits = await retrieve(query, {
      provider,
      scope: own ? scope : undefined,
      onlyOwn: own,
      top: RESULTS_PER_SEARCH,
    });
    const entries = addSources(hits);
    if (entries.length === 0) return "No results.";
    return entries
      .map((s) => {
        const origin = s.scope && s.scope !== "public" ? "Your document" : "Fair Work";
        return `[${s.n}] ${origin}: ${s.title}${s.heading ? ` > ${s.heading}` : ""}\n${s.content}`;
      })
      .join("\n\n");
  }

  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT + "\n" + AGENT_INSTRUCTIONS },
      { role: "user", content: question },
    ];
    const toolList = tools(hasOwnDocuments);

    for (let round = 0; round < MAX_ROUNDS; round++) {
      calls += 1;
      const reply = await models.chat(messages, {
        tools: toolList,
        // First round must search: answering straight from memory is the one
        // thing this whole system exists to prevent.
        toolChoice: round === 0 ? "required" : "auto",
        maxTokens: 1400,
      });

      if (!reply.toolCalls?.length) {
        // The model chose to answer. Deliver its text (already complete).
        const answer = reply.text.trim().replace(/【\s*(\d+)\s*】/g, "[$1]");
        if (onToken) onToken(answer);
        return { answer, sources, usage: reply.usage, provider: models.name, mode: "agent", steps, calls };
      }

      messages.push(reply.raw);
      for (const call of reply.toolCalls.slice(0, MAX_CALLS_PER_ROUND)) {
        messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(call) });
      }
    }

    // Out of rounds: one last call with tools withheld, so it must answer now.
    calls += 1;
    messages.push({ role: "user", content: "You have enough. Answer now, citing the excerpt numbers." });
    const final = await models.chat(messages, { maxTokens: 1400 });
    const answer = final.text.trim().replace(/【\s*(\d+)\s*】/g, "[$1]");
    if (onToken) onToken(answer);
    return { answer, sources, usage: final.usage, provider: models.name, mode: "agent", steps, calls };
  } catch (error) {
    if (error.rateLimited && process.env.AGENT_NO_FALLBACK === "1") throw error;
    console.warn("agent failed, falling back to the direct pipeline:", error.message.slice(0, 120));
    // If the direct pipeline is rate-limited too, let that error propagate so
    // the server can say "busy" rather than "something went wrong".
    const direct = await answerQuestion(question, { onToken, provider, scope });
    return { ...direct, mode: "direct-fallback", steps, calls, fellBackBecause: error.rateLimited ? "rate-limit" : "error" };
  }
}
