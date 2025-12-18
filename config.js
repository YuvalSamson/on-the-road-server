/**
 * config.js (ESM)
 */

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || String(v).trim() === "" ? fallback : String(v).trim();
}

function envInt(name, fallback) {
  const v = parseInt(env(name, ""), 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  // server
  port: envInt("PORT", 10000),
  version: env("APP_VERSION", "btw-facts-only-round50-better-tts-v1"),
  corsAllowOrigins: env("CORS_ALLOW_ORIGINS", "*"),

  // OpenAI
  openaiApiKey: env("OPENAI_API_KEY", ""),
  openaiBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com"),

  // Google (Geocoding + Places)
  googleMapsApiKey: env("GOOGLE_MAPS_API_KEY", ""), // optional but recommended
  googlePlacesApiKey: env("GOOGLE_PLACES_API_KEY", ""), // optional, if empty we reuse googleMapsApiKey

  // OSM fallback
  osmNominatimBaseUrl: env(
    "OSM_NOMINATIM_BASE_URL",
    "https://nominatim.openstreetmap.org"
  ),
  osmUserAgent: env("OSM_USER_AGENT", "bytheway/1.0 (contact: you@example.com)"),

  // Geo cache (memory cache)
  geoCacheTtlMs: envInt("GEO_CACHE_TTL_MS", 6 * 60 * 60 * 1000), // 6h
  httpTimeoutMs: envInt("HTTP_TIMEOUT_MS", 6500),

  // POI behavior
  poiRadiusMeters: envInt("POI_RADIUS_METERS", 650),
  poiMaxCandidates: envInt("POI_MAX_CANDIDATES", 12),
};
