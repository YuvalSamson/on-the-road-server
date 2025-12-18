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

// =======================
// BTW "what you wanted"
// =======================
// - We allow more knowledge from Wikipedia (beyond just 1-2 summary sentences).
// - We still enforce: story must be based ONLY on facts we provide to the model.
// - We add a Wikipedia extraction pipeline that pulls page text (MediaWiki API),
//   extracts candidate sentences, then asks OpenAI to convert them into short atomic facts.
// - We then ask OpenAI to write a BTW story from these facts with strict anti-filler rules.
// - We validate output and do one repair pass if needed.

const BTW_MIN_WORDS = 180;
const BTW_MAX_WORDS = 340;

const BANNED_FILLER_HE = [
  "עובדה מעניינת",
  "משמר היסטוריה",
  "עבר שינויים",
  "שינויים דמוגרפיים",
  "שינויים תרבותיים",
  "תזכורת חיה",
  "היסטוריה לא יושבת במוזיאון",
  "שמור על הקצב",
  "שמור על הערנות",
  "כעת, כשאתה ממשיך בנסיעה",
  "תמשיך בנסיעה",
];

const BANNED_FILLER_EN = [
  "interesting fact",
  "it has changed over time",
  "a reminder that",
  "history lives",
  "keep your eyes on the road",
  "stay alert",
  "as you continue driving",
];

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normalizeSpaces(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim();
}

function countWordsHeuristic(text) {
  if (typeof text !== "string") return 0;
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function containsAny(str, needles) {
  if (!str) return false;
  const s = String(str);
  for (const n of needles) {
    if (n && s.includes(n)) return true;
  }
  return false;
}

function approxHasConcreteAnchor(text) {
  // rough signal: contains a 4-digit year or a date-like pattern
  if (typeof text !== "string") return false;
  const t = text;
  if (/\b(1[5-9]\d{2}|20\d{2})\b/.test(t)) return true;
  if (/\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(t))
    return true;
  if (/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(t)) return true;
  return false;
}

// =======================
// ===== TTS =====
// =======================
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
    "Add natural breathing and micro-pauses: short breaths between clauses, and slightly longer pauses after full stops. " +
    "Use a warm smile in your tone (subtle), and keep energy varied so it does not sound monotone. " +
    "Before a punchline or surprising fact: slow down a bit, pause briefly, then deliver it with a light playful lift. " +
    "Do not shout. Keep it clear and safe for driving. " +
    "Avoid dramatic acting; aim for natural, conversational storytelling.";

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

// =======================
// ===== DB + caches =====
// =======================
const placesCacheMemory = new Map(); // cache_key => pois[]
const userPlacesHistoryMemory = new Map(); // userKey => Set(placeId)
const wikidataFactsMemory = new Map(); // qid|lang => { facts, sources, meta } + also used for sitelinks cache
const wikipediaFactsMemory = new Map(); // wp_facts:lang:title => { facts, sources, meta }
const wikipediaExtractMemory = new Map(); // wp_extract:lang:title => { extract, titleHuman, url }

// =======================
// ===== Cache key =====
// =======================
function makeCacheKey(lat, lng, radiusMeters, mode = "interesting", language = "en") {
  const latKey = lat.toFixed(4);
  const lngKey = lng.toFixed(4);
  return `${mode}:${language}:${latKey},${lngKey},${radiusMeters}`;
}

// =======================
// ===== Distance =====
// =======================
function roundToNearest(n, step) {
  return Math.round(n / step) * step;
}

function approxDistanceMeters(distanceMeters, stepMeters = 50) {
  if (!Number.isFinite(distanceMeters)) return null;
  const d = Math.max(0, distanceMeters);
  const step = Math.max(10, stepMeters);
  return roundToNearest(d, step);
}

function distanceTextByLang(language, metersApprox) {
  const m = Number.isFinite(metersApprox) ? metersApprox : null;
  if (m == null) {
    if (language === "fr") return "distance inconnue";
    if (language === "en") return "unknown distance";
    return "מרחק לא ידוע";
  }
  if (language === "fr") return `environ ${m} mètres`;
  if (language === "en") return `about ${m} meters`;
  return `בערך ${m} מטר`;
}

// =======================
// ===== DB init =====
// =======================
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

// =======================
// ===== Geo helpers =====
// =======================
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
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(t));
}

