/**
 * wikiService.js (ESM)
 *
 * Minimal Wikidata-based helper to extract safe, non-controversial facts
 * for a person name (for street-name anchoring).
 *
 * We explicitly filter out political/war/conflict sensitive stuff.
 */

import { config } from "./config.js";
import {
  HttpError,
  cacheGet,
  cacheSet,
  fetchJson,
  normalizeWhitespace,
  looksLikePersonName,
  safeTrim,
} from "./utils.js";

function normalizeLang(lang) {
  const v = String(lang || "en").toLowerCase();
  if (v.startsWith("he")) return "he";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("en")) return "en";
  return v.slice(0, 5);
}

function isSensitiveDescription(desc) {
  const s = String(desc || "").toLowerCase();
  const bad = [
    "politician",
    "politics",
    "minister",
    "president",
    "prime minister",
    "terror",
    "war",
    "military",
    "conflict",
    "כיבוש",
    "פוליטיקאי",
    "פוליטיקה",
    "שר ",
    "נשיא",
    "ראש ממשלה",
    "מלחמה",
    "צבא",
    "טרור",
  ];
  return bad.some((w) => s.includes(w));
}

function safeFactLine(s) {
  const t = normalizeWhitespace(s);
  if (!t) return "";
  // avoid 1948 and similar hot-button years
  if (/\b1948\b/.test(t)) return "";
  if (/נכבה|מלחמ|כיבוש|טרור|טבח|רצח|נהרג/.test(t)) return "";
  return t;
}

function pickFirstString(arr) {
  if (!Array.isArray(arr)) return "";
  for (const x of arr) {
    if (typeof x === "string" && x.trim()) return x.trim();
  }
  return "";
}

function getClaim(entity, pid) {
  const claims = entity?.claims?.[pid];
  if (!Array.isArray(claims) || !claims.length) return null;
  return claims[0]?.mainsnak?.datavalue?.value ?? null;
}

function getTimeString(timeObj) {
  // Wikidata time format: { time: "+1879-03-14T00:00:00Z", ... }
  const t = timeObj?.time;
  if (!t) return "";
  const m = String(t).match(/([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function wikidataSearch(name, lang) {
  const l = normalizeLang(lang);
  const url =
    "https://www.wikidata.org/w/api.php" +
    `?action=wbsearchentities&search=${encodeURIComponent(name)}` +
    `&language=${encodeURIComponent(l)}` +
    `&format=json&limit=5&origin=*`;

  const r = await fetchJson(url, { timeoutMs: config.httpTimeoutMs });
  if (!r.ok || !r.json) return [];
  return Array.isArray(r.json.search) ? r.json.search : [];
}

async function wikidataEntity(qid) {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const r = await fetchJson(url, { timeoutMs: config.httpTimeoutMs });
  if (!r.ok || !r.json) return null;

  const ent = r.json?.entities?.[qid];
  return ent || null;
}

function labelFor(entity, lang) {
  const l = normalizeLang(lang);
  return (
    entity?.labels?.[l]?.value ||
    entity?.labels?.en?.value ||
    entity?.labels?.he?.value ||
    entity?.labels?.fr?.value ||
    ""
  );
}

function descFor(entity, lang) {
  const l = normalizeLang(lang);
  return (
    entity?.descriptions?.[l]?.value ||
    entity?.descriptions?.en?.value ||
    entity?.descriptions?.he?.value ||
    entity?.descriptions?.fr?.value ||
    ""
  );
}

export async function tryPersonFactsFromName(name, lang) {
  const n = normalizeWhitespace(name);
  if (!looksLikePersonName(n)) return { ok: false, facts: [], person: null };

  const cacheKey = `personfacts:${normalizeLang(lang)}:${n.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const results = await wikidataSearch(n, lang);
  if (!results.length) {
    const out = { ok: false, facts: [], person: null };
    cacheSet(cacheKey, out, config.geoCacheTtlMs);
    return out;
  }

  // pick first non-sensitive result
  let picked = null;
  for (const r of results) {
    const d = r?.description || "";
    if (isSensitiveDescription(d)) continue;
    picked = r;
    break;
  }
  if (!picked) {
    const out = { ok: false, facts: [], person: null };
    cacheSet(cacheKey, out, config.geoCacheTtlMs);
    return out;
  }

  const qid = picked.id;
  const ent = await wikidataEntity(qid);
  if (!ent) {
    const out = { ok: false, facts: [], person: null };
    cacheSet(cacheKey, out, config.geoCacheTtlMs);
    return out;
  }

  const personLabel = labelFor(ent, lang) || picked.label || n;
  const personDesc = descFor(ent, lang) || picked.description || "";

  if (isSensitiveDescription(personDesc)) {
    const out = { ok: false, facts: [], person: null };
    cacheSet(cacheKey, out, config.geoCacheTtlMs);
    return out;
  }

  const facts = [];

  const born = getClaim(ent, "P569"); // date of birth
  const bornStr = getTimeString(born);
  if (bornStr) facts.push(safeFactLine(`${personLabel} נולד/ה ב-${bornStr}.`));

  const occupation = getClaim(ent, "P106"); // occupation (qid)
  if (occupation?.id) {
    // We cannot reliably translate occupation without extra lookups, keep it subtle:
    facts.push(safeFactLine(`${personLabel}: ${safeTrim(personDesc, 120)}.`));
  } else if (personDesc) {
    facts.push(safeFactLine(`${personLabel}: ${safeTrim(personDesc, 120)}.`));
  }

  // spouse (personal-life juice) if present
  const spouse = getClaim(ent, "P26");
  if (spouse?.id) {
    facts.push(safeFactLine(`פרט אישי קטן: היו לו/לה חיי זוגיות מתועדים ב-Wikidata.`));
  }

  const cleanFacts = facts.filter(Boolean).slice(0, 3);

  const out = {
    ok: cleanFacts.length > 0,
    facts: cleanFacts,
    person: {
      qid,
      label: personLabel,
      description: personDesc,
    },
  };

  cacheSet(cacheKey, out, config.geoCacheTtlMs);
  return out;
}
