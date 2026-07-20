/**
 * fal.ai media tools — dynamic pricing (Fase 13.1).
 *
 * Every price below is computed from the tool's OWN args (image size, text
 * length, audio duration, video seconds) using a per-model COGS rate
 * verified against fal.ai's own model pages at implementation time
 * (2026-07-20 — see the per-constant comments for the exact source quote).
 *
 * Formula (per the approved plan):
 *   payPerCall = max(2 × estimatedCogsUsd, $0.02)
 *   prepaid    = payPerCall × 0.75  (≈25% off, same shape as the rest of the
 *                catalog's pay-per-call vs prepaid discount)
 * Both are rounded UP to the nearest milli-USDC ($0.001 = 1000 micro-USDC) so
 * we never under-quote a fractional-cent COGS. All arithmetic is done in
 * integer micro-USDC (bigint) — no floats touch money.
 */

import type { ToolPrice } from "../x402/middleware.js";
import { usdcToMicro, microToUsdc } from "../x402/prepaid.js";

// ---------------------------------------------------------------------------
// Rounding helpers — integer micro-USDC only
// ---------------------------------------------------------------------------

const MILLI_MICRO = 1_000n; // 1 milli-USDC = 1000 micro-USDC (6-decimal base)
const FLOOR_MICRO = 20_000n; // $0.02 floor, matches the rest of the catalog

/** Round a micro-USDC amount UP to the nearest milli-USDC (1000 micro). */
function ceilToMilli(micro: bigint): bigint {
  if (micro <= 0n) return 0n;
  return ((micro + MILLI_MICRO - 1n) / MILLI_MICRO) * MILLI_MICRO;
}

/**
 * Turn an estimated COGS (in micro-USDC) into a { payPerCall, prepaid }
 * ToolPrice, applying the floor + rounding rules above.
 */
export function priceFromCogsMicro(cogsMicro: bigint): ToolPrice {
  const rawPayPerCall = cogsMicro * 2n;
  const payPerCallMicro = ceilToMilli(rawPayPerCall > FLOOR_MICRO ? rawPayPerCall : FLOOR_MICRO);
  // prepaid = 75% of payPerCall, rounded up to the same milli granularity.
  const prepaidMicro = ceilToMilli((payPerCallMicro * 3n) / 4n);
  return {
    payPerCallMicro,
    prepaidMicro,
    payPerCallStr: microToUsdc(payPerCallMicro),
    prepaidStr: microToUsdc(prepaidMicro),
  };
}

/** COGS in micro-USDC from a USD-per-unit rate (as a decimal string) × a unit count. */
export function cogsMicroFromRate(usdPerUnit: number, units: number): bigint {
  // Do the multiplication in micro-USDC integers to avoid float drift:
  // usdPerUnit is a small decimal (e.g. 0.003) — convert via its string form.
  const rateMicro = usdcToMicro(usdPerUnit.toFixed(6));
  // units may be fractional (e.g. audio minutes) — round the final product,
  // never the rate, and always round UP (never under-estimate COGS).
  const product = Number(rateMicro) * units;
  return BigInt(Math.ceil(product));
}

// ---------------------------------------------------------------------------
// FAL_COSTS — verified model catalog + rates
//
// Sources (fetched 2026-07-20 from fal.ai's own model pages, the "Your
// request will cost $X per Y" banner shown on each model's page):
//   - fal-ai/flux/schnell : "$0.003 per megapixel"
//   - fal-ai/flux/dev     : "$0.025 per megapixel"
//   - fal-ai/kokoro/*     : "$0.02 per 1000 character" (per-locale, same rate)
//   - fal-ai/kling-video/v2.6/pro/{text,image}-to-video : "$0.07 per second"
//     (audio off — this integration always requests generate_audio=false to
//     keep the per-second rate deterministic; audio-on is 2x and NOT exposed)
//   - fal-ai/ltx-video-13b-distilled : "$0.04 per video" (flat; this
//     integration locks num_frames=121 @ 24fps ≈ 5s, resolution=480p, no
//     detail-pass/LoRA — the knobs that fal's own docs say change the price)
//   - fal-ai/esrgan and fal-ai/wizper bill by COMPUTE SECOND / are not a
//     fixed rate fal publishes per output unit. For these two, the number
//     below is a documented CONSERVATIVE ASSUMPTION (worst-case runtime),
//     not a first-party fixed price — see the inline comments. The daily
//     budget breaker (src/fal/budget.ts) is the backstop if a real call
//     ever runs hotter than assumed.
// ---------------------------------------------------------------------------