// =======================
// ===== Source 1: Google Places (fallback) =====
// =======================
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
    wikipedia: null,
    osmTags: null,
    description: null,
  }));

  return places;
}

// =======================
// ===== Source 2: OpenStreetMap via Overpass =====
// =======================
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function overpassQuery(lat, lng, radiusMeters) {
  return `
[out:json][timeout:20];
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

  node(around:${radiusMeters},${lat},${lng})[place];
  way(around:${radiusMeters},${lat},${lng})[place];
  relation(around:${radiusMeters},${lat},${lng})[place];
);
out center tags 180;
`.trim();
}

function safeTag(tags, key) {
  if (!tags) return "";
  const v = tags[key];
  return typeof v === "string" ? v : "";
}

function nameFromWikipediaTag(wikipediaTag) {
  if (typeof wikipediaTag !== "string") return "";
  const parts = wikipediaTag.split(":");
  if (parts.length >= 2) return parts.slice(1).join(":").replaceAll("_", " ").trim();
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
    safeTag(tags, "place") ||
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
    description: null,
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
        "User-Agent": "btw-ontheroad-server/2.0 (contact: none)",
      },
      body: q,
    },
    14000
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

  return pois.slice(0, 60);
}

// =======================
// ===== Source 3: Wikidata around via SPARQL =====
// =======================
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

function qidFromEntityUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/entity\/(Q\d+)$/);
  return m ? m[1] : null;
}

async function fetchNearbyPoisFromWikidata(lat, lng, radiusMeters = 800, language = "en") {
  const radiusKm = Math.max(0.2, Math.min(6, radiusMeters / 1000));

  const query = `
SELECT ?item ?itemLabel ?itemDescription ?lat ?lon WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  BIND(geof:latitude(?location) AS ?lat)
  BIND(geof:longitude(?location) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${language},he,en,fr". }
}
LIMIT 40
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  const resp = await abortableFetch(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": "btw-ontheroad-server/2.0 (contact: none)",
      },
    },
    13000
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
      wikipedia: null,
      osmTags: null,
      description: desc,
    });
  }

  return pois;
}

// =======================
// ===== Wikidata facts pack =====
// =======================
async function fetchWikidataFacts(qid, language = "en") {
  if (!qid) return { facts: [], sources: [], meta: {} };

  const cacheKey = `wd_facts:${qid}|${language}`;
  const cached = wikidataFactsMemory.get(cacheKey);
  if (cached) return cached;

  const query = `
SELECT ?itemDescription
       (GROUP_CONCAT(DISTINCT ?instanceLabel; separator=" | ") AS ?instances)
       (GROUP_CONCAT(DISTINCT ?eventLabel; separator=" | ") AS ?events)
       (MIN(?inceptionYear) AS ?inceptionYearMin)
       (GROUP_CONCAT(DISTINCT ?namedAfterLabel; separator=" | ") AS ?namedAfter)
       (GROUP_CONCAT(DISTINCT ?heritageLabel; separator=" | ") AS ?heritage)
WHERE {
  BIND(wd:${qid} AS ?item)

  OPTIONAL { ?item wdt:P31 ?instance . }
  OPTIONAL { ?item wdt:P793 ?event . }
  OPTIONAL { ?item wdt:P571 ?inception . BIND(YEAR(?inception) AS ?inceptionYear) }
  OPTIONAL { ?item wdt:P138 ?namedAfter . }
  OPTIONAL { ?item wdt:P1435 ?heritage . }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "${language},he,en,fr". }
  OPTIONAL { ?item schema:description ?itemDescription . FILTER(LANG(?itemDescription) = "${language}") }
}
GROUP BY ?itemDescription
LIMIT 1
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  try {
    const resp = await abortableFetch(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": "btw-ontheroad-server/2.0 (contact: none)",
        },
      },
      13000
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Wikidata facts error:", resp.status, text.slice(0, 300));
      return { facts: [], sources: [], meta: {} };
    }

    const data = await resp.json();
    const b = data?.results?.bindings?.[0];
    if (!b) return { facts: [], sources: [], meta: {} };

    const desc = b.itemDescription?.value || "";
    const instances = (b.instances?.value || "").trim();
    const events = (b.events?.value || "").trim();
    const inceptionYear = b.inceptionYearMin?.value ? String(b.inceptionYearMin.value) : "";
    const namedAfter = (b.namedAfter?.value || "").trim();
    const heritage = (b.heritage?.value || "").trim();

    const facts = [];
    const meta = {
      hasDesc: !!desc,
      hasInstances: !!instances,
      hasInception: !!inceptionYear,
      hasEvents: !!events,
      hasNamedAfter: !!namedAfter,
      hasHeritage: !!heritage,
    };

    if (desc) facts.push(`Description: ${desc}.`);
    if (instances) facts.push(`Type: ${instances}.`);
    if (inceptionYear) facts.push(`Inception year: ${inceptionYear}.`);
    if (namedAfter) facts.push(`Named after: ${namedAfter}.`);
    if (heritage) facts.push(`Heritage designation: ${heritage}.`);
    if (events) facts.push(`Notable event(s): ${events}.`);

    const sources = [{ type: "wikidata", qid, url: `https://www.wikidata.org/wiki/${qid}` }];

    const result = { facts: facts.slice(0, 8), sources, meta };
    wikidataFactsMemory.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("Wikidata facts fetch failed:", e);
    return { facts: [], sources: [], meta: {} };
  }
}

