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

// ===== BTW story shaping =====
const BTW_MIN_WORDS = 110;
const BTW_MAX_WORDS = 190;

function languageLabel(code) {
  if (code === "he") return "עברית";
  if (code === "fr") return "Français";
  return "English";
}

function buildBtwPrompt({ languageCode, poiName, distanceText, factsText }) {
  const lang = languageCode || "he";
  const placeName = poiName || (lang === "he" ? "מקום לא ידוע" : "Unknown place");

  if (lang === "en") {
    return `
You write BTW driving stories. Create one short, interesting story about a nearby place.

Hard rules:
1) Use ONLY the facts under FACTS. No guessing. No extra knowledge.
2) No filler like "it changed over time", "it preserves history", "interesting fact:", "a reminder that...".
3) No superlatives (amazing, incredible, crazy) and no dramatic hype.
4) Safe for teens. If FACTS mention conflict or violence, refer to it briefly without graphic details.
5) One paragraph only. No titles, no bullet points.
6) Length: ${BTW_MIN_WORDS}-${BTW_MAX_WORDS} words.
7) If FACTS are insufficient to write a meaningful story, output exactly: NO_STORY

Structure:
- 1-2 sentences to locate the driver: place name + distance.
- 3-6 short beats, each with a concrete fact (year, event, name).
- 1 closing sentence that brings it back to the road, non-poetic.

Place: ${placeName}
Distance: ${distanceText || "unknown"}

FACTS:
${factsText || ""}

Return only the final story text.
`.trim();
  }

  if (lang === "fr") {
    return `
Tu écris des histoires BTW pour la conduite. Crée une histoire courte et intéressante sur un lieu proche.

Règles strictes:
1) Utilise UNIQUEMENT les faits sous FACTS. Pas de suppositions, pas de connaissance externe.
2) Pas de remplissage du type "ça a changé avec le temps", "ça préserve l'histoire", "fait intéressant:", "un rappel que...".
3) Pas de superlatifs et pas de dramatisation.
4) Safe pour des ados. Si FACTS mentionne un conflit ou une violence, reste bref et non-graphique.
5) Un seul paragraphe. Pas de titre, pas de listes.
6) Longueur: ${BTW_MIN_WORDS}-${BTW_MAX_WORDS} mots.
7) Si FACTS ne suffit pas pour une histoire utile, retourne exactement: NO_STORY

Structure:
- 1-2 phrases pour situer: nom du lieu + distance.
- 3-6 "beats" courts, chacun avec un fait concret (année, événement, nom).
- 1 phrase de clôture qui revient à la route, sans poésie.

Lieu: ${placeName}
Distance: ${distanceText || "inconnue"}

FACTS:
${factsText || ""}

Retourne seulement le texte final.
`.trim();
  }

  // he
  return `
אתה כותב סיפורי BTW לנהיגה. תיצור סיפור קצר ומעניין על מקום קרוב.

חוקים קשוחים:
1) להשתמש רק בעובדות תחת FACTS. בלי לנחש, בלי להשלים ידע, בלי להמציא.
2) בלי משפטי אוויר כמו "עבר שינויים", "משמר היסטוריה", "עובדה מעניינת:", "תזכורת ש...".
3) בלי סופרלטיבים ובלי דרמה.
4) בטוח לבני נוער. אם FACTS כולל סכסוך או אלימות, להזכיר בקצרה בלי תיאור גרפי.
5) פסקה אחת בלבד. בלי כותרת, בלי רשימות.
6) אורך: ${BTW_MIN_WORDS}-${BTW_MAX_WORDS} מילים.
7) אם אין מספיק עובדות כדי לבנות סיפור משמעותי, תחזיר בדיוק: NO_STORY

מבנה:
- 1-2 משפטים שממקמים: שם המקום + מרחק.
- 3-6 "ביטים" קצרים, כל אחד עם עובדה קונקרטית (שנה, אירוע, שם).
- משפט סיום אחד שמחזיר לכביש, ענייני ולא מליצי.

מקום: ${placeName}
מרחק: ${distanceText || "לא ידוע"}

FACTS:
${factsText || ""}

החזר רק את הסיפור הסופי.
`.trim();
}

function normalizeFactLine(s) {
  if (typeof s !== "string") return "";
  const t = s.trim();
  if (!t) return "";
  return t.replace(/\s+/g, " ");
}

