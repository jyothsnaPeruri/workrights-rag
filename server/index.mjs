// The API the browser talks to.
//
// The whole point of this layer: Azure credentials live here and never reach
// the client. The browser only ever calls /api/ask on this server.

import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { answerQuestion } from "../scripts/answer.mjs";
import { availableProviders, defaultProvider, PROVIDERS } from "../scripts/providers.mjs";
import { adminConfigured, isAdmin, login } from "./auth.mjs";
import { checkVisitor, consumeGlobalQuota, ensureUsageIndex, LIMITS, recordUpload, recordVisit, usageStats } from "./limits.mjs";
import multer from "multer";
import {
  deleteDocument,
  deleteSession,
  ingestUpload,
  listDocuments,
  sessionHasDocuments,
  sweepExpired,
  UPLOAD_LIMITS,
  UploadError,
  validSession,
} from "./uploads.mjs";

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
app.use(["/api/ask", "/api/documents"], (req, res, next) => {
  const origin = req.get("origin");
  if (allowedOrigins && origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "This API only serves the Work Rights Q&A demo site." });
  }
  next();
});

app.get("/api/health", (req, res) => {
  // The page calls this on load to wake the server. A browser sends an Origin
  // header on that cross-origin fetch; the keep-alive cron does not. So "health
  // with an Origin" is a page load — counted with no cookie, script or user data.
  if (req.get("origin")) recordVisit().catch(() => {});
  res.json({ ok: true });
});

app.get("/api/stats", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admin only." });
  try {
    res.json(await usageStats());
  } catch (error) {
    console.error("stats failed:", error.message);
    res.status(500).json({ error: "Couldn't load stats." });
  }
});

// What the client may offer. Visitors are told only the default; an
// authenticated admin also gets the list they're allowed to switch between.
app.get("/api/providers", (req, res) => {
  const admin = isAdmin(req);
  res.json({
    default: defaultProvider(),
    admin,
    adminAvailable: adminConfigured(),
    providers: admin ? availableProviders() : [],
  });
});

// Deliberately rate-limited: this endpoint is the only thing standing between
// the public internet and the provider switch, and scrypt makes each attempt
// costly for us as well as for an attacker.
const loginAttempts = new Map();

app.post("/api/admin/login", async (req, res) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const recent = (loginAttempts.get(ip) ?? []).filter((t) => now - t < 15 * 60 * 1000);
  if (recent.length >= 8) {
    return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  }
  recent.push(now);
  loginAttempts.set(ip, recent);

  const token = await login(req.body?.username, req.body?.password);
  // One message for both wrong-username and wrong-password: saying which was
  // wrong tells an attacker half the answer.
  if (!token) return res.status(401).json({ error: "Incorrect username or password." });

  loginAttempts.delete(ip);
  res.json({ token, providers: availableProviders(), default: defaultProvider() });
});

/* ---------------------------------------------------------- uploads -- */

// The browser mints a random UUID once and sends it on every request. It is
// the only thing that ties a visitor to their documents: no account, nothing
// identifying, and it never leaves that browser unless they clear it.
function requireSession(req, res, next) {
  const session = validSession(req.get("x-session-id"));
  if (!session) return res.status(400).json({ error: "Missing or invalid session id." });
  res.locals.session = session;
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS.fileBytes, files: 1 },
});

// Uploads cost embedding quota and index space, so they get their own, tighter
// per-IP limit on top of everything else.
const uploadAttempts = new Map();
function checkUploadRate(ip) {
  const now = Date.now();
  const recent = (uploadAttempts.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 10) return false;
  recent.push(now);
  uploadAttempts.set(ip, recent);
  return true;
}

app.get("/api/documents", requireSession, async (req, res) => {
  try {
    res.json(await listDocuments(res.locals.session));
  } catch (error) {
    console.error("list documents failed:", error.message);
    res.status(500).json({ error: "Couldn't load your documents. Please try again." });
  }
});

app.post("/api/documents", requireSession, (req, res) => {
  if (!checkUploadRate(req.ip ?? "unknown")) {
    return res.status(429).json({ error: "Upload limit reached. Please try again in an hour." });
  }
  upload.single("file")(req, res, async (multerError) => {
    if (multerError) {
      const tooBig = multerError.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? "Files must be under 5 MB." : multerError.message });
    }
    if (!req.file) return res.status(400).json({ error: "No file received." });
    try {
      // multer decodes names as latin1; recover UTF-8 so "résumé.pdf" survives.
      const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      const doc = await ingestUpload(res.locals.session, name, req.file.buffer);
      recordUpload().catch(() => {});
      res.status(201).json(doc);
    } catch (error) {
      if (error instanceof UploadError) return res.status(error.status).json({ error: error.message });
      console.error("upload failed:", error.message);
      res.status(500).json({ error: "Couldn't process that file. Please try another." });
    }
  });
});

app.delete("/api/documents/:id", requireSession, async (req, res) => {
  try {
    await deleteDocument(res.locals.session, req.params.id);
    res.status(204).end();
  } catch (error) {
    console.error("delete document failed:", error.message);
    res.status(500).json({ error: "Couldn't delete that document." });
  }
});

app.delete("/api/documents", requireSession, async (req, res) => {
  try {
    await deleteSession(res.locals.session);
    res.status(204).end();
  } catch (error) {
    console.error("delete session failed:", error.message);
    res.status(500).json({ error: "Couldn't delete your documents." });
  }
});

/* -------------------------------------------------------------- ask -- */

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

  // Visitors always get the default provider. Only an authenticated admin may
  // name one, so nobody can steer the demo onto the paid models.
  let provider = defaultProvider();
  const requested = req.body?.provider;
  if (requested && requested !== provider) {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Only an admin can choose the model provider." });
    }
    if (!PROVIDERS[requested]) {
      return res.status(400).json({ error: `Unknown provider: ${requested}` });
    }
    if (!PROVIDERS[requested].configured()) {
      return res.status(503).json({ error: `${requested} is not configured on this server.` });
    }
    provider = requested;
  }

  // A session id is optional for asking. When present, retrieval also searches
  // that visitor's uploads — which live only in the free bundle's index, so a
  // session with documents is answered by the free provider regardless of the
  // admin's choice.
  const scope = validSession(req.get("x-session-id"));
  if (scope && provider !== "free" && PROVIDERS.free.configured()) {
    if (await sessionHasDocuments(scope).catch(() => false)) provider = "free";
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
      provider,
      scope,
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
          // Lets the UI label the citation "Your document" and skip the link.
          uploaded: Boolean(source.scope && source.scope !== "public"),
        })),
      );
      send("done", { provider });
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
  const sweep = () =>
    sweepExpired()
      .then((n) => n && console.log(`Swept ${n} expired upload chunk(s)`))
      .catch((error) => console.error("sweep failed:", error.message));
  await sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
  app.listen(PORT, () =>
    console.log(
      `API on http://localhost:${PORT} — ${LIMITS.perVisitor.max}/${LIMITS.perVisitor.windowMs / 60000}min per visitor, ${LIMITS.globalPerDay}/day total`,
    ),
  );
}

export default app;