// =======================
// ===== Wikidata -> Wikipedia sitelink title =====
// =======================
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
          Accept: "application/json",
          "User-Agent": "btw-ontheroad-server/2.0 (contact: none)",
        },
      },
      9000
    );

    if (!resp.ok) return null;

    const data = await resp.json();
    const entity = data?.entities?.[qid];
    const sitelinks = entity?.sitelinks || {};

    const pref = preferredLang === "he" ? "hewiki" : preferredLang === "fr" ? "frwiki" : "enwiki";
    const fallbacks = [pref, "hewiki", "enwiki", "frwiki"];

    for (const key of fallbacks) {
      const title = sitelinks?.[key]?.title;
      if (typeof title === "string" && title.trim()) {
        const result = {
          lang: key === "hewiki" ? "he" : key === "frwiki" ? "fr" : "en",
          title: title.trim(),
        };
        wikidataFactsMemory.set(cacheKey, result);
        return result;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// =======================
// ===== Wikipedia (full extract) =====
// =======================
// We use MediaWiki API to fetch plain text extract.
// Then we pick candidate sentences and ask OpenAI to convert them to atomic facts.

function parseWikipediaTag(wikipediaTag) {
  // "he:כותרת" or "en:Title_with_underscores"
  if (typeof wikipediaTag !== "string") return null;
  const trimmed = wikipediaTag.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":");
  if (parts.length >= 2) {
    const lang = parts[0].trim().toLowerCase() || "en";
    const title = parts.slice(1).join(":").trim();
    if (!title) return null;
    return { lang, title };
  }

  return { lang: "en", title: trimmed };
}

function wikiApiUrl(lang, params) {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const usp = new URLSearchParams(params);
  return `${base}?${usp.toString()}`;
}

async function fetchWikipediaPlainExtract(lang, title) {
  const cacheKey = `wp_extract:${lang}|${title}`;
  const cached = wikipediaExtractMemory.get(cacheKey);
  if (cached) return cached;

  const url = wikiApiUrl(lang, {
    action: "query",
    format: "json",
    origin: "*",
    redirects: "1",
    prop: "extracts|info",
    explaintext: "1",
    exsectionformat: "plain",
    exlimit: "1",
    exintro: "0",
    titles: title,
    inprop: "url",
  });

  const resp = await abortableFetch(
    url,
    {
      method: "GET",
      headers: { "User-Agent": "btw-ontheroad-server/2.0 (contact: none)" },
    },
    12000
  );

  if (!resp.ok) return null;

  const data = await resp.json();
  const pages = data?.query?.pages || {};
  const pageId = Object.keys(pages)[0];
  const page = pages[pageId];
  if (!page) return null;

  const extract = typeof page.extract === "string" ? page.extract.trim() : "";
  const titleHuman = typeof page.title === "string" ? page.title.trim() : title;
  const fullurl = typeof page.fullurl === "string" ? page.fullurl : `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(titleHuman)}`;

  if (!extract) {
    const out = { extract: "", titleHuman, url: fullurl };
    wikipediaExtractMemory.set(cacheKey, out);
    return out;
  }

  const out = { extract, titleHuman, url: fullurl };
  wikipediaExtractMemory.set(cacheKey, out);
  return out;
}

function splitToSentences(text) {
  const t = normalizeSpaces(text);
  if (!t) return [];
  // decent split for he/en/fr
  return t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}

function pickWikipediaCandidateSentences(extract, lang) {
  // We want lines with years, dates, numbers, named events, courts, wars, etc.
  const sents = splitToSentences(extract);
  const out = [];
  const maxKeep = 28;

  const yearRe = /\b(1[5-9]\d{2}|20\d{2})\b/;
  const numberRe = /\b\d{2,}\b/;

  const heSignals = ["ב-", "בשנת", "במאה", "במלחמת", "התקרית", "בית המשפט", "נהרג", "נפצע", "שוחרר", "נכנסו", "התגלו", "ממצאים", "ארכאולוגיים", "מסגד"];
  const enSignals = ["in ", "in the", "war", "incident", "court", "killed", "wounded", "entered", "archaeolog", "discovered"];
  const frSignals = ["en ", "guerre", "incident", "tribunal", "tué", "blessé", "entré", "archéolog", "découvert"];

  const signals = lang === "he" ? heSignals : lang === "fr" ? frSignals : enSignals;

  for (const s of sents) {
    if (s.length < 25) continue;
    if (s.length > 260) continue;

    const hasYear = yearRe.test(s);
    const hasNum = numberRe.test(s);
    const hasSignal = signals.some((x) => s.includes(x));

    if (hasYear || (hasNum && hasSignal) || hasSignal) {
      out.push(s);
      if (out.length >= maxKeep) break;
    }
  }

  // fallback: if we got nothing, take first ~10 sentences
  if (out.length === 0) return sents.slice(0, 10);

  return out;
}

async function openaiExtractAtomicFactsFromWikipedia({ lang, titleHuman, pageUrl, candidateSentences }) {
  const cacheKey = `wp_facts:${lang}|${titleHuman}`;
  const cached = wikipediaFactsMemory.get(cacheKey);
  if (cached) return cached;

  const joined = candidateSentences.slice(0, 28).map((s, i) => `S${i + 1}: ${s}`).join("\n");

  const sys =
    lang === "he"
      ? `
אתה מחלץ עובדות מדויקות מתוך משפטים מוויקיפדיה.

חוקים:
- להשתמש רק במה שמופיע בקטעי המקור (S1..).
- אסור להוסיף ידע מבחוץ ואסור לנחש.
- להוציא "עובדות אטומיות": משפט אחד לכל עובדה, קצר, בלי סופרלטיבים ובלי ניסוחים מליציים.
- אם יש אלימות או סכסוך, לציין בקצרה ולא גרפי.
- להחזיר JSON בלבד במבנה: {"facts":[...]} עם 8 עד 14 עובדות.
- אין לשכפל אותה עובדה בניסוח אחר.
`.trim()
      : lang === "fr"
      ? `
Tu extrais des faits exacts à partir de phrases Wikipedia.

Règles:
- Utilise uniquement ce qui apparaît dans les phrases sources (S1..).
- Pas de connaissance externe, pas de suppositions.
- Produis des "faits atomiques": une phrase courte par fait, sans superlatifs ni style poétique.
- Si violence/conflit, reste bref et non-graphique.
- Réponds en JSON uniquement: {"facts":[...]} avec 8 à 14 faits.
- Pas de doublons.
`.trim()
      : `
You extract exact facts from Wikipedia sentences.

Rules:
- Use only what appears in the source sentences (S1..).
- No outside knowledge, no guessing.
- Output atomic facts: one short sentence per fact, no hype.
- If violence/conflict appears, mention briefly, non-graphic.
- Return JSON only: {"facts":[...]} with 8 to 14 facts.
- No duplicates.
`.trim();

  const user =
    lang === "he"
      ? `
כותרת: ${titleHuman}
מקור: ${pageUrl}

משפטי מקור:
${joined}
`.trim()
      : `
Title: ${titleHuman}
Source: ${pageUrl}

Source sentences:
${joined}
`.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    max_tokens: 650,
    response_format: { type: "json_object" },
  });

  let facts = [];
  try {
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const obj = JSON.parse(raw);
    facts = Array.isArray(obj.facts) ? obj.facts.map((x) => normalizeSpaces(String(x))) : [];
  } catch {
    facts = [];
  }

  // minimal cleaning + dedupe
  const seen = new Set();
  const cleaned = [];
  for (const f of facts) {
    if (!f) continue;
    const k = f.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    cleaned.push(f.endsWith(".") || f.endsWith("!") || f.endsWith("?") ? f : `${f}.`);
    if (cleaned.length >= 14) break;
  }

  const result = {
    facts: cleaned,
    sources: [{ type: "wikipedia", lang, title: titleHuman, url: pageUrl }],
    meta: { title: titleHuman, lang },
  };

  wikipediaFactsMemory.set(cacheKey, result);
  return result;
}

