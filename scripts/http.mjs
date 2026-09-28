// Shared HTTP helpers. Kept deliberately thin and SDK-free so the actual
// requests each provider makes stay visible.

export function env(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from the environment`);
  return value.replace(/\/+$/, "");
}

export const optionalEnv = (name) => process.env[name]?.trim() || undefined;

export async function postJson(url, headers, body, what) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.error?.message ?? JSON.stringify(data) ?? response.statusText;
    throw new Error(`${what} failed (HTTP ${response.status}): ${message}`);
  }
  return data;
}

/**
 * Chat completion over the OpenAI wire protocol, which Azure OpenAI and Groq
 * both speak. Pass `onToken` to stream; the full text is returned either way,
 * so callers that don't stream can ignore it.
 */
export async function chatStream(url, headers, payload, { onToken, maxTokens = 700 } = {}) {
  const streaming = typeof onToken === "function";

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      // Deterministic: the same question must give the same answer when the
      // subject is someone's legal entitlements.
      temperature: 0,
      max_tokens: maxTokens,
      stream: streaming,
      ...payload,
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
      const data = event.replace(/^data: /, "").trim();
      if (!data || data === "[DONE]") continue;
      const token = JSON.parse(data).choices?.[0]?.delta?.content;
      if (token) {
        text += token;
        onToken(token);
      }
    }
  }
  return { text, usage: null };
}
