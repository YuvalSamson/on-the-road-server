/**
 * utils.js (ESM)
 */

import crypto from "crypto";
import { config } from "./config.js";

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function safeTrim(s, maxLen = 400) {
  const str = String(s ?? "");
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

export function makeLogger(prefix) {
  return {
    info: (...args) => console.log(`[${prefix}]`, ...args),
    warn: (...args) => console.warn(`[${prefix}]`, ...args),
    error: (...args) => console.error(`[${prefix}]`, ...args),
  };
}

export function assertFiniteNumber(v, name) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

export function stripCommaSuffix(label) {
  const s = String(label || "").trim();
  if (!s) return s;
  return s.split(",")[0].trim();
}

export function looksLikePersonName(name) {
  const s = normalizeWhitespace(name);
  if (!s) return false;

  const bad =
    /(street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.|דרך|רחוב|שדרות|כיכר|שכונת)/i;
  if (bad.test(s)) return false;

  const parts = s.split(" ").filter(Boolean);
  if (parts.length >= 2) return true;
  if (s.includes("-") && s.length >= 6) return true;
  return false;
}

export async function fetchText(
  url,
  { timeoutMs = config.httpTimeoutMs, headers = {} } = {}
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(
  url,
  { timeoutMs = config.httpTimeoutMs, headers = {}, method = "GET", body = null } = {}
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

// Simple in-memory TTL cache
const _cache = new Map();

export function cacheGet(key) {
  const v = _cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return v.value;
}

export function cacheSet(key, value, ttlMs) {
  _cache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(0, ttlMs || 0),
  });
}