async function getWikipediaFactsForPoi({ poi, language }) {
  const lang = language === "he" ? "he" : language === "fr" ? "fr" : "en";

  // priority 1: OSM wikipedia tag
  let wp = null;
  if (typeof poi?.wikipedia === "string" && poi.wikipedia.trim()) {
    wp = parseWikipediaTag(poi.wikipedia);
  }

  // priority 2: Wikidata sitelink
  if (!wp && poi?.wikidataId) {
    const sl = await fetchWikipediaTitleFromWikidata(poi.wikidataId, lang);
    if (sl && sl.title) wp = { lang: sl.lang || lang, title: sl.title };
  }

  if (!wp || !wp.title) return { facts: [], sources: [] };

  const page = await fetchWikipediaPlainExtract(wp.lang, wp.title);
  if (!page || !page.extract) return { facts: [], sources: page?.url ? [{ type: "wikipedia", lang: wp.lang, title: page.titleHuman, url: page.url }] : [] };

  // limit extract size for processing
  const extract = page.extract.slice(0, 12000);
  const candidates = pickWikipediaCandidateSentences(extract, wp.lang);

  // if candidates are too weak, still try but it may return few facts
  const extracted = await openaiExtractAtomicFactsFromWikipedia({
    lang: wp.lang,
    titleHuman: page.titleHuman || wp.title,
    pageUrl: page.url,
    candidateSentences: candidates,
  });

  return extracted || { facts: [], sources: [] };
}

