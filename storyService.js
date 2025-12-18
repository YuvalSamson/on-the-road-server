/**
 * Story generation (ESM).
 * Uses a safe, template-based generator.
 * If OPENAI_API_KEY is available and you later want to use it, you can extend here.
 */
import { safeTrim } from "./utils.js";

function pickOne(arr, fallback = "") {
  if (!arr || arr.length === 0) return fallback;
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateStoryText({ poi, taste }) {
  const name = poi?.label || "this place";
  const desc = poi?.summary?.description || poi?.description || "";
  const extract = poi?.summary?.extract || pickOne(poi?.facts || [], "");

  const humor = taste?.humor ?? 0.6;     // 0..1
  const nerdy = taste?.nerdy ?? 0.5;     // 0..1
  const dramatic = taste?.dramatic ?? 0.35; // 0..1
  const shortness = taste?.shortness ?? 0.4; // 0..1 (1=short)

  const openers = [
    `Quick detour: you're near ${name}.`,
    `Heads up: ${name} is close by.`,
    `Okay, story time. You're near ${name}.`,
  ];

  const spice = [];
  if (humor > 0.65) spice.push("Try not to pretend you already knew this.");
  if (nerdy > 0.65) spice.push("Yes, this is your officially-approved nerd moment.");
  if (dramatic > 0.65) spice.push("This is where reality quietly becomes a movie scene.");

  const cta = [
    "If you can, look around for a small detail that proves it really exists outside your screen.",
    "If you're passing by, give it one glance. Your future self will appreciate it.",
    "If you're stuck in traffic, congratulations: you just earned a free fun fact.",
  ];

  const bodyParts = [];

  if (desc) bodyParts.push(`${name} is best described as: ${desc}.`);
  if (extract) bodyParts.push(safeTrim(extract, 700));

  if (dramatic > 0.55) {
    bodyParts.push(pickOne([
      `Imagine all the years this spot has been watching people come and go.`,
      `Places like this outlive trends, arguments, and most phone batteries.`,
    ]));
  }

  if (nerdy > 0.55) {
    bodyParts.push(pickOne([
      `If you want to go deeper later, check its Wikipedia page and scan the timeline.`,
      `Small challenge: later, look up one surprising date connected to it.`,
    ]));
  }

  const maxBody = shortness > 0.7 ? 2 : (shortness > 0.4 ? 3 : 4);
  const body = bodyParts.filter(Boolean).slice(0, maxBody).join(" ");

  const outro = pickOne(cta);
  const extra = spice.length ? " " + pickOne(spice) : "";

  return `${pickOne(openers)} ${body} ${outro}${extra}`.replace(/\s+/g, " ").trim();
}
