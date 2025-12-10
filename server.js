// server.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config(); // טוען את .env

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

if (!GOOGLE_PLACES_API_KEY) {
  console.warn("⚠️ GOOGLE_PLACES_API_KEY is missing in .env");
}

const app = express();

app.use(cors());
app.use(bodyParser.json());

// 1. OpenAI client - גם לטקסט וגם ל TTS
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 2. קולות TTS של OpenAI - קולות יותר "חיים"
const TTS_VOICES = ["alloy", "nova", "fable", "shimmer"];

function pickRandomVoice() {
  const idx = Math.floor(Math.random() * TTS_VOICES.length);
  const voiceName = TTS_VOICES[idx];
  const voiceIndex = idx + 1;
  const voiceKey = `OPENAI_VOICE_${voiceName.toUpperCase()}`;
  return { voiceName, voiceIndex, voiceKey };
}

// 3. TTS בעזרת OpenAI - מחזיר base64 + מידע על הקול, עם הוראות אינטונציה
async function ttsWithOpenAI(text, language = "he") {
  const { voiceName, voiceIndex, voiceKey } = pickRandomVoice();

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
 * ===== "דאטאבייס" פשוט בזיכרון =====
 * 1. placesCache - cache של תוצאות Google Places לפי קואורדינטות+רדיוס
 * 2. userPlacesHistory - היסטוריית מקומות של כל יוזר, כדי לא לחזור על אותו POI
 */

// cache לתוצאות Google Places
const placesCache = new Map(); // key: "lat,lng,radius" => value: places[]

function makePlacesCacheKey(lat, lng, radiusMeters) {
  // קירוב ל-1e-4 כדי לא לקבל key שונה על כל תזוזה של סנטימטר
  const latKey = lat.toFixed(4);
  const lngKey = lng.toFixed(4);
  return `${latKey},${lngKey},${radiusMeters}`;
}

// היסטוריית מקומות לכל יוזר
// key: userKey (x-user-id או ip) => Set(placeId)
const userPlacesHistory = new Map();

function getUserKeyFromRequest(req) {
  const headerId = req.headers["x-user-id"];
  if (typeof headerId === "string" && headerId.trim() !== "") {
    return `user:${headerId.trim()}`;
  }
  const ip =
    (typeof req.ip === "string" && req.ip) ||
    (typeof req.headers["x-forwarded-for"] === "string" &&
      req.headers["x-forwarded-for"]);
  if (ip) {
    return `ip:${ip}`;
  }
  return "anon";
}

function markPlaceHeardForUser(userKey, placeId) {
  if (!placeId) return;
  let set = userPlacesHistory.get(userKey);
  if (!set) {
    set = new Set();
    userPlacesHistory.set(userKey, set);
  }
  set.add(placeId);
}

// 4. Google Places - פונקציה אמיתית שמביאה נקודות עניין (קריאה ל-Google)
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
    // לא שולחים includedTypes כדי להימנע משגיאות של Unsupported types
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

// עטיפת cache סביב fetchNearbyPlacesFromGoogle
async function getNearbyPlaces(lat, lng, radiusMeters = 800) {
  const key = makePlacesCacheKey(lat, lng, radiusMeters);
  const cached = placesCache.get(key);
  if (cached) {
    return cached;
  }
  const fresh = await fetchNearbyPlacesFromGoogle(lat, lng, radiusMeters);
  placesCache.set(key, fresh);
  return fresh;
}

// 5. פונקציה לחישוב מרחק במטרים בין הנהג לבין ה-POI
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // רדיוס כדור הארץ במטרים
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
 * - קודם כל מחפשים מקום שהיוזר עוד לא שמע עליו (id לא נמצא ב-Set)
 * - מבין החדשים: בוחרים את הקרוב ביותר
 * - אם אין מקום חדש בכלל: מחזירים הקרוב ביותר (dup), אבל נסמן isNew = false
 */
function pickBestPlaceForUser(places, lat, lng, userKey) {
  if (!places || places.length === 0) return null;

  const heardSet = userPlacesHistory.get(userKey) || new Set();

  let bestNew = null;
  let bestNewDist = null;

  let bestOverall = null;
  let bestOverallDist = null;

  for (const p of places) {
    if (typeof p.lat !== "number" || typeof p.lng !== "number") {
      continue;
    }
    const d = distanceMeters(lat, lng, p.lat, p.lng);

    // הכי קרוב באופן כללי
    if (bestOverallDist === null || d < bestOverallDist) {
      bestOverallDist = d;
      bestOverall = p;
    }

    // מועמד חדש (שהיוזר עוד לא שמע עליו)
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

  // אין מקום חדש - נ fallback למקום הכי קרוב
  return {
    chosen: bestOverall,
    distanceMeters: bestOverallDist,
    isNew: false,
  };
}

// 6. /places - מחזיר מקומות קרובים לפי lat/lng (ל debug, כללי)
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

// 7. בחירת system prompt לפי שפה
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

Hard rules:
- Always answer in English only, with no greetings like "Hello" or "Hi".
- Start immediately with the golden fact - your first sentence must already contain the most interesting core idea.
- Choose exactly one strong, intriguing golden fact about a place that is within a few tens of meters from the driver. Only if there is no choice, you may expand up to about one kilometer.
- If you are not confident there is a relevant place in that range, say explicitly that you are talking a bit more generally about the nearby area, and do not invent details. It is better to be cautious than fake precise.
- You are not allowed to mention the name of any city, neighborhood or district unless it appears exactly in the address or place name given to you. Do not invent city names. If you do not see a city name in the data, avoid mentioning a city at all.
- Never state that the driver is in a specific city that was not explicitly given in the input.
- Do not talk about a place that is clearly more than one kilometer away or about a different city.
- Focus mainly on that one golden fact: what happened, when it happened if known, why it matters today, and how it connects to what the driver sees around them.
- You may add one or two extra details only if they directly reinforce that same fact. Do not drift to unrelated topics.
- Avoid generic tourist phrases like "this is a vibrant city full of life". Prefer concrete details: dates, people, buildings, events.
- Do not end with a generic closing sentence such as "so next time you pass here, remember...". Simply finish after the last fact or witty punchline.
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

Règles strictes:
- Réponds toujours uniquement en français, sans formules de salutation comme "Bonjour" ou "Salut".
- Commence directement par le fait en or - ta première phrase doit déjà contenir le cœur intéressant.
- Choisis un seul fait en or, fort et intrigant, sur un lieu situé à quelques dizaines de mètres du conducteur. Ce n’est qu’en dernier recours que tu peux t’élargir jusqu’à environ un kilomètre.
- Si tu n’es pas sûr qu’il y ait un lieu pertinent dans cette zone, dis clairement que tu parles de manière un peu plus générale de la zone proche, et n’invente pas de détails. Il vaut mieux être prudent que faussement précis.
- Tu n'as pas le droit de mentionner le nom d'une ville, d'un quartier ou d'un district s'il n'apparaît pas exactement dans l'adresse ou le nom du lieu fourni. N'invente pas de noms de villes. Si tu ne vois pas de nom de ville dans les données, ne mentionne aucune ville.
- Ne dis jamais que le conducteur se trouve dans une ville précise qui n'est pas explicitement donnée en entrée.
- Ne parle pas d’un endroit qui se trouve clairement à plus d’un kilomètre ni d’une autre ville.
- Concentre-toi surtout sur ce fait en or: ce qui s’est passé, quand cela s’est passé si on le sait, pourquoi c’est important aujourd’hui, et comment cela se connecte à ce que le conducteur voit autour de lui.
- Tu peux ajouter un ou deux détails supplémentaires seulement s’ils renforcent directement ce même fait. Ne dérive pas vers d’autres sujets.
- Évite les phrases touristiques génériques comme "c’est une ville dynamique et pleine de vie". Préfère des détails concrets: dates, personnes, bâtiments, événements.
- Ne termine pas par une phrase de conclusion générique du style "alors la prochaine fois que tu passeras ici, souviens toi...". Termine simplement après le dernier fait ou la dernière petite chute amusante.
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
- שלב יותר הומור: לפחות שלוש נקודות הומור קטנות לאורך הפסקה - שאלה רטורית, דימוי מצחיק, ניסוח מפתיע, או טוויסט קטן בסוף משפט.
- אל תחשוש מקריצה עדינה על חשבון המקום, השלט, או ההיסטוריה, כל עוד אתה נשאר מכבד ולא ציני מדי.

חוקים קשיחים לתוכן:
- לענות תמיד בשפה שהמשתמש ביקש בלבד, בלי משפטי פתיחה כמו "שלום" או "היי".
- להתחיל ישר בעובדת הזהב - המשפט הראשון שלך צריך כבר להכיל את הליבה המעניינת.
- לבחור עובדת זהב אחת בלבד, חזקה ומסקרנת, על מקום שנמצא כמה עשרות מטרים ממיקום הנהג. רק אם אין ברירה, אפשר להתרחב לכל היותר עד קילומטר אחד.
- אם אין לך ביטחון בעובדה על מקום בטווח הזה, אמור במפורש שאתה מדבר באופן קצת יותר כללי על האזור הקרוב, ואל תמציא פרטים. עדיף להיות זהיר מאשר מדויק לכאורה.
- אסור לך להזכיר שם של עיר, שכונה או רובע שלא הופיע במפורש בשם המקום או בכתובת שניתנו לך. אל תמציא שמות כמו "קריית המדע" או עיר אחרת אם הם לא מופיעים בנתונים.
- אל תגיד שהנהג נמצא בעיר מסוימת אם שם העיר לא הופיע במפורש בכתובת שקיבלת.
- אסור לספר על מקום שנמצא בבירור מעבר לקילומטר ממיקום הנהג, ובוודאי לא על עיר אחרת לגמרי.
- הרחב בעיקר על עובדת הזהב הזאת: מה קרה, מתי זה קרה אם ידוע, למה זה חשוב היום, ואיך זה מתחבר למה שהנהג רואה סביבו.
- אפשר להוסיף עוד פרט אחד או שניים רק אם הם מחזקים ישירות את אותה עובדה. לא להתפזר לנושאים אחרים.
- להימנע ממשפטי תיירות כלליים כמו "זו עיר תוססת ומלאת חיים". תעדיף פרטים קונקרטיים, תאריכים, אנשים, מבנים או אירועים.
- אל תסיים במשפט סיכום כללי בסגנון "אז בפעם הבאה שתעברו כאן..." או "אז כן, זה המקום". סיים מיד אחרי הפאנץ או אחרי העובדה המעניינת האחרונה, בלי משפט פרידה.
- פסקה אחת קצרה וזורמת, בלי נקודות רשימה, באורך בערך 40 עד 70 מילים.
`;
  }
}

// 8. /api/story-both - מקבל prompt + lat/lng + language, מחזיר טקסט + אודיו + מידע על הקול
app.post("/api/story-both", async (req, res) => {
  try {
    const { prompt, lat, lng } = req.body;
    let { language } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'prompt' in request body (string required)" });
    }

    // ברירת מחדל - עברית
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
        // ניסיון ראשון: רדיוס 400 מטר
        const places400 = await getNearbyPlaces(lat, lng, 400);
        let bestInfo = pickBestPlaceForUser(places400, lat, lng, userKey);

        // אם אין מקום חדש, ננסה להגדיל רדיוס ל-800 מטר
        if (!bestInfo || !bestInfo.isNew) {
          const places800 = await getNearbyPlaces(lat, lng, 800);
          const from800 = pickBestPlaceForUser(places800, lat, lng, userKey);

          // מעדיפים מקום חדש אם נמצא ברדיוס המורחב
          if (from800 && from800.isNew) {
            bestInfo = from800;
          } else if (!bestInfo && from800) {
            // אם קודם לא היה בכלל, קח מה-800
            bestInfo = from800;
          }
        }

        if (bestInfo && bestInfo.chosen) {
          const best = bestInfo.chosen;
          const distRounded = Math.round(bestInfo.distanceMeters ?? 0);
          poiLine = `Nearby point of interest (distance about ${distRounded} meters): "${best.name}", address: ${best.address}. Use this specific place as the main focus of the story.`;

          // מסמנים שהיוזר כבר שמע על המקום הזה
          markPlaceHeardForUser(userKey, best.id);
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
    build: "golden-fact-multi-lang-nearby-short-voice-history-v1",
  });
});

// 10. הרצה
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`On The Road server listening on port ${PORT}`);
});
