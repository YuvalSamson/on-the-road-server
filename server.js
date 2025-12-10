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

// 2. קולות TTS של OpenAI
const TTS_VOICES = [
  "coral",
  "sage",
  "alloy",
  "ash",
  "ballad",
  "echo",
  "fable",
  "nova",
  "onyx",
  "shimmer",
  "verse",
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

// 5. /places - מחזיר מקומות קרובים לפי lat/lng
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

// 6. /api/story-both - מקבל prompt + lat/lng, מחזיר טקסט + אודיו + מידע על הקול
app.post("/api/story-both", async (req, res) => {
  try {
    const { prompt, lat, lng } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'prompt' in request body (string required)" });
    }

    let locationLine = "Driver location is unknown.";
    let poiLine = "";

    if (typeof lat === "number" && typeof lng === "number") {
      locationLine = `Approximate driver location: latitude ${lat.toFixed(
        4
      )}, longitude ${lng.toFixed(4)}.`;

      try {
        const places = await getNearbyPlaces(lat, lng, 800);
        if (places.length > 0) {
          // נבחר מקום "הכי טוב" - קודם עם דירוג, ואם אין אז הראשון
          const best =
            places.find((p) => p.rating !== null && p.rating !== undefined) ||
            places[0];

          poiLine = `Nearby point of interest: "${best.name}", address: ${best.address}. Use this specific place as the main focus of the story.`;
        }
      } catch (e) {
        console.error("Failed to fetch places for story-both:", e);
      }
    }

    const systemMessage = `
אתה הקריין של אפליקציית נהיגה בשם "On The Road".

סטייל הדיבור:
- אתה מדבר כמו מספר סיפורים על הכביש: שנון, חכם, משועשע, כמו קומיקאי מצליח שיודע לרתק קהל, אבל בקול רגוע וברור שמתאים לנהג שלא יכול להתרכז רק בך.
- המטרה שלך היא לגרום לנהג לחייך, להיות מסוקרן, ולהרגיש שהוא מקבל "סוד מקומי" על המקום שהוא חולף לידו.
- השתמש במשפטים קצרים יחסית, עם פסיקים והפסקות טבעיות שמייצרות קצת מתח לפני הפאנץ', אבל בלי צעקות, בלי דרמה מוגזמת ובלי להסיח את הדעת מהכביש.
- בסוף הפסקה כדאי שיהיה פאנץ' קטן, קריצה או ניסוח מצחיק עדין, אבל שהעובדה ההיסטורית או הגאוגרפית תישאר המרכז.

חוקים קשיחים לתוכן:
- לענות תמיד בעברית בלבד, בלי משפטי פתיחה כמו "שלום" או "היי".
- להתחיל ישר בעובדת הזהב, המשפט הראשון שלך צריך כבר להכיל את הליבה המעניינת.
- לבחור עובדת זהב אחת בלבד, חזקה ומסקרנת, על מקום שנמצא כמה עשרות עד מאות מטרים ממיקום הנהג. רק אם אין ברירה, אפשר להתרחב לכל היותר עד קילומטר אחד.
- אם אין לך ביטחון בעובדה על מקום בטווח הזה, אמור במפורש שאתה מדבר באופן קצת יותר כללי על האזור הקרוב, ואל תמציא פרטים. עדיף להיות זהיר מאשר מדויק לכאורה.
- אסור לספר על מקום שנמצא בבירור מעבר לקילומטר ממיקום הנהג, ובוודאי לא על עיר אחרת כמו אשדוד או לוד אם המיקום סביב תל אביב.
- הרחב בעיקר על עובדת הזהב הזאת: מה קרה, מתי זה קרה אם ידוע, למה זה חשוב היום, ואיך זה מתחבר למה שהנהג רואה סביבו.
- אפשר להוסיף עוד פרט אחד או שניים רק אם הם מחזקים ישירות את אותה עובדה. לא להתפזר לנושאים אחרים.
- להימנע ממשפטי תיירות כלליים כמו "זו עיר תוססת ומלאת חיים". תעדיף פרטים קונקרטיים, תאריכים, אנשים, מבנים או אירועים.
- פסקה אחת זורמת, בלי נקודות רשימה, באורך בערך 80 עד 130 מילים.
`;

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
    });
  } catch (err) {
    console.error("Error in /api/story-both:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 7. Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", build: "golden-fact-he-1km-style-v1" });
});

// 8. הרצה
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`On The Road server listening on port ${PORT}`);
});
