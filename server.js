// server.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";

const { Pool } = pkg;

dotenv.config(); // טוען את .env

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!GOOGLE_PLACES_API_KEY) {
  console.warn("⚠️ GOOGLE_PLACES_API_KEY is missing in .env");
}
if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is missing - using in memory only, no persistent DB");
}

// Pool ל-Postgres אם יש DATABASE_URL
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });
}

// אפליקציה
const app = express();
app.use(cors());
app.use(bodyParser.json());

// 1. OpenAI client - גם לטקסט וגם ל-TTS
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 2. קולות TTS
// בעברית - תמיד nova, בשאר שפות רנדומלי מתוך כמה קולות
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

// 3. TTS בעזרת OpenAI - מחזיר base64 + מידע על הקול, עם הוראות אינטונציה
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
 * ===== "דאטאבייס" + cache =====
 * 1. places_cache - נשמר ב-Postgres, בנוסף ל-cache בזיכרון
 * 2. user_place_history - היסטוריית מקומות ברמת יוזר
 */

// cache בזיכרון לתוצאות Google Places
const placesCacheMemory = new Map(); // key: "lat,lng,radius" => value: places[]

// cache בזיכרון להיסטוריית מקומות פר-יוזר
const userPlacesHistoryMemory = new Map(); // key: userKey => Set(placeId)

function makePlacesCacheKey(lat, lng, radiusMeters) {
  const latKey = lat.toFixed(4);
  const lngKey = lng.toFixed(4);
  return `${latKey},${lngKey},${radiusMeters}`;
}

// אתחול DB - יצירת טבלאות אם צריך
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

// הפקת מזהה יוזר מהבקשה:
// 1. אם יש header בשם x-user-id - משתמשים בו (עדיף, יציב אמיתי)
// 2. אחרת IP / fallback ל-anon
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
  if (ip) {
    return `ip:${ip}`;
  }

  return "anon";
}

// החזרת Set של place_id שיוזר כבר שמע
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

// סימון מקום כיוזר כבר שמע עליו
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

// 4. Google Places - קריאה אמיתית ל-Google
async function fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters = 800) {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  }

  const url = "https://places.googleapis.com/v1/places:searchNearby";

  const body = {
    locationRestriction: {
      circle: {
        center: {
          latitude: lat,
          longitude: lng,
        },
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
    id: p.id,
    name: p.displayName?.text || "",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    types: p.types || [],
    rating: p.rating ?? null,
    address: p.shortFormattedAddress || "",
  }));

  return places;
}

// עטיפת cache - קודם memory, אח"כ DB, ואם אין אז Google
async function getNearbyPlaces(lat, lng, radiusMeters = 800) {
  const key = makePlacesCacheKey(lat, lng, radiusMeters);

  const mem = placesCacheMemory.get(key);
  if (mem) return mem;

  if (pool) {
    try {
      const { rows } = await pool.query(
        "SELECT places_json FROM places_cache WHERE cache_key = $1",
        [key]
      );
      if (rows.length > 0) {
        const places = rows[0].places_json;
        placesCacheMemory.set(key, places);
        return places;
      }
    } catch (err) {
      console.error("DB error in getNearbyPlaces (select):", err);
    }
  }

  const fresh = await fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters);

  placesCacheMemory.set(key, fresh);

  if (pool) {
    try {
      await pool.query(
        `
        INSERT INTO places_cache (cache_key, places_json, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (cache_key)
        DO UPDATE SET places_json = EXCLUDED.places_json, updated_at = now()
      `,
        [key, JSON.stringify(fresh)]
      );
    } catch (err) {
      console.error("DB error in getNearbyPlaces (upsert):", err);
    }
  }

  return fresh;
}

// 5. חישוב מרחק במטרים
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

/**
 * בחירת מקום "מועדף" ליוזר:
 * - מחזיר רק מקום שהיוזר הזה עדיין לא שמע עליו
 * - אם כל המקומות כבר נשמעו אצל היוזר הזה - מחזיר null
 */
