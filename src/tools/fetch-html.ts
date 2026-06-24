import type { McpTool } from "../mcp/types.js";

const DEFAULT_MAX_CHARS = 16_000;
const HARD_MAX_CHARS = 64_000;
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Remove an element and all of its content (open tag → close tag), case-insensitive.
 * Used for elements whose content is pure noise for reconstruction (scripts, styles…).
 */
function dropElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
}

/**
 * Clean HTML while PRESERVING structure (tags, classes, ids, semantic layout).
 * Strips scripts, styles, comments, SVG/iframe blobs, and inline JS handlers —
 * leaving a skeleton suitable for reconstructing the page as static HTML.
 */
function cleanHtml(html: string): string {
  let out = html;

  // HTML comments (incl. conditional comments)
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // Elements whose content is noise for reconstruction
  for (const tag of ["script", "style", "noscript", "template", "svg", "iframe"]) {
    out = dropElement(out, tag);
  }

  // Self-closing / orphan script and link-preload-as-script tags
  out = out.replace(/<script\b[^>]*\/?>/gi, "");

  // Inline event handlers: on*="..." or on*='...'
  out = out.replace(/\son[a-z]+\s*=\s*"(?:[^"]*)"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'(?:[^']*)'/gi, "");

  // Collapse whitespace between tags and runs of blank space
  out = out.replace(/>\s+</g, ">\n<");
  out = out.replace(/[^\S\n]{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

export const fetchHtmlTool: McpTool = {
  name: "fetch_html",
  description:
    "Fetch a URL and return clean HTML with structure preserved — tags, classes, ids and semantic layout kept, but scripts, styles, comments, SVG/iframe blobs and inline JS handlers removed. Unlike fetch_extract (flattens to text) or html_to_markdown (converts to Markdown), this keeps the DOM skeleton so an agent can reconstruct the page as static HTML. Ideal for site migration (e.g. WordPress → static). Cost: $0.02 USDC on Base. First call free per wallet address.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (http:// or https://).",
      },
      maxChars: {
        type: "number",
        description: `Max characters to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}).`,
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
          "User-Agent": "toolsnap-mcp/1.0 (fetch_html; +https://toolsnap.app)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch URL: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    let html: string;
    try {
      html = await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read response body: ${message}`);
    }

    let cleaned = cleanHtml(html);

    if (cleaned.length > maxChars) {
      cleaned = cleaned.slice(0, maxChars) + `\n<!-- [Truncated at ${maxChars} chars] -->`;
    }

    return cleaned;
  },
};
