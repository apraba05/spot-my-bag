// SpotMyBag — server-side proxy for xAI Grok vision.
// Validates input, rate-limits per IP, never exposes the key to the client.

export const config = {
  maxDuration: 60,
};

const SYSTEM_PROMPT = `You are a luggage identification assistant. The first set of images are reference photos of a single user's bag, captured from multiple angles (a "360 scan"). Treat them together as one bag — combine their information (color, shape, size, brand markings, stickers, handles, wheels, zippers, ribbons, tags, scuffs, unique features). If flight context is provided (airline, flight number, arrival airport), treat it as informational metadata only, not as identification evidence. The final image is a crowd of luggage on an airport tarmac. Your job is to find which bag in the final image most likely belongs to the user.

Describe where the bag is in the tarmac photo (e.g., "center-right of the pile, second row from the front"), what specific features matched, and give a confidence level: High, Medium, or Low. If multiple bags look similar, say so and list what to look for to narrow it down. If you truly cannot find a match, say so honestly.

You must also estimate the bounding box of the matched bag in the tarmac image as percentages of the image dimensions (origin top-left). x and y are the top-left corner; w and h are width/height. All four are integers 0–100. If you cannot localize the bag confidently, set bbox to null.

Respond ONLY in valid minified JSON with this exact shape:
{"location":"<short phrase>","matched":["<feature>","<feature>",...],"confidence":"High|Medium|Low","notes":"<one or two sentences>","bbox":{"x":<int>,"y":<int>,"w":<int>,"h":<int>}}

Do not include markdown, code fences, or any text outside the JSON object. If you cannot find a confident match, set confidence to "Low", bbox to null, and explain in notes.`;

const MAX_BAG_IMAGES = 8;
const MAX_DATA_URL_BYTES = 1_500_000;        // ~1.5MB per image (base64)
const MAX_TOTAL_BYTES = 10_000_000;          // ~10MB total payload guard

// Per-instance in-memory rate limiting. Two tiers:
//  1. Per-IP limit prevents single-user abuse.
//  2. Global per-instance cap bounds total cost even if many IPs hit the same instance.
// Vercel Fluid Compute keeps instances warm and reuses them, so this provides
// meaningful protection. For cross-instance enforcement at higher traffic,
// swap for @upstash/ratelimit backed by Upstash Redis (see README).
const RATE = new Map();
const RATE_LIMIT = 10;                       // requests per window per IP
const RATE_WINDOW_MS = 60 * 60 * 1000;       // 1 hour

const GLOBAL_HOURLY_CAP = 120;               // ~$0.12/hr worst case at current pricing
const GLOBAL_DAILY_CAP  = 600;               // ~$0.60/day per instance ceiling
let globalCount = { hourCount: 0, hourReset: 0, dayCount: 0, dayReset: 0 };

const isImageDataUrl = (s) =>
  typeof s === "string" && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s);

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function checkRate(ip) {
  const now = Date.now();
  const entry = RATE.get(ip);
  if (!entry || entry.resetAt < now) {
    RATE.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, remaining: RATE_LIMIT - 1, resetAt: now + RATE_WINDOW_MS };
  }
  if (entry.count >= RATE_LIMIT) {
    return { ok: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count++;
  return { ok: true, remaining: RATE_LIMIT - entry.count, resetAt: entry.resetAt };
}

function checkGlobalCap() {
  const now = Date.now();
  if (now > globalCount.hourReset) {
    globalCount.hourCount = 0;
    globalCount.hourReset = now + RATE_WINDOW_MS;
  }
  if (now > globalCount.dayReset) {
    globalCount.dayCount = 0;
    globalCount.dayReset = now + 24 * 60 * 60 * 1000;
  }
  if (globalCount.hourCount >= GLOBAL_HOURLY_CAP) return { ok: false, scope: "hourly" };
  if (globalCount.dayCount  >= GLOBAL_DAILY_CAP)  return { ok: false, scope: "daily"  };
  globalCount.hourCount++;
  globalCount.dayCount++;
  return { ok: true };
}

// Periodic GC of stale per-IP entries to prevent memory growth on long-lived instances
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of RATE) if (entry.resetAt < now) RATE.delete(ip);
}, 10 * 60 * 1000).unref?.();

