/**
 * Shared fal.ai REST client (Fase 13.1) — extracted from remove-background.ts
 * (Fase 13.0) so every fal-backed tool (remove_background, image_generate,
 * image_upscale, audio_transcribe, text_to_speech, and the queue-based
 * video_generate) shares one implementation of:
 *
 *  - resolving a source URL into a data: URI fal.ai can fetch directly
 *    (works around fal.ai being blocked by Cloudflare WAF on many CDN
 *    domains, and Cloudflare's same-zone subrequest loopback restriction
 *    for our own /files/* URLs — read those straight from R2 instead)
 *  - calling https://fal.run/<model> (synchronous inference) with the
 *    Key auth header, a timeout, and consistent "fal.ai <model> failed: ..."
 *    error messages (the "fal.ai" prefix matters — see
 *    src/alerts/error-alerts.ts PROVIDER_PREFIXES, which routes these to the
 *    provider-failure alert path)
 *  - downloading a fal.ai CDN result and re-hosting it in our own R2 bucket
 *    under media/<tool>/<ts>-<rand>.<ext>, returning a public URL
 *
 * Money-safety note: none of this module touches pricing or payment — it is
 * pure I/O. Pricing lives in src/fal/pricing.ts, the daily spend breaker in
 * src/fal/budget.ts. Callers (the individual tool files) are responsible for
 * calling checkFalBudget() before, and recordFalCost() after, invoking these
 * functions.
 */

import type { Env } from "../index.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const LOCAL_PREFIX = "/files/";

/**
 * Default source-file size cap for resolveSourceAsDataUri (Fase 13.1c —
 * shared between image_upscale and video_generate's kling-pro image_url so
 * both keep their flat-price/runtime assumptions bounded; callers may pass
 * a different `maxBytes` explicitly if a tool needs a different limit).
 */
export const DEFAULT_MAX_SOURCE_BYTES = 6 * 1024 * 1024; // 6 MB

export interface FalSourceEnv {
  SCREENSHOTS_BUCKET: R2Bucket;
}

/**
 * Resolve a source URL (public URL, or one of our own /files/<key> URLs)
 * into a data: URI. Local /files/ URLs are read directly from the R2
 * binding (avoiding the Cloudflare same-zone loopback restriction); if the
 * key lives under uploads/ (a temporary upload_file object) it is deleted
 * immediately after being read, matching remove_background's existing
 * behavior.
 */
export async function resolveSourceAsDataUri(
  sourceUrl: string,
  env: FalSourceEnv,
  opts: { timeoutMs?: number; defaultMimeType?: string; maxBytes?: number } = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let srcBytes: ArrayBuffer;
    let mimeType: string;

    const parsedUrl = new URL(sourceUrl);
    const isLocal = parsedUrl.pathname.startsWith(LOCAL_PREFIX);
    if (isLocal) {
      const r2Key = parsedUrl.pathname.slice(LOCAL_PREFIX.length);
      const obj = await env.SCREENSHOTS_BUCKET.get(r2Key);
      if (!obj) throw new Error(`File not found in storage: ${r2Key}`);
      srcBytes = await obj.arrayBuffer();
      mimeType = obj.httpMetadata?.contentType ?? opts.defaultMimeType ?? "application/octet-stream";
      if (r2Key.includes("/uploads/") || r2Key.startsWith("uploads/")) {
        await env.SCREENSHOTS_BUCKET.delete(r2Key);
      }
    } else {
      const srcRes = await fetch(sourceUrl, { signal: controller.signal });
      if (!srcRes.ok) throw new Error(`Failed to fetch source: HTTP ${srcRes.status}`);
      srcBytes = await srcRes.arrayBuffer();
      mimeType =
        (srcRes.headers.get("content-type") ?? opts.defaultMimeType ?? "application/octet-stream")
          .split(";")[0]
          .trim();
    }

    if (opts.maxBytes !== undefined && srcBytes.byteLength > opts.maxBytes) {
      throw new Error(
        `Source file too large (${srcBytes.byteLength} bytes, max ${opts.maxBytes}) — this tool's pricing/runtime assumes a bounded source size. Downscale it first.`
      );
    }

    const b64 = arrayBufferToBase64(srcBytes);
    return `data:${mimeType};base64,${b64}`;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Source download timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Chunked to avoid blowing the call stack on large files (String.fromCharCode(...bytes)).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface FalCallEnv {
  FAL_API_KEY?: string;
}

/**
 * Synchronous fal.ai inference call: POST https://fal.run/<model>.
 * Throws `fal.ai <model> failed: HTTP <status> — <detail>` on non-2xx, or a
 * timeout message, so error-alerts.ts's provider-prefix classification keeps
 * working unchanged.
 */
export async function callFalSync<T = unknown>(
  model: string,
  body: Record<string, unknown>,
  env: FalCallEnv,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  if (!env.FAL_API_KEY) {
    throw new Error("fal.ai API key is not configured (FAL_API_KEY).");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${env.FAL_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      throw new Error(`fal.ai ${model} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`fal.ai ${model} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface FalRehostEnv {
  SCREENSHOTS_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;
}

/**
 * Download a fal.ai CDN result and re-host it in our R2 bucket under
 * <keyPrefix>/<ts>-<rand>.<ext> (e.g. "rembg" for remove_background,
 * "media/image_generate" for the new tools — see each tool file). Returns
 * the public URL + byte size.
 */
export async function downloadAndRehost(
  sourceUrl: string,
  env: FalRehostEnv,
  keyPrefix: string,
  ext: string,
  contentType: string
): Promise<{ url: string; key: string; bytes: number }> {
  const download = await fetch(sourceUrl);
  if (!download.ok) {
    throw new Error(`Failed to download result from fal.ai CDN: HTTP ${download.status}`);
  }
  const data = await download.arrayBuffer();
  const key = `${keyPrefix}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
  await env.SCREENSHOTS_BUCKET.put(key, data, { httpMetadata: { contentType } });
  const publicBase = (env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  return { url: `${publicBase}/${key}`, key, bytes: data.byteLength };
}

/** Convenience union of the env slices every fal tool needs. */
export type FalToolEnv = Env;
