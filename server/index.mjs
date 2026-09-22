// The API the browser talks to.
//
// The whole point of this layer: Azure credentials live here and never reach
// the client. The browser only ever calls /api/ask on this server.

import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { answerQuestion } from "../scripts/answer.mjs";
import { checkVisitor, consumeGlobalQuota, ensureUsageIndex, LIMITS } from "./limits.mjs";

const PORT = Number(process.env.PORT ?? 8787);

// In production only the deployed site may call this API. Without it, anyone
// could point their own app at this endpoint and spend the Azure credit.
// Unset in development, where the Vite dev server proxies same-origin.
const allowedOrigins = process.env.CLIENT_ORIGIN?.split(",").map((o) => o.trim());

const app = express();
// Hosting platforms put a proxy in front, so req.ip is the proxy unless this
// is set. Exactly one hop — a larger number would let clients spoof X-Forwarded-For.
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb" }));
app.use(cors({ origin: allowedOrigins ?? true }));

// CORS alone only stops a *browser* reading the response — the server has
// already done the work and spent the quota by then, and curl ignores CORS
// entirely. Rejecting a disallowed Origin up front means an embedded widget on
// someone else's site costs nothing. A scripted client can omit or forge the
// header, which is why the global daily cap, not this, is the real guard.
app.use("/api/ask", (req, res, next) => {
  const origin = req.get("origin");
  if (allowedOrigins && origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "This API only serves the Work Rights Q&A demo site." });
  }
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/ask", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    return res.status(400).json({ error: "Please type a question." });
  }
  if (question.length > LIMITS.questionChars) {
    return res.status(400).json({
      error: `That question is a bit long — please keep it under ${LIMITS.questionChars} characters.`,
    });
  }

  const visitor = checkVisitor(req.ip ?? "unknown");
  if (!visitor.allowed) {
    const minutes = Math.ceil(visitor.retryAfterSec / 60);
    res.set("Retry-After", String(visitor.retryAfterSec));
    return res.status(429).json({
      error: `You've asked a lot of questions quickly. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    });
  }

  // The global cap is the real spending guard: it applies regardless of who is
  // asking, so unlike the per-IP limit it can't be sidestepped.
  const quota = await consumeGlobalQuota().catch((error) => {
    // A failure here must not take the app down; the Azure budget alert and the
    // per-deployment token limit are still in place behind it.
    console.error("quota check failed, allowing request:", error.message);
    return { allowed: true };
  });
  if (!quota.allowed) {
    return res.status(429).json({
      error:
        "This free demo has reached its limit for today, to keep hosting costs down. Please come back tomorrow — or read the same information at fairwork.gov.au.",
    });
  }

  // Server-sent events: the answer streams token by token, so the page shows
  // words as they are written instead of a blank box for several seconds.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // stop proxies buffering the stream
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Detect the client going away, so we stop writing into a dead socket.
  // This must listen on `res`, not `req`: Node emits "close" on the REQUEST
  // stream as soon as its body has been fully read, which for every POST is
  // immediately — so `req.on("close")` would mark the client gone before we
  // had written a single token.
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  try {
    const { sources } = await answerQuestion(question, {
      onToken: (token) => {
        if (!closed) send("token", token);
      },
    });
    // Sources are sent last: only then do we know which the model actually
    // cited, and the citation markers in the text are numbered by position.
    if (!closed) {
      send(
        "sources",
        sources.map((source, i) => ({
          n: i + 1,
          title: source.title,
          heading: source.heading,
          url: source.url,
          saved: source.saved,
          // Strip the "Title > Heading" prefix added at ingest time.
          excerpt: source.content.split("\n\n").slice(1).join("\n\n"),
        })),
      );
      send("done", {});
    }
  } catch (error) {
    console.error("ask failed:", error);
    if (!closed) send("error", { error: "Something went wrong answering that. Please try again." });
  } finally {
    res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureUsageIndex();
  app.listen(PORT, () =>
    console.log(
      `API on http://localhost:${PORT} — ${LIMITS.perVisitor.max}/${LIMITS.perVisitor.windowMs / 60000}min per visitor, ${LIMITS.globalPerDay}/day total`,
    ),
  );
}

export default app;
