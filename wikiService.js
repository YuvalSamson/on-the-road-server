/**
 * Wikidata + Wikipedia + Overpass fallback services (ESM).
 *
 * Primary flow:
 * 1) Query Wikidata SPARQL for nearby entities.
 * 2) For the best candidates, fetch a short Wikipedia summary (if an enwiki link exists).
 *
 * Fallback flow:
 * - Query Overpass for OSM objects with a wikipedia tag around the location
 * - Pull Wikipedia summaries for those titles
 */
import { config } from "./config.js";
import { HttpError, jsonOk, safeTrim, sleep } from "./utils.js";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const WIKI_SUMMARY_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

function userAgent() {
  return "BTW/1.0 (contact: you@example.com)";
}

export async function queryWikidataNearby({ lat, lng, radiusMeters, limit }) {
  const r = radiusMeters ?? config.wikidataRadiusMeters;
  const lim = limit ?? config.wikidataLimit;

  // Note: SERVICE wikibase:around provides distance in kilometers by default via wikibase:distance
  const sparql = `
    SELECT ?item ?itemLabel ?itemDescription ?article ?image ?dist WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?location .
        bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${(r / 1000).toFixed(3)}" .
        bd:serviceParam wikibase:distance ?dist .
      }
      OPTIONAL { ?article schema:about ?item ;
                        schema:isPartOf <https://en.wikipedia.org/> . }
      OPTIONAL { ?item wdt:P18 ?image . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    ORDER BY ?dist
    LIMIT ${lim}
  `.trim();

  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(sparql)}`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/sparql-results+json",
      "User-Agent": userAgent(),
    },
  });

  if (!res.ok) throw new HttpError(res.status, "Wikidata SPARQL failed");

  const data = await res.json().catch(() => null);
  if (!data?.results?.bindings) return [];

  return data.results.bindings.map((b) => {
    const itemUrl = b.item?.value || "";
    const qid = itemUrl.split("/").pop() || "";
    const label = b.itemLabel?.value || "";
    const desc = b.itemDescription?.value || "";
    const article = b.article?.value || "";
    const image = b.image?.value || "";
    const distKm = Number(b.dist?.value || "9999");
    return {
      source: "wikidata",
      key: qid ? `wd:${qid}` : itemUrl,
      qid,
      label,
      description: desc,
      wikipediaUrl: article || null,
      imageUrl: image || null,
      distanceMetersApprox: Math.round(distKm * 1000),
    };
  });
}

export async function fetchWikipediaSummaryByUrl(wikipediaUrl) {
  if (!wikipediaUrl) return null;
  try {
    const u = new URL(wikipediaUrl);
    const title = u.pathname.split("/").pop() || "";
    return await fetchWikipediaSummaryByTitle(decodeURIComponent(title));
  } catch {
    return null;
  }
}

export async function fetchWikipediaSummaryByTitle(title) {
  const t = safeTrim(title, 200);
  if (!t) return null;

  const url = `${WIKI_SUMMARY_BASE}${encodeURIComponent(t)}`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": userAgent(),
    },
  });

  if (!res.ok) return null;
  if (!jsonOk(res)) return null;

  const data = await res.json().catch(() => null);
  if (!data) return null;

  return {
    title: data.title || t,
    extract: data.extract || "",
    description: data.description || "",
    thumbnail: data.thumbnail?.source || null,
    pageUrl: data.content_urls?.desktop?.page || null,
  };
}

export async function queryOverpassWikipediaTagged({ lat, lng, radiusMeters }) {
  const r = radiusMeters ?? config.overpassRadiusMeters;

  const q = `
    [out:json][timeout:20];
    (
      node(around:${r},${lat},${lng})["wikipedia"];
      way(around:${r},${lat},${lng})["wikipedia"];
      relation(around:${r},${lat},${lng})["wikipedia"];
    );
    out tags center 25;
  `.trim();

  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": userAgent(),
    },
    body: q,
  });

  if (!res.ok) return [];

  const data = await res.json().catch(() => null);
  const els = data?.elements || [];
  const out = [];

  for (const el of els) {
    const wikiTag = el.tags?.wikipedia;
    if (!wikiTag) continue;

    // Common formats: "en:Title", "Title"
    const parts = String(wikiTag).split(":");
    const lang = parts.length > 1 ? parts[0] : "en";
    const title = parts.length > 1 ? parts.slice(1).join(":") : parts[0];

    if (lang !== "en") continue;

    out.push({
      source: "osm",
      key: `osm:${el.type}:${el.id}`,
      label: el.tags?.name || title,
      wikipediaTitle: title,
      lat: el.lat ?? el.center?.lat ?? null,
      lng: el.lon ?? el.center?.lon ?? null,
    });
  }

  return out.slice(0, 12);
}

export async function getFactsForPoiCandidate(poi) {
  // Rate limit a bit to be polite to Wikipedia in burst mode.
  await sleep(80);

  const summary =
    poi.wikipediaUrl
      ? await fetchWikipediaSummaryByUrl(poi.wikipediaUrl)
      : (poi.wikipediaTitle ? await fetchWikipediaSummaryByTitle(poi.wikipediaTitle) : null);

  if (!summary) return { ...poi, facts: [], summary: null };

  // Facts extraction: keep it simple and robust.
  const facts = [];
  const extract = safeTrim(summary.extract, 1200);

  if (summary.description) facts.push(summary.description);
  if (extract) facts.push(extract);

  return {
    ...poi,
    summary,
    facts,
    wikipediaUrl: poi.wikipediaUrl || summary.pageUrl || null,
    imageUrl: poi.imageUrl || summary.thumbnail || null,
  };
}
