/**
 * storyService.js (ESM)
 *
 * No disallowSexualContent logic.
 * Keeps it PG by prompt rules, and avoids sensitive/hot-button topics.
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

function cleanFacts(poi, max = 10) {
  const facts = Array.isArray(poi?.facts) ? poi.facts : [];
  return facts
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .filter((x) => !isSensitiveLine(x))
    .slice(0, max);
}

function hashToIndex(seed, mod) {
  const s = String(seed || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

const NUGGETS = {
  he: [
    "בונוס ידע: GPS לבד יכול לטעות בכמה מטרים, ושילוב עם Wi-Fi וסלולר בדרך כלל משפר דיוק בעיר.",
    "בונוס ידע: באוכל, חריפות של פלפל היא תחושת חום-כאב, לא 'טעם' רגיל.",
    "בונוס ידע: במוזיקה, שינוי קטן בטמפו יכול לגרום לשיר להרגיש אחר לגמרי בלי לשנות את המנגינה.",
    "בונוס ידע: בטכנולוגיה, דחיסה חכמה חוסכת רוחב פס הרבה יותר ממה שחושבים, במיוחד באודיו.",
    "בונוס ידע: בטבע, הרבה צמחים מגיבים לאור ולחום יותר מאשר לשעה ביום.",
  ],
  en: [
    "Knowledge bonus: GPS alone can be off by several meters, and adding Wi-Fi and cell data often improves city accuracy.",
    "Knowledge bonus: Chili “heat” is a heat-pain sensation, not a classic taste.",
    "Knowledge bonus: In music, a small tempo change can make a track feel totally different without changing the melody.",
    "Knowledge bonus: In tech, smart compression saves a surprising amount of bandwidth, especially for audio.",
    "Knowledge bonus: In nature, many plants respond more to light and temperature than to clock time.",
  ],
  fr: [
    "Bonus savoir: Le GPS seul peut dévier de plusieurs mètres, et le Wi-Fi plus le réseau améliorent souvent la précision en ville.",
    "Bonus savoir: Le piquant du piment est une sensation de chaleur, pas un goût classique.",
    "Bonus savoir: En musique, un léger changement de tempo peut transformer l’énergie sans toucher à la mélodie.",
    "Bonus savoir: En tech, une bonne compression économise beaucoup de bande passante, surtout pour l’audio.",
    "Bonus savoir: Dans la nature, beaucoup de plantes réagissent plus à la lumière et à la température qu’à l’heure.",
  ],
};

function generalNugget(lang, seed) {
  const l = normalizeLang(lang);
  const list = NUGGETS[l] || NUGGETS.en;
  return list[hashToIndex(seed, list.length)];
}

function fallbackStory({ poi, lang }) {
  const l = normalizeLang(lang);
  const anchor = poi?.anchor?.areaLabel ? stripCommaSuffix(poi.anchor.areaLabel) : "";
  const name = poi?.label ? stripCommaSuffix(poi.label) : "";
  const where = anchor || name || (l === "he" ? "האזור הזה" : l === "fr" ? "ce coin" : "this area");
  const nugget = generalNugget(l, `${where}|${l}`);

  if (l === "he") {
    return safeTrim(
      `עצרנו ליד ${where}. אין לי כרגע מספיק עובדות ניטרליות וחזקות על נקודה ספציפית ממש פה כדי להיות מדויק, אז אני לא ממציא. ${nugget}`,
      1400
    );
  }
  if (l === "fr") {
    return safeTrim(
      `On est près de ${where}. Je n’ai pas assez de faits neutres et solides sur un point précis ici, donc je n’invente rien. ${nugget}`,
      1400
    );
  }
  return safeTrim(
    `We’re near ${where}. I don’t have enough neutral, solid facts about a specific spot right here, so I won’t make things up. ${nugget}`,
    1400
  );
}

async function openaiChat({ system, user }) {
  if (!config.openaiApiKey) throw new HttpError(500, "Missing OPENAI_API_KEY");

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
  return String(json?.choices?.[0]?.message?.content ?? "");
}

export async function generateStoryText({ poi, taste, lang = "en" }) {
  const l = normalizeLang(lang);
  const facts = cleanFacts(poi, 10);

  if (facts.length < 2) return fallbackStory({ poi, lang: l });

  const humor = Number.isFinite(Number(taste?.humor)) ? Number(taste.humor) : 0.55;
  const nugget = generalNugget(l, `${poi?.label || ""}|${poi?.anchor?.areaLabel || ""}|${l}`);

  const system = [
    `You write micro-stories for a travel app named BYTHEWAY.`,
    `Output language must be ${languageLabel(l)}. Do not mix languages.`,
    `Hard rules:`,
    `- NO politics, NO conflict/war, NO ethnic/religious tension, NO controversy.`,
    `- Keep it PG. No sexual content and no explicit intimacy.`,
    `- Use ONLY the provided facts for place-specific claims.`,
    `- Do not invent history, events, vibes, or claims about the place.`,
    `Style (BYTHEWAY):`,
    `- 90-150 words total.`,
    `- First sentence: sharp hook, simple, slightly playful.`,
    `- Include 2-4 facts from the list (paraphrase ok).`,
    `- Include exactly 1 gentle smile-worthy line (not forced).`,
    `Knowledge enrichment:`,
    `- Add exactly 1 generic knowledge nugget as a single sentence.`,
    `Formatting: plain text, no bullets, no emojis.`,
  ].join(" ");

  const user = [
    `Anchor label: ${poi?.anchor?.areaLabel || ""}`,
    `Place name: ${poi?.label || ""}`,
    `Facts:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`,
    `Knowledge nugget (must include exactly one sentence): ${nugget}`,
    `Humor level (0-1): ${humor}`,
    `Write the story now.`,
  ].join("\n");

  const out = await openaiChat({ system, user });
  const trimmed = safeTrim(out, 1400);
  if (!trimmed) throw new HttpError(500, "Empty story text from OpenAI");
  return trimmed;
}
