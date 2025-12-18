/**
 * ElevenLabs TTS (ESM). Returns audio Buffer.
 */
import { config } from "./config.js";
import { HttpError, sanitizeForTts, safeTrim } from "./utils.js";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

function requireElevenKey() {
  if (!config.elevenLabsApiKey) {
    throw new HttpError(500, "Missing ELEVENLABS_API_KEY");
  }
  if (!config.elevenLabsVoiceId) {
    throw new HttpError(500, "Missing ELEVENLABS_VOICE_ID");
  }
}

export async function synthesizeTts(text, opts = {}) {
  requireElevenKey();

  const cleaned = sanitizeForTts(safeTrim(text, 4000), {
    disallowSexualContent: config.safety.disallowSexualContent,
  });

  if (!cleaned) {
    throw new HttpError(400, "Empty TTS text after sanitization");
  }

  const voiceId = opts.voiceId || config.elevenLabsVoiceId;
  const modelId = opts.modelId || config.elevenLabsModelId;

  const url = `${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`;

  const payload = {
    text: cleaned,
    model_id: modelId,
    voice_settings: opts.voiceSettings || config.tts.voiceSettings,
    output_format: opts.outputFormat || config.tts.outputFormat,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": config.elevenLabsApiKey,
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const maybeText = await res.text().catch(() => "");
    throw new HttpError(res.status, "ElevenLabs TTS failed", safeTrim(maybeText, 800));
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export function audioToBase64(audioBuf) {
  return audioBuf.toString("base64");
}
