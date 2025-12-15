import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";

const { Pool } = pkg;

dotenv.config();

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!GOOGLE_PLACES_API_KEY) {
  console.warn("⚠️ GOOGLE_PLACES_API_KEY is missing in env");
}
if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is missing - using in memory only, no persistent DB");
}

// Pool for Postgres if DATABASE_URL exists (Render SSL)
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// App
const app = express();
app.use(cors());
app.use(bodyParser.json());

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== TTS =====
const TTS_VOICES_NON_HE = ["alloy", "fable", "shimmer"];

function pickVoice(language) {
  if (language === "he") {
    return { voiceName: "nova", voiceIndex: 1, voiceKey: "OPENAI_VOICE_NOVA" };
  }
  const idx = Math.floor(Math.random() * TTS_VOICES_NON_HE.length);
  const voiceName = TTS_VOICES_NON_HE[idx];
  return {
    voiceName,
    voiceIndex: idx + 1,
    voiceKey: `OPENAI_VOICE_${voiceName.toUpperCase()}`,
  };
}

async function ttsWithOpenAI(text, language = "he") {
  const { voiceName, voiceIndex, voiceKey } = pickVoice(language);

  const instructions =
    "Speak in the same language as the input text. " +
    "Sound like a friendly, smart human narrator riding with the driver. " +
    "Add more natural breathing and micro-pauses: short breaths between clauses, and slightly longer pauses after full stops. " +
    "Use a warm smile in your tone (audible but subtle), and keep your energy varied so it never sounds monotone. " +
    "Before a punchline or surprising fact: slow down a little, pause briefly, then deliver it with a light playful lift. " +
    "Do not shout. Keep it clear and safe for driving. " +
    "Avoid overly dramatic acting; aim for natural, conversational storytelling.";

  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: voiceName,
    input: text,
    instructions,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  const audioBase64 = buffer.toString("base64");
  const voiceId = `gpt-4o-mini-tts:${voiceName}`;
  return { audioBase64, voiceId, voiceIndex, voiceKey };
}

/**
 * ===== DB + caches =====
 * places_cache: cache_key => pois_json
 * user_place_history: user_key + place_id (we store unified ids like osm:..., wd:..., gp:...)
 */

const placesCacheMemory = new Map(); // cache_key => pois[]
const userPlacesHistoryMemory = new Map(); // userKey => Set(placeId)
const wikidataFactsMemory = new Map(); // qid|lang => { facts, sources, meta }

function makeCacheKey(lat, lng, radiusMeters, mode = "interesting", language = "en") {
  const latKey = lat.toFixed(4);
  const lngKey = lng.toFixed(4);
  return `${mode}:${language}:${latKey},${lngKey},${radiusMeters}`;
}

// ===== Human distance formatting =====
function roundToNearest(n, step) {
  return Math.round(n / step) * step;
}

function approxDistanceMeters(distanceMeters, stepMeters = 50) {
  if (!Number.isFinite(distanceMeters)) return null;
  const d = Math.max(0, distanceMeters);
  const step = Math.max(10, stepMeters);
  return roundToNearest(d, step);
}