// =======================
// ===== Unified POI retrieval + cache =====
// =======================
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

  // de-dupe by name+coord
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

// =======================
// ===== Picking logic =====
// =======================
function scoreByDistance(distanceM) {
  const d = Number.isFinite(distanceM) ? distanceM : 999999;
  return d;
}

function scoreBoostForFacts(facts) {
  // more facts and more "anchor" facts => better
  const f = Array.isArray(facts) ? facts : [];
  const base = Math.min(20, f.length) * 80;

  let anchors = 0;
  for (const x of f) if (approxHasConcreteAnchor(x)) anchors += 1;

  return base + clamp(anchors, 0, 10) * 220;
}

function mergeFactsDedup(a, b, limit = 20) {
  const out = [];
  const seen = new Set();

  function pushOne(x) {
    const s = normalizeSpaces(String(x || ""));
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s.endsWith(".") || s.endsWith("!") || s.endsWith("?") ? s : `${s}.`);
  }

  for (const x of a || []) pushOne(x);
  for (const x of b || []) pushOne(x);

  return out.slice(0, limit);
}

function factsHaveStoryPotential(facts) {
  // We require at least 1-2 anchored facts for "BTW quality"
  const f = Array.isArray(facts) ? facts : [];
  let anchors = 0;
  for (const x of f) if (approxHasConcreteAnchor(x)) anchors += 1;
  return f.length >= 10 && anchors >= 2;
}

