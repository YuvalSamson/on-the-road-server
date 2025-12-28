/**
 * wikiService.js (ESM)
 *
 * IMPORTANT:
 * - No SPARQL.
 * - Never throws on Wikidata/Wikipedia errors. Returns ok:false and empty facts on failure.
 * - Produces neutral, compact facts only when clearly supported.
 *
 * New:
 * - getNearbyWikiContext returns "items" per page (title+dist+facts) so callers can filter by primary entity.
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

function isSensitiveText(s) {
  const t = String(s || "").toLowerCase();
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
    "massacre",
    "פוליטיקאי",
    "פוליטיקה",
    "שר",
    "נשיא",
    "ראש ממשלה",
    "מלחמה",
    "צבא",
    "טרור",
    "כיבוש",
    "טבח",
    "רצח",
    "נהרג",
    "נכבה",
  ];
  return bad.some((w) => t.includes(w));
}

function safeFactLine(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (/\b1948\b/.test(t)) return "";
  if (/נכבה|מלחמ|כיבוש|טרור|טבח|רצח|נהרג/.test(t)) return "";
  if (isSensitiveText(t)) return "";
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

function sitelinkTitle(entity, lang) {
  const l = normalizeLang(lang);
  const key = `${l}wiki`;
  return entity?.sitelinks?.[key]?.title || entity?.sitelinks?.enwiki?.title || "";
}

function firstSentences(text, maxSentences = 2) {
  const t = normalizeWhitespace(String(text || "")).trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.?!])\s+/);
  return parts.slice(0, maxSentences).map((x) => x.trim()).filter(Boolean);
}

function tryNameOriginFromIntro(intro, lang) {
  const l = normalizeLang(lang);
  const t = normalizeWhitespace(String(intro || "")).trim();
  if (!t) return "";

  const patterns = l === "he"
    ? [
        /נקרא(?:ת)? על שם[^.?!]+[.?!]/,
        /משמעות השם[^.?!]+[.?!]/,
        /השם(?:ו)?[^.?!]+משמעות[^.?!]+[.?!]/,
        /תרגום[^.?!]+[.?!]/,
      ]
    : [
        /named after[^.?!]+[.?!]/i,
        /the name means[^.?!]+[.?!]/i,
        /translation of[^.?!]+[.?!]/i,
      ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[0]) return safeFactLine(m[0]);
  }

  return "";
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

async function wikipediaIntroByTitle(title, lang) {
  const l = normalizeLang(lang);
  const url =
    `https://${encodeURIComponent(l)}.wikipedia.org/w/api.php` +
    `?action=query&prop=extracts&explaintext=1&exintro=1&format=json&origin=*` +
    `&titles=${encodeURIComponent(title)}`;

  const r = await fetchJson(url, { timeoutMs: config.httpTimeoutMs });
  if (!r.ok || !r.json) return "";
  const pages = r.json?.query?.pages || {};
  const first = Object.values(pages)[0];
  return String(first?.extract || "");
}

function buildPersonFactStrings({ lang, personLabel, personDesc, bornStr, wikiIntro }) {
  const facts = [];

  if (bornStr) {
    if (lang === "he") facts.push(`${personLabel} נולד/ה ב-${bornStr}.`);
    else if (lang === "fr") facts.push(`${personLabel} est né(e) le ${bornStr}.`);
    else facts.push(`${personLabel} was born on ${bornStr}.`);
  }

  if (personDesc) {
    const d = safeTrim(personDesc, 110);
    if (d && !isSensitiveText(d)) {
      facts.push(`${personLabel}: ${d}.`);
    }
  }

  const introSentences = firstSentences(wikiIntro, 2);
  for (const s of introSentences) {
    const line = safeFactLine(s);
    if (!line) continue;
    facts.push(safeTrim(line, 140));
    break;
  }

  return facts.map(safeFactLine).filter(Boolean).slice(0, 3);
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
      if (isSensitiveText(d)) continue;
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

    if (isSensitiveText(personDesc)) {
      const out = { ok: false, facts: [], person: null };
      cacheSet(cacheKey, out, config.geoCacheTtlMs);
      return out;
    }

    const born = getClaim(ent, "P569");
    const bornStr = getTimeString(born);

    const title = sitelinkTitle(ent, l);
    const wikiIntro = title ? await wikipediaIntroByTitle(title, l) : "";

    const facts = buildPersonFactStrings({
      lang: l,
      personLabel,
      personDesc,
      bornStr,
      wikiIntro,
    });

    const out = {
      ok: facts.length > 0,
      facts,
      person: { qid, label: personLabel, description: personDesc, wikipediaTitle: title || "" },
    };

    cacheSet(cacheKey, out, config.geoCacheTtlMs);
    return out;
  } catch {
    return { ok: false, facts: [], person: null };
  }
}

/**
 * Nearby Wikipedia context facts from coordinates.
 *
 * Returns:
 * - pages: list of nearby page metadata
 * - items: per-page facts (so caller can filter by primary entity)
 * - facts: flattened list (kept for backward compatibility)
 */
