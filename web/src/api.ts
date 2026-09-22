// Empty in development: the Vite dev server proxies /api to localhost:8787, so
// the browser sees one origin. In production this is baked in at build time and
// points at the App Service backend, which is a different origin — hence CORS.
const API = import.meta.env.VITE_API_URL ?? "";

/**
 * App Service's free tier sleeps after ~20 minutes idle and takes ~30 seconds
 * to wake. Calling /api/health as soon as the page loads starts that wake-up
 * while the visitor is still reading the intro, so by the time they ask
 * something the server is usually up. Resolves false if it is still waking.
 */
export async function warmUp(): Promise<boolean> {
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

export interface Source {
  n: number;
  title: string;
  heading: string;
  url: string;
  saved: string;
  excerpt: string;
}

interface AskHandlers {
  onToken: (token: string) => void;
  onSources: (sources: Source[]) => void;
}

/**
 * Posts a question and reads the server-sent-event stream back.
 * Returns a function that aborts the request, so the UI can cancel cleanly
 * when the user navigates away or asks something else.
 */
export function ask(question: string, handlers: AskHandlers): { done: Promise<void>; abort: () => void } {
  const controller = new AbortController();

  const done = (async () => {
    const response = await fetch(`${API}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error ?? `Request failed (${response.status})`);
    }

    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += value;

      // SSE frames are separated by a blank line; the last piece may be partial.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === "token") handlers.onToken(payload);
        else if (event === "sources") handlers.onSources(payload);
        else if (event === "error") throw new Error(payload.error);
      }
    }
  })();

  return { done, abort: () => controller.abort() };
}
