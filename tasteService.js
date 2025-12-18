/**
 * Taste profile service (ESM).
 * Minimal, safe, and easy to evolve.
 */
import { sha1, clamp } from "./utils.js";
import { getTasteProfile, upsertTasteProfile } from "./db.js";

export function defaultTaste() {
  return {
    humor: 0.6,
    nerdy: 0.5,
    dramatic: 0.35,
    shortness: 0.45,
    // Add more later: "historyVsPop", "sarcasm", etc.
  };
}

export function normalizeTasteInput(obj = {}) {
  const d = defaultTaste();
  const out = { ...d };

  for (const k of Object.keys(d)) {
    if (obj[k] === undefined) continue;
    const n = Number(obj[k]);
    if (Number.isFinite(n)) out[k] = clamp(n, 0, 1);
  }
  return out;
}

export async function getOrCreateTasteProfile({ userId = null, tasteProfileId = null }) {
  const id = tasteProfileId || (userId ? `taste:${sha1(userId)}` : `taste:anon`);
  const existing = await getTasteProfile(id);
  if (existing) return { id, taste: normalizeTasteInput(existing) };

  const taste = defaultTaste();
  await upsertTasteProfile(id, taste);
  return { id, taste };
}

export function applyFeedback(taste, feedback) {
  // feedback: { liked: boolean, moreHumor?: boolean, moreNerdy?: boolean, shorter?: boolean }
  const t = normalizeTasteInput(taste);

  const bump = (k, dir, amount = 0.06) => {
    t[k] = clamp(t[k] + dir * amount, 0, 1);
  };

  if (feedback?.moreHumor === true) bump("humor", +1);
  if (feedback?.moreHumor === false) bump("humor", -1);

  if (feedback?.moreNerdy === true) bump("nerdy", +1);
  if (feedback?.moreNerdy === false) bump("nerdy", -1);

  if (feedback?.shorter === true) bump("shortness", +1);
  if (feedback?.shorter === false) bump("shortness", -1);

  if (feedback?.moreDramatic === true) bump("dramatic", +1);
  if (feedback?.moreDramatic === false) bump("dramatic", -1);

  // If user simply liked/disliked, small reinforcement
  if (feedback?.liked === true) bump("humor", +1, 0.02);
  if (feedback?.liked === false) bump("shortness", +1, 0.02);

  return t;
}

export async function saveTasteProfile(id, taste) {
  await upsertTasteProfile(id, normalizeTasteInput(taste));
}
