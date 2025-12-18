/**
 * storyService.js (ESM)
 *
 * Robust story generator:
 * - Never crashes if taste / taste.safety is missing
 * - Avoids sensitive/hot-button topics
 * - If POI facts are weak after filtering, still returns a useful BTW-style story
 *   anchored to real area label (if provided by poi.anchor)
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

function targetLanguageName(lang) {
  const l = normalizeLang(lang);
  if (l === "he") return "Hebrew";
  if (l === "fr") return "French";
  if (l === "en") return "English";
  return "the requested language";
}

function requireOpenAIKey() {
  if (!config.openaiApiKey) throw new HttpError(500, "Missing OPENAI_API_KEY");
}

function isSensitiveFactLine(line) {
  const s = String(line || "").toLowerCase();

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
  // Only if explicitly present in facts
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

const NUGGETS = {
  he: [
    "בונוס ידע: GPS לבד יכול לטעות בכמה מטרים, ושילוב עם Wi-Fi וסלולר בדרך כלל משפר דיוק בעיר.",
    "בונוס ידע: באדריכלות, קשת מפזרת עומס לצדדים ולכן מבנים עם קשתות מחזיקים משקל יפה גם בלי הרבה חומר.",
    "בונוס ידע: במדע מדויק, מספרים ראשוניים הם אבני הבניין של הכפל: אי אפשר לפרק אותם לגורמים חוץ מ-1 ומעצמם.",
    "בונוס ידע: באוכל, חריפות של פלפל היא תחושת חום-כאב (לא 'טעם'), כי היא מפעילה קולטנים ייעודיים.",
    "בונוס ידע: במוזיקה, שינוי קטן בטמפו יכול לגרום לשיר להרגיש יותר אנרגטי גם בלי לשנות את המנגינה.",
    "בונוס ידע: בטבע, הרבה פרחים נפתחים ונסגרים לפי אור וטמפרטורה, לא לפי שעה קבועה.",
  ],
  en: [
    "Knowledge bonus: GPS alone can be off by several meters, and combining it with Wi-Fi and cell data often improves city accuracy.",
    "Knowledge bonus: In architecture, an arch redirects load sideways, letting structures carry weight efficiently with less material.",
    "Knowledge bonus: In math, prime numbers are the building blocks of multiplication: they can’t be factored except by 1 and themselves.",
    "Knowledge bonus: In food, chili “heat” isn’t a taste, it’s a heat-pain sensation triggered by capsaicin receptors.",
    "Knowledge bonus: In music, a small tempo change can feel noticeably more energetic even if the melody stays the same.",
    "Knowledge bonus: In nature, many flowers open and close based on light and temperature rather than a fixed clock time.",
  ],
  fr: [
    "Bonus savoir: Le GPS seul peut dévier de plusieurs mètres, et l’ajout du Wi-Fi et du réseau améliore souvent la précision en ville.",
    "Bonus savoir: En architecture, une arche renvoie la charge sur les côtés et porte du poids avec moins de matière.",
    "Bonus savoir: En maths, les nombres premiers sont les briques de la multiplication: on ne peut les factoriser qu’avec 1 et eux-mêmes.",
    "Bonus savoir: En cuisine, le piment déclenche surtout une sensation de chaleur via des récepteurs, ce n’est pas un 'goût' classique.",
    "Bonus savoir: En musique, un petit changement de tempo peut rendre un morceau plus énergique sans changer la mélodie.",
    "Bonus savoir: Dans la nature, beaucoup de fleurs s’ouvrent et se ferment selon la lumière et la température.",
  ],
};

function hashStringToIndex(s, mod) {
  const str = String(s || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

function generalNugget({ lang, seed }) {
  const l = normalizeLang(lang);
  const list = NUGGETS[l] || NUGGETS.en;
  const idx = hashStringToIndex(seed, list.length);
  return list[idx];
}

function fallbackStory({ poiName, anchorLabel, lang }) {
  const l = normalizeLang(lang);

  const nameBase = stripCommaSuffix(poiName || "").trim();
  const anchorBase = stripCommaSuffix(anchorLabel || "").trim();

  const where =
    anchorBase ||
    nameBase ||
    (l === "he" ? "האזור הזה" : l === "fr" ? "ce coin" : "this area");

  const nugget = generalNugget({ lang: l, seed: `${where}|${l}|n` });

  if (l === "he") {
    return safeTrim(
      `עצרנו ליד ${where}. אין לי כרגע מספיק עובדות ניטרליות וחזקות על נקודה ספציפית כאן כדי לספר משהו מדויק, אז אני לא ממציא. ${nugget}`,
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
    `We’re near ${where}. I don’t have enough neutral, solid facts about a specific spot here, so I won’t make things up. ${nugget}`,
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

  // Robust taste defaults (this fixes your crash indirectly)
  const t = taste || {};
  const safety = t.safety || {};
const disallowSexualContent =
  (t?.safety?.disallowSexualContent ?? t?.disallowSexualContent ?? true);

// keep for future use, but never crash
void disallowSexualContent;


  const poiName = poi?.label || "";
  const anchorLabel = poi?.anchor?.areaLabel || "";
  const poiDesc = poi?.description || "";
  const wiki = poi?.wikipediaUrl || "";

  const facts = takeFacts(poi, 10);
  const personalHint = pickPersonalLifeFacts(facts);

  if (facts.length < 2) {
    return fallbackStory({ poiName, anchorLabel, lang: l });
  }

  const humor = Number(t.humor ?? 0.55);

  const system = [
    `You write micro-stories for a travel app named BYTHEWAY.`,
    `Output language must be ${languageName}. Do not mix languages.`,
    `Hard rules:`,
    `- NO politics, NO conflict/war, NO ethnic/religious tension, NO controversy.`,
    `- No sexual content and no explicit intimacy. Keep it PG.`,
    `- Use ONLY the provided facts for place-specific claims.`,
    `- Do not invent streets, buildings, vibes, history, or claims about the place.`,
    `- Avoid poetic clichés.`,
    `Style (BYTHEWAY):`,
    `- 90-150 words total.`,
    `- First sentence: sharp hook, simple, slightly playful.`,
    `- Include 2 to 4 concrete facts from the list (paraphrase ok).`,
    `- Include exactly 1 gentle smile-worthy line (not forced).`,
    `Knowledge enrichment:`,
    `- Add exactly 1 general-knowledge nugget (1 sentence).`,
    `- Nugget must be clearly generic unless directly supported by facts.`,
    `Personal "juice":`,
    `- If a personal-life fact is provided, include exactly one. If not, add none.`,
    `Formatting: plain text, no bullets, no emojis.`,
  ].join(" ");

  const user = [
    `Anchor label (if any): ${anchorLabel}`,
    `Place name: ${stripCommaSuffix(poiName) || poiName}`,
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
