/**
 * Postgres helpers (ESM).
 * If DATABASE_URL is empty, we run in "no-db" mode (in-memory only).
 *
 * Render Postgres often requires SSL/TLS.
 * Control:
 *   DB_SSL=false   to disable SSL (default is SSL enabled)
 */
import pg from "pg";
import { config } from "./config.js";
import { nowIso, sha1 } from "./utils.js";

const { Pool } = pg;

let pool = null;

export function hasDb() {
  return Boolean(config.databaseUrl);
}

function shouldUseSsl() {
  const raw = process.env.DB_SSL;
  if (raw === "false" || raw === "0") return false;
  return true;
}

export function getPool() {
  if (!hasDb()) return null;

  if (!pool) {
    const useSsl = shouldUseSsl();
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  return pool;
}

export async function initDb() {
  const p = getPool();
  if (!p) return;

  await p.query(`
    CREATE TABLE IF NOT EXISTS taste_profiles (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      data JSONB NOT NULL
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS story_logs (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      user_id TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      poi_key TEXT,
      poi_name TEXT,
      poi_source TEXT,
      distance_meters DOUBLE PRECISION,
      should_speak BOOLEAN,
      reason TEXT,
      taste_profile_id TEXT,
      story_len INTEGER
    );
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS story_logs_user_poi_idx
    ON story_logs(user_id, poi_key, created_at DESC);
  `);
}

export async function getTasteProfile(id) {
  const p = getPool();
  if (!p) return null;
  const res = await p.query("SELECT data FROM taste_profiles WHERE id = $1", [id]);
  return res.rows[0]?.data ?? null;
}

export async function upsertTasteProfile(id, data) {
  const p = getPool();
  if (!p) return;
  const ts = nowIso();
  await p.query(
    `
    INSERT INTO taste_profiles (id, created_at, updated_at, data)
    VALUES ($1, $2, $2, $3)
    ON CONFLICT (id) DO UPDATE SET updated_at = $2, data = $3
    `,
    [id, ts, JSON.stringify(data)]
  );
}

export async function logStory({
  userId,
  lat,
  lng,
  poiKey,
  poiName,
  poiSource,
  distanceMeters,
  shouldSpeak,
  reason,
  tasteProfileId,
  storyLen,
}) {
  const p = getPool();
  if (!p) return;

  const id = sha1([
    nowIso(),
    userId ?? "",
    String(lat ?? ""),
    String(lng ?? ""),
    poiKey ?? "",
    String(Math.random()),
  ].join("|"));

  await p.query(
    `
    INSERT INTO story_logs (
      id, created_at, user_id, lat, lng,
      poi_key, poi_name, poi_source,
      distance_meters, should_speak, reason,
      taste_profile_id, story_len
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `,
    [
      id,
      nowIso(),
      userId ?? null,
      lat ?? null,
      lng ?? null,
      poiKey ?? null,
      poiName ?? null,
      poiSource ?? null,
      distanceMeters ?? null,
      shouldSpeak ?? null,
      reason ?? null,
      tasteProfileId ?? null,
      storyLen ?? null,
    ]
  );
}

export async function wasPoiRecentlyServed({ userId, poiKey, withinMinutes = 120 }) {
  const p = getPool();
  if (!p || !userId || !poiKey) return false;

  const res = await p.query(
    `
    SELECT 1
    FROM story_logs
    WHERE user_id = $1 AND poi_key = $2 AND should_speak = true
      AND created_at > (NOW() - ($3 || ' minutes')::INTERVAL)
    LIMIT 1
    `,
    [userId, poiKey, String(withinMinutes)]
  );
  return res.rowCount > 0;
}
