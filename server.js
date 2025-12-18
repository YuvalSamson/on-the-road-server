/**
 * BTW server entry (ESM).
 */
import express from "express";
import cors from "cors";

import { config } from "./config.js";
import { initDb, logStory } from "./db.js";
import { makeLogger, assertFiniteNumber } from "./utils.js";
import { findBestPoi } from "./poiService.js";
import { generateStoryText } from "./storyService.js";
import { synthesizeTts, audioToBase64 } from "./tts.js";
import { getOrCreateTasteProfile, applyFeedback, saveTasteProfile, normalizeTasteInput } from "./tasteService.js";

const log = makeLogger("BTW");
const app = express();

app.use(express.json({ limit: "1mb" }));

// CORS
if (config.corsAllowOrigins && config.corsAllowOrigins !== "*") {
  const allowed = new Set(config.corsAllowOrigins.split(",").map((s) => s.trim()).filter(Boolean));
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return cb(null, allowed.has(origin));
    },
  }));
} else {
  app.use(cors({ origin: true }));
}

app.get("/health", (req, res) => {
  res.status(200).send(config.version);
});

app.post("/api/story-both", async (req, res) => {
  const startedAt = Date.now();

  try {
    const lat = assertFiniteNumber(req.body?.lat, "lat");
    const lng = assertFiniteNumber(req.body?.lng, "lng");
    const userId = req.body?.userId ? String(req.body.userId) : null;
    const tasteProfileId = req.body?.tasteProfileId ? String(req.body.tasteProfileId) : null;

    const { id: tpId, taste } = await getOrCreateTasteProfile({ userId, tasteProfileId });

    const poiPick = await findBestPoi({ lat, lng, userId });

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
        distanceMetersApprox: poiPick.distanceMetersApprox,
        poi: poiPick.poi,
      });
    }

    const poi = poiPick.poiWithFacts;
    const storyText = generateStoryText({ poi, taste });

    const audioBuf = await synthesizeTts(storyText);
    const audioBase64 = audioToBase64(audioBuf);

    await logStory({
      userId,
      lat,
      lng,
      poiKey: poi.key ?? null,
      poiName: poi.label ?? null,
      poiSource: poi.source ?? null,
      distanceMeters: poi.distanceMetersApprox ?? null,
      shouldSpeak: true,
      reason: "ok",
      tasteProfileId: tpId,
      storyLen: storyText.length,
    });

    const ms = Date.now() - startedAt;

    res.status(200).json({
      version: config.version,
      shouldSpeak: true,
      reason: "ok",
      distanceMetersApprox: poi.distanceMetersApprox ?? null,
      poi: {
        key: poi.key,
        source: poi.source,
        label: poi.label,
        description: poi.description ?? null,
        wikipediaUrl: poi.wikipediaUrl ?? null,
        imageUrl: poi.imageUrl ?? null,
      },
      facts: (poi.facts || []).slice(0, 6),
      storyText,
      audio: {
        contentType: "audio/mpeg",
        base64: audioBase64,
        bytes: audioBuf.length,
      },
      timingMs: ms,
    });
  } catch (err) {
    log.error("story-both error:", err?.status, err?.message, err?.details || "");
    const status = err?.status && Number.isFinite(err.status) ? err.status : 500;
    res.status(status).json({
      version: config.version,
      error: err?.message || "Server error",
      details: err?.details || null,
    });
  }
});

app.post("/api/taste/feedback", async (req, res) => {
  try {
    const userId = req.body?.userId ? String(req.body.userId) : null;
    const tasteProfileId = req.body?.tasteProfileId ? String(req.body.tasteProfileId) : null;

    const { id: tpId, taste } = await getOrCreateTasteProfile({ userId, tasteProfileId });

    const feedback = {
      liked: req.body?.liked === true,
      moreHumor: req.body?.moreHumor,
      moreNerdy: req.body?.moreNerdy,
      shorter: req.body?.shorter,
      moreDramatic: req.body?.moreDramatic,
    };

    const updated = applyFeedback(taste, feedback);
    await saveTasteProfile(tpId, updated);

    res.status(200).json({ ok: true, tasteProfileId: tpId, taste: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
});

app.post("/api/taste/set", async (req, res) => {
  try {
    const tasteProfileId = req.body?.tasteProfileId ? String(req.body.tasteProfileId) : null;
    if (!tasteProfileId) return res.status(400).json({ ok: false, error: "tasteProfileId is required" });

    const taste = normalizeTasteInput(req.body?.taste || {});
    await saveTasteProfile(tasteProfileId, taste);

    res.status(200).json({ ok: true, tasteProfileId, taste });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "Server error" });
  }
});

async function main() {
  await initDb().catch((e) => log.warn("DB init skipped/failed:", e?.message || e));

  app.listen(config.port, () => {
    log.info(`Listening on port ${config.port}`);
    log.info(`Version: ${config.version}`);
  });
}

main().catch((e) => {
  log.error("Fatal:", e);
  process.exit(1);
});