async function pickBestPoiForUser(pois, lat, lng, userKey, language) {
  if (!pois || pois.length === 0) return null;

  const heardSet = await getHeardSetForUser(userKey);

  // candidates within 2.2km and unseen
  const raw = [];
  for (const p of pois) {
    if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;

    const d = distanceMeters(lat, lng, p.lat, p.lng);
    if (d > 2200) continue;

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
  for (const c of raw.slice(0, 18)) {
    const poi = c.p;
    const qid = c.qid;

    let wdFacts = [];
    let wdSources = [];
    if (qid) {
      const wd = await fetchWikidataFacts(qid, language === "he" ? "he" : language === "fr" ? "fr" : "en");
      wdFacts = Array.isArray(wd.facts) ? wd.facts : [];
      wdSources = Array.isArray(wd.sources) ? wd.sources : [];
    } else if (typeof poi.description === "string" && poi.description.trim()) {
      wdFacts = [`Description: ${normalizeSpaces(poi.description)}.`];
    }

    const wp = await getWikipediaFactsForPoi({ poi, language });
    const wpFacts = Array.isArray(wp.facts) ? wp.facts : [];
    const wpSources = Array.isArray(wp.sources) ? wp.sources : [];

    const allFacts = mergeFactsDedup(wdFacts, wpFacts, 22);
    const sources = [...wdSources, ...wpSources];

    // story quality gate: if too generic, skip
    const ok = factsHaveStoryPotential(allFacts);
    if (!ok) continue;

    // scoring: distance minus boost
    const s = scoreByDistance(c.d) - scoreBoostForFacts(allFacts);

    enriched.push({
      p: poi,
      d: c.d,
      qid,
      facts: allFacts,
      sources,
      score: s,
    });
  }

  if (enriched.length === 0) return null;

  enriched.sort((a, b) => a.score - b.score);
  return enriched[0];
}

// =======================
// ===== Story prompt =====
// =======================
function buildFactsBlock({ language, poiName, distanceText, facts }) {
  const lines = [];

  if (language === "he") {
    if (poiName) lines.push(`שם המקום: ${poiName}.`);
    if (distanceText) lines.push(`מרחק מהנהג: ${distanceText}.`);
  } else if (language === "fr") {
    if (poiName) lines.push(`Nom du lieu: ${poiName}.`);
    if (distanceText) lines.push(`Distance du conducteur: ${distanceText}.`);
  } else {
    if (poiName) lines.push(`Place name: ${poiName}.`);
    if (distanceText) lines.push(`Distance from the driver: ${distanceText}.`);
  }

  const f = Array.isArray(facts) ? facts : [];
  for (let i = 0; i < Math.min(18, f.length); i += 1) {
    lines.push(`FACT ${i + 1}: ${normalizeSpaces(f[i])}`);
  }

  return lines.join("\n");
}

function getSystemMessage(language) {
  const lang = language === "he" ? "he" : language === "fr" ? "fr" : "en";

  if (lang === "he") {
    return `
אתה כותב סיפורי BTW לנהיגה.

חוקי אמת:
- משתמשים רק במה שמופיע תחת FACTS.
- אסור להוסיף ידע מבחוץ, אסור לנחש, אסור להמציא.

חוקי סגנון:
- בלי מילוי, בלי סופרלטיבים, בלי משפטי "נוף" או "היסטוריה חיה", בלי עצות נהיגה כלליות.
- אם FACTS כולל אלימות או סכסוך: להזכיר בקצרה וללא תיאור גרפי.
- פסקה אחת בלבד. בלי כותרת. בלי רשימות.
- כל משפט חייב לכלול לפחות עובדה קונקרטית (שנה, תאריך, מספר, שם, אירוע, מקום, גוף, מסלול).
- אם אין מספיק עובדות לבניית סיפור טוב: להחזיר בדיוק NO_STORY.
`.trim();
  }

  if (lang === "fr") {
    return `
Tu écris des histoires BTW pour la conduite.

Vérité:
- Utilise uniquement FACTS.
- Pas de connaissance externe, pas de suppositions.

Style:
- Pas de remplissage, pas de superlatifs, pas de conseils de conduite génériques.
- Si conflit/violence: bref, non-graphique.
- Un seul paragraphe. Pas de titre. Pas de listes.
- Chaque phrase doit contenir au moins un fait concret (année, date, nombre, nom, événement, lieu).
- Si FACTS ne suffit pas: retourne exactement NO_STORY.
`.trim();
  }

  return `
You write BTW driving stories.

Truth:
- Use only FACTS.
- No outside knowledge, no guessing.

Style:
- No filler, no superlatives, no generic driving advice.
- If conflict/violence: brief and non-graphic.
- One paragraph. No title. No lists.
- Every sentence must include at least one concrete fact (year, date, number, name, event, place).
- If FACTS are insufficient: output exactly NO_STORY.
`.trim();
}

function buildBtwUserPrompt(language) {
  if (language === "he") {
    return `
כתוב סיפור BTW אחד.

מבנה חובה:
- 1-2 משפטים ראשונים: שם המקום + המרחק (כמו ב-FACTS), וכניסה ישרה לעניין.
- 5-9 משפטים קצרים: כל משפט עם עובדה אחרת, עדיף עם שנים/תאריכים/אירועים/גופים/שמות.
- משפט סיום אחד: חייב להזכיר עובדה קונקרטית מתוך FACTS (לא עצת נהיגה כללית, לא קלישאה).

חוקים:
- פסקה אחת בלבד.
- אורך: ${BTW_MIN_WORDS}-${BTW_MAX_WORDS} מילים.
- אסור להשתמש בביטויים: "עובדה מעניינת", "עבר שינויים", "משמר היסטוריה", "תזכורת", "שמור על הערנות/קצב".
- אם FACTS לא נותן לפחות 2 עובדות עם עוגן זמן (שנה/תאריך) או אירוע ברור: החזר NO_STORY.
`.trim();
  }

  if (language === "fr") {
    return `
Écris une histoire BTW.

Structure:
- 1-2 premières phrases: nom du lieu + distance (comme dans FACTS), puis va droit au sujet.
- 5-9 phrases courtes: chaque phrase avec un fait différent, de préférence avec années/dates/événements/noms.
- 1 phrase finale: doit référencer un fait concret de FACTS (pas de conseil générique).

Règles:
- Un seul paragraphe.
- Longueur: ${BTW_MIN_WORDS}-${BTW_MAX_WORDS} mots.
- Si FACTS n'a pas au moins 2 faits ancrés (année/date) ou un événement clair: retourne NO_STORY.
`.trim();
  }

  return `
Write one BTW story.

Structure:
- First 1-2 sentences: place name + distance (as in FACTS), then jump straight in.
- Next 5-9 short sentences: each with a different concrete fact, preferably with years/dates/events/names.
- Final 1 sentence: must reference a concrete fact from FACTS (no generic driving advice).

Rules:
- One paragraph only.
- Length: ${BTW_MIN_WORDS}-${BTW_MAX_WORDS} words.
- If FACTS lacks at least 2 time-anchored facts (year/date) or a clear event: output NO_STORY.
`.trim();
}

function validateStory({ story, language }) {
  const w = countWordsHeuristic(story);
  if (w < BTW_MIN_WORDS || w > BTW_MAX_WORDS) return { ok: false, reason: "bad_length", words: w };

  if (language === "he") {
    if (containsAny(story, BANNED_FILLER_HE)) return { ok: false, reason: "banned_filler", words: w };
  } else {
    if (containsAny(story.toLowerCase(), BANNED_FILLER_EN)) return { ok: false, reason: "banned_filler", words: w };
  }

  // one-paragraph heuristic: no double newlines
  if (/\n\s*\n/.test(story)) return { ok: false, reason: "not_one_paragraph", words: w };

  return { ok: true, reason: "ok", words: w };
}

async function generateBtwStoryFromFacts({ language, factsBlock }) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: getSystemMessage(language) },
      { role: "user", content: `${buildBtwUserPrompt(language)}\n\nFACTS:\n${factsBlock}` },
    ],
    temperature: 0.45,
    max_tokens: 900,
  });

  return completion.choices[0]?.message?.content?.trim() || "";
}

