// SpotMyBag — hybrid CV + LLM pipeline.
//
// When REPLICATE_API_TOKEN is set:
//   1. Grounding DINO detects every bag in the pile photo (pixel-tight bboxes)
//   2. CLIP embeds the user's reference photos and each detected bag region
//   3. Cosine similarity ranks candidates → pick best
//   4. Grok writes the natural-language explanation of the match
//
// When REPLICATE_API_TOKEN is missing, falls back to a Grok-only pipeline.
//
// Both paths return the same JSON shape to the client.

import sharp from "sharp";

export const config = { maxDuration: 120 };

const MAX_BAG_IMAGES = 8;
const MAX_DATA_URL_BYTES = 1_500_000;
const MAX_TOTAL_BYTES = 10_000_000;

const RATE = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_HOURLY_CAP = 120;
const GLOBAL_DAILY_CAP  = 600;
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
  if (entry.count >= RATE_LIMIT) return { ok: false, remaining: 0, resetAt: entry.resetAt };
  entry.count++;
  return { ok: true, remaining: RATE_LIMIT - entry.count, resetAt: entry.resetAt };
}

function checkGlobalCap() {
  const now = Date.now();
  if (now > globalCount.hourReset) { globalCount.hourCount = 0; globalCount.hourReset = now + RATE_WINDOW_MS; }
  if (now > globalCount.dayReset)  { globalCount.dayCount  = 0; globalCount.dayReset  = now + 24*60*60*1000; }
  if (globalCount.hourCount >= GLOBAL_HOURLY_CAP) return { ok: false, scope: "hourly" };
  if (globalCount.dayCount  >= GLOBAL_DAILY_CAP)  return { ok: false, scope: "daily" };
  globalCount.hourCount++; globalCount.dayCount++;
  return { ok: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of RATE) if (entry.resetAt < now) RATE.delete(ip);
}, 10*60*1000).unref?.();

// ============== Replicate helpers ==============

const REPLICATE_GROUNDING_DINO_VERSION =
  "efd10a8ddc57ea28773327e881ce95e20cc1d734c589f7dd01d2036921ed78aa"; // adirik/grounding-dino
const REPLICATE_CLIP_VERSION =
  "75b33f253f7714a281ad3e9b28f63e3232d583716ef6718f2e46641077ea040a"; // andreasjansson/clip-features

async function replicateRun(version, input) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN not set");

  const startRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Prefer": "wait=30",
    },
    body: JSON.stringify({ version, input }),
  });

  if (!startRes.ok) {
    const txt = await startRes.text().catch(() => "");
    throw new Error(`Replicate ${startRes.status}: ${txt.slice(0, 200)}`);
  }

  let pred = await startRes.json();
  const start = Date.now();
  while (pred.status === "starting" || pred.status === "processing") {
    if (Date.now() - start > 90_000) throw new Error("Replicate timeout");
    await new Promise(r => setTimeout(r, 1500));
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    pred = await pollRes.json();
  }

  if (pred.status !== "succeeded") {
    throw new Error(pred.error || `Replicate status: ${pred.status}`);
  }
  return pred.output;
}

async function detectBagsInPile(pileDataUrl) {
  const output = await replicateRun(REPLICATE_GROUNDING_DINO_VERSION, {
    image: pileDataUrl,
    query: "luggage. suitcase. bag. backpack. duffel bag. carry-on.",
    box_threshold: 0.22,
    text_threshold: 0.20,
  });

  // Output is { detections: [{box: [x1,y1,x2,y2], label, score}], ... }
  // Some versions return { result_image, detections }
  let dets = [];
  if (Array.isArray(output)) {
    dets = output;
  } else if (output && Array.isArray(output.detections)) {
    dets = output.detections;
  } else if (output && Array.isArray(output.predictions)) {
    dets = output.predictions;
  }

  return dets
    .filter(d => Array.isArray(d.box) && d.box.length === 4)
    .map(d => ({
      box: d.box.map(Number),
      score: Number(d.score ?? d.confidence ?? 0),
      label: String(d.label ?? "bag"),
    }));
}