function buildFactsTextForModel({ language, poiName, distanceMetersApprox, facts }) {
  const lines = [];
  const name = poiName || "";
  const dist = Number.isFinite(distanceMetersApprox) ? distanceMetersApprox : null;

  if (language === "he") {
    if (name) lines.push(`שם המקום: ${name}.`);
    if (dist != null) lines.push(`מרחק מהנהג: בערך ${dist} מטר.`);
  } else if (language === "fr") {
    if (name) lines.push(`Nom du lieu: ${name}.`);
    if (dist != null) lines.push(`Distance du conducteur: environ ${dist} mètres.`);
  } else {
    if (name) lines.push(`Place name: ${name}.`);
    if (dist != null) lines.push(`Distance from the driver: about ${dist} meters.`);
  }

  const seen = new Set();
  for (const f of Array.isArray(facts) ? facts : []) {
    const x = normalizeFactLine(f);
    if (!x) continue;
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(x);
    if (lines.length >= 14) break;
  }

  return lines.join("\n");
}

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

    if (instance) facts.push(`Instance: ${instance}.`);
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

// ===== Wikipedia summary fallback (from OSM wikipedia tag OR Wikidata sitelinks) =====
function parseWikipediaTag(wikipediaTag) {
  // Returns {lang, title} or null
  if (typeof wikipediaTag !== "string") return null;
  const trimmed = wikipediaTag.trim();
  if (!trimmed) return null;

  // formats: "he:כותרת" or "en:Title_with_underscores"
  const parts = trimmed.split(":");
  if (parts.length >= 2) {
    const lang = parts[0].trim().toLowerCase() || "en";
    const title = parts.slice(1).join(":").trim().replaceAll(" ", "_");
    if (!title) return null;
    return { lang, title };
  }

  // Sometimes it's just a title, assume English
  return { lang: "en", title: trimmed.replaceAll(" ", "_") };
}

async function fetchWikipediaSummaryByLangTitle(lang, title) {
  if (!lang || !title) return { facts: [], sources: [] };

  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

  try {
    const resp = await abortableFetch(
      url,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "btw-ontheroad-server/1.0 (contact: none)",
        },
      },
      9000
    );

    if (!resp.ok) return { facts: [], sources: [] };

    const data = await resp.json();

    const extract = typeof data.extract === "string" ? data.extract.trim() : "";
    if (!extract) return { facts: [], sources: [] };

    // Keep first 2 sentences only
    const parts = extract.split(/(?<=[.!?])\s+/).filter(Boolean);
    const short = parts.slice(0, 2).join(" ").trim();
    if (!short) return { facts: [], sources: [] };

    const titleHuman =
      (typeof data.title === "string" && data.title.trim())
        ? data.title.trim()
        : title.replaceAll("_", " ");

    const pageUrl =
      (typeof data.content_urls?.desktop?.page === "string" && data.content_urls.desktop.page)
        ? data.content_urls.desktop.page
        : `https://${lang}.wikipedia.org/wiki/${title}`;

    const facts = [
      `Wikipedia page title: ${titleHuman}.`,
      `Wikipedia summary: ${short}`,
    ];

    const sources = [{ type: "wikipedia", lang, title: titleHuman, url: pageUrl }];

    return { facts: facts.slice(0, 3), sources };
  } catch {
    return { facts: [], sources: [] };
  }
}

async function fetchWikipediaSummaryFacts(wikipediaTag, language = "en") {
  const parsed = parseWikipediaTag(wikipediaTag);
  if (!parsed) return { facts: [], sources: [] };

  const langFromTag = parsed.lang || "";
  const fallbackLang = language === "he" ? "he" : (language === "fr" ? "fr" : "en");
  const lang = langFromTag || fallbackLang;
  const title = parsed.title;

  return fetchWikipediaSummaryByLangTitle(lang, title);
}