export async function getNearbyWikiContext({ lat, lon, lang = "en", radiusM = 1200, limit = 8 }) {
  try {
    const l = normalizeLang(lang);

    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      return { ok: false, facts: [], pages: [], items: [] };
    }

    const cacheKey = `nearbywikictx:${l}:${la.toFixed(5)},${lo.toFixed(5)}:${radiusM}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const geoUrl =
      `https://${encodeURIComponent(l)}.wikipedia.org/w/api.php` +
      `?action=query&list=geosearch&format=json&origin=*` +
      `&gscoord=${encodeURIComponent(`${la}|${lo}`)}` +
      `&gsradius=${encodeURIComponent(String(radiusM))}` +
      `&gslimit=${encodeURIComponent(String(Math.max(1, Math.min(20, limit))))}`;

    const geo = await fetchJson(geoUrl, { timeoutMs: config.httpTimeoutMs });
    const list = Array.isArray(geo?.json?.query?.geosearch) ? geo.json.query.geosearch : [];
    const pages = list
      .map((x) => ({
        title: String(x?.title || ""),
        pageid: Number(x?.pageid || 0),
        dist: Number(x?.dist || 0),
      }))
      .filter((x) => x.title && Number.isFinite(x.pageid) && x.pageid > 0)
      .slice(0, limit);

    if (!pages.length) {
      const out = { ok: false, facts: [], pages: [], items: [] };
      cacheSet(cacheKey, out, config.geoCacheTtlMs);
      return out;
    }

    const pageIds = pages.map((p) => p.pageid).join("|");
    const exUrl =
      `https://${encodeURIComponent(l)}.wikipedia.org/w/api.php` +
      `?action=query&prop=extracts&explaintext=1&exintro=1&format=json&origin=*` +
      `&pageids=${encodeURIComponent(pageIds)}`;

    const ex = await fetchJson(exUrl, { timeoutMs: config.httpTimeoutMs });
    const map = ex?.json?.query?.pages || {};

    const items = [];
    const allFacts = [];

    for (const p of pages) {
      const page = map?.[p.pageid];
      const intro = String(page?.extract || "");
      if (!intro) continue;
      if (isSensitiveText(intro)) continue;

      const nameOrigin = tryNameOriginFromIntro(intro, l);
      const s1 = firstSentences(intro, 1)[0] || "";
      const line1 = safeFactLine(s1);

      const facts = [];
      if (nameOrigin) facts.push(safeTrim(nameOrigin, 220));
      if (line1) facts.push(safeTrim(line1, 220));

      const cleanFacts = facts.map(safeFactLine).filter(Boolean);
      if (!cleanFacts.length) continue;

      const it = { title: p.title, pageid: p.pageid, dist: p.dist, facts: cleanFacts };
      items.push(it);

      for (const f of cleanFacts) allFacts.push(f);

      if (items.length >= limit) break;
    }

    const out = { ok: allFacts.length > 0, facts: allFacts.slice(0, 12), pages, items };
    cacheSet(cacheKey, out, config.geoCacheTtlMs);
    return out;
  } catch {
    return { ok: false, facts: [], pages: [], items: [] };
  }
}