export default async function handler(req, res) {
  // CORS for safety (same-origin will work without these but keeps preview deploys flexible)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = getClientIp(req);
  const rate = checkRate(ip);
  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.floor(rate.resetAt / 1000)));
  if (!rate.ok) {
    const minsLeft = Math.ceil((rate.resetAt - Date.now()) / 60000);
    return res.status(429).json({ error: `Rate limit reached. Try again in ${minsLeft} minute${minsLeft === 1 ? "" : "s"}.` });
  }

  const cap = checkGlobalCap();
  if (!cap.ok) {
    return res.status(429).json({
      error: cap.scope === "daily"
        ? "Daily search budget reached. Add your own xAI key in settings to continue."
        : "Service is busy. Try again in a few minutes, or add your own xAI key in settings.",
    });
  }

  // Vercel auto-parses JSON when content-type is application/json
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "JSON body required." });
  }

  const { bag, pile, flight } = body;

  if (!Array.isArray(bag) || bag.length < 1 || bag.length > MAX_BAG_IMAGES) {
    return res.status(400).json({ error: `Provide 1–${MAX_BAG_IMAGES} reference photos.` });
  }
  if (!isImageDataUrl(pile)) {
    return res.status(400).json({ error: "Pile photo missing or not a valid image data URL." });
  }
  if (!bag.every(isImageDataUrl)) {
    return res.status(400).json({ error: "Reference photos must all be valid image data URLs." });
  }

  let totalBytes = pile.length;
  for (const url of bag) {
    if (url.length > MAX_DATA_URL_BYTES) {
      return res.status(413).json({ error: "One of the photos is too large. Try retaking it." });
    }
    totalBytes += url.length;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return res.status(413).json({ error: "Combined photo size too large. Try a smaller scan." });
  }

  const key = process.env.XAI_API_KEY;
  if (!key) {
    console.error("XAI_API_KEY not set");
    return res.status(500).json({ error: "Server misconfigured." });
  }

  // Sanitize and shape optional flight context (clamped, no injection vectors)
  const cleanFlight = (() => {
    if (!flight || typeof flight !== "object") return null;
    const trim = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");
    const out = {
      airline: trim(flight.airline, 60),
      flightNo: trim(flight.flightNo, 12),
      arrival: trim(flight.arrival, 6).toUpperCase(),
    };
    return (out.airline || out.flightNo || out.arrival) ? out : null;
  })();

  const flightLine = cleanFlight
    ? `Flight context (informational): airline=${cleanFlight.airline || "?"}, flight=${cleanFlight.flightNo || "?"}, arrival=${cleanFlight.arrival || "?"}.`
    : null;

  const userContent = [
    { type: "text", text: `Reference set: ${bag.length} photo${bag.length === 1 ? "" : "s"} of my bag from different angles.${flightLine ? "\n" + flightLine : ""}` },
    ...bag.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
    { type: "text", text: "Now find my bag in this airport tarmac pile:" },
    { type: "image_url", image_url: { url: pile, detail: "high" } },
  ];

  let xaiRes;
  try {
    xaiRes = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "grok-4-fast-non-reasoning",
        max_tokens: 800,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch (err) {
    console.error("xAI fetch failed:", err);
    return res.status(502).json({ error: "Couldn't reach Grok. Try again." });
  }

  if (!xaiRes.ok) {
    let msg = `Grok returned ${xaiRes.status}`;
    try {
      const e = await xaiRes.json();
      if (e?.error) msg = (typeof e.error === "string" ? e.error : e.error.message) || msg;
    } catch {}
    console.error("xAI error:", msg);
    return res.status(502).json({ error: msg });
  }

  let data;
  try {
    data = await xaiRes.json();
  } catch (err) {
    return res.status(502).json({ error: "Grok returned malformed JSON." });
  }

  const text = (data?.choices?.[0]?.message?.content || "").trim();
  if (!text) return res.status(502).json({ error: "Grok returned an empty response." });

  return res.status(200).json({ text });
}