async function fetchWikipediaTitleFromWikidata(qid, preferredLang = "en") {
  if (!qid) return null;

  const cacheKey = `wd_sitelink:${qid}|${preferredLang}`;
  const cached = wikidataFactsMemory.get(cacheKey);
  if (cached) return cached;

  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;

  try {
    const resp = await abortableFetch(
      url,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "btw-ontheroad-server/1.0 (contact: none)",
        },
      },
      9000
    );

    if (!resp.ok) return null;

    const data = await resp.json();
    const entity = data?.entities?.[qid];
    const sitelinks = entity?.sitelinks || {};

    const pref = preferredLang === "he" ? "hewiki" : (preferredLang === "fr" ? "frwiki" : "enwiki");
    const fallbacks = [pref, "hewiki", "enwiki", "frwiki"];

    for (const key of fallbacks) {
      const title = sitelinks?.[key]?.title;
      if (typeof title === "string" && title.trim()) {
        const result = { lang: key === "hewiki" ? "he" : (key === "frwiki" ? "fr" : "en"), title };
        wikidataFactsMemory.set(cacheKey, result);
        return result;
      }
    }

    return null;
  } catch {
    return null;
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
  const lang = language === "he" ? "he" : (language === "fr" ? "fr" : "en");

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

    // Quality gate:
    // - at least 4 facts and at least 1 hard anchor, OR
    // - at least 6 facts even without anchors.
    let ok = (factsCount >= 4 && hardAnchors >= 1) || (factsCount >= 6);

    // If weak, try Wikipedia via OSM wikipedia tag
    if (!ok) {
      const wikiTag = typeof c.p.wikipedia === "string" ? c.p.wikipedia : null;
      if (wikiTag) {
        const wr = await fetchWikipediaSummaryFacts(wikiTag, lang);
        if (Array.isArray(wr.facts) && wr.facts.length > 0) {
          facts = facts.concat(wr.facts);
          sources = sources.concat(wr.sources || []);
        }
      }
      const factsCount2 = facts.length;
      ok = (factsCount2 >= 3 && hardAnchors >= 1) || (factsCount2 >= 5);
    }

    // Still weak: try Wikidata sitelinks -> Wikipedia summary
    if (!ok && qid) {
      const sl = await fetchWikipediaTitleFromWikidata(qid, lang);
      if (sl && sl.title) {
        const wr2 = await fetchWikipediaSummaryByLangTitle(sl.lang, sl.title.replaceAll(" ", "_"));
        if (Array.isArray(wr2.facts) && wr2.facts.length > 0) {
          facts = facts.concat(wr2.facts);
          sources = sources.concat(wr2.sources || []);
        }
      }
      const factsCount3 = facts.length;
      ok = (factsCount3 >= 3 && hardAnchors >= 1) || (factsCount3 >= 5);
    }

    if (!ok) continue;

    const score = computeFactScore(c.d, meta, facts.length);

    enriched.push({
      p: c.p,
      d: c.d,
      qid,
      facts: facts.slice(0, 12),
      sources,
      meta,
      score,
    });
  }

  if (enriched.length === 0) return null;

  enriched.sort((a, b) => a.score - b.score);
  return enriched[0];
}

// ===== System message: keep it controlled, story prompt carries most logic =====
function getSystemMessage(language) {
  const lang = language === "he" ? "he" : (language === "fr" ? "fr" : "en");

  if (lang === "en") {
    return `
You are a careful driving-story writer.

Core rules:
- Use ONLY the provided FACTS. If it is not in FACTS, do not state it.
- No filler, no hype, no superlatives.
- One paragraph, no headings, no lists.
- Safe for teens. If facts mention violence, keep it brief and non-graphic.
- If you cannot write a meaningful story from FACTS, output exactly: NO_STORY
`.trim();
  }

  if (lang === "fr") {
    return `
Tu es un rédacteur prudent d'histoires pour la conduite.

Règles:
- Utilise UNIQUEMENT les FACTS fournis. Sinon, ne l'affirme pas.
- Pas de remplissage, pas de hype, pas de superlatifs.
- Un seul paragraphe, pas de titre, pas de listes.
- Safe pour des ados. Si FACTS mentionne une violence, reste bref et non-graphique.
- Si tu ne peux pas écrire une histoire utile à partir de FACTS, retourne exactement: NO_STORY
`.trim();
  }

  return `
אתה כותב סיפורי נהיגה בזהירות.

חוקים:
- להשתמש רק ב-FACTS. אם פרט לא מופיע שם, אסור לקבוע אותו.
- בלי מילוי, בלי דרמה, בלי סופרלטיבים.
- פסקה אחת, בלי כותרות ובלי רשימות.
- בטוח לבני נוער. אם FACTS כולל אלימות, לציין בקצרה בלי תיאור גרפי.
- אם אי אפשר לכתוב סיפור שימושי מתוך FACTS, תחזיר בדיוק: NO_STORY
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
      const pois = await getNearbyPois(lat, lng, r, "interesting", language === "he" ? "he" : (language === "fr" ? "fr" : "en"));
      best = await pickBestPoiForUser(pois, lat, lng, userKey, language);
      if (best) break;
    }

    if (!best || !best.p) {
      return res.json({ shouldSpeak: false, reason: "no_strong_poi", language });
    }

    const poi = best.p;
    const distExact = best.d;
    const distApprox = approxDistanceMeters(distExact, 50);
    const distText = distApprox != null ? `${distApprox} מטר` : `${Math.round(distExact)} מטר`;

    // Facts for model
    const facts = Array.isArray(best.facts) ? best.facts : [];
    const factsText = buildFactsTextForModel({
      language,
      poiName: poi.name,
      distanceMetersApprox: distApprox,
      facts,
    });

    const btwPrompt = buildBtwPrompt({
      languageCode: language,
      poiName: poi.name,
      distanceText: language === "he" ? distText : (language === "fr" ? distText.replace("מטר", "mètres") : distText.replace(" מטר", " meters")),
      factsText,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: getSystemMessage(language) },
        { role: "user", content: btwPrompt },
      ],
      temperature: 0.4,
      max_tokens: 650,
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
    build: "btw-better-storyprompt-words190-wiki-sitelink-fallback-tts-v2",
  });
});

initDb().catch((err) => {
  console.error("DB init failed:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
