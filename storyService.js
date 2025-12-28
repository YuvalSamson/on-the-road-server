/**
 * storyService.js (ESM)
 *
 * Contract-driven micro-stories for BYTHEWAY:
 * - 4-6 sentences, each adds new info.
 * - No generic "bonus knowledge" unless a clear contextual note is provided.
 * - No hype / marketing clichés.
 * - Use ONLY provided facts for place-specific claims.
 */

import { config } from "./config.js";
import { HttpError, safeTrim, stripCommaSuffix } from "./utils.js";

function normalizeLang(lang) {
  const v = String(lang || "en").toLowerCase();
  if (v.startsWith("he")) return "he";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("en")) return "en";
  return v.slice(0, 5);
}

function languageLabel(lang) {
  const l = normalizeLang(lang);
  if (l === "he") return "Hebrew";
  if (l === "fr") return "French";
  return "English";
}

function isSensitiveLine(s) {
  const t = String(s || "").toLowerCase();
  const bad = [
    /1948/,
    /\bwar\b/,
    /\bterror\b/,
    /\boccupation\b/,
    /מלחמ/,
    /נכבה/,
    /טרור/,
    /כיבוש/,
    /טבח/,
    /רצח/,
    /נהרג/,
  ];
  return bad.some((re) => re.test(t));
}

// Removes low-signal rating/review lines when review-count is small.
// Example patterns we see in facts:
// - "Rating: 5, reviews: 1"
// - "דירוג 5 ומספר ביקורות 1"
function isTinyReviewLine(s) {
  const t = String(s || "");
  // English-ish
  const m1 = t.match(/reviews?\s*[:=]?\s*(\d{1,4})/i);
  // Hebrew-ish
  const m2 = t.match(/ביקורות?\s*[:=]?\s*(\d{1,4})/i);
  const n = Number(m1?.[1] || m2?.[1] || NaN);
  if (!Number.isFinite(n)) return false;
  return n < 20;
}

// Optional contextual note: only if there's a clear link.
// Keep this very conservative. If in doubt, return "".
function contextualNote({ lang, poi, facts }) {
  const l = normalizeLang(lang);
  const text = `${poi?.label || ""} ${poi?.anchor?.areaLabel || ""} ${facts.join(" ")}`.toLowerCase();

  // Clear navigation context
  const navHints = ["gps", "navigation", "wayfinding", "waze", "maps", "מפה", "ניווט", "gps", "ווייז", "מפות"];
  const hasNav = navHints.some((k) => text.includes(k));
  if (hasNav) {
    if (l === "he") return "טיפ ניווט קצר: בעיר GPS לפעמים מזייף כמה מטרים, אז עדיף להיצמד לכתובת ולשילוט.";
    if (l === "fr") return "Astuce navigation: en ville, le GPS peut décaler de quelques mètres, fiez-vous aussi à l’adresse et au panneau.";
    return "Navigation tip: in cities, GPS can drift by a few meters, so use the street address and signage too.";
  }

  // Nature/park context
  const natureHints = ["park", "trail", "viewpoint", "garden", "forest", "parc", "sentier", "תצפית", "פארק", "שביל", "גן", "יער"];
  const hasNature = natureHints.some((k) => text.includes(k));
  if (hasNature) {
    // Only if it's truly nature-related.
    if (l === "he") return "אם בא לך רגע שקט: עצירה של 60 שניות בלי מסך עושה פלאים לנוף.";
    if (l === "fr") return "Si vous voulez une vraie pause: 60 secondes sans écran changent la manière dont on voit le paysage.";
    return "If you want a real reset: 60 seconds without your screen changes how the view feels.";
  }

  return "";
}

function cleanFacts(poi, extraFacts = [], max = 10) {
  const base = Array.isArray(poi?.facts) ? poi.facts : [];
  const merged = [...base, ...(Array.isArray(extraFacts) ? extraFacts : [])];

  return merged
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .filter((x) => !isSensitiveLine(x))
    .filter((x) => !isTinyReviewLine(x))
    .slice(0, max);
}

