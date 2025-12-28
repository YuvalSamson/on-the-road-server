/**
 * poiService.js (ESM)
 *
 * Strategy:
 * 1) Reverse geocode (Google first, fallback OSM) to get anchor: street, neighborhood, city.
 * 2) Try Google Places nearby (optional) for a strong POI within radius.
 * 3) Always enrich with nearby Wikipedia context facts (neutral + filtered).
 * 4) Try to extract "person facts" from street name via Wikidata (safe filtered).
 *
 * Notes:
 * - Avoid low-signal rating facts when reviews are tiny (< 20).
 * - Keep facts compact and actually useful for the story contract.
 * - Debug: set DEBUG_WIKI_CONTEXT=1 to log raw wiki context + final facts.
 */

import { config } from "./config.js";
import {
  HttpError,
  cacheGet,
  cacheSet,
  fetchJson,
  normalizeWhitespace,
  stripCommaSuffix,
  safeTrim,
  makeLogger,
} from "./utils.js";
import { tryPersonFactsFromName, getNearbyWikiContext } from "./wikiService.js";

const log = makeLogger("poiService");
const DEBUG_WIKI_CONTEXT = config.debugWikiContext === true || process.env.DEBUG_WIKI_CONTEXT === "1";

function normalizeLang(lang) {
  const v = String(lang || "en").toLowerCase();
  if (v.startsWith("he")) return "he";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("en")) return "en";
  return v.slice(0, 5);
}

function googleKey() {
  return config.googleMapsApiKey || config.googlePlacesApiKey || "";
}

function placesKey() {
  return config.googlePlacesApiKey || config.googleMapsApiKey || "";
}

function metersBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Remove trailing house numbers and noisy prefixes so person lookup is more likely to succeed.
function streetForPersonLookup(street) {
  const s = normalizeWhitespace(String(street || ""));
  if (!s) return "";

  let t = stripCommaSuffix(s);
  t = t.replace(/^(רחוב|שדרות|שד'|שד׳|דרך|כביש)\s+/i, "").trim();
  t = t.replace(/\s+\d{1,5}[a-zא-ת]?\s*$/i, "").trim();
  t = t.replace(/\b(street|st\.|st|ave\.|ave|road|rd\.|rd|blvd\.|blvd)\b/gi, "").trim();

  return safeTrim(normalizeWhitespace(t), 80);
}

function uniqFacts(list, max = 10) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const s = normalizeWhitespace(String(x || "")).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

async function reverseGeocodeGoogle({ lat, lng, lang }) {
  const key = googleKey();
  if (!key) return null;

  const l = normalizeLang(lang);
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?latlng=${encodeURIComponent(`${lat},${lng}`)}` +
    `&language=${encodeURIComponent(l)}` +
    `&key=${encodeURIComponent(key)}`;

  const cacheKey = `geocode:g:${l}:${lat.toFixed(6)},${lng.toFixed(6)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const r = await fetchJson(url, { timeoutMs: config.httpTimeoutMs });
  if (!r.ok || !r.json || r.json.status !== "OK") return null;

  const res = Array.isArray(r.json.results) ? r.json.results : [];
  const best = res[0];
  const comps = Array.isArray(best?.address_components) ? best.address_components : [];

  const getComp = (type) => {
    const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(type));
    return c?.long_name || "";
  };

  const streetNumber = getComp("street_number");
  const route = getComp("route");
  const neighborhood = getComp("neighborhood") || getComp("sublocality");
  const locality = getComp("locality") || getComp("administrative_area_level_2");
  const country = getComp("country");

  const street = normalizeWhitespace([route, streetNumber].filter(Boolean).join(" "));
  const areaLabel = normalizeWhitespace([street || neighborhood, locality, country].filter(Boolean).join(", "));

  const out = {
    provider: "google",
    street,
    neighborhood,
    city: locality,
    country,
    areaLabel,
  };

  cacheSet(cacheKey, out, config.geoCacheTtlMs);
  return out;
}

async function reverseGeocodeOSM({ lat, lng, lang }) {
  const l = normalizeLang(lang);
  const base = config.osmNominatimBaseUrl;
  const url =
    `${base}/reverse` +
    `?format=jsonv2&lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lng)}` +
    `&accept-language=${encodeURIComponent(l)}`;

  const cacheKey = `geocode:o:${l}:${lat.toFixed(6)},${lng.toFixed(6)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const r = await fetchJson(url, {
    timeoutMs: config.httpTimeoutMs,
    headers: { "User-Agent": config.osmUserAgent },
  });
  if (!r.ok || !r.json) return null;

  const addr = r.json.address || {};
  const road = addr.road || "";
  const houseNumber = addr.house_number || "";
  const neighborhood = addr.neighbourhood || addr.suburb || "";
  const city = addr.city || addr.town || addr.village || addr.municipality || "";
  const country = addr.country || "";

  const street = normalizeWhitespace([road, houseNumber].filter(Boolean).join(" "));
  const areaLabel = normalizeWhitespace([street || neighborhood, city, country].filter(Boolean).join(", "));

  const out = {
    provider: "osm",
    street,
    neighborhood,
    city,
    country,
    areaLabel,
  };

  cacheSet(cacheKey, out, config.geoCacheTtlMs);
  return out;
}

async function reverseGeocode({ lat, lng, lang }) {
  return (
    (await reverseGeocodeGoogle({ lat, lng, lang })) ||
    (await reverseGeocodeOSM({ lat, lng, lang })) ||
    null
  );
}

async function googlePlacesNearby({ lat, lng, lang, radiusMeters }) {
  const key = placesKey();
  if (!key) return [];

  const l = normalizeLang(lang);

  const includedTypes = [
    "tourist_attraction",
    "museum",
    "park",
    "art_gallery",
    "library",
    "stadium",
    "university",
    "cafe",
    "restaurant",
    "natural_feature",
  ];

  const all = [];

  for (const type of includedTypes) {
    const url =
      "https://maps.googleapis.com/maps/api/place/nearbysearch/json" +
      `?location=${encodeURIComponent(`${lat},${lng}`)}` +
      `&radius=${encodeURIComponent(radiusMeters)}` +
      `&type=${encodeURIComponent(type)}` +
      `&language=${encodeURIComponent(l)}` +
      `&key=${encodeURIComponent(key)}`;

    const cacheKey = `places:${l}:${type}:${lat.toFixed(5)},${lng.toFixed(5)}:${radiusMeters}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      all.push(...cached);
      continue;
    }

    const r = await fetchJson(url, { timeoutMs: config.httpTimeoutMs });
    if (!r.ok || !r.json || r.json.status !== "OK") {
      cacheSet(cacheKey, [], config.geoCacheTtlMs);
      continue;
    }

    const res = Array.isArray(r.json.results) ? r.json.results : [];
    const mapped = res
      .map((p) => ({
        placeId: p.place_id,
        name: p.name,
        types: p.types || [],
        rating: p.rating ?? null,
        userRatingsTotal: p.user_ratings_total ?? null,
        vicinity: p.vicinity ?? null,
        location: p.geometry?.location
          ? { lat: p.geometry.location.lat, lng: p.geometry.location.lng }
          : null,
      }))
      .filter((x) => x.location && x.name);

    cacheSet(cacheKey, mapped, config.geoCacheTtlMs);
    all.push(...mapped);
  }

  const byId = new Map();
  for (const p of all) {
    if (!p.placeId) continue;
    if (!byId.has(p.placeId)) byId.set(p.placeId, p);
  }

  return Array.from(byId.values());
}

