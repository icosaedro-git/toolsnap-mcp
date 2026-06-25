import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";

/**
 * remove_background (Fase 13.0) — removes the background from an image via
 * fal.ai imageutils/rembg (U²-Net model). Returns a transparent PNG uploaded
 * to R2; never returns raw bytes so context stays clean.
 *
 * Env-aware (needs FAL_API_KEY + SCREENSHOTS_BUCKET + R2_PUBLIC_URL).
 * Pricing: $0.03 pay-per-call / $0.02 prepaid. No first-call-free (COGS).
 */

const FAL_REMBG_URL = "https://fal.run/fal-ai/imageutils/rembg";
const API_TIMEOUT_MS = 60_000;

const HANDLED_AT_SERVER =
  "remove_background is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

interface FalRembgResponse {
  image: {
    url: string;
    content_type: string;
    file_name?: string;
    file_size?: number;
  };
}

async function runRemoveBackground(
  args: Record<string, unknown>,
  env: Env
): Promise<string> {
  const imageUrl = typeof args.image_url === "string" ? args.image_url.trim() : "";
  if (!imageUrl) throw new Error("`image_url` is required and must be a non-empty string URL");

  if (!env.FAL_API_KEY) {
    throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  }
  if (!env.SCREENSHOTS_BUCKET) {
    throw new Error("R2 bucket is not configured (SCREENSHOTS_BUCKET).");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // fal.ai cannot fetch arbitrary external URLs (blocked by Cloudflare WAF on
  // many CDN domains including r2.dev). We download the source image ourselves
  // and pass it as a data URI — this is reliable regardless of the origin host.
  let sourceDataUri: string;
  try {
    const srcRes = await fetch(imageUrl, { signal: controller.signal });
    if (!srcRes.ok) {
      throw new Error(`Failed to fetch source image: HTTP ${srcRes.status}`);
    }
    const srcBytes = await srcRes.arrayBuffer();
    const contentType = srcRes.headers.get("content-type") ?? "image/jpeg";
    const mimeType = contentType.split(";")[0].trim();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(srcBytes)));
    sourceDataUri = `data:${mimeType};base64,${b64}`;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Source image download timed out after ${API_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  let falResult: FalRembgResponse;
  try {
    const res = await fetch(FAL_REMBG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${env.FAL_API_KEY}`,
      },
      body: JSON.stringify({ image_url: sourceDataUri }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 400); } catch { /* ignore */ }
      throw new Error(
        `fal.ai rembg failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`
      );
    }

    falResult = (await res.json()) as FalRembgResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`fal.ai rembg timed out after ${API_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!falResult?.image?.url) {
    throw new Error("fal.ai rembg returned an unexpected response (no image URL)");
  }

  // Download the PNG from fal.ai CDN and re-host on our R2 bucket.
  const download = await fetch(falResult.image.url);
  if (!download.ok) {
    throw new Error(`Failed to download rembg result from fal.ai CDN: HTTP ${download.status}`);
  }

  const pngBytes = await download.arrayBuffer();

  // Key: rembg/<timestamp>-<random>.png
  const key = `rembg/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.png`;
  await env.SCREENSHOTS_BUCKET.put(key, pngBytes, {
    httpMetadata: { contentType: "image/png" },
  });

  const publicBase = (env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  const publicUrl = `${publicBase}/${key}`;

  return JSON.stringify({
    url: publicUrl,
    format: "png",
    source_url: imageUrl,
    model: "fal-ai/imageutils/rembg",
    file_size_bytes: pngBytes.byteLength,
  });
}

export const removeBackgroundTool: McpTool = {
  name: "remove_background",
  description:
    "Removes the background from an image (U²-Net model via fal.ai) and returns a transparent PNG hosted on a public URL — never raw bytes, so it does not bloat context. Input: `image_url` (any public JPEG/PNG/WEBP URL). Output: `url` (permanent public PNG), `file_size_bytes`. Use for product photos, profile pictures, logo cutouts, or any image that needs a clean transparent background before compositing. Cost: $0.03 USDC pay-per-call ($0.02 prepaid). No first-call-free.",
  inputSchema: {
    type: "object",
    properties: {
      image_url: {
        type: "string",
        description:
          "Public URL of the source image (JPEG, PNG, or WEBP). Must be accessible from the internet — local paths and data: URIs are not supported.",
      },
    },
    required: ["image_url"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runRemoveBackground(args, env as Env);
  },
};
