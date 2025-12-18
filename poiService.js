/**
 * Pick best POI and decide if we should speak (ESM).
 */
import { config } from "./config.js";
import { haversineMeters, clamp } from "./utils.js";
import { queryWikidataNearby, queryOverpassWikipediaTagged, getFactsForPoiCandidate } from "./wikiService.js";
import { wasPoiRecentlyServed } from "./db.js";

function scorePoi(poi) {
  // Score 0..1
  const dist = poi.distanceMetersApprox ?? 9999;
  const distScore = clamp(1 - (dist / 1200), 0, 1);

  const hasWiki = poi.wikipediaUrl || poi.wikipediaTitle ? 1 : 0;
  const hasDesc = poi.description ? clamp(poi.description.length / 120, 0, 1) : 0;

  // Bias towards Wikipedia-backed items
  const base = 0.55 * distScore + 0.35 * hasWiki + 0.10 * hasDesc;
  return clamp(base, 0, 1);
}

function reasonNoStrongPoi(bestScore) {
  if (bestScore < config.minPoiScoreToSpeak) return "no_strong_poi";
  return "unknown";
}

export async function findBestPoi({ lat, lng, userId = null }) {
  // First: Wikidata
  const candidates = await queryWikidataNearby({
    lat,
    lng,
    radiusMeters: config.wikidataRadiusMeters,
    limit: config.wikidataLimit,
  });

  let scored = candidates
    .map((p) => ({ ...p, score: scorePoi(p) }))
    .sort((a, b) => b.score - a.score);

  // If weak, try Overpass fallback (OSM wikipedia tags)
  if (!scored[0] || scored[0].score < config.minPoiScoreToSpeak) {
    const osm = await queryOverpassWikipediaTagged({ lat, lng, radiusMeters: config.overpassRadiusMeters });
    const osmScored = osm.map((p) => {
      const d = (p.lat && p.lng) ? haversineMeters(lat, lng, p.lat, p.lng) : 9999;
      return {
        ...p,
        distanceMetersApprox: Math.round(d),
        score: clamp(0.50 * clamp(1 - (d / 1500), 0, 1) + 0.50, 0, 1), // wiki tag gives base score
      };
    }).sort((a, b) => b.score - a.score);

    scored = osmScored.concat(scored).sort((a, b) => b.score - a.score);
  }

  const best = scored[0] || null;
  const bestScore = best?.score ?? 0;

  if (!best || bestScore < config.minPoiScoreToSpeak) {
    return {
      shouldSpeak: false,
      reason: reasonNoStrongPoi(bestScore),
      distanceMetersApprox: best?.distanceMetersApprox ?? null,
      poi: best,
      poiWithFacts: null,
    };
  }

  // Avoid repeating same POI too frequently for the same user (if DB enabled)
  if (userId && best.key) {
    const recently = await wasPoiRecentlyServed({ userId, poiKey: best.key, withinMinutes: 120 });
    if (recently) {
      return {
        shouldSpeak: false,
        reason: "recently_served_poi",
        distanceMetersApprox: best.distanceMetersApprox ?? null,
        poi: best,
        poiWithFacts: null,
      };
    }
  }

  const withFacts = await getFactsForPoiCandidate(best);

  // If still no facts, treat as weak
  const factsCount = (withFacts.facts || []).filter(Boolean).length;
  if (factsCount === 0) {
    return {
      shouldSpeak: false,
      reason: "no_facts",
      distanceMetersApprox: withFacts.distanceMetersApprox ?? null,
      poi: best,
      poiWithFacts: withFacts,
    };
  }

  return {
    shouldSpeak: true,
    reason: "ok",
    distanceMetersApprox: withFacts.distanceMetersApprox ?? null,
    poi: best,
    poiWithFacts: withFacts,
  };
}
