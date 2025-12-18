/**
 * Story generation (ESM).
 * Forces output language using OpenAI, so choosing "he"/"fr" etc actually works.
 *
 * Uses env:
 *   OPENAI_API_KEY (required)
 *   OPENAI_TEXT_MODEL (optional, default: gpt-4o-mini)
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

function formatFacts(poi) {
  const facts = Array.isArray(poi?.facts) ? poi.facts : [];
  const cleaned = facts
    .map((f) => (typeof f === "string" ? f.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);

  if (!cleaned.length) return "(no strong facts)";

  return cleaned.map((f, i) => `${i + 1}. ${f}`).join("\n");
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
    throw new HttpError(
      res.status,
      "OpenAI story generation failed",
      safeTrim(t, 900)
    );
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

  const factsBlock = formatFacts(poi);

  const humor = taste?.humor ?? 0.6;

  const system = [
    `You write short, engaging micro-stories for a travel app named BYTHEWAY.`,
    `Safety: keep it clean and teen-safe. No sexual content, no explicit violence, no hate.`,
    `Output language must be ${languageName}. Do not mix languages.`,
    `Length: 70-140 words.`,
    `Style: friendly, witty, a bit punchy. Keep facts accurate and don't invent new facts.`,
    `If facts are weak, say so lightly and keep it general.`,
  ].join(" ");

  const user = [
    `Place name: ${poiName}`,
    poiDesc ? `Description: ${poiDesc}` : "",
    wiki ? `Wikipedia: ${wiki}` : "",
    `Facts:`,
    factsBlock,
    `Humor level (0-1): ${Number(humor)}`,
    `Write the story now.`,
  ]
    .filter(Boolean)
    .join("\n");

  const out = await openaiChat({ system, user });
  const trimmed = safeTrim(out, 1400);

  if (!trimmed) throw new HttpError(500, "Empty story text from OpenAI");
  return trimmed;
}