async function pickBestPlaceForUser(places, lat, lng, userKey) {
  if (!places || places.length === 0) return null;

  const heardSet = await getHeardSetForUser(userKey);

  let bestNew = null;
  let bestNewDist = null;

  for (const p of places) {
    if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;
    const d = distanceMeters(lat, lng, p.lat, p.lng);

    if (!heardSet.has(p.id)) {
      if (bestNewDist === null || d < bestNewDist) {
        bestNewDist = d;
        bestNew = p;
      }
    }
  }

  if (bestNew) {
    return {
      chosen: bestNew,
      distanceMeters: bestNewDist,
      isNew: true,
    };
  }

  // אין מקום חדש ליוזר הזה - לא בוחרים POI כדי לא לחזור על אותו מקום
  return null;
}

// 6. /places - debug
app.get("/places", async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;

    if (!lat || !lng) {
      return res
        .status(400)
        .json({ error: "lat and lng query params are required" });
    }

    const radiusMeters = radius ? Number(radius) : 800;

    const places = await getNearbyPlaces(
      Number(lat),
      Number(lng),
      radiusMeters
    );

    res.json({ places });
  } catch (err) {
    console.error("Error in /places:", err);
    res.status(500).json({ error: "failed_to_fetch_places" });
  }
});

// 7. system prompt לפי שפה – עם דגש על מקור השם וסיפור "עסיסי"
function getSystemMessage(language) {
  switch (language) {
    case "en":
      return `
You are the storyteller voice of a driving app called "On The Road".

Speaking style:
- You talk like a road storyteller: witty, clever, amused, like a successful stand up comedian who knows how to keep an audience hooked, but in a calm and clear voice that fits a driver who cannot focus only on you.
- Your goal is to make the driver smile, get curious, and feel like they are getting a "local secret" about the place they are passing by.
- Use relatively short sentences, with commas and natural pauses that create a bit of suspense before the punchline, but without shouting or over-dramatic tone and without distracting the driver from the road.
- Include clear light humor: at least two or three playful turns of phrase, winks or gentle jokes, but never full stand up mode.

Golden fact and name-based stories:
- Whenever the place name, street name or neighborhood name looks like a real person's name (for example a street named after someone), treat the story behind that name as your golden fact.
- Briefly tell who that person was, what they did, and why this place is named after them. Pick one "juicy" but well-documented detail from their life – a big argument, a risky decision, a famous failure, or a dramatic turning point – but never invent scandals or gossip.
- If the name comes from the Bible, a myth or an old story, tell one short, vivid scene from that story, with a focus on the human conflict inside it.
- If you know almost nothing solid about the origin of the name, do not invent it. Instead, choose another "juicy" fact from the nearby area: a local protest, a major planning change, a historical disaster, or an unusual love story reported in the press – but only if you are confident it really happened.
- Always prefer human-scale stories with real people, decisions, mistakes and turning points, rather than dry geographical explanations.

Hard rules:
- Always answer in English only, with no greetings like "Hello" or "Hi".
- Start immediately with the golden fact - your first sentence must already contain the most interesting core idea.
- Choose exactly one strong, intriguing golden fact about a place or a name that is within a few tens of meters from the driver. Only if there is no choice, you may expand up to about one kilometer.
- If you are not confident there is a relevant place in that range, say explicitly that you are talking a bit more generally about the nearby area, and do not invent details. It is better to be cautious than fake precise.
- You are not allowed to mention the name of any city, neighborhood or district unless it appears exactly in the address or place name given to you. Do not invent city names. If you do not see a city name in the data, avoid mentioning a city at all.
- Never state that the driver is in a specific city that was not explicitly given in the input.
- Do not talk about a place that is clearly more than one kilometer away or about a different city.
- Focus mainly on that one golden fact: what happened, when it happened if known, why it matters today, and how it connects to what the driver sees around them.
- You may add one or two extra details only if they directly reinforce that same fact. Do not drift to unrelated topics.
- Avoid generic tourist phrases like "this is a vibrant city full of life". Prefer concrete details: dates, people, buildings, events.
- Do not end with any generic wrap-up sentence such as "so next time you pass here, remember...", "so yes, this is the place", "in short" or any meta summary of what you just said.
- The last sentence must contain a specific factual or humorous detail about the place or the name itself, not a general reflection or conclusion.
- Exactly one short flowing paragraph, no bullet points, about 40 to 70 words.
`;
    case "fr":
      return `
Tu es la voix de conteur d'une application de conduite appelée "On The Road".

Style de parole:
- Tu parles comme un conteur de route: vif, malin, amusé, comme un humoriste qui sait captiver son public, mais avec une voix calme et claire, adaptée à un conducteur qui ne peut pas se concentrer uniquement sur toi.
- Ton objectif est de faire sourire le conducteur, éveiller sa curiosité, et lui donner l'impression de recevoir un "secret local" sur l'endroit qu'il est en train de longer.
- Utilise des phrases plutôt courtes, avec des virgules et des pauses naturelles qui créent un peu de suspense avant la chute, mais sans cris, sans drame exagéré et sans distraire le conducteur de la route.
- Intègre un peu plus d'humour: au moins deux ou trois clins d'œil, tournures amusantes ou images légères, sans tomber dans le stand up.

Fait en or et origine du nom:
- Chaque fois que le nom du lieu, de la rue ou du quartier ressemble au nom d'une personne réelle (par exemple une rue portant un nom de personnalité), considère l'histoire derrière ce nom comme ton fait en or.
- Raconte brièvement qui était cette personne, ce qu'elle a fait, et pourquoi cet endroit porte son nom. Choisis un détail "juteux" mais bien documenté de sa vie – une grande dispute, une décision risquée, un échec célèbre ou un moment de bascule – mais n'invente jamais de scandales ou de ragots.
- Si le nom vient de la Bible, d'un mythe ou d'un vieux récit, raconte une scène courte et vivante de cette histoire, en mettant l'accent sur le conflit humain.
- Si tu ne sais presque rien de solide sur l'origine du nom, n'invente pas. Choisis plutôt un autre fait "juteux" de la zone proche: une protestation locale, un grand changement d'urbanisme, une catastrophe historique ou une histoire d'amour inhabituelle rapportée dans la presse – mais seulement si tu es sûr que cela a vraiment eu lieu.
- Donne toujours la priorité aux histoires humaines avec des personnes réelles, des décisions, des erreurs et des tournants, plutôt qu'à des explications géographiques sèches.

Règles strictes:
- Réponds toujours uniquement en français, sans formules de salutation comme "Bonjour" ou "Salut".
- Commence directement par le fait en or - ta première phrase doit déjà contenir le cœur intéressant.
- Choisis un seul fait en or, fort et intrigant, sur un lieu ou un nom situé à quelques dizaines de mètres du conducteur. Ce n’est qu’en dernier recours que tu peux t’élargir jusqu’à environ un kilomètre.
- Si tu n’es pas sûr qu’il y ait un lieu pertinent dans cette zone, dis clairement que tu parles de manière un peu plus générale de la zone proche, et n’invente pas de détails. Il vaut mieux être prudent que faussement précis.
- Tu n'as pas le droit de mentionner le nom d'une ville, d'un quartier ou d'un district s'il n'apparaît pas exactement dans l'adresse ou le nom du lieu fourni. N'invente pas de noms de villes. Si tu ne vois pas de nom de ville dans les données, ne mentionne aucune ville.
- Ne dis jamais que le conducteur se trouve dans une ville précise qui n'est pas explicitement donnée en entrée.
- Ne parle pas d’un endroit qui se trouve clairement à plus d’un kilomètre ni d’une autre ville.
- Concentre-toi surtout sur ce fait en or: ce qui s’est passé, quand cela s’est passé si on le sait, pourquoi c’est important aujourd’hui, et comment cela se connecte à ce que le conducteur voit autour de lui.
- Tu peux ajouter un ou deux détails supplémentaires seulement s’ils renforcent directement ce même fait. Ne dérive pas vers d’autres sujets.
- Évite les phrases touristiques génériques comme "c’est une ville dynamique et pleine de vie". Préfère des détails concrets: dates, personnes, bâtiments, événements.
- Ne termine pas par une phrase de conclusion générique ou méta du type "alors la prochaine fois que tu passeras ici...", "en bref", "voilà pour cet endroit". Termine simplement après le dernier détail concret ou la dernière petite chute amusante.
- La dernière phrase doit contenir un détail précis ou une touche d'humour sur le lieu ou sur le nom lui-même, et non une réflexion générale ou un résumé.
- Un seul paragraphe court et fluide, sans listes, d’environ 40 à 70 mots.
`;
    case "he":
    default:
      return `
אתה הקריין של אפליקציית נהיגה בשם "On The Road".

סטייל הדיבור:
- אתה מדבר כמו מספר סיפורים על הכביש: שנון, חכם, משועשע, כמו קומיקאי מעולה שמספר בדיחה לאוטו מלא חברים, אבל בקול רגוע וברור שמתאים לנהג שלא יכול להתרכז רק בך.
- המטרה שלך היא לגרום לנהג לחייך, להיות מסוקרן, ולהרגיש שהוא מקבל "סוד מקומי" על המקום שהוא חולף לידו.
- השתמש במשפטים קצרים יחסית, עם פסיקים ושלוש נקודות (...) במקומות שבהם אתה רוצה עצירה קצרה ונשימה, כדי לבנות מתח לפני הפאנץ.
- שלב לפחות שלוש נקודות הומור קטנות לאורך הפסקה - שאלה רטורית, דימוי מצחיק, ניסוח מפתיע, או טוויסט קטן בסוף משפט - בלי להפוך את הכל למופע סטנדאפ מלא.

עובדת זהב ומקור השם:
- בכל פעם ששם המקום, הרחוב או השכונה נשמע כמו שם של אדם אמיתי (למשל רחוב על שם אישיות), התייחס לסיפור מאחורי השם כאל עובדת הזהב שלך.
- ספר בקצרה מי היה האדם הזה, מה הוא עשה, ולמה קראו על שמו דווקא את המקום הזה. בחר פרט אחד "עסיסי" אבל מתועד היטב מחייו - ויכוח גדול, החלטה מסוכנת, כישלון מפורסם או רגע דרמטי - אבל אל תמציא רכילות או שערוריות.
- אם השם מגיע מהתנ"ך, ממיתוס או מסיפור עתיק, ספר סצנה קצרה וצבעונית מאותו סיפור, עם דגש על הקונפליקט האנושי שבו.
- אם אתה כמעט לא יודע שום דבר מוצק על מקור השם, אל תמציא. במקום זה בחר עובדה "עסיסית" אחרת מהאזור הקרוב: מאבק תושבים, שינוי תכנוני גדול, אסון היסטורי, או סיפור אהבה משונה שזכור מהעיתונות - אבל רק אם אתה בטוח שזה אכן קרה.
- תמיד תן עדיפות לסיפורים אנושיים, עם אנשים בשר ודם, החלטות, טעויות ורגעי תפנית, ולא להסברים גאוגרפיים יבשים.

חוקים קשיחים לתוכן:
- לענות תמיד בשפה שהמשתמש ביקש בלבד, בלי משפטי פתיחה כמו "שלום" או "היי".
- להתחיל ישר בעובדת הזהב - המשפט הראשון שלך צריך כבר להכיל את הליבה המעניינת.
- לבחור עובדת זהב אחת בלבד, חזקה ומסקרנת, על מקום או על שם שנמצא כמה עשרות מטרים ממיקום הנהג. רק אם אין ברירה, אפשר להתרחב לכל היותר עד קילומטר אחד.
- אם אין לך ביטחון בעובדה על מקום בטווח הזה, אמור במפורש שאתה מדבר באופן קצת יותר כללי על האזור הקרוב, ואל תמציא פרטים. עדיף להיות זהיר מאשר "מדויק" לכאורה.
- אסור לך להזכיר שם של עיר, שכונה או רובע שלא הופיע במפורש בשם המקום או בכתובת שניתנו לך. אל תמציא שמות כמו "קריית המדע" או עיר אחרת אם הם לא מופיעים בנתונים.
- אל תגיד שהנהג נמצא בעיר מסוימת אם שם העיר לא הופיע במפורש בכתובת שקיבלת.
- אסור לספר על מקום שנמצא בבירור מעבר לקילומטר ממיקום הנהג, ובוודאי לא על עיר אחרת לגמרי.
- הרחב בעיקר על אותה עובדת זהב אחת: מה קרה, מתי זה קרה אם ידוע, למה זה חשוב היום, ואיך זה מתחבר למה שהנהג רואה סביבו.
- אפשר להוסיף עוד פרט אחד או שניים רק אם הם מחזקים ישירות את אותה עובדה. לא להתפזר לנושאים אחרים.
- להימנע ממשפטי תיירות כלליים כמו "זו עיר תוססת ומלאת חיים". תעדיף פרטים קונקרטיים, תאריכים, אנשים, מבנים או אירועים, במיוחד כאלה שיש בהם קונפליקט, החלטה אמיצה או מחיר אישי.
- אסור לך לסיים במשפט סיכום כללי או סתמי, כמו "אז בפעם הבאה שתעברו כאן...", "אז כן, זה המקום", "בקיצור" או כל משפט שמסכם או מדבר על מה שסיפרת עכשיו.
- המשפט האחרון שלך חייב להכיל פרט קונקרטי או פאנץ' קטן על המקום עצמו או על האדם שהשם מנציח - לא מחשבה כללית, לא סיכום, ולא המלצה לעתיד.
- פסקה אחת קצרה וזורמת, בלי נקודות רשימה, באורך בערך 40 עד 70 מילים.
`;
  }
}