export const FAL_COSTS = {
  image_generate: {
    "flux-schnell": { model: "fal-ai/flux/schnell", usdPerMegapixel: 0.003 },
    "flux-dev": { model: "fal-ai/flux/dev", usdPerMegapixel: 0.025 },
  },
  image_upscale: {
    model: "fal-ai/esrgan",
    // esrgan bills $0.00111/compute-second (fal's own model page). We don't
    // know compute-seconds ahead of a call, so we assume a conservative
    // worst-case runtime per scale factor, verified generous vs anything
    // seen in community reports of this model's typical runtime.
    usdPerComputeSecond: 0.00111,
    assumedComputeSeconds: { "2": 8, "4": 15 } as Record<string, number>,
  },
  audio_transcribe: {
    model: "fal-ai/wizper",
    // fal publishes Wizper as priced by audio duration (not raw compute
    // time, unlike base whisper) at ~$0.50 per 1000 audio-minutes → $0.0005
    // /minute. fal's own model page renders this banner dynamically from a
    // submitted file rather than as static text, so this is corroborated
    // from fal's public pricing commentary (Wizper announcement: "20x
    // cheaper than OpenAI Whisper v3") rather than a scraped static string —
    // documented here as the best verified figure at implementation time.
    usdPerMinute: 0.0005,
  },
  text_to_speech: {
    model: "fal-ai/kokoro/american-english",
    usdPerThousandChars: 0.02,
  },
  video_generate: {
    "ltx-fast": { model: "fal-ai/ltx-video-13b-distilled", usdPerVideo: 0.04, fixedSeconds: 5 },
    "kling-pro": {
      modelTextToVideo: "fal-ai/kling-video/v2.6/pro/text-to-video",
      modelImageToVideo: "fal-ai/kling-video/v2.6/pro/image-to-video",
      usdPerSecond: 0.07,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// image_size → megapixel table (fal's flux image_size enum), rounded UP to
// the nearest whole megapixel per fal's own billing rule ("Images are billed
// by rounding up to the nearest megapixel").
// ---------------------------------------------------------------------------

export const IMAGE_SIZE_PIXELS: Record<string, { width: number; height: number }> = {
  square_hd: { width: 1024, height: 1024 },
  square: { width: 512, height: 512 },
  portrait_4_3: { width: 768, height: 1024 },
  portrait_16_9: { width: 720, height: 1280 },
  landscape_4_3: { width: 1024, height: 768 },
  landscape_16_9: { width: 1280, height: 720 },
};

export function megapixelsForImageSize(
  imageSize: unknown
): number {
  if (typeof imageSize === "string") {
    const dims = IMAGE_SIZE_PIXELS[imageSize];
    if (!dims) throw new Error(`Unknown image_size "${imageSize}"`);
    return Math.ceil((dims.width * dims.height) / 1_000_000);
  }
  if (imageSize && typeof imageSize === "object") {
    const w = Number((imageSize as Record<string, unknown>).width);
    const h = Number((imageSize as Record<string, unknown>).height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error("image_size object must have positive numeric width/height");
    }
    return Math.ceil((w * h) / 1_000_000);
  }
  // Default: landscape_4_3 (fal's own default), 1 MP.
  return Math.ceil((1024 * 768) / 1_000_000);
}

// ---------------------------------------------------------------------------
// Shared caps (also enforced by the tools themselves at execution time, not
// just here — pricing and execution must agree on the same limits).
// ---------------------------------------------------------------------------

export const MAX_IMAGE_GENERATE_NUM_IMAGES = 4;
export const MAX_AUDIO_TRANSCRIBE_MINUTES = 60;
export const MAX_TTS_CHARS = 5_000;
export const MAX_VIDEO_SECONDS = 10;

// ---------------------------------------------------------------------------
// Dynamic pricers — one per fal.ai tool, registered into
// src/x402/middleware.ts's DYNAMIC_PRICERS.
//
// Contract: called with `args: undefined` for a representative/default quote
// (used by discovery endpoints like /.well-known/mcp.json that don't have a
// real call to price) — must NOT throw in that case. Called with a real
// `args` object (even {}) from the actual payment gate — MUST throw a clear,
// specific Error if the args don't carry enough information to price the
// call safely (e.g. audio_transcribe without duration_seconds). Never
// estimate a lower COGS than reality; when in doubt, round up.
// ---------------------------------------------------------------------------

// Each xCogsMicro function is the single source of truth for that tool's
// estimated COGS — reused by the pricer (via priceFromCogsMicro), the daily
// budget breaker (checkFalBudget/recordFalCost), AND the tool's own
// runWithEnv implementation, so pricing/budget/execution can never drift
// apart. `args: undefined` returns a representative estimate and must never
// throw; a real (possibly {}) args object throws when it can't be priced.

export function imageGenerateCogsMicro(args?: Record<string, unknown>): bigint {
  const modelKey = typeof args?.model === "string" ? args.model : "flux-schnell";
  const modelCfg = (FAL_COSTS.image_generate as Record<string, { model: string; usdPerMegapixel: number }>)[
    modelKey
  ];
  if (!modelCfg) {
    throw new Error(
      `Unknown image_generate model "${modelKey}". Allowed: ${Object.keys(FAL_COSTS.image_generate).join(", ")}`
    );
  }

  let numImages = 1;
  if (args && args.num_images !== undefined) {
    const n = Number(args.num_images);
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGE_GENERATE_NUM_IMAGES) {
      throw new Error(`num_images must be an integer between 1 and ${MAX_IMAGE_GENERATE_NUM_IMAGES}`);
    }
    numImages = n;
  }

  const mp = megapixelsForImageSize(args?.image_size);
  return cogsMicroFromRate(modelCfg.usdPerMegapixel, mp * numImages);
}

export function imageUpscaleCogsMicro(args?: Record<string, unknown>): bigint {
  const scale = args && args.scale !== undefined ? String(args.scale) : "2";
  const seconds = FAL_COSTS.image_upscale.assumedComputeSeconds[scale];
  if (seconds === undefined) {
    throw new Error(
      `Unsupported scale "${scale}". Allowed: ${Object.keys(FAL_COSTS.image_upscale.assumedComputeSeconds).join(", ")}`
    );
  }
  return cogsMicroFromRate(FAL_COSTS.image_upscale.usdPerComputeSecond, seconds);
}

export function audioTranscribeCogsMicro(args?: Record<string, unknown>): bigint {
  if (args === undefined) {
    return cogsMicroFromRate(FAL_COSTS.audio_transcribe.usdPerMinute, 1);
  }
  const declared = args.duration_seconds;
  const seconds = Number(declared);
  if (declared === undefined || declared === null || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      "`duration_seconds` is required to price audio_transcribe (declare the audio's approximate duration in seconds — verified after transcription; if it's off by more than 10% the call is rejected without charging beyond the quoted price)."
    );
  }
  if (seconds > MAX_AUDIO_TRANSCRIBE_MINUTES * 60) {
    throw new Error(`duration_seconds too large — max ${MAX_AUDIO_TRANSCRIBE_MINUTES} minutes (${MAX_AUDIO_TRANSCRIBE_MINUTES * 60}s) per call`);
  }
  return cogsMicroFromRate(FAL_COSTS.audio_transcribe.usdPerMinute, seconds / 60);
}

export function textToSpeechCogsMicro(args?: Record<string, unknown>): bigint {
  if (args === undefined) {
    return cogsMicroFromRate(FAL_COSTS.text_to_speech.usdPerThousandChars, 500 / 1000);
  }
  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) {
    throw new Error("`text` is required (non-empty string) to price text_to_speech");
  }
  if (text.length > MAX_TTS_CHARS) {
    throw new Error(`text too long — max ${MAX_TTS_CHARS} characters per call`);
  }
  return cogsMicroFromRate(FAL_COSTS.text_to_speech.usdPerThousandChars, text.length / 1000);
}

