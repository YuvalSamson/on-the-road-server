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

// Postgres pool
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

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// TTS voices
const TTS_VOICES_NON_HE = ["alloy", "fable", "shimmer"];

function pickVoice(language) {
  if (language === "he") {
    const voiceName = "nova";
    const voiceIndex = 1;
    const voiceKey = "OPENAI_VOICE_NOVA";
    return { voiceName, voiceIndex, voiceKey };
  }

  const idx = Math.floor(Math.random() * TTS_VOICES_NON_HE.length);
  const voiceName = TTS_VOICES_NON_HE[idx];
  const voiceIndex = idx + 1;
  const voiceKey = `OPENAI_VOICE_${voiceName.toUpperCase()}`;
  return { voiceName, voiceIndex, voiceKey };
}

async function ttsWithOpenAI(text, language = "he") {
  const { voiceName, voiceIndex, voiceKey } = pickVoice(language);

  const instructions =
    "Speak in the same language as the input text with a very natural, lively storyteller style. " +
    "Use a medium-to-fast pace: clearly faster than a slow audiobook, but never rushed or messy. " +
    "Avoid monotone: vary your pitch and energy, especially before and during funny or surprising parts. " +
    "Make short, clear pauses at commas and full stops, as if you take a quick breath. " +
    "Build tension before punchlines by slightly raising your tone and energy, then relax after the joke. " +
    "Sound like a great stand up comedian telling a short, warm story to a driver: funny, curious, playful, " +
    "but always easy to understand and not over-the-top.";

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
 * ===== DB + cache =====
 * places_cache: cache JSON by cache_key
 * user_place_history: per-user history of POI ids (we store generic poi_id strings)
 */

// in-memory cache
const placesCacheMemory = new Map(); // key => array
const userPlacesHistoryMemory = new Map(); // userKey => Set(poiId)

// extra cache for wikidata facts
const wikidataFactsMemory = new Map(); // qid|lang => { facts:[], sources:[] }

function makePlacesCacheKey(lat, lng, radiusMeters, mode = "mixed") {
  const latKey = lat.toFixed(4);
  const lngKey = lng.toFixed(4);
  return `${mode}:${latKey},${lngKey},${radiusMeters}`;
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
      for (const row of rows) {
        set.add(row.place_id);
      }
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

// distance meters
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

// ===== Google Places (kept as fallback) =====
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

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.types,places.rating,places.shortFormattedAddress",
    },
    body: JSON.stringify(body),
  });

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

// ===== OSM Overpass =====
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function overpassQuery(lat, lng, radiusMeters) {
  // Focus on non-business POIs: historic, tourism attractions/viewpoints, memorials, natural
  return `
[out:json][timeout:12];
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
out center tags 40;
`.trim();
}

function safeTag(tags, key) {
  if (!tags) return "";
  const v = tags[key];
  return typeof v === "string" ? v : "";
}

function normalizeNameFromOsm(tags) {
  const n = safeTag(tags, "name");
  if (n) return n;
  const en = safeTag(tags, "name:en");
  if (en) return en;
  const he = safeTag(tags, "name:he");
  if (he) return he;
  return "";
}

function osmElementToPoi(el) {
  const type = el.type; // node/way/relation
  const id = el.id;
  const tags = el.tags || {};
  const name = normalizeNameFromOsm(tags);

  let lat = null;
  let lng = null;

  if (type === "node") {
    lat = el.lat;
    lng = el.lon;
  } else {
    // ways/relations
    if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") {
      lat = el.center.lat;
      lng = el.center.lon;
    }
  }

  if (typeof lat !== "number" || typeof lng !== "number") return null;

  const wikidataId = safeTag(tags, "wikidata") || null;

  return {
    id: `osm:${type}/${id}`,
    name: name || "",
    lat,
    lng,
    types: Object.keys(tags).slice(0, 10),
    rating: null,
    address: "",
    source: "osm",
    wikidataId,
    osmTags: tags,
  };
}

async function fetchNearbyPoisFromOSM(lat, lng, radiusMeters = 800) {
  const q = overpassQuery(lat, lng, radiusMeters);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": "on-the-road-server/1.0 (contact: not-set)",
      },
      body: q,
      signal: controller.signal,
    });

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

      // must have at least a name or a wikidata id
      if (!poi.name && !poi.wikidataId) continue;

      pois.push(poi);
    }

    return pois.slice(0, 30);
  } finally {
    clearTimeout(timeout);
  }
}

// ===== Wikidata SPARQL around =====
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

function qidFromEntityUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/entity\/(Q\d+)$/);
  return m ? m[1] : null;
}

async function fetchNearbyPoisFromWikidata(lat, lng, radiusMeters = 800, language = "en") {
  const radiusKm = Math.max(0.1, Math.min(5, radiusMeters / 1000));

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
LIMIT 25
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/sparql-results+json",
        "User-Agent": "on-the-road-server/1.0 (contact: not-set)",
      },
      signal: controller.signal,
    });

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
  } finally {
    clearTimeout(timeout);
  }
}