async function repairStoryToComply({ language, factsBlock, badStory, failureReason }) {
  const sys = getSystemMessage(language);

  const user =
    language === "he"
      ? `
יש טיוטה שלא עומדת בכללים (${failureReason}). תקן אותה כך שתעמוד בכל החוקים.

חוקים:
- להשתמש רק ב-FACTS.
- פסקה אחת.
- אורך ${BTW_MIN_WORDS}-${BTW_MAX_WORDS} מילים.
- בלי מילוי וביטויי קלישאה, בלי עצות נהיגה כלליות.
- כל משפט עם עובדה קונקרטית.
- אם אי אפשר לתקן בלי להמציא: החזר NO_STORY.

FACTS:
${factsBlock}

טיוטה:
${badStory}
`.trim()
      : `
The draft violates rules (${failureReason}). Rewrite to comply.

Rules:
- Use only FACTS.
- One paragraph.
- Length ${BTW_MIN_WORDS}-${BTW_MAX_WORDS}.
- No filler, no generic driving advice.
- Every sentence has a concrete fact.
- If you cannot fix without inventing: output NO_STORY.

FACTS:
${factsBlock}

Draft:
${badStory}
`.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.25,
    max_tokens: 900,
  });

  return completion.choices[0]?.message?.content?.trim() || "";
}

