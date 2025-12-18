/**
 * poiService.js (ESM)
 *
 * Strategy:
 * 1) Reverse geocode (Google first, fallback OSM) to get anchor: street, neighborhood, city.
 * 2) Try Google Places nearby (optional) for a strong POI within radius.
 * 3) If no strong POI: return an "anchor POI" and still shouldSpeak=true.
 * 4) Try to extract "person facts" from street name via Wikidata (safe filtered).
 */

import { config } from "./config.js";
import {
  HttpError,
  cacheGet,
  cacheSet,
  fetchJson,
  normalizeWhitespace,
  stripCommaSuffix,
} from "./utils.js";
import { tryPersonFactsFromName } from "./wikiService.js";

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

async function reverseGeocodeGoogle({ lat, lng, lang }) {
  const key = googleKey();
  if (!key) return null;

  const l = normalizeLang(lang);
  // Google uses "iw" sometimes, but "he" generally works too. Keep "he".
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
  const comps = Array.isArray(best?.address_components)
    ? best.address_components
    : [];

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
  const areaLabel = normalizeWhitespace(
    [street || neighborhood, locality, country].filter(Boolean).join(", ")
  );

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
  const areaLabel = normalizeWhitespace(
    [street || neighborhood, city, country].filter(Boolean).join(", ")
  );

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

  // Prefer "interesting" categories for stories
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

  // de-dup by placeId
  const byId = new Map();
  for (const p of all) {
    if (!p.placeId) continue;
    if (!byId.has(p.placeId)) byId.set(p.placeId, p);
  }

  return Array.from(byId.values());
}

function scorePlace(p) {
  // gentle scoring: rating + popularity
  const r = typeof p.rating === "number" ? p.rating : 0;
  const n = typeof p.userRatingsTotal === "number" ? p.userRatingsTotal : 0;
  const pop = Math.min(1.5, Math.log10(1 + n) / 3.2);
  return r + pop;
}

function buildPoiFromPlace(p, lat, lng) {
  const dist =
    p.location && typeof p.location.lat === "number" && typeof p.location.lng === "number"
      ? Math.round(metersBetween(lat, lng, p.location.lat, p.location.lng))
      : null;

  const key = `gplaces:${p.placeId}`;
  const label = p.name;

  const facts = [];
  if (p.rating) facts.push(`דירוג: ${p.rating}.`);
  if (p.userRatingsTotal) facts.push(`מספר ביקורות: ${p.userRatingsTotal}.`);
  if (p.vicinity) facts.push(`באזור: ${p.vicinity}.`);

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

/**
 * Public API expected by server.js
 */
export async function findBestPoi({ lat, lng, userId, lang = "en" }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new HttpError(400, "Invalid coordinates");
  }

  const l = normalizeLang(lang);
  const anchor = await reverseGeocode({ lat, lng, lang: l });

  // Try places near you
  const radius = config.poiRadiusMeters;
  const candidates = await googlePlacesNearby({ lat, lng, lang: l, radiusMeters: radius });

  // pick best candidate if any
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
    const poi = buildPoiFromPlace(best, lat, lng);
    poi.anchor = anchor;

    // Also try to add "street person" facts if useful (optional)
    if (anchor?.street) {
      const pf = await tryPersonFactsFromName(stripCommaSuffix(anchor.street), l);
      if (pf.ok && pf.facts.length) {
        poi.facts = [...poi.facts, ...pf.facts].slice(0, 8);
      }
    }

    return {
      shouldSpeak: true,
      reason: "poi_google_places",
      distanceMetersApprox: poi.distanceMetersApprox ?? null,
      poi: { key: poi.key, label: poi.label, source: poi.source },
      poiWithFacts: poi,
    };
  }

  // No strong POI found - fallback anchor POI
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

  // Try "someone known" from street name and attach as facts
  if (anchor?.street) {
    const pf = await tryPersonFactsFromName(stripCommaSuffix(anchor.street), l);
    if (pf.ok && pf.facts.length) {
      anchorPoi.facts = [...anchorPoi.facts, ...pf.facts].slice(0, 6);
      anchorPoi.anchor = { ...anchorPoi.anchor, person: pf.person || null };
    }
  }

  // IMPORTANT: shouldSpeak=true even without POI, because user wants always an enriching story
  return {
    shouldSpeak: true,
    reason: "fallback_anchor",
    distanceMetersApprox: 0,
    poi: { key: anchorPoi.key, label: anchorPoi.label, source: anchorPoi.source },
    poiWithFacts: anchorPoi,
  };
}
