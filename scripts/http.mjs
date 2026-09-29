// Shared HTTP helpers. Kept deliberately thin and SDK-free so the actual
// requests each provider makes stay visible.

export function env(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from the environment`);
  return value.replace(/\/+$/, "");
}

export const optionalEnv = (name) => process.env[name]?.trim() || undefined;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying, in ms, or null if the error isn't retryable.
 * Free tiers rate-limit aggressively and usually say exactly how long to wait —
 * Google in an RPC RetryInfo detail, most others in a Retry-After header.
 * Honouring that beats a blind exponential backoff.
 */
function retryDelay(response, data, attempt) {
  if (response.status !== 429 && response.status < 500) return null;

  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;

  const info = data?.error?.details?.find((d) => d["@type"]?.endsWith("RetryInfo"));
  const seconds = Number.parseFloat(info?.retryDelay ?? "");
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 500;

  return Math.min(2 ** attempt * 1000, 30_000);
}

export async function postJson(url, headers, body, what, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (response.ok) return data;

    const wait = attempt < retries ? retryDelay(response, data, attempt) : null;
    if (wait === null) {
      const message = data?.error?.message ?? JSON.stringify(data) ?? response.statusText;
      throw new Error(`${what} failed (HTTP ${response.status}): ${message}`);
    }
    console.warn(`  ${what}: rate limited, waiting ${Math.round(wait / 1000)}s...`);
    await sleep(wait);
  }
}

/**
 * Chat completion over the OpenAI wire protocol, which Azure OpenAI and Groq
 * both speak. Pass `onToken` to stream; the full text is returned either way,
 * so callers that don't stream can ignore it.
 */
export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.rateLimited = true;
  }
}

export async function chatStream(url, headers, payload, { onToken, maxTokens = 700, tools, toolChoice } = {}) {
  // Tool calls need the whole message back at once, so tools imply non-streaming.
  const streaming = typeof onToken === "function" && !tools;
  if (tools) {
    payload = { ...payload, tools, tool_choice: toolChoice ?? "auto" };
  }

  const body = JSON.stringify({
    // Deterministic: the same question must give the same answer when the
    // subject is someone's legal entitlements.
    temperature: 0,
    max_tokens: maxTokens,
    stream: streaming,
    ...payload,
  });

  // Free tiers meter tokens per minute. Groq says exactly how long to wait
  // ("try again in 764ms"), so a short retry usually succeeds; but we cap the
  // total wait so a visitor never sits through a long stall — the caller can
  // degrade instead (agent -> direct -> "busy, try again").
  let response;
  const MAX_TOTAL_WAIT_MS = 6000;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    if (response.ok) break;

    const detail = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    let wait = Number(response.headers.get("retry-after")) * 1000;
    const inMessage = detail.match(/try again in ([\d.]+)(ms|s)/i);
    if (!wait && inMessage) wait = parseFloat(inMessage[1]) * (inMessage[2].toLowerCase() === "s" ? 1000 : 1);
    if (!wait) wait = Math.min(1000 * 2 ** attempt, 3000);
    wait = Math.ceil(wait) + 150;

    if (!retryable || waited + wait > MAX_TOTAL_WAIT_MS || attempt >= 3) {
      const error = new Error(`Chat failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      throw response.status === 429 ? Object.assign(new RateLimitError(error.message), { status: 429 }) : error;
    }
    await sleep(wait);
    waited += wait;
  }

  if (!streaming) {
    const data = await response.json();
    const message = data.choices[0].message;
    return {
      text: message.content ?? "",
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        // Arguments arrive as a JSON string; a malformed one is the model's
        // fault, not ours, so surface it as an empty object rather than throwing.
        args: (() => {
          try {
            return JSON.parse(call.function.arguments || "{}");
          } catch {
            return {};
          }
        })(),
      })),
      // Needed verbatim in the transcript when we reply with tool results.
      raw: message,
      usage: data.usage,
    };
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
