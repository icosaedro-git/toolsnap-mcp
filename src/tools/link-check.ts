import type { McpTool } from "../mcp/types.js";
import { assertPublicHttpUrl } from "./safe-fetch.js";

/**
 * link_check (Fase 18.1) — batch HTTP status/redirect checker.
 *
 * Worker-only, zero COGS. Follows redirects manually (redirect: "manual")
 * to build the full hop-by-hop chain instead of just the final URL, which
 * `fetch`'s built-in redirect following would hide.
 *
 * Subrequest budget: Cloudflare Workers cap subrequests per incoming
 * request (50 on the free plan). Each redirect hop is one subrequest, so a
 * shared counter stops the batch cleanly instead of throwing mid-run when a
 * pathological redirect chain would blow the cap.
 */

const HARD_MAX_URLS = 20;
const MAX_REDIRECTS = 5;
const SUBREQUEST_BUDGET = 45;
const FETCH_TIMEOUT_MS = 8_000;

interface ChainHop {
  url: string;
  status: number;
}

interface LinkCheckResult {
  url: string;
  status: number | null;
  final_url: string;
  redirect_count: number;
  chain: ChainHop[];
  latency_ms: number;
  error?: string;
}

async function checkOne(
  url: string,
  budget: { remaining: number }
): Promise<LinkCheckResult> {
  const start = Date.now();
  const chain: ChainHop[] = [];
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (budget.remaining <= 0) {
      return {
        url,
        status: null,
        final_url: current,
        redirect_count: hop,
        chain,
        latency_ms: Date.now() - start,
        error: "Subrequest budget exceeded for this batch — send fewer URLs per call.",
      };
    }
    budget.remaining--;

    try {
      assertPublicHttpUrl(current);
    } catch (err) {
      return {
        url,
        status: null,
        final_url: current,
        redirect_count: hop,
        chain,
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "toolsnap-mcp/1.0 (link_check; +https://toolsnap.app)" },
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        url,
        status: null,
        final_url: current,
        redirect_count: hop,
        chain,
        latency_ms: Date.now() - start,
        error: `Request failed: ${msg}`,
      };
    }
    clearTimeout(timer);
    // Only status/headers are needed — release the body without reading it.
    response.body?.cancel().catch(() => {});

    chain.push({ url: current, status: response.status });

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (!loc) {
        return {
          url,
          status: response.status,
          final_url: current,
          redirect_count: hop,
          chain,
          latency_ms: Date.now() - start,
          error: "Redirect response had no Location header",
        };
      }
      try {
        current = new URL(loc, current).href;
      } catch {
        return {
          url,
          status: response.status,
          final_url: current,
          redirect_count: hop,
          chain,
          latency_ms: Date.now() - start,
          error: `Invalid redirect Location: ${loc}`,
        };
      }
      continue;
    }

    return {
      url,
      status: response.status,
      final_url: current,
      redirect_count: hop,
      chain,
      latency_ms: Date.now() - start,
    };
  }

  return {
    url,
    status: null,
    final_url: current,
    redirect_count: MAX_REDIRECTS,
    chain,
    latency_ms: Date.now() - start,
    error: `Too many redirects (> ${MAX_REDIRECTS})`,
  };
}

export const linkCheckTool: McpTool = {
  name: "link_check",
  description:
    "Check a batch of URLs and return, for each one, the HTTP status, the full redirect chain, the final URL after following redirects, and latency in ms — without loading any page content into context. Detects broken links (4xx/5xx, timeouts, DNS failures). Free, Worker-only, zero COGS. Ideal for link-rot audits and post-migration QA; complements sitemap_parse/page_links (crawling) and feeds the seo_audit recipe. Max 20 URLs per call, up to 5 redirect hops each.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        description: `List of http(s) URL strings to check (max ${HARD_MAX_URLS}).`,
      },
    },
    required: ["urls"],
  },
  async run(args) {
    const raw = args.urls;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("`urls` must be a non-empty array of URL strings");
    }
    if (raw.length > HARD_MAX_URLS) {
      throw new Error(`Maximum ${HARD_MAX_URLS} URLs per call; got ${raw.length}`);
    }
    const urls = raw.map((u, i) => {
      if (typeof u !== "string" || (!u.startsWith("http://") && !u.startsWith("https://"))) {
        throw new Error(`urls[${i}] must be an http:// or https:// string`);
      }
      return u;
    });

    const budget = { remaining: SUBREQUEST_BUDGET };
    const results = await Promise.all(urls.map((u) => checkOne(u, budget)));

    const summary = {
      total: results.length,
      ok: results.filter((r) => r.status !== null && r.status < 400).length,
      broken: results.filter((r) => r.status === null || r.status >= 400).length,
    };

    return JSON.stringify({ summary, results }, null, 2);
  },
};