function scorePlace(p) {
  const r = typeof p.rating === "number" ? p.rating : 0;
  const n = typeof p.userRatingsTotal === "number" ? p.userRatingsTotal : 0;
  const pop = Math.min(1.5, Math.log10(1 + n) / 3.2);
  return r + pop;
}

function placeFacts({ p, lang, dist }) {
  const l = normalizeLang(lang);
  const facts = [];

  if (Number.isFinite(dist) && dist !== null) {
    if (l === "he") facts.push(`בערך ${dist} מטר מפה.`);
    else if (l === "fr") facts.push(`À environ ${dist} m d’ici.`);
    else facts.push(`About ${dist} meters from here.`);
  }

  if (p.vicinity) {
    if (l === "he") facts.push(`באזור: ${p.vicinity}.`);
    else if (l === "fr") facts.push(`Dans le coin: ${p.vicinity}.`);
    else facts.push(`Area: ${p.vicinity}.`);
  }

  const n = typeof p.userRatingsTotal === "number" ? p.userRatingsTotal : null;
  const r = typeof p.rating === "number" ? p.rating : null;
  if (r !== null && n !== null && n >= 20) {
    if (l === "he") facts.push(`דירוג ${r} על בסיס ${n} ביקורות.`);
    else if (l === "fr") facts.push(`Note ${r} basée sur ${n} avis.`);
    else facts.push(`Rated ${r} from ${n} reviews.`);
  }

  if (Array.isArray(p.types) && p.types.length) {
    const t = p.types.slice(0, 3).join(", ");
    if (l === "he") facts.push(`סוג מקום: ${t}.`);
    else if (l === "fr") facts.push(`Type: ${t}.`);
    else facts.push(`Type: ${t}.`);
  }

  return facts;
}

function buildPoiFromPlace(p, lat, lng, lang) {
  const dist =
    p.location && typeof p.location.lat === "number" && typeof p.location.lng === "number"
      ? Math.round(metersBetween(lat, lng, p.location.lat, p.location.lng))
      : null;

  const key = `gplaces:${p.placeId}`;
  const label = p.name;

  const facts = placeFacts({ p, lang, dist });

  return {
    key,
    source: "google_places",
    label,
    description: null,
    wikipediaUrl: null,
    imageUrl: null,
    distanceMetersApprox: dist,
    facts,
    anchor: null,
  };
}

