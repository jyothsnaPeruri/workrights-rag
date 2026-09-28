// Azure AI Search REST wrapper.
//
// Index-agnostic: every call takes the index name, because the app keeps one
// index per embedding provider (vectors from different models are not
// comparable, so they cannot share an index).

import { env } from "./http.mjs";

const SEARCH_API_VERSION = "2024-07-01";

export { env } from "./http.mjs";

const headers = () => ({
  "api-key": env("AZURE_SEARCH_KEY"),
  "Content-Type": "application/json",
});

const url = (index, suffix = "") =>
  `${env("AZURE_SEARCH_ENDPOINT")}/indexes/${index}${suffix}?api-version=${SEARCH_API_VERSION}`;

async function request(target, options, what) {
  const response = await fetch(target, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.error?.message ?? JSON.stringify(data) ?? response.statusText;
    throw new Error(`${what} failed (HTTP ${response.status}): ${message}`);
  }
  return data;
}

export const search = {
  headers,

  /** Creates or replaces an index, so ingestion is re-runnable. */
  createIndex: (definition) =>
    request(
      url(definition.name),
      { method: "PUT", headers: headers(), body: JSON.stringify(definition) },
      "Create index",
    ),

  async deleteIndex(index) {
    const response = await fetch(url(index), { method: "DELETE", headers: headers() });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete index failed (HTTP ${response.status})`);
    }
  },

  upload: (index, documents) =>
    request(
      url(index, "/docs/index"),
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          value: documents.map((doc) => ({ "@search.action": "mergeOrUpload", ...doc })),
        }),
      },
      "Upload documents",
    ),

  query: (index, payload) =>
    request(
      url(index, "/docs/search"),
      { method: "POST", headers: headers(), body: JSON.stringify(payload) },
      "Search",
    ),

  async count(index) {
    return Number(await request(url(index, "/docs/$count"), { headers: headers() }, "Count"));
  },

  /** Used by the daily-usage counter, which lives in its own tiny index. */
  async getDocument(index, id) {
    const response = await fetch(url(index, `/docs/${id}`), { headers: headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Read failed (HTTP ${response.status})`);
    return response.json();
  },
};

export const toVector = (embedding) => `[${embedding.join(",")}]`;
