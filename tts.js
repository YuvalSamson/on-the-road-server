/**
 * tts.js (ESM) - OpenAI Text-to-Speech
 */

import { config } from "./config.js";
import { HttpError, sanitizeForTts, safeTrim } from "./utils.js";

export function getTtsContentType() {
  return "audio/mpeg";
}

export function audioToBase64(buf) {
  return Buffer.from(buf).toString("base64");
}

function requireOpenAIKey() {
  if (!config.openaiApiKey) throw new HttpError(500, "Missing OPENAI_API_KEY");
}

function getTtsModel() {
  // Required by OpenAI TTS API
  return process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
}

function getTtsVoice() {
  return process.env.OPENAI_TTS_VOICE || "coral";
}

/**
 * @param {string} text
 * @param {{lang?: string}} opts
 * @returns {Promise<Buffer>}
 */
export async function synthesizeTts(text, opts = {}) {
  requireOpenAIKey();

  const cleaned = sanitizeForTts(safeTrim(text, 3900), {
    disallowSexualContent: config.safety?.disallowSexualContent ?? true,
  });
  if (!cleaned) throw new HttpError(400, "Empty TTS text after sanitization");

  const url = `${config.openaiBaseUrl}/v1/audio/speech`;

  const payload = {
    model: getTtsModel(), // <- THIS fixes your current 400
    input: cleaned,
    voice: getTtsVoice(),
    format: "mp3",
    // optional:
    // instructions: "Speak clearly and naturally.",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new HttpError(res.status, "OpenAI TTS failed", safeTrim(t, 1500));
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