async function initDb() {
  if (!pool) {
    console.warn("DB init skipped - no DATABASE_URL");
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS places_cache (
        cache_key   text PRIMARY KEY,
        places_json jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_place_history (
        user_key      text NOT NULL,
        place_id      text NOT NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_key, place_id)
      );
    `);

    console.log("✅ DB tables ready");
  } catch (err) {
    console.error("❌ Error initializing DB:", err);
  }
}

function getUserKeyFromRequest(req) {
  const headerId = req.headers["x-user-id"];
  if (typeof headerId === "string" && headerId.trim() !== "") {
    return `user:${headerId.trim()}`;
  }

  const ipHeader = req.headers["x-forwarded-for"];
  if (typeof ipHeader === "string" && ipHeader.trim() !== "") {
    return `ip:${ipHeader.split(",")[0].trim()}`;
  }

  const ip = typeof req.ip === "string" && req.ip ? req.ip : null;
  if (ip) return `ip:${ip}`;
  return "anon";
}

async function getHeardSetForUser(userKey) {
  let set = userPlacesHistoryMemory.get(userKey);
  if (set) return set;

  set = new Set();

  if (pool) {
    try {
      const { rows } = await pool.query(
        "SELECT place_id FROM user_place_history WHERE user_key = $1",
        [userKey]
      );
      for (const row of rows) set.add(row.place_id);
    } catch (err) {
      console.error("DB error in getHeardSetForUser:", err);
    }
  }

  userPlacesHistoryMemory.set(userKey, set);
  return set;
}

async function markPlaceHeardForUser(userKey, placeId) {
  if (!placeId) return;

  const set = await getHeardSetForUser(userKey);
  set.add(placeId);

  if (!pool) return;

  try {
    await pool.query(
      `
      INSERT INTO user_place_history (user_key, place_id)
      VALUES ($1, $2)
      ON CONFLICT (user_key, place_id) DO NOTHING
      `,
      [userKey, placeId]
    );
  } catch (err) {
    console.error("DB error in markPlaceHeardForUser:", err);
  }
}

// ===== Geo helpers =====
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function abortableFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(t)
  );
}

// ===== Source 1: Google Places (fallback) =====
async function fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters = 800) {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  }

  const url = "https://places.googleapis.com/v1/places:searchNearby";
  const body = {
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radiusMeters,
      },
    },
    maxResultCount: 10,
  };

  const resp = await abortableFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.location,places.types,places.rating,places.shortFormattedAddress",
      },
      body: JSON.stringify(body),
    },
    9000
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Google Places error:", resp.status, text);
    throw new Error("Google Places API error");
  }

  const data = await resp.json();
  const places = (data.places || []).map((p) => ({
    id: `gp:${p.id}`,
    name: p.displayName?.text || "",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    types: p.types || [],
    rating: p.rating ?? null,
    address: p.shortFormattedAddress || "",
    source: "google_places",
    wikidataId: null,
  }));

  return places;
}

// ===== Source 2: OpenStreetMap via Overpass =====
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function overpassQuery(lat, lng, radiusMeters) {
  // Non-business POI focus
  return `
[out:json][timeout:18];
(
  node(around:${radiusMeters},${lat},${lng})[historic];
  way(around:${radiusMeters},${lat},${lng})[historic];
  relation(around:${radiusMeters},${lat},${lng})[historic];

  node(around:${radiusMeters},${lat},${lng})[tourism=attraction];
  way(around:${radiusMeters},${lat},${lng})[tourism=attraction];
  relation(around:${radiusMeters},${lat},${lng})[tourism=attraction];

  node(around:${radiusMeters},${lat},${lng})[tourism=viewpoint];
  way(around:${radiusMeters},${lat},${lng})[tourism=viewpoint];
  relation(around:${radiusMeters},${lat},${lng})[tourism=viewpoint];

  node(around:${radiusMeters},${lat},${lng})[memorial];
  way(around:${radiusMeters},${lat},${lng})[memorial];
  relation(around:${radiusMeters},${lat},${lng})[memorial];

  node(around:${radiusMeters},${lat},${lng})[natural];
  way(around:${radiusMeters},${lat},${lng})[natural];
  relation(around:${radiusMeters},${lat},${lng})[natural];
);
out center tags 80;
`.trim();
}

function safeTag(tags, key) {
  if (!tags) return "";
  const v = tags[key];
  return typeof v === "string" ? v : "";
}

function nameFromWikipediaTag(wikipediaTag) {
  // e.g. "he:הטכניון" or "en:Some_Title"
  if (typeof wikipediaTag !== "string") return "";
  const parts = wikipediaTag.split(":");
  if (parts.length >= 2) {
    return parts.slice(1).join(":").replaceAll("_", " ").trim();
  }
  return wikipediaTag.replaceAll("_", " ").trim();
}

function bestNameFromOsm(tags) {
  const n = safeTag(tags, "name");
  if (n) return n;
  const he = safeTag(tags, "name:he");
  if (he) return he;
  const en = safeTag(tags, "name:en");
  if (en) return en;

  const wikipedia = safeTag(tags, "wikipedia");
  if (wikipedia) return nameFromWikipediaTag(wikipedia);

  return "";
}

function osmElementToPoi(el) {
  const type = el.type;
  const id = el.id;
  const tags = el.tags || {};
  const name = bestNameFromOsm(tags);

  let lat = null;
  let lng = null;
  if (type === "node") {
    lat = el.lat;
    lng = el.lon;
  } else if (el.center) {
    lat = el.center.lat;
    lng = el.center.lon;
  }

  if (typeof lat !== "number" || typeof lng !== "number") return null;

  const wikidataId = safeTag(tags, "wikidata") || null;
  const wikipedia = safeTag(tags, "wikipedia") || null;

  const kind =
    safeTag(tags, "historic") ||
    safeTag(tags, "tourism") ||
    safeTag(tags, "natural") ||
    safeTag(tags, "memorial") ||
    "";

  return {
    id: `osm:${type}/${id}`,
    name: name || "",
    lat,
    lng,
    types: kind ? [kind] : [],
    rating: null,
    address: "",
    source: "osm",
    wikidataId,
    wikipedia,
    osmTags: tags,
  };
}

async function fetchNearbyPoisFromOSM(lat, lng, radiusMeters = 800) {
  const q = overpassQuery(lat, lng, radiusMeters);

  const resp = await abortableFetch(
    OVERPASS_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": "btw-ontheroad-server/1.0 (contact: none)",
      },
      body: q,
    },
    12000
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Overpass error:", resp.status, text.slice(0, 400));
    throw new Error("Overpass API error");
  }

  const data = await resp.json();
  const elements = Array.isArray(data.elements) ? data.elements : [];

  const pois = [];
  for (const el of elements) {
    const poi = osmElementToPoi(el);
    if (!poi) continue;

    // Keep if it has a name OR wikidata OR wikipedia
    if (!poi.name && !poi.wikidataId && !poi.wikipedia) continue;

    pois.push(poi);
  }

  return pois.slice(0, 40);
}

// ===== Source 3: Wikidata around via SPARQL =====
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

function qidFromEntityUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/entity\/(Q\d+)$/);
  return m ? m[1] : null;
}

async function fetchNearbyPoisFromWikidata(lat, lng, radiusMeters = 800, language = "en") {
  const radiusKm = Math.max(0.2, Math.min(5, radiusMeters / 1000));

  const query = `
SELECT ?item ?itemLabel ?itemDescription ?lat ?lon WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  BIND(geof:latitude(?location) AS ?lat)
  BIND(geof:longitude(?location) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${language},he,en". }
}
LIMIT 35
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  const resp = await abortableFetch(
    url,
    {
      method: "GET",
      headers: {
        "Accept": "application/sparql-results+json",
        "User-Agent": "btw-ontheroad-server/1.0 (contact: none)",
      },
    },
    12000
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Wikidata around error:", resp.status, text.slice(0, 400));
    throw new Error("Wikidata SPARQL error");
  }

  const data = await resp.json();
  const bindings = data?.results?.bindings || [];

  const pois = [];
  for (const b of bindings) {
    const qid = qidFromEntityUrl(b.item?.value);
    if (!qid) continue;

    const name = b.itemLabel?.value || "";
    const desc = b.itemDescription?.value || "";
    const latV = Number(b.lat?.value);
    const lngV = Number(b.lon?.value);

    if (!Number.isFinite(latV) || !Number.isFinite(lngV)) continue;
    if (!name) continue;

    pois.push({
      id: `wd:${qid}`,
      name,
      lat: latV,
      lng: lngV,
      types: [],
      rating: null,
      address: "",
      source: "wikidata",
      wikidataId: qid,
      description: desc,
    });
  }

  return pois;
}

// ===== Wikidata facts pack (stronger) =====
function toYearString(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  return String(x);
}

async function fetchWikidataFacts(qid, language = "en") {
  if (!qid) return { facts: [], sources: [], meta: {} };

  const cacheKey = `${qid}|${language}`;
  const cached = wikidataFactsMemory.get(cacheKey);
  if (cached) return cached;

  // Pull: instance, description, inception year, named after, architect, heritage designation, significant event
  const query = `
SELECT ?itemLabel ?itemDescription ?instanceLabel ?inceptionYear ?namedAfter ?namedAfterLabel ?architectLabel ?heritageLabel ?eventLabel WHERE {
  BIND(wd:${qid} AS ?item)
  OPTIONAL { ?item wdt:P31 ?instance . }
  OPTIONAL { ?item wdt:P571 ?inception . BIND(YEAR(?inception) AS ?inceptionYear) }
  OPTIONAL { ?item wdt:P138 ?namedAfter . }
  OPTIONAL { ?item wdt:P84 ?architect . }
  OPTIONAL { ?item wdt:P1435 ?heritage . }
  OPTIONAL { ?item wdt:P793 ?event . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${language},he,en". }
}
LIMIT 1
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  try {
    const resp = await abortableFetch(
      url,
      {
        method: "GET",
        headers: {
          "Accept": "application/sparql-results+json",
          "User-Agent": "btw-ontheroad-server/1.0 (contact: none)",
        },
      },
      12000
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Wikidata facts error:", resp.status, text.slice(0, 400));
      return { facts: [], sources: [], meta: {} };
    }

    const data = await resp.json();
    const b = data?.results?.bindings?.[0];
    if (!b) return { facts: [], sources: [], meta: {} };

    const desc = b.itemDescription?.value || "";
    const instance = b.instanceLabel?.value || "";
    const inceptionYear = b.inceptionYear?.value || "";
    const namedAfterLabel = b.namedAfterLabel?.value || "";
    const namedAfterQid = qidFromEntityUrl(b.namedAfter?.value) || "";
    const architect = b.architectLabel?.value || "";
    const heritage = b.heritageLabel?.value || "";
    const event = b.eventLabel?.value || "";

    const facts = [];
    const meta = {
      hasInstance: !!instance,
      hasDesc: !!desc,
      hasInception: !!inceptionYear,
      hasNamedAfter: !!namedAfterLabel,
      hasArchitect: !!architect,
      hasHeritage: !!heritage,
      hasEvent: !!event,
      namedAfterQid: namedAfterQid || null,
    };

    if (instance) facts.push(`Instance of: ${instance}.`);
    if (desc) facts.push(`Description: ${desc}.`);
    if (inceptionYear) facts.push(`Inception year: ${toYearString(inceptionYear)}.`);
    if (namedAfterLabel) facts.push(`Named after: ${namedAfterLabel}.`);
    if (architect) facts.push(`Architect: ${architect}.`);
    if (heritage) facts.push(`Heritage designation: ${heritage}.`);
    if (event) facts.push(`Significant event: ${event}.`);

    const sources = [
      { type: "wikidata", qid, url: `https://www.wikidata.org/wiki/${qid}` },
    ];

    const result = { facts: facts.slice(0, 8), sources, meta };
    wikidataFactsMemory.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("Wikidata facts fetch failed:", e);
    return { facts: [], sources: [], meta: {} };
  }
}

