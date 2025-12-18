/**
 * Central config for BTW server (ESM).
 * Reads from environment variables.
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
  version: env("BTW_VERSION", "btw-facts-only-round50-better-tts-v1"),
  nodeEnv: env("NODE_ENV", "development"),
  port: toInt(env("PORT", "3000"), 3000),

  // API keys
  openaiApiKey: env("OPENAI_API_KEY", ""),
  elevenLabsApiKey: env("ELEVENLABS_API_KEY", ""),
  elevenLabsVoiceId: env("ELEVENLABS_VOICE_ID", ""),
  elevenLabsModelId: env("ELEVENLABS_MODEL_ID", "eleven_turbo_v2_5"),

  // Optional Google Places key (not required for the Wikidata-first pipeline)
  googlePlacesApiKey: env("GOOGLE_PLACES_API_KEY", ""),

  // Postgres
  databaseUrl: env("DATABASE_URL", ""),

  // CORS (comma separated origins). Use "*" only if you truly need it.
  corsAllowOrigins: env("CORS_ALLOW_ORIGINS", ""),

  // POI / facts
  wikidataRadiusMeters: toInt(env("WIKIDATA_RADIUS_METERS", "800"), 800),
  wikidataLimit: toInt(env("WIKIDATA_LIMIT", "15"), 15),
  overpassRadiusMeters: toInt(env("OVERPASS_RADIUS_METERS", "1000"), 1000),
  minPoiScoreToSpeak: Number(env("MIN_POI_SCORE_TO_SPEAK", "0.55")),

  // Safety: keep content teen-safe
  safety: {
    disallowSexualContent: true,
    disallowGraphicViolence: true,
  },

  // TTS defaults
  tts: {
    outputFormat: env("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
    voiceSettings: {
      stability: Number(env("ELEVENLABS_STABILITY", "0.4")),
      similarity_boost: Number(env("ELEVENLABS_SIMILARITY_BOOST", "0.8")),
      style: Number(env("ELEVENLABS_STYLE", "0.35")),
      use_speaker_boost: env("ELEVENLABS_SPEAKER_BOOST", "true") === "true",
    },
  },
};
