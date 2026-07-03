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

  // Build a base64 data URI from the source image so fal.ai doesn't need to
  // fetch external URLs (fal.ai is blocked by Cloudflare WAF on many CDN
  // domains). For URLs served by this Worker (/files/*) we read R2 directly
  // to avoid Cloudflare's loopback restriction on same-zone subrequests.
  let sourceDataUri: string;
  try {
    let srcBytes: ArrayBuffer;
    let mimeType: string;

    const LOCAL_PREFIX = "/files/";
    const parsedUrl = new URL(imageUrl);
    const isLocalUpload = parsedUrl.pathname.startsWith(LOCAL_PREFIX) &&
      parsedUrl.pathname.includes("/uploads/");
    if (parsedUrl.pathname.startsWith(LOCAL_PREFIX)) {
      // Internal R2 object — read via binding to avoid same-zone HTTP loopback.
      const r2Key = parsedUrl.pathname.slice(LOCAL_PREFIX.length);
      const obj = await env.SCREENSHOTS_BUCKET.get(r2Key);
      if (!obj) throw new Error(`File not found in storage: ${r2Key}`);
      srcBytes = await obj.arrayBuffer();
      mimeType = obj.httpMetadata?.contentType ?? "image/jpeg";
      // Delete temporary uploads immediately after reading.
      if (isLocalUpload) {
        await env.SCREENSHOTS_BUCKET.delete(r2Key);
      }
    } else {
      const srcRes = await fetch(imageUrl, { signal: controller.signal });
      if (!srcRes.ok) throw new Error(`Failed to fetch source image: HTTP ${srcRes.status}`);
      srcBytes = await srcRes.arrayBuffer();
      mimeType = (srcRes.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    }

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
  description: "Remove an image's background, return a transparent PNG URL. $0.03 USDC/call.",
  inputSchema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "Public image URL." },
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
