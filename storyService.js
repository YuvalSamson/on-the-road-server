/**
 * storyService.js (ESM)
 * Generates the spoken micro-story text.
 *
 * Updated goal (per your request):
 * - Not just history: enrich every story with 1 short "general knowledge" nugget
 *   from domains like sports, music, architecture, life science, exact science,
 *   technology, nature, medicine, food, etc.
 *
 * IMPORTANT:
 * - No hallucinations about the place.
 * - The general-knowledge nugget must be clearly generic (not claimed about this exact POI)
 *   unless it is explicitly supported by provided facts.
 * - Avoid hot-button topics (politics/conflict/war/ethnic-religious tension).
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

  // Strict filter: if it smells like conflict/politics/violence, drop it.
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

function takeFacts(poi, max = 10) {
  const facts = Array.isArray(poi?.facts) ? poi.facts : [];
  return facts
    .map((f) => (typeof f === "string" ? f.trim() : ""))
    .filter(Boolean)
    .filter((f) => !isSensitiveFactLine(f))
    .slice(0, max);
}

function pickPersonalLifeFacts(facts) {
  // Personal-life flavor ONLY if explicitly present in facts.
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
  return hits.slice(0, 1);
}

function formatFactsBlock(facts) {
  if (!facts.length) return "(no strong facts)";
  return facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
}

function weakFactsFallback({ poiName, lang }) {
  const l = normalizeLang(lang);

  if (l === "he") {
    return safeTrim(
      `עצרנו ליד ${poiName}. כרגע אין לי מספיק עובדות חזקות על המקום כדי לספר משהו מדויק, ואני מעדיף לדייק מאשר לייפות. תן לי נקודת עניין קרובה אחרת, ואני אנסה שוב.`,
      1400
    );
  }
  if (l === "fr") {
    return safeTrim(
      `On est près de ${poiName}. Pour l'instant je n'ai pas assez de faits solides pour raconter quelque chose de précis, et je préfère être exact plutôt que faire du remplissage. Essaie un point d'intérêt juste à côté et je réessaie.`,
      1400
    );
  }
  return safeTrim(
    `We’re near ${poiName}. Right now I don’t have enough solid facts to tell a precise story, and I’d rather be accurate than fill space. Try a nearby point of interest and I’ll take another shot.`,
    1400
  );
}

async function openaiChat({ system, user }) {
  requireOpenAIKey();

  const model = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
  const url = `${config.openaiBaseUrl}/v1/chat/completions`;

  const payload = {
    model,
    temperature: 0.55,
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

export async function generateStoryText({ poi, taste, lang = "en" }) {
  const l = normalizeLang(lang);
  const languageName = targetLanguageName(l);

  const poiName = poi?.label || "a place";
  const poiDesc = poi?.description || "";
  const wiki = poi?.wikipediaUrl || "";

  const facts = takeFacts(poi, 10);
  const personalHint = pickPersonalLifeFacts(facts);

  // If we do not have enough facts, do NOT freestyle.
  if (facts.length < 2) {
    return weakFactsFallback({ poiName, lang: l });
  }

  const humor = Number(taste?.humor ?? 0.55);

  const system = [
    `You write micro-stories for a travel app named BYTHEWAY.`,
    `Output language must be ${languageName}. Do not mix languages.`,
    `Hard rules:`,
    `- NO politics, NO conflict/war, NO ethnic/religious tension, NO controversy. Ignore sensitive facts if present.`,
    `- Use ONLY the provided facts for anything that sounds place-specific.`,
    `- Do not invent streets, buildings, vibes, history, or claims about the place.`,
    `- Do not add city/region names unless they appear in the provided facts.`,
    `Style (BYTHEWAY):`,
    `- 80-140 words total.`,
    `- First sentence is a sharp hook, not poetic.`,
    `- Include 2 to 4 concrete facts from the list (paraphrase ok).`,
    `- Include exactly 1 gentle, understated smile-worthy line (simple, not forced).`,
    `- Avoid metaphors and clichés like "time stops", "secrets of the past", "each wall tells a story".`,
    `Knowledge enrichment (your new requirement):`,
    `- Add exactly 1 short "general knowledge" nugget (1 sentence) that teaches something.`,
    `- Choose ONE domain that best matches the facts: sports, music, architecture, life science, exact science, technology, nature, medicine, food, or art.`,
    `- The nugget MUST be clearly generic (not claimed about this place) unless directly supported by the provided facts.`,
    `- Keep medicine informational only: no advice, no diagnosis, no instructions.`,
    `Personal "juice":`,
    `- If a personal-life fact about a notable person is provided, include exactly one.`,
    `- If not provided, do not add any personal details.`,
    `Formatting: plain text, no bullets, no emojis.`,
  ].join(" ");

  const user = [
    `Place name: ${poiName}`,
    poiDesc ? `Description: ${poiDesc}` : "",
    wiki ? `Wikipedia: ${wiki}` : "",
    `Facts:`,
    formatFactsBlock(facts),
    personalHint.length
      ? `Personal-life fact (use exactly one if relevant):\n${formatFactsBlock(personalHint)}`
      : `Personal-life fact: (none provided)`,
    `Humor level (0-1): ${Number.isFinite(humor) ? humor : 0.55}`,
    `Write the story now.`,
  ]
    .filter(Boolean)
    .join("\n");

  const out = await openaiChat({ system, user });
  const trimmed = safeTrim(out, 1400);

  if (!trimmed) throw new HttpError(500, "Empty story text from OpenAI");
  return trimmed;
}