// ===== Wikidata facts =====
async function fetchWikidataFacts(qid, language = "en") {
  if (!qid) return { facts: [], sources: [] };

  const cacheKey = `${qid}|${language}`;
  const cached = wikidataFactsMemory.get(cacheKey);
  if (cached) return cached;

  const query = `
SELECT ?itemLabel ?itemDescription ?inception ?inceptionLabel ?namedAfterLabel ?architectLabel ?instanceLabel WHERE {
  BIND(wd:${qid} AS ?item)
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P138 ?namedAfter . }
  OPTIONAL { ?item wdt:P84 ?architect . }
  OPTIONAL { ?item wdt:P31 ?instance . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${language},he,en". }
}
LIMIT 1
`.trim();

  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/sparql-results+json",
        "User-Agent": "on-the-road-server/1.0 (contact: not-set)",
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Wikidata facts error:", resp.status, text.slice(0, 400));
      return { facts: [], sources: [] };
    }

    const data = await resp.json();
    const b = data?.results?.bindings?.[0];
    if (!b) return { facts: [], sources: [] };

    const label = b.itemLabel?.value || "";
    const desc = b.itemDescription?.value || "";
    const instance = b.instanceLabel?.value || "";
    const inceptionLabel = b.inceptionLabel?.value || "";
    const namedAfter = b.namedAfterLabel?.value || "";
    const architect = b.architectLabel?.value || "";

    const facts = [];

    if (label && instance) facts.push(`It is a ${instance}.`);
    if (desc) facts.push(`Short description: ${desc}.`);
    if (inceptionLabel) facts.push(`Inception or opening: ${inceptionLabel}.`);
    if (namedAfter) facts.push(`Named after: ${namedAfter}.`);
    if (architect) facts.push(`Architect: ${architect}.`);

    const sources = [
      { type: "wikidata", qid, url: `https://www.wikidata.org/wiki/${qid}` },
    ];

    const result = { facts: facts.slice(0, 5), sources };
    wikidataFactsMemory.set(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ===== Unified POI fetch with cache =====
async function getNearbyPois(lat, lng, radiusMeters = 800, mode = "interesting", language = "en") {
  const key = makePlacesCacheKey(lat, lng, radiusMeters, mode);

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
    // Prefer OSM + Wikidata
    const [osm, wd] = await Promise.allSettled([
      fetchNearbyPoisFromOSM(lat, lng, radiusMeters),
      fetchNearbyPoisFromWikidata(lat, lng, radiusMeters, language),
    ]);

    if (osm.status === "fulfilled") pois = pois.concat(osm.value);
    if (wd.status === "fulfilled") pois = pois.concat(wd.value);

    // If nothing, fallback to Google Places
    if (pois.length === 0) {
      try {
        const gp = await fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters);
        pois = gp;
      } catch (e) {
        // ignore
      }
    }
  } else {
    // Legacy mode: Google Places
    pois = await fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters);
  }

  // light de-dupe by coordinate + name
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

// ===== Pick best POI with "quality gate" =====
async function pickBestPoiForUser(pois, lat, lng, userKey, language) {
  if (!pois || pois.length === 0) return null;

  const heardSet = await getHeardSetForUser(userKey);

  // score candidates
  const candidates = [];
  for (const p of pois) {
    if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;

    const d = distanceMeters(lat, lng, p.lat, p.lng);
    if (d > 1500) continue;

    if (heardSet.has(p.id)) continue;

    // bonus for wikidata id (more likely to have facts)
    const hasWd = !!(p.wikidataId && typeof p.wikidataId === "string");
    const bonus = hasWd ? 250 : 0;

    const score = d - bonus;

    candidates.push({ p, d, score });
  }

  candidates.sort((a, b) => a.score - b.score);

  // quality gate: need at least 2 facts
  for (const c of candidates.slice(0, 10)) {
    const poi = c.p;

    const qid = poi.wikidataId || (poi.id.startsWith("wd:") ? poi.id.replace("wd:", "") : null);
    const { facts, sources } = qid ? await fetchWikidataFacts(qid, language === "he" ? "he" : "en") : { facts: [], sources: [] };

    // Accept if enough facts, or if we have a good description
    const enough = facts.length >= 2 || (typeof poi.description === "string" && poi.description.trim().length > 20);

    if (enough) {
      return {
        chosen: poi,
        distanceMeters: c.d,
        facts,
        sources,
      };
    }
  }

  return null;
}

