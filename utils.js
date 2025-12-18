import crypto from "crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function assertFiniteNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    const err = new Error(`Invalid number for ${name}`);
    err.code = "BAD_INPUT";
    throw err;
  }
  return n;
}

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

export function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

export function safeTrim(s, maxLen = 4000) {
  const t = String(s ?? "").trim();
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

/**
 * Clean text before sending it to TTS.
 * Keeps it teen-safe and avoids weird punctuation that can break URL paths.
 */
export function sanitizeForTts(text, { disallowSexualContent = true } = {}) {
  let t = String(text ?? "");

  // Normalize whitespace
  t = t.replace(/\s+/g, " ").trim();

  // Remove control chars
  t = t.replace(/[\u0000-\u001F\u007F]/g, "");

  // Optional safety scrub (lightweight; real safety should be handled upstream too)
  if (disallowSexualContent) {
    // Remove a few explicit terms if they slipped in
    t = t.replace(/\b(sex|sexual|porn|nude|naked)\b/gi, ""); // conservative
    t = t.replace(/\s+/g, " ").trim();
  }

  return t;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

export function jsonOk(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") || ct.includes("application/sparql-results+json");
}

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function makeLogger(prefix = "BTW") {
  return {
    info: (...args) => console.log(`[${prefix}]`, ...args),
    warn: (...args) => console.warn(`[${prefix}]`, ...args),
    error: (...args) => console.error(`[${prefix}]`, ...args),
  };
}