async function getCLIPEmbedding(dataUrl) {
  const output = await replicateRun(REPLICATE_CLIP_VERSION, {
    inputs: dataUrl,
  });

  // Output shapes seen: array of {input, embedding}, or array of arrays, or object.
  if (Array.isArray(output)) {
    if (output[0]?.embedding) return output[0].embedding;
    if (Array.isArray(output[0])) return output[0];
    return output;
  }
  if (output && Array.isArray(output.embedding)) return output.embedding;
  throw new Error("Unexpected CLIP output shape");
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

function meanVector(vectors) {
  if (vectors.length === 0) return [];
  const n = vectors[0].length;
  const mean = new Array(n).fill(0);
  for (const v of vectors) for (let i = 0; i < n; i++) mean[i] += v[i];
  for (let i = 0; i < n; i++) mean[i] /= vectors.length;
  return mean;
}

function locationDescriptor(box, w, h) {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const xPct = cx / w, yPct = cy / h;
  let hPos, vPos;
  if (xPct < 0.34) hPos = "left";
  else if (xPct < 0.67) hPos = "center";
  else hPos = "right";
  if (yPct < 0.34) vPos = "top";
  else if (yPct < 0.67) vPos = "middle";
  else vPos = "bottom";
  if (vPos === "middle" && hPos === "center") return "center of the pile";
  if (vPos === "middle") return `${hPos} side of the pile`;
  if (hPos === "center") return `${vPos} center of the pile`;
  return `${vPos}-${hPos} of the pile`;
}

function bboxToPercent(box, w, h) {
  return {
    x: Math.max(0, Math.min(100, Math.round((box[0] / w) * 100))),
    y: Math.max(0, Math.min(100, Math.round((box[1] / h) * 100))),
    w: Math.max(1, Math.min(100, Math.round(((box[2] - box[0]) / w) * 100))),
    h: Math.max(1, Math.min(100, Math.round(((box[3] - box[1]) / h) * 100))),
  };
}

// ============== Grok-based matching from cropped candidates ==============

async function pickMatchFromCandidates(refDataUrls, candidates) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY not set");

  const userContent = [
    { type: "text", text: `Here are ${refDataUrls.length} reference photo${refDataUrls.length === 1 ? "" : "s"} of MY specific bag (multiple angles of the same bag):` },
    ...refDataUrls.map(url => ({ type: "image_url", image_url: { url, detail: "low" } })),
    { type: "text", text: `\nA computer-vision detector found ${candidates.length} bag${candidates.length === 1 ? "" : "s"} in the tarmac pile and cropped each one. They are shown below IN ORDER, indexed 0 through ${candidates.length - 1}. Pick which crop is MY bag.` },
    ...candidates.map((c, i) => ({ type: "image_url", image_url: { url: c.cropDataUrl, detail: "high" } })),
    { type: "text", text: `\nReturn ONLY minified JSON with the 0-based index of the best match, distinguishing features that matched, calibrated confidence, and a 1–2 sentence note. If no candidate looks like the user's bag, return index -1.` },
  ];

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "grok-4-fast-reasoning",
      max_tokens: 700,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are picking which detected luggage in a tarmac pile matches the user's reference bag. The crops are presented IN ORDER, indexed 0..N-1.

Procedure:
1. Note distinguishing features of the reference bag (dominant color, secondary color, shape class, hardware, tags, ribbons, stickers, scuffs).
2. Look at each cropped candidate.
3. Pick the single crop that best matches the reference.

Confidence:
- "High" = strong match on color + shape + at least one distinguishing detail
- "Medium" = color and shape match but no distinguishing details visible
- "Low" = guessing, OR multiple bags look identical, OR no candidate looks like the reference

Output ONLY a single line of minified JSON in EXACTLY this shape (no markdown, no fences):
{"index":<int>,"matched":["<feature 1>","<feature 2>",...],"confidence":"High|Medium|Low","notes":"<one or two sentences>"}

Use index -1 only if no crop looks like the user's bag.`,
        },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Grok ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.choices?.[0]?.message?.content || "").trim();

  // Tolerant parsing
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) try { parsed = JSON.parse(fenced[1].trim()); } catch {}
    if (!parsed) {
      const s = text.indexOf("{"), e = text.lastIndexOf("}");
      if (s !== -1 && e > s) try { parsed = JSON.parse(text.slice(s, e + 1)); } catch {}
    }
  }
  if (!parsed) throw new Error("Grok returned unparseable response");

  const idx = Number.isInteger(parsed.index) ? parsed.index : -1;
  let matched = parsed.matched;
  if (typeof matched === "string") matched = [matched];
  if (!Array.isArray(matched)) matched = [];
  const conf = String(parsed.confidence || "").trim().toLowerCase();
  const confidence = conf.startsWith("h") ? "High" : conf.startsWith("m") ? "Medium" : "Low";

  return {
    index: idx,
    matched: matched.map(s => String(s).trim()).filter(Boolean).slice(0, 8),
    confidence,
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
  };
}

// ============== Grok explanation step (legacy, used by full CLIP pipeline) ==============

