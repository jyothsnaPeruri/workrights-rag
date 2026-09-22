// Checks that every Azure service we need is reachable and correctly configured,
// BEFORE we build anything on top of them. Run with:
//   npm run verify
//
// Uses plain fetch against the REST APIs rather than an SDK, so you can see
// exactly what an Azure OpenAI call looks like on the wire.

const OPENAI_API_VERSION = "2024-10-21";
const SEARCH_API_VERSION = "2024-07-01";

function env(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env`);
  return value.replace(/\/+$/, ""); // tolerate a trailing slash on endpoints
}

/** Reads the response body once, as JSON if possible, so errors stay readable. */
async function body(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("Azure OpenAI — embedding model", async () => {
  const endpoint = env("AZURE_OPENAI_ENDPOINT");
  const deployment = env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
  const url = `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${OPENAI_API_VERSION}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "api-key": env("AZURE_OPENAI_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ input: "How much annual leave do I get?" }),
  });
  const data = await body(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data.error ?? data)}`);

  const vector = data.data[0].embedding;
  return `${vector.length} dimensions, used ${data.usage.total_tokens} tokens`;
});

check("Azure OpenAI — chat model", async () => {
  const endpoint = env("AZURE_OPENAI_ENDPOINT");
  const deployment = env("AZURE_OPENAI_CHAT_DEPLOYMENT");
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "api-key": env("AZURE_OPENAI_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Reply with exactly the word: ready" }],
      max_completion_tokens: 10,
    }),
  });
  const data = await body(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data.error ?? data)}`);

  return `replied "${data.choices[0].message.content.trim()}", used ${data.usage.total_tokens} tokens`;
});

check("Azure AI Search — service reachable", async () => {
  const url = `${env("AZURE_SEARCH_ENDPOINT")}/servicestats?api-version=${SEARCH_API_VERSION}`;
  const response = await fetch(url, { headers: { "api-key": env("AZURE_SEARCH_KEY") } });
  const data = await body(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data.error ?? data)}`);

  const { documentCount, storageSize } = data.counters;
  return `${documentCount.usage} documents, ${(storageSize.usage / 1e6).toFixed(1)} MB used of ${(storageSize.quota / 1e6).toFixed(0)} MB`;
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    console.log(`PASS  ${name}\n      ${await fn()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log(failed === 0 ? "\nAll checks passed. Azure is ready." : `\n${failed} check(s) failed — see above.`);
process.exit(failed === 0 ? 0 : 1);
