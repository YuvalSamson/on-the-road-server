/**
 * wikiService.js (ESM)
 *
 * IMPORTANT:
 * - No SPARQL.
 * - Never throws on Wikidata errors. If Wikidata fails, returns ok:false and empty facts.
 * - Produces small, neutral person facts ONLY when clearly available.
 */

import { config } from "./config.js";
import {
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
    "occupation",
    "פוליטיקאי",
    "פוליטיקה",
    "שר",
    "נשיא",
    "ראש ממשלה",
    "מלחמה",
    "צבא",
    "טרור",
    "כיבוש",
  ];
  return bad.some((w) => s.includes(w));
}

function safeFactLine(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (/\b1948\b/.test(t)) return "";
  if (/נכבה|מלחמ|כיבוש|טרור|טבח|רצח|נהרג/.test(t)) return "";
  return t;
}

function getClaim(entity, pid) {
  const claims = entity?.claims?.[pid];
  if (!Array.isArray(claims) || !claims.length) return null;
  return claims[0]?.mainsnak?.datavalue?.value ?? null;
}

function getTimeString(timeObj) {
  const t = timeObj?.time;
  if (!t) return "";
  const m = String(t).match(/([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
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

function buildFactStrings({ lang, personLabel, personDesc, bornStr, hasSpouse }) {
  const l = normalizeLang(lang);
  const facts = [];

  if (bornStr) {
    if (l === "he") facts.push(`${personLabel} נולד/ה ב-${bornStr}.`);
    else if (l === "fr") facts.push(`${personLabel} est né(e) le ${bornStr}.`);
    else facts.push(`${personLabel} was born on ${bornStr}.`);
  }

  if (personDesc) {
    if (l === "he") facts.push(`${personLabel}: ${safeTrim(personDesc, 120)}.`);
    else if (l === "fr") facts.push(`${personLabel}: ${safeTrim(personDesc, 120)}.`);
    else facts.push(`${personLabel}: ${safeTrim(personDesc, 120)}.`);
  }

  if (hasSpouse) {
    if (l === "he") facts.push(`פרט אישי קטן: יש תיעוד לחיי זוגיות ב-Wikidata.`);
    else if (l === "fr") facts.push(`Petit détail perso: une vie de couple est documentée sur Wikidata.`);
    else facts.push(`Tiny personal detail: a documented spouse/partner exists on Wikidata.`);
  }

  return facts.map(safeFactLine).filter(Boolean).slice(0, 3);
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
  return r.json?.entities?.[qid] || null;
}

export async function tryPersonFactsFromName(name, lang = "en") {
  try {
    const n = normalizeWhitespace(name);
    const l = normalizeLang(lang);

    if (!looksLikePersonName(n)) return { ok: false, facts: [], person: null };

    const cacheKey = `personfacts:${l}:${n.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const results = await wikidataSearch(n, l);
    if (!results.length) {
      const out = { ok: false, facts: [], person: null };
      cacheSet(cacheKey, out, config.geoCacheTtlMs);
      return out;
    }

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

    const personLabel = labelFor(ent, l) || picked.label || n;
    const personDesc = descFor(ent, l) || picked.description || "";

    if (isSensitiveDescription(personDesc)) {
      const out = { ok: false, facts: [], person: null };
      cacheSet(cacheKey, out, config.geoCacheTtlMs);
      return out;
    }

    const born = getClaim(ent, "P569");
    const bornStr = getTimeString(born);

    const spouse = getClaim(ent, "P26");
    const hasSpouse = Boolean(spouse);

    const facts = buildFactStrings({
      lang: l,
      personLabel,
      personDesc,
      bornStr,
      hasSpouse,
    });

    const out = {
      ok: facts.length > 0,
      facts,
      person: { qid, label: personLabel, description: personDesc },
    };

    cacheSet(cacheKey, out, config.geoCacheTtlMs);
    return out;
  } catch {
    // Never fail the request because Wikidata had a bad day
    return { ok: false, facts: [], person: null };
  }
}
