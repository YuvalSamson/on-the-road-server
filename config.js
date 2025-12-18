/**
 * Central config for BYTHEWAY server (ESM).
 */
const env = (k, fallback = undefined) => {
  const v = process.env[k];
  return (v === undefined || v === "") ? fallback : v;
};

const toInt = (v, fallback) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  version: env("BTW_VERSION", "bytheway-facts-only-round50-openai-tts-v1"),
  nodeEnv: env("NODE_ENV", "development"),
  port: toInt(env("PORT", "3000"), 3000),

  // OpenAI
  openaiApiKey: env("OPENAI_API_KEY", ""),
  openaiBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com"),
  openaiTtsModel: env("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
  openaiTtsVoice: env("OPENAI_TTS_VOICE", "coral"),
  openaiTtsResponseFormat: env("OPENAI_TTS_FORMAT", "mp3"),
  openaiTtsSpeed: Number(env("OPENAI_TTS_SPEED", "1.0")),
  openaiTtsInstructions: env(
    "OPENAI_TTS_INSTRUCTIONS",
    "Sound like a witty, friendly tour guide. Keep it clean and not sexual. Avoid graphic violence."
  ),

  googlePlacesApiKey: env("GOOGLE_PLACES_API_KEY", ""),
  databaseUrl: env("DATABASE_URL", ""),
  corsAllowOrigins: env("CORS_ALLOW_ORIGINS", ""),

  wikidataRadiusMeters: toInt(env("WIKIDATA_RADIUS_METERS", "800"), 800),
  wikidataLimit: toInt(env("WIKIDATA_LIMIT", "15"), 15),
  overpassRadiusMeters: toInt(env("OVERPASS_RADIUS_METERS", "1000"), 1000),
  minPoiScoreToSpeak: Number(env("MIN_POI_SCORE_TO_SPEAK", "0.55")),

  safety: {
    disallowSexualContent: true,
    disallowGraphicViolence: true,
  },
};
