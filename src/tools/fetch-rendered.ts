import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { assertPublicHttpUrl, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY } from "./safe-fetch.js";
import { extractText } from "./fetch-extract.js";

/**
 * fetch_rendered (Fase 29) — render a JS-executed page (SPA) with a
 * server-side headless browser via Cloudflare's Browser Rendering REST API
 * (/content endpoint), then run it through the same text-extraction pipeline
 * as fetch_extract. Complements fetch_extract: use this only when the plain
 * fetch would return an empty shell (client-side rendered app).
 *
 * Env-aware (needs CF_ACCOUNT_ID + BROWSER_RENDERING_API_TOKEN), executed via
 * runWithEnv from the dispatcher's payment gate; the plain `run` throws.
 */

const DEFAULT_MAX_CHARS = 8_000;
const HARD_MAX_CHARS = 32_000;
const RENDER_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 10_000;

const HANDLED_AT_SERVER =
  "fetch_rendered is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

interface RenderedParams {
  url: string;
  maxChars: number;
  waitMs: number;
  forwardHeaders?: Record<string, string>;
}

function parseParams(args: Record<string, unknown>): RenderedParams {
  const url = assertPublicHttpUrl(String(args.url ?? "")).toString();

  const rawMax = args.maxChars !== undefined ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
  const maxChars = Math.min(Math.max(1, Math.floor(rawMax)), HARD_MAX_CHARS);

  const rawWait = args.waitMs !== undefined ? Number(args.waitMs) : 0;
  const waitMs = Number.isFinite(rawWait) ? Math.min(Math.max(0, Math.floor(rawWait)), MAX_WAIT_MS) : 0;

  const forwardHeaders = parseForwardHeaders(args.headers);

  return { url, maxChars, waitMs, forwardHeaders };
}

/**
 * Calls Cloudflare's Browser Rendering REST API /content endpoint, which
 * spins up a headless browser, navigates to the URL, waits for it to settle,
 * and returns the fully-rendered HTML. See
 * https://developers.cloudflare.com/browser-rendering/rest-api/content-endpoint/
 */
async function renderHtml(p: RenderedParams, env: Env, signal: AbortSignal): Promise<string> {
  if (!env.CF_ACCOUNT_ID || !env.BROWSER_RENDERING_API_TOKEN) {
    throw new Error("Browser Rendering is not configured (CF_ACCOUNT_ID / BROWSER_RENDERING_API_TOKEN missing).");
  }

  const gotoOptions: Record<string, unknown> = {
    waitUntil: "networkidle0",
    timeout: RENDER_TIMEOUT_MS,
  };

  const body: Record<string, unknown> = {
    url: p.url,
    gotoOptions,
  };

  if (p.waitMs > 0) {
    body.waitForTimeout = p.waitMs;
  }

  if (p.forwardHeaders) {
    // Cookie needs to be a real navigation cookie for the target origin;
    // Authorization/X-Api-Key ride as extra request headers.
    const extraHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(p.forwardHeaders)) {
      if (key === "cookie") {
        const host = new URL(p.url).hostname;
        body.cookies = value.split(";").map((pair) => {
          const idx = pair.indexOf("=");
          const name = (idx === -1 ? pair : pair.slice(0, idx)).trim();
          const val = idx === -1 ? "" : pair.slice(idx + 1).trim();
          return { name, value: val, domain: host };
        });
      } else {
        extraHeaders[key] = value;
      }
    }
    if (Object.keys(extraHeaders).length > 0) {
      body.setExtraHTTPHeaders = extraHeaders;
    }
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${env.BROWSER_RENDERING_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(
      `Browser Rendering failed: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`
    );
  }

  const json = (await res.json()) as { success?: boolean; result?: string; errors?: unknown[] };
  if (!json.success || typeof json.result !== "string") {
    throw new Error(
      `Browser Rendering returned no content${json.errors ? `: ${JSON.stringify(json.errors)}` : ""}`
    );
  }
  return json.result;
}

async function runFetchRendered(args: Record<string, unknown>, env: Env): Promise<string> {
  const p = parseParams(args);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS + 5_000);
  let html: string;
  try {
    html = await renderHtml(p, env, controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`fetch_rendered timed out after ${(RENDER_TIMEOUT_MS + 5_000) / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let text = extractText(html);
  if (!text || text.length < 10) {
    throw new Error("Rendered page produced no extractable text (it may require login, or block automation).");
  }

  if (text.length > p.maxChars) {
    text = text.slice(0, p.maxChars) + `\n\n[Truncated at ${p.maxChars} chars]`;
  }

  return text;
}

export const fetchRenderedTool: McpTool = {
  name: "fetch_rendered",
  description: "Fetch a JS-rendered SPA via server-side browser, return clean text. $0.04/call.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      maxChars: { type: "number" },
      waitMs: { type: "number" },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["url"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runFetchRendered(args, env as Env);
  },
};
