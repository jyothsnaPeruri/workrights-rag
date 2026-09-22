// Thin REST wrappers around the two Azure services.
// Deliberately no SDK: the raw calls are short, and keeping them visible makes
// it obvious what the app actually sends and what it gets back.

const OPENAI_API_VERSION = "2024-10-21";
const SEARCH_API_VERSION = "2024-07-01";

export function env(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env`);
  return value.replace(/\/+$/, "");
}

async function request(url, options, what) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.error?.message ?? JSON.stringify(data) ?? response.statusText;
    throw new Error(`${what} failed (HTTP ${response.status}): ${message}`);
  }
  return data;
}

/** The embedding model can take many inputs per call, which is far faster than one at a time. */
export async function embed(texts) {
  const url = `${env("AZURE_OPENAI_ENDPOINT")}/openai/deployments/${env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT")}/embeddings?api-version=${OPENAI_API_VERSION}`;
  const data = await request(
    url,
    {
      method: "POST",
      headers: { "api-key": env("AZURE_OPENAI_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify({ input: texts }),
    },
    "Embedding",
  );
  // The API may return results out of order, so sort by index before mapping.
  return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

/**
 * Calls the chat model. Pass `onToken` to stream: the callback fires per token
 * and the full text is still returned at the end, so callers that don't care
 * about streaming can ignore it.
 */
export async function chat(messages, { onToken, maxTokens = 700 } = {}) {
  const url = `${env("AZURE_OPENAI_ENDPOINT")}/openai/deployments/${env("AZURE_OPENAI_CHAT_DEPLOYMENT")}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  const streaming = typeof onToken === "function";

  const response = await fetch(url, {
    method: "POST",
    headers: { "api-key": env("AZURE_OPENAI_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      // Deterministic: the same question must give the same answer when the
      // subject is someone's legal entitlements.
      temperature: 0,
      max_tokens: maxTokens,
      stream: streaming,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Chat failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  if (!streaming) {
    const data = await response.json();
    return { text: data.choices[0].message.content ?? "", usage: data.usage };
  }

  // Server-sent events: "data: {json}\n\n", terminated by "data: [DONE]".
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const event of events) {
      const payload = event.replace(/^data: /, "").trim();
      if (!payload || payload === "[DONE]") continue;
      const token = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (token) {
        text += token;
        onToken(token);
      }
    }
  }
  return { text, usage: null };
}

export const search = {
  indexUrl(suffix = "") {
    return `${env("AZURE_SEARCH_ENDPOINT")}/indexes/${env("AZURE_SEARCH_INDEX")}${suffix}?api-version=${SEARCH_API_VERSION}`;
  },

  headers() {
    return { "api-key": env("AZURE_SEARCH_KEY"), "Content-Type": "application/json" };
  },

  /** Creates the index, replacing any existing one so the script is re-runnable. */
  async createIndex(definition) {
    const url = `${env("AZURE_SEARCH_ENDPOINT")}/indexes/${definition.name}?api-version=${SEARCH_API_VERSION}`;
    return request(url, { method: "PUT", headers: this.headers(), body: JSON.stringify(definition) }, "Create index");
  },

  async deleteIndex() {
    const response = await fetch(this.indexUrl(), { method: "DELETE", headers: this.headers() });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete index failed (HTTP ${response.status})`);
    }
  },

  async upload(documents) {
    return request(
      this.indexUrl("/docs/index"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ value: documents.map((doc) => ({ "@search.action": "mergeOrUpload", ...doc })) }),
      },
      "Upload documents",
    );
  },

  async query(payload) {
    return request(
      this.indexUrl("/docs/search"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(payload) },
      "Search",
    );
  },

  async count() {
    const data = await request(this.indexUrl("/docs/$count"), { headers: this.headers() }, "Count");
    return Number(data);
  },
};