async function fetchPersonFacts(personQid, language = "en") {
  if (!personQid) return { facts: [], sources: [] };

  const cacheKey = `person:${personQid}|${language}`;
  const cached = wikidataFactsMemory.get(cacheKey);
  if (cached) return cached;

  // We intentionally pull "human" but safe details:
  // occupation, positions held, notable works, awards, education, and a short description if available.
  // We DO NOT pull explicit sexual content, and we don't invent anything beyond these facts.
  const query = `
SELECT ?personLabel
       (GROUP_CONCAT(DISTINCT ?occupationLabel; separator=" | ") AS ?occupations)
       (GROUP_CONCAT(DISTINCT ?positionLabel; separator=" | ") AS ?positions)
       (GROUP_CONCAT(DISTINCT ?workLabel; separator=" | ") AS ?works)
       (GROUP_CONCAT(DISTINCT ?awardLabel; separator=" | ") AS ?awards)
       (GROUP_CONCAT(DISTINCT ?eduLabel; separator=" | ") AS ?education)
       (GROUP_CONCAT(DISTINCT ?eventLabel; separator=" | ") AS ?events)
       (MIN(?birthYear) AS ?birthYearMin)
       (MIN(?deathYear) AS ?deathYearMin)
WHERE {

  BIND(wd:${personQid} AS ?person)

  OPTIONAL { ?person wdt:P106 ?occupation . }
  OPTIONAL { ?person wdt:P39 ?position . }
  OPTIONAL { ?person wdt:P800 ?work . }
  OPTIONAL { ?person wdt:P166 ?award . }
  OPTIONAL { ?person wdt:P69 ?edu . }
  OPTIONAL { ?person wdt:P793 ?event . }

  OPTIONAL { ?person wdt:P569 ?birth . BIND(YEAR(?birth) AS ?birthYear) }
  OPTIONAL { ?person wdt:P570 ?death . BIND(YEAR(?death) AS ?deathYear) }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "${language},he,en". }
}
GROUP BY ?personLabel
LIMIT 1
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  try {
    const resp = await abortableFetch(
      url,
      {
        method: "GET",
        headers: {
          "Accept": "application/sparql-results+json",
          "User-Agent": "btw-ontheroad-server/1.0 (contact: none)",
        },
      },
      12000
    );

    if (!resp.ok) return { facts: [], sources: [] };

    const data = await resp.json();
    const b = data?.results?.bindings?.[0];
    if (!b) return { facts: [], sources: [] };

    const personLabel = b.personLabel?.value || "";
    const occupations = (b.occupations?.value || "").trim();
    const positions = (b.positions?.value || "").trim();
    const works = (b.works?.value || "").trim();
    const awards = (b.awards?.value || "").trim();
    const education = (b.education?.value || "").trim();
    const events = (b.events?.value || "").trim();
    const birthYear = b.birthYearMin?.value ? String(b.birthYearMin.value) : "";
    const deathYear = b.deathYearMin?.value ? String(b.deathYearMin.value) : "";

    const facts = [];
    if (personLabel) facts.push(`Person: ${personLabel}.`);
    if (occupations) facts.push(`Occupation(s): ${occupations}.`);
    if (positions) facts.push(`Position(s) held: ${positions}.`);
    if (works) facts.push(`Known for / notable work(s): ${works}.`);
    if (awards) facts.push(`Award(s): ${awards}.`);
    if (education) facts.push(`Education: ${education}.`);
    if (events) facts.push(`Significant event(s): ${events}.`);
    if (birthYear && deathYear) facts.push(`Lifespan: ${birthYear}-${deathYear}.`);
    else if (birthYear) facts.push(`Birth year: ${birthYear}.`);

    const sources = [
      { type: "wikidata", qid: personQid, url: `https://www.wikidata.org/wiki/${personQid}` },
    ];

    const result = { facts: facts.slice(0, 8), sources };
    wikidataFactsMemory.set(cacheKey, result);
    return result;
  } catch {
    return { facts: [], sources: [] };
  }
}

