/**
 * BYTHEWAY server entry (ESM)
 */

import express from "express";
import cors from "cors";

import { config } from "./config.js";
import { initDb, logStory } from "./db.js";
import { makeLogger, assertFiniteNumber } from "./utils.js";
import { findBestPoi } from "./poiService.js";
import { generateStoryText } from "./storyService.js";
import { synthesizeTts, audioToBase64, getTtsContentType } from "./tts.js";
import {
  getOrCreateTasteProfile,
  applyFeedback,
  saveTasteProfile,
  normalizeTasteInput,
} from "./tasteService.js";

const log = makeLogger("BYTHEWAY");
const app = express();

app.use(express.json({ limit: "1mb" }));

// CORS
if (config.corsAllowOrigins && config.corsAllowOrigins !== "*") {
  const allowed = new Set(
    config.corsAllowOrigins
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        return cb(null, allowed.has(origin));
      },
    })
  );
} else {
  app.use(cors({ origin: true }));
}

app.get("/health", (req, res) => {
  res.status(200).send(config.version);
});

function normalizeTasteForSafety(taste) {
  const t = taste && typeof taste === "object" ? taste : {};
  const safety = t.safety && typeof t.safety === "object" ? t.safety : {};

  const disallowSexualContent =
    safety.disallowSexualContent ?? t.disallowSexualContent ?? true;

  return {
    ...t,
    safety: {
      ...safety,
      disallowSexualContent,
    },
    disallowSexualContent,
  };
}

app.post("/api/story-both", async (req, res) => {
  const startedAt = Date.now();

  try {
    // Accept multiple key names and comma-decimal strings
    const latRaw = req.body?.lat ?? req.body?.latitude ?? req.body?.Latitude;
    const lngRaw =
      req.body?.lng ??
      req.body?.lon ??
      req.body?.longitude ??
      req.body?.Longitude;

    const lat = assertFiniteNumber(latRaw, "lat");
    const lng = assertFiniteNumber(lngRaw, "lng");

    // App sends language code like "he" / "en" / "fr"
    const langRaw =
      req.body?.lang ??
      req.body?.language ??
      req.body?.locale ??
      req.body?.speechLang ??
      "en";
    const lang = String(langRaw).toLowerCase().slice(0, 5);

    const userId = req.body?.userId ? String(req.body.userId) : null;
    const tasteProfileId = req.body?.tasteProfileId
      ? String(req.body.tasteProfileId)
      : null;

    const { id: tpId, taste } = await getOrCreateTasteProfile({
      userId,
      tasteProfileId,
    });

    // CRITICAL: ensure taste.safety exists so no module can crash on it
    const safeTaste = normalizeTasteForSafety(taste);

    const poiPick = await findBestPoi({ lat, lng, userId, lang });

    if (!poiPick.shouldSpeak) {
      await logStory({
        userId,
        lat,
        lng,
        poiKey: poiPick.poi?.key ?? null,
        poiName: poiPick.poi?.label ?? null,
        poiSource: poiPick.poi?.source ?? null,
        distanceMeters: poiPick.distanceMetersApprox ?? null,
        shouldSpeak: false,
        reason: poiPick.reason,
        tasteProfileId: tpId,
        storyLen: 0,
      });

      return res.status(200).json({
        version: config.version,
        shouldSpeak: false,
        reason: poiPick.reason,
        distanceMetersApprox: poiPick.distanceMetersApprox ?? null,
        poi: poiPick.poi ?? null,
        lang,

        text: "",
        storyText: "",
        audioBase64: "",
        audioContentType: "",
        audio: null,
      });
    }

    const poi = poiPick.poiWithFacts;

    const storyText = await generateStoryText({
      poi,
      taste: safeTaste,
      lang,
    });

    const audioBuf = await synthesizeTts(storyText, { lang });
    const audioBase64 = audioToBase64(audioBuf);
    const audioContentType = getTtsContentType();

    await logStory({
      userId,
      lat,
      lng,
      poiKey: poi.key ?? null,
      poiName: poi.label ?? null,
      poiSource: poi.source ?? null,
      distanceMeters: poi.distanceMetersApprox ?? null,
      shouldSpeak: true,
      reason: poiPick.reason || "ok",
      tasteProfileId: tpId,
      storyLen: storyText.length,
    });

    const ms = Date.now() - startedAt;

    return res.status(200).json({
      version: config.version,
      shouldSpeak: true,
      reason: poiPick.reason || "ok",
      distanceMetersApprox: poi.distanceMetersApprox ?? null,
      lang,

      poi: {
        key: poi.key,
        source: poi.source,
        label: poi.label,
        description: poi.description ?? null,
        wikipediaUrl: poi.wikipediaUrl ?? null,
        imageUrl: poi.imageUrl ?? null,
        anchor: poi.anchor ?? null,
      },

      facts: (poi.facts || []).slice(0, 8),

      // Backward compatibility
      text: storyText,
      storyText,

      audioBase64,
      audioContentType,
      audio: {
        contentType: audioContentType,
        base64: audioBase64,
        bytes: audioBuf.length,
      },

      timingMs: ms,
    });
  } catch (err) {
    log.error(
      "story-both error:",
      err?.status,
      err?.message,
      err?.details || ""
    );

    const status =
      err?.status && Number.isFinite(err.status) ? err.status : 500;

    return res.status(status).json({
      version: config.version,
      error: err?.message || "Server error",
      details: err?.details || null,
    });
  }
});

app.post("/api/taste/feedback", async (req, res) => {
  try {
    const userId = req.body?.userId ? String(req.body.userId) : null;
    const tasteProfileId = req.body?.tasteProfileId
      ? String(req.body.tasteProfileId)
      : null;

    const { id: tpId, taste } = await getOrCreateTasteProfile({
      userId,
      tasteProfileId,
    });

    const feedback = {
      liked: req.body?.liked === true,
      moreHumor: req.body?.moreHumor,
      moreNerdy: req.body?.moreNerdy,
      shorter: req.body?.shorter,
      moreDramatic: req.body?.moreDramatic,
    };

    const updated = applyFeedback(taste, feedback);
    await saveTasteProfile(tpId, updated);

    return res
      .status(200)
      .json({ ok: true, tasteProfileId: tpId, taste: updated });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Server error" });
  }
});

app.post("/api/taste/set", async (req, res) => {
  try {
    const tasteProfileId = req.body?.tasteProfileId
      ? String(req.body.tasteProfileId)
      : null;

    if (!tasteProfileId) {
      return res
        .status(400)
        .json({ ok: false, error: "tasteProfileId is required" });
    }

    const taste = normalizeTasteInput(req.body?.taste || {});
    await saveTasteProfile(tasteProfileId, taste);

    return res.status(200).json({ ok: true, tasteProfileId, taste });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Server error" });
  }
});

async function main() {
  await initDb().catch((e) =>
    log.warn("DB init skipped/failed:", e?.message || e)
  );

  app.listen(config.port, () => {
    log.info(`Listening on port ${config.port}`);
    log.info(`Version: ${config.version}`);
  });
}

main().catch((e) => {
  log.error("Fatal:", e);
  process.exit(1);
});
