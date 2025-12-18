/**
 * tasteService.js (ESM)
 *
 * Minimal, crash-proof taste handling.
 * No safety/disallowSexualContent fields at all.
 * Uses in-memory store to avoid DB coupling.
 */

import crypto from "crypto";

const byId = new Map();     // tasteProfileId -> taste
const byUser = new Map();   // userId -> tasteProfileId

function clamp01(v, fallback = 0.55) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function normalizeTasteInput(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  return {
    humor: clamp01(t.humor, 0.55),
    nerdy: clamp01(t.nerdy, 0.35),
    dramatic: clamp01(t.dramatic, 0.25),
    shorter: clamp01(t.shorter, 0.2),
  };
}

export async function getOrCreateTasteProfile({ userId, tasteProfileId }) {
  // 1) explicit id
  if (tasteProfileId && byId.has(String(tasteProfileId))) {
    const id = String(tasteProfileId);
    return { id, taste: byId.get(id) || normalizeTasteInput({}) };
  }

  // 2) user binding
  if (userId && byUser.has(String(userId))) {
    const id = byUser.get(String(userId));
    if (id && byId.has(id)) return { id, taste: byId.get(id) };
  }

  // 3) create new
  const id = crypto.randomUUID();
  const taste = normalizeTasteInput({});
  byId.set(id, taste);
  if (userId) byUser.set(String(userId), id);
  return { id, taste };
}

export function applyFeedback(taste, feedback) {
  const t = normalizeTasteInput(taste || {});
  const f = feedback && typeof feedback === "object" ? feedback : {};

  let humor = t.humor;
  let nerdy = t.nerdy;
  let dramatic = t.dramatic;
  let shorter = t.shorter;

  if (f.moreHumor != null) humor = clamp01(Number(f.moreHumor), humor);
  if (f.moreNerdy != null) nerdy = clamp01(Number(f.moreNerdy), nerdy);
  if (f.moreDramatic != null) dramatic = clamp01(Number(f.moreDramatic), dramatic);
  if (f.shorter != null) shorter = clamp01(Number(f.shorter), shorter);

  if (f.liked === true) {
    humor = clamp01(humor + 0.03, humor);
  } else if (f.liked === false) {
    shorter = clamp01(shorter + 0.05, shorter);
  }

  return { humor, nerdy, dramatic, shorter };
}

export async function saveTasteProfile(tasteProfileId, taste) {
  const id = String(tasteProfileId || "");
  if (!id) return;
  byId.set(id, normalizeTasteInput(taste || {}));
}