async function describeMatch(refDataUrls, matchDataUrl, score, secondScore) {
  const key = process.env.XAI_API_KEY;
  if (!key) return { matched: [], notes: "Match selected by computer-vision similarity scoring." };

  const ambiguity = secondScore != null
    ? `Top similarity score: ${score.toFixed(3)}, runner-up: ${secondScore.toFixed(3)}.`
    : `Top similarity score: ${score.toFixed(3)}.`;

  const userContent = [
    {
      type: "text",
      text: `I have ${refDataUrls.length} reference photo${refDataUrls.length === 1 ? "" : "s"} of my specific bag. A computer vision pipeline already ranked the bags in a tarmac pile by visual similarity to my references. ${ambiguity} The cropped image at the end is the top-ranked candidate. Confirm what visible features match between my references and the candidate.`,
    },
    ...refDataUrls.map(url => ({ type: "image_url", image_url: { url, detail: "low" } })),
    { type: "text", text: "And here is the cropped candidate from the tarmac:" },
    { type: "image_url", image_url: { url: matchDataUrl, detail: "high" } },
  ];

  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-4-fast-reasoning",
        max_tokens: 600,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `You are explaining why a candidate luggage matches a reference set. The CV pipeline already picked it; your job is just to list the visible matching features (color, shape, brand, tags, ribbons, wheels, hardware, stickers) and write a 1-2 sentence note about confidence or what to verify in person.

Output ONLY a single line of minified JSON in exactly this shape:
{"matched":["<feature 1>","<feature 2>",...],"notes":"<one or two sentences>"}
No markdown, no code fences.`,
          },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!r.ok) return { matched: [], notes: "Match selected by CV similarity scoring." };
    const data = await r.json();
    const text = (data.choices?.[0]?.message?.content || "").trim();

    // Tolerant JSON extraction
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) try { parsed = JSON.parse(fenced[1].trim()); } catch {}
      if (!parsed) {
        const s = text.indexOf("{"), e = text.lastIndexOf("}");
        if (s !== -1 && e > s) try { parsed = JSON.parse(text.slice(s, e + 1)); } catch {}
      }
    }
    if (!parsed) return { matched: [], notes: text || "Match selected by CV similarity." };

    let matched = parsed.matched;
    if (typeof matched === "string") matched = [matched];
    if (!Array.isArray(matched)) matched = [];
    return {
      matched: matched.map(s => String(s).trim()).filter(Boolean).slice(0, 8),
      notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "Match confirmed by CV similarity.",
    };
  } catch {
    return { matched: [], notes: "Match selected by CV similarity scoring." };
  }
}

// ============== Hybrid pipeline ==============

async function runHybridPipeline(bagDataUrls, pileDataUrl) {
  // Hybrid pipeline: 1 Replicate call (Grounding DINO for detection) +
  // 1 Grok call (matching from cropped candidates). This gives us:
  //   - Pixel-tight bboxes from a real CV detector (not VLM-estimated)
  //   - Visual matching via Grok comparing the reference set against
  //     each cropped candidate side-by-side
  //   - Stays within Replicate's free-tier rate limit (1 prediction per
  //     request) — works for users without paid credit
  const pileB64 = pileDataUrl.split(",")[1];
  const pileBuffer = Buffer.from(pileB64, "base64");

  const meta = await sharp(pileBuffer).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error("Could not read pile image dimensions");

  // Step 1: Detect every bag in the pile
  const detections = await detectBagsInPile(pileDataUrl);
  if (detections.length === 0) {
    return {
      location: "No bags detected in the pile",
      matched: [],
      confidence: "Low",
      notes: "Object detection couldn't find any luggage in the tarmac photo. Try a clearer or wider shot.",
      bbox: null,
    };
  }

  // Cap candidates by detector score (top 12 keeps the Grok call manageable)
  const topDetections = [...detections]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 12);

  // Step 2: Crop each detection from the pile (server-side with sharp)
  const candidates = await Promise.all(
    topDetections.map(async (det) => {
      const [x1, y1, x2, y2] = det.box.map(v => Math.max(0, Math.round(v)));
      const left   = Math.min(x1, W - 1);
      const top    = Math.min(y1, H - 1);
      const width  = Math.max(1, Math.min(x2 - x1, W - left));
      const height = Math.max(1, Math.min(y2 - y1, H - top));

      const cropBuffer = await sharp(pileBuffer)
        .extract({ left, top, width, height })
        .resize(420, 420, { fit: "contain", background: { r: 0, g: 0, b: 0 } })
        .jpeg({ quality: 88 })
        .toBuffer();

      return {
        box: [x1, y1, x2, y2],
        score: det.score,
        cropDataUrl: `data:image/jpeg;base64,${cropBuffer.toString("base64")}`,
      };
    })
  );

  // Step 3: Ask Grok which crop matches the reference bag
  const pick = await pickMatchFromCandidates(bagDataUrls, candidates);

  // Step 4: Map the picked index back to its detection (with precise bbox)
  if (pick.index < 0 || pick.index >= candidates.length) {
    return {
      location: "No confident match in the pile",
      matched: [],
      confidence: "Low",
      notes: pick.notes || "Grok didn't recognize any of the detected bags as yours. The pile may be too far/blurry, or your bag may not be in the shot.",
      bbox: null,
    };
  }

  const matched = candidates[pick.index];
  return {
    location: locationDescriptor(matched.box, W, H),
    matched: pick.matched,
    confidence: pick.confidence,
    notes: pick.notes,
    bbox: bboxToPercent(matched.box, W, H),
  };
}