async function enrichWithNearbyWikiFacts({ lat, lng, lang, existingFacts = [] }) {
  const radiusM = Number.isFinite(Number(config.wikiRadiusMeters))
    ? Number(config.wikiRadiusMeters)
    : 1200;
  const limit = Number.isFinite(Number(config.wikiContextLimit))
    ? Number(config.wikiContextLimit)
    : 8;

  const ctx = await getNearbyWikiContext({ lat, lon: lng, lang, radiusM, limit });

  if (DEBUG_WIKI_CONTEXT) {
    log.info("getNearbyWikiContext raw", {
      lat,
      lng,
      lang,
      radiusM,
      limit,
      ok: ctx?.ok === true,
      factsCount: Array.isArray(ctx?.facts) ? ctx.facts.length : 0,
      pages: Array.isArray(ctx?.pages)
        ? ctx.pages.map((p) => ({ title: p.title, pageid: p.pageid, dist: p.dist }))
        : [],
      facts: Array.isArray(ctx?.facts) ? ctx.facts : [],
    });
  }

  if (!ctx.ok || !ctx.facts.length) return existingFacts;

  // Keep a small number, and dedupe.
  return uniqFacts([...existingFacts, ...ctx.facts], 12);
}

/**
 * Public API expected by server.js
 */
export async function findBestPoi({ lat, lng, userId, lang = "en" }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new HttpError(400, "Invalid coordinates");
  }

  const l = normalizeLang(lang);
  const anchor = await reverseGeocode({ lat, lng, lang: l });

  const radius = config.poiRadiusMeters;
  const candidates = await googlePlacesNearby({ lat, lng, lang: l, radiusMeters: radius });

  let best = null;
  let bestScore = -1;

  for (const c of candidates.slice(0, config.poiMaxCandidates)) {
    const s = scorePlace(c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  if (best) {
    const poi = buildPoiFromPlace(best, lat, lng, l);
    poi.anchor = anchor;

    poi.facts = await enrichWithNearbyWikiFacts({ lat, lng, lang: l, existingFacts: poi.facts });

    if (anchor?.street) {
      const who = streetForPersonLookup(anchor.street);
      if (who) {
        const pf = await tryPersonFactsFromName(who, l);
        if (pf.ok && pf.facts.length) {
          poi.facts = uniqFacts([...poi.facts, ...pf.facts], 12);
        }
      }
    }

    if (DEBUG_WIKI_CONTEXT) {
      log.info("final facts going into story", {
        lat,
        lng,
        lang: l,
        poiLabel: poi.label,
        poiSource: poi.source,
        anchorStreet: poi.anchor?.street || "",
        anchorArea: poi.anchor?.areaLabel || "",
        facts: poi.facts,
      });
    }

    return {
      shouldSpeak: true,
      reason: "poi_google_places",
      distanceMetersApprox: poi.distanceMetersApprox ?? null,
      poi: { key: poi.key, label: poi.label, source: poi.source },
      poiWithFacts: poi,
    };
  }

  const label =
    anchor?.areaLabel ||
    (l === "he" ? "האזור הזה" : l === "fr" ? "ce coin" : "this area");

  const anchorPoi = {
    key: `anchor:${lat.toFixed(5)},${lng.toFixed(5)}`,
    source: "anchor",
    label,
    description: null,
    wikipediaUrl: null,
    imageUrl: null,
    distanceMetersApprox: 0,
    facts: [],
    anchor,
  };

  anchorPoi.facts = await enrichWithNearbyWikiFacts({
    lat,
    lng,
    lang: l,
    existingFacts: anchorPoi.facts,
  });

  if (anchor?.street) {
    const who = streetForPersonLookup(anchor.street);
    if (who) {
      const pf = await tryPersonFactsFromName(who, l);
      if (pf.ok && pf.facts.length) {
        anchorPoi.facts = uniqFacts([...anchorPoi.facts, ...pf.facts], 12);
        anchorPoi.anchor = { ...anchorPoi.anchor, person: pf.person || null };
      }
    }
  }

  if (DEBUG_WIKI_CONTEXT) {
    log.info("final facts going into story", {
      lat,
      lng,
      lang: l,
      poiLabel: anchorPoi.label,
      poiSource: anchorPoi.source,
      anchorStreet: anchorPoi.anchor?.street || "",
      anchorArea: anchorPoi.anchor?.areaLabel || "",
      facts: anchorPoi.facts,
    });
  }

  return {
    shouldSpeak: true,
    reason: "fallback_anchor",
    distanceMetersApprox: 0,
    poi: { key: anchorPoi.key, label: anchorPoi.label, source: anchorPoi.source },
    poiWithFacts: anchorPoi,
  };
}