export function videoGenerateCogsMicro(args?: Record<string, unknown>): bigint {
  const modelKey = typeof args?.model === "string" ? args.model : "ltx-fast";
  if (modelKey === "ltx-fast") {
    return cogsMicroFromRate(FAL_COSTS.video_generate["ltx-fast"].usdPerVideo, 1);
  }
  if (modelKey === "kling-pro") {
    const durationStr = args && args.duration !== undefined ? String(args.duration) : "5";
    const duration = Number(durationStr);
    if (durationStr !== "5" && durationStr !== "10") {
      throw new Error(`kling-pro duration must be "5" or "10" (seconds), got "${durationStr}"`);
    }
    if (duration > MAX_VIDEO_SECONDS) {
      throw new Error(`duration too large — max ${MAX_VIDEO_SECONDS}s per call`);
    }
    return cogsMicroFromRate(FAL_COSTS.video_generate["kling-pro"].usdPerSecond, duration);
  }
  throw new Error(`Unknown video_generate model "${modelKey}". Allowed: ltx-fast, kling-pro`);
}

/** Registry merged into src/x402/middleware.ts's DYNAMIC_PRICERS. */
export const FAL_DYNAMIC_PRICERS: Record<string, (args?: Record<string, unknown>) => ToolPrice> = {
  image_generate: (args) => priceFromCogsMicro(imageGenerateCogsMicro(args)),
  image_upscale: (args) => priceFromCogsMicro(imageUpscaleCogsMicro(args)),
  audio_transcribe: (args) => priceFromCogsMicro(audioTranscribeCogsMicro(args)),
  text_to_speech: (args) => priceFromCogsMicro(textToSpeechCogsMicro(args)),
  video_generate: (args) => priceFromCogsMicro(videoGenerateCogsMicro(args)),
};