function fallbackStory({ poi, lang }) {
  const l = normalizeLang(lang);
  const anchor = poi?.anchor?.areaLabel ? stripCommaSuffix(poi.anchor.areaLabel) : "";
  const name = poi?.label ? stripCommaSuffix(poi.label) : "";
  const where = anchor || name || (l === "he" ? "האזור הזה" : l === "fr" ? "ce coin" : "this area");

  if (l === "he") {
    return safeTrim(
      `עצרנו ליד ${where}. אין לי כרגע עובדה חזקה ומדויקת ממש על הנקודה הזאת, אז אני לא ממציא. אם תרצה, נסה להזיז את המפה מעט או לבחור נקודת עניין קרובה יותר.`,
      1400
    );
  }
  if (l === "fr") {
    return safeTrim(
      `On est près de ${where}. Je n’ai pas de fait solide et précis sur ce point exact, donc je n’invente rien. Si vous voulez, déplacez un peu la carte ou choisissez un lieu tout proche.`,
      1400
    );
  }
  return safeTrim(
    `We’re near ${where}. I don’t have a solid, precise fact about this exact spot, so I won’t make things up. If you want, nudge the map a bit or pick a nearby point of interest.`,
    1400
  );
}

async function openaiChat({ system, user }) {
  if (!config.openaiApiKey) throw new HttpError(500, "Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
  const url = `${config.openaiBaseUrl}/v1/chat/completions`;

  const payload = {
    model,
    temperature: 0.45,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new HttpError(res.status, "OpenAI story generation failed", safeTrim(t, 900));
  }

  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? "");
}

/**
 * generateStoryText
 * @param {object} args
 * @param {object} args.poi
 * @param {object} args.taste
 * @param {string} args.lang
 * @param {string[]} [args.extraFacts] - optional additional facts, for example from wikiService nearby context
 * @param {boolean} [args.allowContextNote] - default true. If false, never adds contextual note.
 */
export async function generateStoryText({ poi, taste, lang = "en", extraFacts = [], allowContextNote = true }) {
  const l = normalizeLang(lang);
  const facts = cleanFacts(poi, extraFacts, 12);

  // Minimum: need at least 2 facts to avoid fluff.
  if (facts.length < 2) return fallbackStory({ poi, lang: l });

  const humor = Number.isFinite(Number(taste?.humor)) ? Number(taste.humor) : 0.35;

  const note = allowContextNote ? contextualNote({ lang: l, poi, facts }) : "";

  const system = [
    `You write micro-stories for a travel app named BYTHEWAY.`,
    `Output language must be ${languageLabel(l)}. Do not mix languages.`,
    `Hard rules:`,
    `- NO politics, NO conflict/war, NO ethnic/religious tension, NO controversy.`,
    `- Keep it PG. No sexual content and no explicit intimacy.`,
    `- Use ONLY the provided facts for place-specific claims. Do not invent.`,
    `Story contract (must follow):`,
    `- 4 to 6 sentences total. Plain text, no bullets, no emojis.`,
    `- Sentence 1: sharp hook that justifies stopping here (no clichés).`,
    `- Include exactly one concrete, sensory detail (from facts) that paints a picture.`,
    `- If any fact explains the name (meaning / named after), include it in one sentence.`,
    `- Include one surprising, true anecdote from the facts (one sentence).`,
    `- End with one practical action the user can do now in 3 to 10 minutes.`,
    `- Each sentence must add new information. Remove filler.`,
    `- Avoid hype words like: perfect, magical, must-see, unforgettable.`,
    `Optional contextual note:`,
    `- If a "Contextual note" line is provided, you MAY append it as the last sentence ONLY if it clearly connects to the place.`,
    `- If no note is provided, do not add any general knowledge.`,
    `Tone: practical, friendly, slightly playful but not forced.`,
  ].join(" ");

  const user = [
    `Anchor label: ${poi?.anchor?.areaLabel || ""}`,
    `Place name: ${poi?.label || ""}`,
    `Facts (use only these for claims):`,
    facts.map((f, i) => `${i + 1}. ${f}`).join("\n"),
    note ? `Contextual note (optional, only if clearly connected): ${note}` : `Contextual note: (none)`,
    `Humor level (0-1): ${humor}`,
    `Write the story now.`,
  ].join("\n");

  const out = await openaiChat({ system, user });
  const trimmed = safeTrim(out, 1400);
  if (!trimmed) throw new HttpError(500, "Empty story text from OpenAI");

  // Guardrail: reject if model sneaks in "bonus" lines when not allowed.
  if (!note && /בונוס|knowledge bonus|bonus savoir/i.test(trimmed)) {
    return safeTrim(trimmed.replace(/(^|\s)(בונוס.*$|knowledge bonus.*$|bonus savoir.*$)/gim, "").trim(), 1400);
  }

  return trimmed;
}