// ===== system prompts (tighten anti-hallucination) =====
function getSystemMessage(language) {
  if (language === "en") {
    return `
You are the storyteller voice of a driving app.

Hard truth rules:
- Use ONLY the factual notes provided to you under "FACTS". If a detail is not in FACTS, you must not state it as fact.
- If FACTS are too thin, produce "NO_STORY" exactly.

Speaking style:
- Short, witty, surprising, but factual and deep.
- Exactly one paragraph, 40 to 70 words.

Other rules:
- No greetings.
- Start immediately with the most interesting fact.
- No city name unless it appears in the provided place name or address line.
`.trim();
  }

  if (language === "fr") {
    return `
Tu es la voix d'un conteur pour une application de conduite.

Règles de vérité:
- Utilise UNIQUEMENT les notes factuelles fournies sous "FACTS". Si ce n'est pas dans FACTS, tu ne dois pas l'affirmer.
- Si FACTS est trop pauvre, réponds exactement "NO_STORY".

Style:
- Court, surprenant, avec une touche d'humour, mais factuel et un peu profond.
- Un seul paragraphe, 40 à 70 mots.

Autres règles:
- Pas de salutations.
- Commence directement par le fait le plus intéressant.
- Ne mentionne pas une ville si elle n'apparaît pas dans le nom ou l'adresse fournis.
`.trim();
  }

  // he
  return `
אתה הקריין של אפליקציית נהיגה.

חוקי אמת:
- אתה משתמש רק בעובדות שניתנו לך תחת "FACTS". אם פרט לא נמצא ב-FACTS אסור לך להציג אותו כעובדה.
- אם FACTS דל מדי, אתה מחזיר בדיוק "NO_STORY".

סגנון:
- קצר, שנון, מפתיע, אבל מדויק ועם עומק.
- פסקה אחת בלבד, 40 עד 70 מילים.

חוקים נוספים:
- בלי ברכות פתיחה.
- להתחיל ישר בעובדה הכי מעניינת.
- לא לציין שם עיר אם הוא לא מופיע במפורש בשם המקום או בשורת הכתובת שניתנו לך.
`.trim();
}

// ===== debug endpoint =====
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

// ===== main endpoint =====
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

    let locationLine = "Driver location is unknown.";
    let poiLine = "";
    let factsBlock = "";
    let sources = [];
    let chosenPoiId = null;

    if (typeof lat === "number" && typeof lng === "number") {
      locationLine = `Approximate driver location: latitude ${lat.toFixed(4)}, longitude ${lng.toFixed(4)}.`;

      try {
        // Expand radius gradually
        const radii = [400, 800, 1500];
        let best = null;

        for (const r of radii) {
          const pois = await getNearbyPois(lat, lng, r, "interesting", language === "he" ? "he" : "en");
          best = await pickBestPoiForUser(pois, lat, lng, userKey, language);
          if (best) break;
        }

        if (best && best.chosen) {
          const poi = best.chosen;
          const distRounded = Math.round(best.distanceMeters ?? 0);

          chosenPoiId = poi.id;
          sources = Array.isArray(best.sources) ? best.sources : [];

          // keep city safe: do not inject city here unless you have it
          const placeName = poi.name ? `"${poi.name}"` : `"nearby point"`;

          poiLine = `Nearby point of interest (distance about ${distRounded} meters): ${placeName}. Use this as the main focus.`;

          const facts = Array.isArray(best.facts) ? best.facts : [];
          if (facts.length > 0) {
            const lines = facts.slice(0, 5).map((f, i) => `FACT ${i + 1}: ${f}`);
            factsBlock = `FACTS:\n${lines.join("\n")}`;
          }
        }
      } catch (e) {
        console.error("Failed to fetch POIs for story-both:", e);
      }
    }

    // If we have no facts, we prefer silence
    if (!factsBlock) {
      return res.json({
        shouldSpeak: false,
        reason: "no_strong_poi_or_facts",
        language,
      });
    }

    const systemMessage = getSystemMessage(language);

    const userMessage = `${locationLine}
${poiLine ? poiLine + "\n" : ""}${factsBlock}
User request: ${prompt}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      temperature: 0.4,
    });

    const storyText = completion.choices[0]?.message?.content?.trim();
    if (!storyText) throw new Error("No story generated by OpenAI");

    if (storyText === "NO_STORY") {
      return res.json({
        shouldSpeak: false,
        reason: "model_refused_due_to_thin_facts",
        language,
      });
    }

    const { audioBase64, voiceId, voiceIndex, voiceKey } = await ttsWithOpenAI(storyText, language);

    // Mark as heard only if we actually spoke
    if (chosenPoiId) {
      await markPlaceHeardForUser(userKey, chosenPoiId);
    }

    res.json({
      shouldSpeak: true,
      text: storyText,
      audioBase64,
      voiceId,
      voiceIndex,
      voiceKey,
      language,
      sources, // for debug, not spoken
    });
  } catch (err) {
    console.error("Error in /api/story-both:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    build: "btw-interesting-osm-wikidata-quality-gate-v1",
  });
});

initDb().catch((err) => console.error("DB init failed:", err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
