// Model providers, bundled.
//
// Chat and embeddings cannot be swapped independently: an index stores vectors
// of one fixed width produced by one model, and vectors from different models
// are not comparable. So a "provider" here is a bundle — chat model, embedding
// model, and the search index built with that embedding model.
//
//   azure : Azure OpenAI throughout. Higher quality, costs money.
//   free  : Groq for chat, Google Gemini for embeddings. $0, and what the
//           public demo runs on once the Azure trial credit expires.
//
// Visitors always get the default bundle. An admin can switch, which is what
// makes an honest side-by-side comparison possible.

import { chatStream, env, optionalEnv, postJson } from "./http.mjs";

const AZURE_OPENAI_API_VERSION = "2024-10-21";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GROQ_BASE = "https://api.groq.com/openai/v1";

/* --------------------------------------------------------------- azure -- */

const azure = {
  name: "azure",
  label: "Azure OpenAI",
  dimensions: 1536,
  index: () => optionalEnv("AZURE_SEARCH_INDEX") ?? "workrights",
  chatModel: () => optionalEnv("AZURE_OPENAI_CHAT_DEPLOYMENT") ?? "gpt-4.1-mini",

  configured: () => Boolean(process.env.AZURE_OPENAI_KEY && process.env.AZURE_OPENAI_ENDPOINT),

  async embed(texts) {
    const url = `${env("AZURE_OPENAI_ENDPOINT")}/openai/deployments/${env(
      "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
    )}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
    const data = await postJson(
      url,
      { "api-key": env("AZURE_OPENAI_KEY") },
      { input: texts },
      "Azure embedding",
    );
    // Batched results can come back out of order; pair them by index.
    return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  },

  chat(messages, options) {
    const url = `${env("AZURE_OPENAI_ENDPOINT")}/openai/deployments/${azure.chatModel()}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
    return chatStream(url, { "api-key": env("AZURE_OPENAI_KEY") }, { messages }, options);
  },
};

/* ---------------------------------------------------------------- free -- */

const free = {
  name: "free",
  label: "Groq + Gemini",
  dimensions: 768, // Gemini text-embedding-004
  index: () => optionalEnv("FREE_SEARCH_INDEX") ?? "workrights-free",
  chatModel: () => optionalEnv("GROQ_CHAT_MODEL") ?? "llama-3.3-70b-versatile",
  embeddingModel: () => optionalEnv("GEMINI_EMBEDDING_MODEL") ?? "text-embedding-004",

  configured: () => Boolean(process.env.GROQ_API_KEY && process.env.GEMINI_API_KEY),

  async embed(texts) {
    // Gemini embeds one text per request, or many via batchEmbedContents.
    const model = `models/${free.embeddingModel()}`;
    const url = `${GEMINI_BASE}/${model}:batchEmbedContents?key=${env("GEMINI_API_KEY")}`;
    const out = [];
    const BATCH = 100; // Gemini's per-request cap
    for (let i = 0; i < texts.length; i += BATCH) {
      const data = await postJson(
        url,
        {},
        {
          requests: texts.slice(i, i + BATCH).map((text) => ({
            model,
            content: { parts: [{ text }] },
            // RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY: Gemini embeds passages and
            // questions into slightly different spaces on purpose, which
            // improves retrieval. The caller says which via `taskType`.
            taskType: "RETRIEVAL_DOCUMENT",
          })),
        },
        "Gemini embedding",
      );
      for (const item of data.embeddings) out.push(item.values);
    }
    return out;
  },

  /** Questions embed better with RETRIEVAL_QUERY than RETRIEVAL_DOCUMENT. */
  async embedQuery(text) {
    const model = `models/${free.embeddingModel()}`;
    const url = `${GEMINI_BASE}/${model}:embedContent?key=${env("GEMINI_API_KEY")}`;
    const data = await postJson(
      url,
      {},
      { model, content: { parts: [{ text }] }, taskType: "RETRIEVAL_QUERY" },
      "Gemini query embedding",
    );
    return data.embedding.values;
  },

  chat(messages, options) {
    // Groq speaks the OpenAI protocol, so the request shape is identical.
    return chatStream(
      `${GROQ_BASE}/chat/completions`,
      { Authorization: `Bearer ${env("GROQ_API_KEY")}` },
      { messages, model: free.chatModel() },
      options,
    );
  },
};

/* ------------------------------------------------------------ registry -- */

export const PROVIDERS = { azure, free };

/** What visitors get. Set to `free` once the Azure trial credit runs out. */
export const defaultProvider = () => optionalEnv("DEFAULT_PROVIDER") ?? "azure";

export function getProvider(name) {
  const provider = PROVIDERS[name ?? defaultProvider()];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

/** Only providers whose credentials are actually present can be offered. */
export const availableProviders = () =>
  Object.values(PROVIDERS)
    .filter((p) => p.configured())
    .map((p) => ({ name: p.name, label: p.label, chatModel: p.chatModel() }));
