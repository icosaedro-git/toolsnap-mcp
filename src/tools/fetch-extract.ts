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

export const fetchExtractTool: McpTool = {
  name: "fetch_extract",
  description:
    "Fetch a URL and return clean, readable text — stripped of HTML tags, scripts, styles, and navigation. Use this instead of loading raw HTML into your context; a typical web page returns 50–200KB of HTML but only 2–5KB of meaningful text. Saves 90–95% of context tokens compared to loading the raw page.",
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

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
    }

    return text;
  },
};
