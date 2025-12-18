/**
 * OpenAI TTS via Audio API (ESM).
 */
import { config } from "./config.js";
import { HttpError, sanitizeForTts, safeTrim, clamp } from "./utils.js";

function requireOpenAIKey() {
  if (!config.openaiApiKey) throw new HttpError(500, "Missing OPENAI_API_KEY");
}

function contentTypeFor(format) {
  const f = String(format || "mp3").toLowerCase();
  if (f === "mp3") return "audio/mpeg";
  if (f === "wav") return "audio/wav";
  if (f === "aac") return "audio/aac";
  if (f === "opus") return "audio/opus";
  if (f === "flac") return "audio/flac";
  if (f === "pcm") return "audio/pcm";
  return "application/octet-stream";
}

export function getTtsContentType() {
  return contentTypeFor(config.openaiTtsResponseFormat);
}

export async function synthesizeTts(text, opts = {}) {
  requireOpenAIKey();

  const cleaned = sanitizeForTts(safeTrim(text, 3900), {
    disallowSexualContent: config.safety.disallowSexualContent,
  });
  if (!cleaned) throw new HttpError(400, "Empty TTS text after sanitization");

  const model = opts.model || config.openaiTtsModel;
  const voice = opts.voice || config.openaiTtsVoice;
  const response_format = opts.responseFormat || config.openaiTtsResponseFormat;

  const speedRaw = (opts.speed ?? config.openaiTtsSpeed);
  const speed = clamp(Number(speedRaw), 0.25, 4.0);

  const instructions = opts.instructions ?? config.openaiTtsInstructions;

  const url = `${config.openaiBaseUrl}/v1/audio/speech`;

  const payload = {
    model,
    voice,
    input: cleaned,
    response_format,
    speed,
    ...(instructions ? { instructions } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const maybeText = await res.text().catch(() => "");
    throw new HttpError(res.status, "OpenAI TTS failed", safeTrim(maybeText, 900));
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export function audioToBase64(audioBuf) {
  return audioBuf.toString("base64");
}
