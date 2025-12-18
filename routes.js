import express from "express";

import { CONFIG } from "./config.js";
import { getUserKeyFromRequest, normalizeLanguage } from "./user.js";

import { getNearbyPois } from "./poi/poiService.js";
import { pickBestPoiForUser } from "./poi/picker.js";

import { generateBtwStory } from "./story/storyGenerator.js";
import { ttsWithOpenAI } from "./tts/tts.js";

import {
  dbMarkHeard,
  dbInsertFeedback,
  dbGetRecentFeedback,
  dbGetTasteProfile,
} from "./db.js";
import { updateTasteProfileFromFeedback } from "./taste/tasteModel.js";

export function createRoutes() {
  const router = express.Router();

  // Health
  router.get("/health", (req, res) => {
    res.json({
      status: "ok",
      build: "btw-modular-wikipedia-strong-v1",
    });
  });

  // Debug: places
  router.get("/places", async (req, res) => {
    try {
      const { lat, lng, radius, mode, language } = req.query;

      if (!lat || !lng) {
        return res
          .status(400)
          .json({ error: "lat and lng query params are required" });
      }

      const radiusMeters = radius ? Number(radius) : 900;
      const m = typeof mode === "string" ? mode : "interesting";
      const lang = normalizeLanguage(typeof language === "string" ? language : "he");

      const pois = await getNearbyPois(
        Number(lat),
        Number(lng),
        radiusMeters,
        m,
        lang
      );
      res.json({ pois });
    } catch (err) {
      console.error("Error in /places:", err);
      res.status(500).json({ error: "failed_to_fetch_places" });
    }
  });

  // Main API: story + audio
  router.post("/api/story-both", async (req, res) => {
    try {
      const { lat, lng } = req.body;
      const prompt =
        typeof req.body?.prompt === "string" ? req.body.prompt : "";
      const language = normalizeLanguage(req.body?.language);

      const userKey = getUserKeyFromRequest(req);

      if (typeof lat !== "number" || typeof lng !== "number") {
        return res.json({ shouldSpeak: false, reason: "location_missing", language });
      }

      // Expanding radii
      let best = null;
      for (const r of CONFIG.RADIUS_STEPS) {
        const pois = await getNearbyPois(lat, lng, r, "interesting", language);
        best = await pickBestPoiForUser(pois, lat, lng, userKey, language);
        if (best) break;
      }

      if (!best || !best.poi) {
        return res.json({ shouldSpeak: false, reason: "no_strong_poi", language });
      }

      // Generate story text (facts-first, more Wikipedia, longer)
      const story = await generateBtwStory({
        poi: best.poi,
        distanceMetersExact: best.distanceMeters,
        distanceMetersApprox: best.distanceMetersApprox,
        language,
        userKey,
        prompt,
        minWords: CONFIG.BTW_MIN_WORDS,
        maxWords: CONFIG.BTW_MAX_WORDS,
        facts: best.facts || [],
        sources: best.sources || [],
      });

      if (!story?.text || typeof story.text !== "string" || story.text.trim() === "") {
        return res.json({ shouldSpeak: false, reason: "model_no_story", language });
      }

      const storyText = story.text.trim();

      // TTS
      const { audioBase64, voiceId, voiceIndex, voiceKey } =
        await ttsWithOpenAI(storyText, language);

      // Mark heard
      await dbMarkHeard(userKey, best.poi.id);

      res.json({
        shouldSpeak: true,
        text: storyText,
        audioBase64,
        voiceId,
        voiceIndex,
        voiceKey,
        language,

        poiId: best.poi.id,
        poiName: best.poi.name,
        poiSource: best.poi.source,

        distanceMetersApprox: best.distanceMetersApprox,
        factsUsed: Array.isArray(story.factsUsed) ? story.factsUsed : [],
        sources: Array.isArray(story.sources)
          ? story.sources
          : Array.isArray(best.sources)
          ? best.sources
          : [],

        debug: story.debug || null,
      });
    } catch (err) {
      console.error("Error in /api/story-both:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Feedback from client (like/dislike/rating/tags/note)
  router.post("/api/feedback", async (req, res) => {
    try {
      const userKey = getUserKeyFromRequest(req);

      const poiId = typeof req.body?.poiId === "string" ? req.body.poiId.trim() : "";
      const storyText = typeof req.body?.storyText === "string" ? req.body.storyText : "";
      const liked = typeof req.body?.liked === "boolean" ? req.body.liked : null;

      const ratingRaw = req.body?.rating;
      const rating =
        typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
          ? Math.max(1, Math.min(5, Math.round(ratingRaw)))
          : null;

      const tags = Array.isArray(req.body?.tags)
        ? req.body.tags
            .map((t) => String(t).trim())
            .filter(Boolean)
            .slice(0, 12)
        : null;

      const note =
        typeof req.body?.note === "string"
          ? req.body.note.trim().slice(0, 800)
          : null;

      const poi = req.body?.poi && typeof req.body.poi === "object" ? req.body.poi : null;
      const facts = Array.isArray(req.body?.facts) ? req.body.facts.slice(0, 60) : [];

      if (!poiId) return res.status(400).json({ error: "poiId is required" });
      if (!storyText) return res.status(400).json({ error: "storyText is required" });

      const storyHash = await updateTasteProfileFromFeedback({
        userKey,
        poiId,
        storyText,
        liked,
        rating,
        tags,
        note,
        poi,
        facts,
      });

      await dbInsertFeedback({
        userKey,
        poiId,
        storyHash,
        liked,
        rating,
        tags,
        note,
      });

      res.json({ ok: true, storyHash });
    } catch (err) {
      console.error("Error in /api/feedback:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Taste profile snapshot
  router.get("/api/taste", async (req, res) => {
    try {
      const userKey = getUserKeyFromRequest(req);
      const profile = await dbGetTasteProfile(userKey);
      const recentFeedback = await dbGetRecentFeedback(userKey, 50);

      res.json({
        userKey,
        profile: profile || null,
        recentFeedback,
      });
    } catch (err) {
      console.error("Error in /api/taste:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