// =======================
// ===== /places debug =====
// =======================
app.get("/places", async (req, res) => {
  try {
    const { lat, lng, radius, mode, language } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: "lat and lng query params are required" });
    }

    const radiusMeters = radius ? Number(radius) : 900;
    const m = typeof mode === "string" ? mode : "interesting";
    const lang = typeof language === "string" ? language : "en";

    const pois = await getNearbyPois(Number(lat), Number(lng), radiusMeters, m, lang);
    res.json({ pois });
  } catch (err) {
    console.error("Error in /places:", err);
    res.status(500).json({ error: "failed_to_fetch_places" });
  }
});

// =======================
// ===== Main API: /api/story-both =====
// =======================
app.post("/api/story-both", async (req, res) => {
  try {
    const { lat, lng } = req.body;
    let { language } = req.body;

    // prompt from client is ignored on purpose to keep BTW consistent
    // (we still accept the field for backward compatibility)

    if (!language || typeof language !== "string") language = "he";
    language = language.toLowerCase();
    if (!["he", "en", "fr"].includes(language)) language = "he";

    const userKey = getUserKeyFromRequest(req);

    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.json({ shouldSpeak: false, reason: "location_missing", language });
    }

    // Expanding radii
    const radii = [500, 900, 1500, 2400];
    let best = null;

    for (const r of radii) {
      const pois = await getNearbyPois(
        lat,
        lng,
        r,
        "interesting",
        language === "he" ? "he" : language === "fr" ? "fr" : "en"
      );
      best = await pickBestPoiForUser(pois, lat, lng, userKey, language);
      if (best) break;
    }

    if (!best || !best.p) {
      return res.json({ shouldSpeak: false, reason: "no_strong_poi", language });
    }

    const poi = best.p;
    const distExact = best.d;
    const distApprox = approxDistanceMeters(distExact, 50);
    const distText = distanceTextByLang(language, distApprox);

    const factsBlock = buildFactsBlock({
      language,
      poiName: poi.name,
      distanceText: distText,
      facts: best.facts || [],
    });

    // 1st pass
    let storyText = await generateBtwStoryFromFacts({ language, factsBlock });

    if (!storyText) throw new Error("No story generated by OpenAI");
    if (storyText === "NO_STORY") {
      return res.json({ shouldSpeak: false, reason: "model_no_story", language });
    }

    // validate + optional repair pass
    const v1 = validateStory({ story: storyText, language });
    if (!v1.ok) {
      const repaired = await repairStoryToComply({
        language,
        factsBlock,
        badStory: storyText,
        failureReason: v1.reason,
      });

      if (repaired === "NO_STORY") {
        return res.json({ shouldSpeak: false, reason: `repair_failed_${v1.reason}`, language });
      }

      const v2 = validateStory({ story: repaired, language });
      if (!v2.ok) {
        // if still not good, go silent instead of shipping boring/invalid
        return res.json({ shouldSpeak: false, reason: `final_validation_failed_${v2.reason}`, language });
      }
      storyText = repaired;
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
      debug: {
        factsCount: Array.isArray(best.facts) ? best.facts.length : 0,
      },
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
    build: "btw-wikipedia-deep-facts-words340-repairpass-v3",
  });
});

initDb().catch((err) => {
  console.error("DB init failed:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