// ============== Grok-only fallback (kept for redundancy) ==============

const GROK_ONLY_SYSTEM_PROMPT = `You are a luggage identification assistant. The user provides reference photos of their bag from multiple angles, plus one wide tarmac photo with many bags. Find their bag in the tarmac photo.

Procedure: extract distinguishing features from the references (color, shape, size, brand, tags, ribbons, hardware, stickers); scan the tarmac photo region by region; pick the best match. Output a tight bbox as integer percentages (origin top-left).

Output ONLY minified JSON: {"location":"<phrase>","matched":["<feature>",...],"confidence":"High|Medium|Low","notes":"<1-2 sentences>","bbox":{"x":<int>,"y":<int>,"w":<int>,"h":<int>}}
No markdown, no fences.`;

async function runGrokOnlyPipeline(bagDataUrls, pileDataUrl, flightLine) {
  const userContent = [
    { type: "text", text: `Reference set: ${bagDataUrls.length} photo${bagDataUrls.length === 1 ? "" : "s"} of my bag from different angles.${flightLine ? "\n" + flightLine : ""}` },
    ...bagDataUrls.map(url => ({ type: "image_url", image_url: { url, detail: "high" } })),
    { type: "text", text: "Now find my bag in this airport tarmac pile:" },
    { type: "image_url", image_url: { url: pileDataUrl, detail: "high" } },
  ];

  const xaiRes = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-4-fast-reasoning",
      max_tokens: 1200,
      temperature: 0.2,
      messages: [
        { role: "system", content: GROK_ONLY_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!xaiRes.ok) {
    let msg = `Grok returned ${xaiRes.status}`;
    try { const e = await xaiRes.json(); if (e?.error) msg = (typeof e.error === "string" ? e.error : e.error.message) || msg; } catch {}
    throw new Error(msg);
  }
  const data = await xaiRes.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

// ============== Handler ==============

export default async function handler(req, res) {
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

  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "JSON body required." });
  const { bag, pile, flight } = body;

  if (!Array.isArray(bag) || bag.length < 1 || bag.length > MAX_BAG_IMAGES)
    return res.status(400).json({ error: `Provide 1–${MAX_BAG_IMAGES} reference photos.` });
  if (!isImageDataUrl(pile))
    return res.status(400).json({ error: "Pile photo missing or not a valid image data URL." });
  if (!bag.every(isImageDataUrl))
    return res.status(400).json({ error: "Reference photos must all be valid image data URLs." });

  let totalBytes = pile.length;
  for (const url of bag) {
    if (url.length > MAX_DATA_URL_BYTES)
      return res.status(413).json({ error: "One of the photos is too large. Try retaking it." });
    totalBytes += url.length;
  }
  if (totalBytes > MAX_TOTAL_BYTES)
    return res.status(413).json({ error: "Combined photo size too large. Try a smaller scan." });

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

  // === Hybrid path (Replicate + Grok) when configured ===
  if (process.env.REPLICATE_API_TOKEN && process.env.XAI_API_KEY) {
    try {
      const result = await runHybridPipeline(bag, pile);
      return res.status(200).json({ text: JSON.stringify(result), pipeline: "hybrid" });
    } catch (err) {
      console.error("Hybrid pipeline failed, falling back to Grok-only:", err.message);
    }
  }

  // === Grok-only fallback ===
  if (!process.env.XAI_API_KEY) {
    console.error("XAI_API_KEY not set");
    return res.status(500).json({ error: "Server misconfigured." });
  }

  try {
    const text = await runGrokOnlyPipeline(bag, pile, flightLine);
    if (!text) return res.status(502).json({ error: "Grok returned an empty response." });
    return res.status(200).json({ text, pipeline: "grok-only" });
  } catch (err) {
    console.error("Grok-only pipeline failed:", err.message);
    return res.status(502).json({ error: err.message || "Search failed." });
  }
}
