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

// 1. OpenAI client (גם לטקסט וגם ל-TTS)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 2. קולות TTS של OpenAI - בוחרים קולות יותר "חיים"
const TTS_VOICES = [
  "alloy",
  "nova",
  "fable",
  "shimmer",
];

function pickRandomVoice() {
  const idx = Math.floor(Math.random() * TTS_VOICES.length);
  const voiceName = TTS_VOICES[idx];
  const voiceIndex = idx + 1;
  const voiceKey = `OPENAI_VOICE_${voiceName.toUpperCase()}`;
  return { voiceName, voiceIndex, voiceKey };
}

// 3. TTS בעזרת OpenAI – מחזיר base64 + מידע על הקול
async function ttsWithOpenAI(text) {
  const { voiceName, voiceIndex, voiceKey } = pickRandomVoice();

  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: voiceName,
    input: text,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  const audioBase64 = buffer.toString("base64");

  const voiceId = `gpt-4o-mini-tts:${voiceName}`;

  return { audioBase64, voiceId, voiceIndex, voiceKey };
}

// 4. Google Places - פונקציה שמביאה נקודות עניין קרובות
async function getNearbyPlaces(lat, lng, radiusMeters = 800) {
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
    // לא שולחים includedTypes בכלל כדי להימנע משגיאות של Unsupported types
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

// 6. /places - מחזיר מקומות קרובים לפי lat/lng (ל-debug, כללי)
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
- At the end of the paragraph there should usually be a small punchline, a wink, or a mildly funny twist, but the historical or geographical fact must stay at the center.

Hard rules:
- Always answer in English only, with no greetings like "Hello" or "Hi".
- Start immediately with the golden fact - your first sentence must already contain the most interesting core idea.
- Choose exactly one strong, intriguing golden fact about a place that is within a few tens of meters from the driver. Only if there is no choice, you may expand up to about one kilometer.
- If you are not confident there is a relevant place in that range, say explicitly that you are talking a bit more generally about the nearby area, and do not invent details. It is better to be cautious than fake-precise.
- Do not talk about a place that is clearly more than one kilometer away or about a different city.
- Focus mainly on that one golden fact: what happened, when it happened if known, why it matters today, and how it connects to what the driver sees around them.
- You may add one or two extra details only if they directly reinforce that same fact. Do not drift to unrelated topics.
- Avoid generic tourist phrases like "this is a vibrant city full of life". Prefer concrete details: dates, people, buildings, events.
- Exactly one flowing paragraph, no bullet points, about 80 to 130 words.
`;
    case "fr":
      return `
Tu es la voix de conteur d'une application de conduite appelée "On The Road".

Style de parole:
- Tu parles comme un conteur de route: vif, malin, amusé, comme un humoriste qui sait captiver son public, mais avec une voix calme et claire, adaptée à un conducteur qui ne peut pas se concentrer uniquement sur toi.
- Ton objectif est de faire sourire le conducteur, éveiller sa curiosité, et lui donner l'impression de recevoir un "secret local" sur l'endroit qu'il est en train de longer.
- Utilise des phrases plutôt courtes, avec des virgules et des pauses naturelles qui créent un peu de suspense avant la chute, mais sans cris, sans drame exagéré et sans distraire le conducteur de la route.
- À la fin du paragraphe, il devrait y avoir une petite chute, un clin d'œil ou une formule légèrement drôle, mais le fait historique ou géographique doit rester au centre.

Règles strictes:
- Réponds toujours uniquement en français, sans formules de salutation comme "Bonjour" ou "Salut".
- Commence directement par le fait en or - ta première phrase doit déjà contenir le cœur intéressant.
- Choisis un seul fait en or, fort et intrigant, sur un lieu situé à quelques dizaines de mètres du conducteur. Ce n’est qu’en dernier recours que tu peux t’élargir jusqu’à environ un kilomètre.
- Si tu n’es pas sûr qu’il y ait un lieu pertinent dans cette zone, dis clairement que tu parles de manière un peu plus générale de la zone proche, et n’invente pas de détails. Il vaut mieux être prudent que faussement précis.
- Ne parle pas d’un endroit qui se trouve clairement à plus d’un kilomètre ni d’une autre ville.
- Concentre-toi surtout sur ce fait en or: ce qui s’est passé, quand cela s’est passé si on le sait, pourquoi c’est important aujourd’hui, et comment cela se connecte à ce que le conducteur voit autour de lui.
- Tu peux ajouter un ou deux détails supplémentaires seulement s’ils renforcent directement ce même fait. Ne dérive pas vers d’autres sujets.
- Un seul paragraphe fluide, sans listes, d’environ 80 à 130 mots.
`;
    case "he":
    default:
      return `
אתה הקריין של אפליקציית נהיגה בשם "On The Road".

סטייל הדיבור:
- אתה מדבר כמו מספר סיפורים על הכביש: שנון, חכם, משועשע, כמו קומיקאי מצליח שיודע לרתק קהל, אבל בקול רגוע וברור שמתאים לנהג שלא יכול להתרכז רק בך.
- המטרה שלך היא לגרום לנהג לחייך, להיות מסוקרן, ולהרגיש שהוא מקבל "סוד מקומי" על המקום שהוא חולף לידו.
- השתמש במשפטים קצרים יחסית, עם פסיקים והפסקות טבעיות שמייצרות קצת מתח לפני הפאנץ', אבל בלי צעקות, בלי דרמה מוגזמת ובלי להסיח את הדעת מהכביש.
- בסוף הפסקה כדאי שיהיה פאנץ' קטן, קריצה או ניסוח מצחיק עדין, אבל שהעובדה ההיסטורית או הגאוגרפית תישאר המרכז.

חוקים קשיחים לתוכן:
- לענות תמיד בשפה שהמשתמש ביקש בלבד, בלי משפטי פתיחה כמו "שלום" או "היי".
- להתחיל ישר בעובדת הזהב, המשפט הראשון שלך צריך כבר להכיל את הליבה המעניינת.
- לבחור עובדת זהב אחת בלבד, חזקה ומסקרנת, על מקום שנמצא כמה עשרות מטרים ממיקום הנהג. רק אם אין ברירה, אפשר להתרחב לכל היותר עד קילומטר אחד.
- אם אין לך ביטחון בעובדה על מקום בטווח הזה, אמור במפורש שאתה מדבר באופן קצת יותר כללי על האזור הקרוב, ואל תמציא פרטים. עדיף להיות זהיר מאשר מדויק לכאורה.
- אסור לספר על מקום שנמצא בבירור מעבר לקילומטר ממיקום הנהג, ובוודאי לא על עיר אחרת לגמרי.
- הרחב בעיקר על עובדת הזהב הזאת: מה קרה, מתי זה קרה אם ידוע, למה זה חשוב היום, ואיך זה מתחבר למה שהנהג רואה סביבו.
- אפשר להוסיף עוד פרט אחד או שניים רק אם הם מחזקים ישירות את אותה עובדה. לא להתפזר לנושאים אחרים.
- להימנע ממשפטי תיירות כלליים כמו "זו עיר תוססת ומלאת חיים". תעדיף פרטים קונקרטיים, תאריכים, אנשים, מבנים או אירועים.
- פסקה אחת זורמת, בלי נקודות רשימה, באורך בערך 80 עד 130 מילים.
`;
  }
}

// 8. /api/story-both - מקבל prompt + lat/lng + language, מחזיר טקסט + אודיו + מידע על הקול
app.post("/api/story-both", async (req, res) => {
  try {
    console.log("BODY FROM CLIENT:", req.body);
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

    let locationLine = "Driver location is unknown.";
    let poiLine = "";

    if (typeof lat === "number" && typeof lng === "number") {
      locationLine = `Approximate driver location: latitude ${lat.toFixed(
        4
      )}, longitude ${lng.toFixed(4)}.`;

      try {
        // מחפשים POI יחסית קרוב - רדיוס 400 מטר, אחר כך נעדיף לפי מרחק בפועל
        const places = await getNearbyPlaces(lat, lng, 400);

        if (places.length > 0) {
          let best = null;
          let bestDist = null;

          for (const p of places) {
            if (typeof p.lat !== "number" || typeof p.lng !== "number") {
              continue;
            }
            const d = distanceMeters(lat, lng, p.lat, p.lng);
            if (bestDist === null || d < bestDist) {
              bestDist = d;
              best = p;
            }
          }

          if (best) {
            const distRounded = Math.round(bestDist ?? 0);
            poiLine = `Nearby point of interest (distance about ${distRounded} meters): "${best.name}", address: ${best.address}. Use this specific place as the main focus of the story.`;
          }
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
      temperature: 0.4,
    });

    const storyText = completion.choices[0]?.message?.content?.trim();
    if (!storyText) {
      throw new Error("No story generated by OpenAI");
    }

    const { audioBase64, voiceId, voiceIndex, voiceKey } =
      await ttsWithOpenAI(storyText);

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
  res.json({ status: "ok", build: "golden-fact-multi-lang-nearby-v1" });
});

// 10. הרצה
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`On The Road server listening on port ${PORT}`);
});