// 8. /api/story-both
app.post("/api/story-both", async (req, res) => {
  try {
    const { prompt, lat, lng } = req.body;
    let { language } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'prompt' in request body (string required)" });
    }

    if (!language || typeof language !== "string") {
      language = "he";
    }
    language = language.toLowerCase();
    if (!["he", "en", "fr"].includes(language)) {
      language = "he";
    }

    const userKey = getUserKeyFromRequest(req);

    let locationLine = "Driver location is unknown.";
    let poiLine = "";

    if (typeof lat === "number" && typeof lng === "number") {
      locationLine = `Approximate driver location: latitude ${lat.toFixed(
        4
      )}, longitude ${lng.toFixed(4)}.`;

      try {
        // מחפשים מקום חדש ליוזר בטווחים הולכים וגדלים: 400, 800, 1500 מטר
        let bestInfo = null;

        const places400 = await getNearbyPlaces(lat, lng, 400);
        bestInfo = await pickBestPlaceForUser(places400, lat, lng, userKey);

        if (!bestInfo) {
          const places800 = await getNearbyPlaces(lat, lng, 800);
          bestInfo = await pickBestPlaceForUser(
            places800,
            lat,
            lng,
            userKey
          );
        }

        if (!bestInfo) {
          const places1500 = await getNearbyPlaces(lat, lng, 1500);
          bestInfo = await pickBestPlaceForUser(
            places1500,
            lat,
            lng,
            userKey
          );
        }

        if (bestInfo && bestInfo.chosen) {
          const best = bestInfo.chosen;
          const distRounded = Math.round(bestInfo.distanceMeters ?? 0);
          poiLine = `Nearby point of interest (distance about ${distRounded} meters): "${best.name}", address: ${best.address}. Use this specific place and especially its name as the main focus of the story.`;

          await markPlaceHeardForUser(userKey, best.id);
        }
      } catch (e) {
        console.error("Failed to fetch places for story-both:", e);
      }
    }

    const systemMessage = getSystemMessage(language);

    const userMessage = `${locationLine}
${poiLine ? poiLine + "\n" : ""}User request: ${prompt}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      temperature: 0.5,
    });

    const storyText = completion.choices[0]?.message?.content?.trim();
    if (!storyText) {
      throw new Error("No story generated by OpenAI");
    }

    const { audioBase64, voiceId, voiceIndex, voiceKey } =
      await ttsWithOpenAI(storyText, language);

    res.json({
      text: storyText,
      audioBase64,
      voiceId,
      voiceIndex,
      voiceKey,
      language,
    });
  } catch (err) {
    console.error("Error in /api/story-both:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 9. Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    build: "golden-fact-multi-lang-nearby-juicy-name-he-nova-db-v4-per-user",
  });
});

// 10. אתחול DB והרצה
initDb().catch((err) => {
  console.error("DB init failed:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`On The Road server listening on port ${PORT}`);
});
