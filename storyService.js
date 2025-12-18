/**
 * storyService.js (ESM)
 * Generates the spoken micro-story text.
 *
 * Goals:
 * - Respect requested language (he/en/fr)
 * - Avoid hot-button topics (e.g., 1948, conflict/politics/ethnic/religious tension)
 * - Add "BTW vibe": short, punchy, lightly witty (not forced), one sensory detail
 * - Add a personal-life detail about a notable person ONLY if it exists in the provided facts
 * - No hallucinations: do not invent facts
 *
 * Env:
 * - OPENAI_API_KEY (required)
 * - OPENAI_TEXT_MODEL (optional, default: gpt-4o-mini)
 */

import { config } from "./config.js";
import { HttpError, safeTrim } from "./utils.js";

function requireOpenAIKey() {
  if (!config.openaiApiKey) throw new HttpError(500, "Missing OPENAI_API_KEY");
}

function normalizeLang(lang) {
  const v = String(lang || "en").toLowerCase();
  if (v.startsWith("he")) return "he";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("en")) return "en";
  return v.slice(0, 5);
}

function targetLanguageName(lang) {
  const l = normalizeLang(lang);
  if (l === "he") return "Hebrew";
  if (l === "fr") return "French";
  if (l === "en") return "English";
  return "the requested language";
}

function isSensitiveFactLine(line) {
  const s = String(line || "").toLowerCase();

  // Keep this intentionally strict: if it smells like conflict/politics/violence, drop it.
  const patterns = [
    /1948/,
    /\bnakba\b/,
    /\bwar\b/,
    /\bmassacre\b/,
    /\bterror\b/,
    /\boccupation\b/,
    /\bexpell(ed|ing)?\b/,
    /\bkilled\b/,
    /מלחמ/,
    /נכבה/,
    /טבח/,
    /רצח/,
    /נהרג/,
    /טרור/,
    /כיבוש/,
    /גורש/,
    /פלסטינ/,
  ];

  return patterns.some((re) => re.test(s));
}

function takeFacts(poi, max = 8) {
  const facts = Array.isArray(poi?.facts) ? poi.facts : [];
  return facts
    .map((f) => (typeof f === "string" ? f.trim() : ""))
    .filter(Boolean)
    .filter((f) => !isSensitiveFactLine(f))
    .slice(0, max);
}

function pickPersonalLifeFacts(facts) {
  // We only allow personal-life flavor if it's explicitly in facts.
  // Heuristics: look for "born", "married", "wife", "husband", "children", "grew up", Hebrew equivalents.
  const patterns = [
    /\bborn\b/i,
    /\bmarried\b/i,
    /\bwife\b/i,
    /\bhusband\b/i,
    /\bchildren\b/i,
    /\bgrew up\b/i,
    /\bfamily\b/i,
    /נולד/,
    /נולדה/,
    /התחתנ/,
    /אשתו/,
    /בעלה/,
    /ילדיו/,
    /ילדיה/,
    /משפחת/,
    /גדל/,
    /גדלה/,
  ];

  const hits = facts.filter((f) => patterns.some((re) => re.test(f)));
  return hits.slice(0, 2);
}

function formatFactsBlock(facts) {
  if (!facts.length) return "(no strong facts)";
  return facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
}

async function openaiChat({ system, user }) {
  requireOpenAIKey();

  const model = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
  const url = `${config.openaiBaseUrl}/v1/chat/completions`;

  const payload = {
    model,
    temperature: 0.7,
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
  const text = json?.choices?.[0]?.message?.content ?? "";
  return String(text);
}

/**
 * Public API used by server.js
 */
export async function generateStoryText({ poi, taste, lang = "en" }) {
  const l = normalizeLang(lang);
  const languageName = targetLanguageName(l);

  const poiName = poi?.label || "a place";
  const poiDesc = poi?.description || "";
  const wiki = poi?.wikipediaUrl || "";

  const facts = takeFacts(poi, 8);
  const personalHints = pickPersonalLifeFacts(facts);

  // Taste is optional. Keep it safe and lightweight.
  const humor = Number(taste?.humor ?? 0.6);

  const system = [
    `You write short micro-stories for a travel app named BYTHEWAY.`,
    `Output language must be ${languageName}. Do not mix languages.`,
    `Safety and tone rules:`,
    `- Keep it clean and teen-safe: no sexual content, no explicit violence, no hate.`,
    `- Avoid hot-button topics: no politics, no conflict/war, no ethnic/religious tension, no historical controversy.`,
    `- If the provided facts contain such topics, ignore them. Do not mention years like 1948.`,
    `Style rules (BYTHEWAY):`,
    `- 70-130 words.`,
    `- Hook in the first sentence (question or surprising angle).`,
    `- Include exactly 1 gentle, understated smile-worthy line (not a forced metaphor).`,
    `- Include 1 sensory detail (sound/smell/texture/heat/wind).`,
    `- No generic closings like "every place has a story". No lecturing.`,
    `- Facts must be grounded ONLY in the provided facts. Do not invent.`,
    `Personal "juice" rule:`,
    `- If there is a notable person personal-life detail in the provided facts, include ONE such detail.`,
    `- If not present, do NOT invent; skip it.`,
    `Formatting: plain text, no bullets, no emojis.`,
  ].join(" ");

  const user = [
    `Place name: ${poiName}`,
    poiDesc ? `Description: ${poiDesc}` : "",
    wiki ? `Wikipedia: ${wiki}` : "",
    `Facts (sanitized):`,
    formatFactsBlock(facts),
    personalHints.length ? `Personal-life fact hints (use at most one):\n${formatFactsBlock(personalHints)}` : `Personal-life fact hints: (none provided)`,
    `Humor level (0-1): ${Number.isFinite(humor) ? humor : 0.6}`,
    `Write the story now.`,
  ]
    .filter(Boolean)
    .join("\n");

  const out = await openaiChat({ system, user });
  const trimmed = safeTrim(out, 1400);

  if (!trimmed) throw new HttpError(500, "Empty story text from OpenAI");
  return trimmed;
}