// ===== Unified POI retrieval + cache =====
async function getNearbyPois(lat, lng, radiusMeters = 800, mode = "interesting", language = "en") {
  const key = makeCacheKey(lat, lng, radiusMeters, mode, language);

  const mem = placesCacheMemory.get(key);
  if (mem) return mem;

  if (pool) {
    try {
      const { rows } = await pool.query(
        "SELECT places_json FROM places_cache WHERE cache_key = $1",
        [key]
      );
      if (rows.length > 0) {
        const pois = rows[0].places_json;
        placesCacheMemory.set(key, pois);
        return pois;
      }
    } catch (err) {
      console.error("DB error in getNearbyPois (select):", err);
    }
  }

  let pois = [];

  if (mode === "interesting") {
    const [osmRes, wdRes] = await Promise.allSettled([
      fetchNearbyPoisFromOSM(lat, lng, radiusMeters),
      fetchNearbyPoisFromWikidata(lat, lng, radiusMeters, language),
    ]);

    if (osmRes.status === "fulfilled") pois = pois.concat(osmRes.value);
    if (wdRes.status === "fulfilled") pois = pois.concat(wdRes.value);

    if (pois.length === 0) {
      try {
        pois = await fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters);
      } catch {
        // ignore
      }
    }
  } else {
    pois = await fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters);
  }

  // de-dupe by name+coord (light)
  const seen = new Set();
  const deduped = [];
  for (const p of pois) {
    const nameKey = (p.name || "").trim().toLowerCase();
    const latKey = typeof p.lat === "number" ? p.lat.toFixed(4) : "x";
    const lngKey = typeof p.lng === "number" ? p.lng.toFixed(4) : "y";
    const k = `${nameKey}|${latKey}|${lngKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(p);
  }

  placesCacheMemory.set(key, deduped);

  if (pool) {
    try {
      await pool.query(
        `
        INSERT INTO places_cache (cache_key, places_json, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (cache_key)
        DO UPDATE SET places_json = EXCLUDED.places_json, updated_at = now()
        `,
        [key, JSON.stringify(deduped)]
      );
    } catch (err) {
      console.error("DB error in getNearbyPois (upsert):", err);
    }
  }

  return deduped;
}

// ===== Picking logic: prefer "fact density" over raw distance =====
function computeFactScore(distanceM, factsMeta, factsCount) {
  const d = Number.isFinite(distanceM) ? distanceM : 999999;

  // Base: closer is better
  let score = d;

  // Strong preference for items with concrete anchors
  if (factsMeta?.hasNamedAfter) score -= 650;
  if (factsMeta?.hasInception) score -= 350;
  if (factsMeta?.hasEvent) score -= 650;
  if (factsMeta?.hasHeritage) score -= 450;
  if (factsMeta?.hasArchitect) score -= 250;

  // More facts => better
  score -= Math.min(6, Math.max(0, factsCount)) * 120;

  return score;
}

function countHardAnchors(factsMeta) {
  let n = 0;
  if (factsMeta?.hasNamedAfter) n += 1;
  if (factsMeta?.hasInception) n += 1;
  if (factsMeta?.hasEvent) n += 1;
  if (factsMeta?.hasHeritage) n += 1;
  return n;
}

async function pickBestPoiForUser(pois, lat, lng, userKey, language) {
  if (!pois || pois.length === 0) return null;

  const heardSet = await getHeardSetForUser(userKey);
  const lang = language === "he" ? "he" : "en";

  // Start with nearby + unseen candidates
  const raw = [];
  for (const p of pois) {
    if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;

    const d = distanceMeters(lat, lng, p.lat, p.lng);
    if (d > 2000) continue;

    if (heardSet.has(p.id)) continue;

    const qid =
      p.wikidataId ||
      (typeof p.id === "string" && p.id.startsWith("wd:")
        ? p.id.replace("wd:", "")
        : null);

    raw.push({ p, d, qid });
  }

  // Sort by distance first, then we enrich facts for top ones
  raw.sort((a, b) => a.d - b.d);

  const enriched = [];
  for (const c of raw.slice(0, 16)) {
    const qid = c.qid;
    let facts = [];
    let sources = [];
    let meta = {};

    if (qid) {
      const r = await fetchWikidataFacts(qid, lang);
      facts = r.facts || [];
      sources = r.sources || [];
      meta = r.meta || {};

      // If we have "named after", pull basic person facts too
      if (meta.namedAfterQid) {
        const pr = await fetchPersonFacts(meta.namedAfterQid, lang);
        if (Array.isArray(pr.facts) && pr.facts.length > 0) {
          facts = facts.concat(pr.facts);
          sources = sources.concat(pr.sources || []);
        }
      }
    } else if (typeof c.p.description === "string" && c.p.description.trim().length > 0) {
      facts = [`Description: ${c.p.description.trim()}.`];
      sources = [];
      meta = { hasDesc: true };
    }

    const hardAnchors = countHardAnchors(meta);
    const factsCount = facts.length;

    // Quality gate: at least 4 facts AND at least 2 hard anchors
    const ok = factsCount >= 4 && hardAnchors >= 2;

    if (!ok) continue;

    const score = computeFactScore(c.d, meta, factsCount);

    enriched.push({
      p: c.p,
      d: c.d,
      qid,
      facts: facts.slice(0, 9),
      sources,
      meta,
      score,
    });
  }

  if (enriched.length === 0) return null;

  enriched.sort((a, b) => a.score - b.score);
  return enriched[0];
}

// ===== System message: facts only, no hype, no opinions =====
function getSystemMessage(language) {
  if (language === "en") {
    return `
You are a factual narrator for a driving app.

Truth rules:
- Use ONLY the facts provided under FACTS.
- If a detail is not in FACTS, do not state it as fact.
- No hype, no opinions, no superlatives. Avoid adjectives like "beautiful", "amazing", "famous", "vibrant".
- Each sentence must contain at least one concrete fact (a name, year, number, title, designation, or the distance).
- Avoid graphic violence or sexual content. Keep it safe for teens.

Output rules:
- If FACTS include a human-person detail (occupation, award, notable work, position), the last sentence MUST be a light punchline based on that fact (still factual).
- Exactly one paragraph.
- 60 to 120 words.
- No greeting.
- Use commas and occasional ellipses to help natural speech.
- Start immediately with the strongest fact.
`.trim();
  }

  if (language === "fr") {
    return `
Tu es un narrateur factuel pour une application de conduite.

Règles de vérité:
- Utilise UNIQUEMENT les faits sous FACTS.
- Si ce n'est pas dans FACTS, ne l'affirme pas.
- Zéro hype, zéro opinion, pas de superlatifs. Évite "magnifique", "incroyable", "célèbre", etc.
- Chaque phrase doit contenir au moins un fait concret (nom, année, nombre, titre, désignation, ou la distance).
- Évite la violence graphique et le contenu sexuel. Reste safe pour des ados.

Règles de sortie:
- Si FACTS incluent un détail humain sur une personne (métier, prix, œuvre, poste), la dernière phrase doit être une petite chute basée sur ce fait (tout en restant factuelle).
- Un seul paragraphe.
- 60 à 120 mots.
- Pas de salutation.
- Utilise des virgules et parfois des points de suspension (...) pour aider la voix.
- Commence directement par le fait le plus fort.
`.trim();
  }

  return `
אתה קריין עובדתי לאפליקציית נהיגה.

חוקי אמת:
- אתה משתמש רק בעובדות שניתנו לך תחת FACTS.
- אם פרט לא נמצא ב-FACTS אסור לך להציג אותו כעובדה.
- אפס סופרלטיבים, אפס דעות, אפס "מדהים/יפה/מפורסם". לא להשתמש בתיאורי רושם.
- כל משפט חייב לכלול לפחות עובדה קונקרטית אחת (שם, שנה, מספר, תפקיד, סטטוס, או המרחק).
- לא להכניס אלימות גרפית או תוכן מיני. זה חייב להיות בטוח לבני נוער.

חוקי פלט:
- אם ב-FACTS יש פרט אנושי על אדם (מקצוע, פרס, יצירה, תפקיד), המשפט האחרון חייב להיות פאנץ' קטן שמבוסס על העובדה הזאת, ועדיין עובדתי.
- פסקה אחת בלבד.
- 60 עד 120 מילים.
- בלי ברכות פתיחה.
- להשתמש בפסיקים ולעיתים בשלוש נקודות (...) כדי לעזור לקריינות אנושית.
- להתחיל ישר בעובדה הכי חזקה.
`.trim();
}

// ===== Debug: /places =====
app.get("/places", async (req, res) => {
  try {
    const { lat, lng, radius, mode, language } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: "lat and lng query params are required" });
    }

    const radiusMeters = radius ? Number(radius) : 800;
    const m = typeof mode === "string" ? mode : "interesting";
    const lang = typeof language === "string" ? language : "en";

    const pois = await getNearbyPois(Number(lat), Number(lng), radiusMeters, m, lang);
    res.json({ pois });
  } catch (err) {
    console.error("Error in /places:", err);
    res.status(500).json({ error: "failed_to_fetch_places" });
  }
});

// ===== Main API: /api/story-both =====
app.post("/api/story-both", async (req, res) => {
  try {
    const { prompt, lat, lng } = req.body;
    let { language } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing 'prompt' in request body (string required)" });
    }

    if (!language || typeof language !== "string") language = "he";
    language = language.toLowerCase();
    if (!["he", "en", "fr"].includes(language)) language = "he";

    const userKey = getUserKeyFromRequest(req);

    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.json({ shouldSpeak: false, reason: "location_missing", language });
    }

    // Expanding radii
    const radii = [400, 800, 1500, 2200];
    let best = null;

    for (const r of radii) {
      const pois = await getNearbyPois(lat, lng, r, "interesting", language === "he" ? "he" : "en");
      best = await pickBestPoiForUser(pois, lat, lng, userKey, language);
      if (best) break;
    }

    if (!best || !best.p) {
      return res.json({ shouldSpeak: false, reason: "no_strong_poi", language });
    }

    const poi = best.p;
    const distExact = best.d;
    const distApprox = approxDistanceMeters(distExact, 50); // user chose 50m rounding
    const distText = distApprox != null ? `${distApprox}` : `${Math.round(distExact)}`;

    // Facts pack for model (facts-only)
    const facts = Array.isArray(best.facts) ? best.facts : [];
    const factsLines = facts.slice(0, 9).map((f, i) => `FACT ${i + 1}: ${f}`);

    // Add distance as a fact (rounded)
    factsLines.unshift(`FACT 0: Distance from the driver: about ${distText} meters.`);

    const poiLine = `Point of interest: "${poi.name}".`;

    const userMessage = `
${poiLine}
FACTS:
${factsLines.join("\n")}
User request: ${prompt}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: getSystemMessage(language) },
        { role: "user", content: userMessage },
      ],
      temperature: 0.35,
    });

    const storyText = completion.choices[0]?.message?.content?.trim();
    if (!storyText) throw new Error("No story generated by OpenAI");
    if (storyText === "NO_STORY") {
      return res.json({ shouldSpeak: false, reason: "model_no_story", language });
    }

    const { audioBase64, voiceId, voiceIndex, voiceKey } = await ttsWithOpenAI(storyText, language);

    await markPlaceHeardForUser(userKey, poi.id);

    res.json({
      shouldSpeak: true,
      text: storyText,
      audioBase64,
      voiceId,
      voiceIndex,
      voiceKey,
      language,
      poiId: poi.id,
      poiName: poi.name,
      poiSource: poi.source,
      distanceMetersApprox: distApprox,
      sources: Array.isArray(best.sources) ? best.sources : [],
    });
  } catch (err) {
    console.error("Error in /api/story-both:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    build: "btw-facts-only-round50-person-events-words120-tts-v1",
  });
});

initDb().catch((err) => {
  console.error("DB init failed:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
