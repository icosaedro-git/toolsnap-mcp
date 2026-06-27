import type { McpTool } from "../mcp/types.js";

const DEFAULT_MAX_CHARS = 8_000;
const HARD_MAX_CHARS = 32_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Strip block-level elements (and their content) that are typically noise:
 * <script>, <style>, <nav>, <header>, <footer>, <aside>.
 */
function stripBlockElements(html: string): string {
  const tags = ["script", "style", "nav", "header", "footer", "aside"];
  let result = html;
  for (const tag of tags) {
    // Non-greedy match, case-insensitive, including multiline content.
    result = result.replace(
      new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
      " "
    );
  }
  return result;
}

/** Strip all remaining HTML tags. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

/** Decode common HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#160;/g, " ");
}

/** Collapse runs of whitespace while preserving single newlines. */
function collapseWhitespace(text: string): string {
  // Normalise line endings
  let result = text.replace(/\r\n?/g, "\n");
  // Collapse horizontal whitespace (spaces/tabs) runs to a single space
  result = result.replace(/[^\S\n]+/g, " ");
  // Collapse runs of blank lines to a single newline
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

function extractText(html: string): string {
  let text = stripBlockElements(html);
  text = stripTags(text);
  text = decodeEntities(text);
  text = collapseWhitespace(text);
  return text;
}

/**
 * Markers that a page is a client-side-rendered SPA whose real content only
 * exists after JavaScript runs. fetch_extract does a plain fetch (no JS engine),
 * so for these pages it would return an almost-empty shell.
 */
const SPA_MARKERS = [
  /<div[^>]+id=["'](root|app|__next|__nuxt|app-root)["']/i,
  /__NEXT_DATA__/,
  /window\.__NUXT__/,
  /data-reactroot/i,
  /<app-root/i,
  /id=["']svelte["']/i,
];

/**
 * Detect a JS-rendered/empty response so the server does NOT charge for a
 * useless extraction. Returns a reason string if the page looks unusable, else
 * null. Conservative: only fires when the extracted text is very thin AND the
 * HTML was non-trivial (so genuinely short static pages are not flagged).
 */
function detectUnusable(html: string, text: string): string | null {
  if (text.length >= 300) return null; // got real content — fine
  if (html.length < 2_000) return null; // genuinely tiny page — let it through
  const isSpa = SPA_MARKERS.some((re) => re.test(html));
  if (isSpa) {
    return "This page is client-side rendered (SPA): its content only appears after JavaScript runs, which fetch_extract does not execute. Use screenshot_url (to see it) or fetch_html (raw markup), or render it on your side.";
  }
  // Large HTML but almost no text and no SPA markers → likely a bot wall,
  // login gate, or an asset/redirect page.
  return "This URL returned very little extractable text despite a sizeable response (likely a bot wall, login gate, or non-article page). Try screenshot_url or fetch_html instead.";
}

export const fetchExtractTool: McpTool = {
  name: "fetch_extract",
  description:
    "Fetch a URL and return clean text, stripped of HTML, scripts, styles, and navigation. Benchmark (11 real pages): median 98.1% token reduction (53 820 → 2 001 tokens); saves ~$0.156/call at Sonnet pricing ($3/M tokens) vs loading raw HTML. Break-even at 26 KB pages — virtually all real pages qualify. Deterministic, parallel-safe, zero-setup. Note: does NOT run JavaScript — for client-side-rendered SPAs use screenshot_url or fetch_html instead (fetch_extract detects this and returns an error WITHOUT charging). Cost: $0.02 USDC on Base. First call free per wallet address.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch and extract text from",
      },
      maxChars: {
        type: "number",
        description: `Max characters to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS})`,
      },
    },
    required: ["url"],
  },
  async run(args) {
    const url = args.url;
    if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      throw new Error("url must be a string starting with http:// or https://");
    }

    const rawMax = args.maxChars !== undefined ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
    const maxChars = Math.min(Math.max(1, Math.floor(rawMax)), HARD_MAX_CHARS);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "toolsnap-mcp/1.0 (fetch_extract; +https://toolsnap.app)",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch URL: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(
        `Fetch failed: HTTP ${response.status} ${response.statusText} for ${url}`
      );
    }

    let html: string;
    try {
      html = await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read response body: ${message}`);
    }

    let text = extractText(html);

    // Throwing here means the payment gate does NOT settle (it only charges on
    // success), so the caller is not billed for an unusable extraction.
    const unusable = detectUnusable(html, text);
    if (unusable) {
      throw new Error(unusable);
    }

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
    }

    return text;
  },
};
