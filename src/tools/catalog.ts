/**
 * Catalog metadata (Fase 18) — single source of truth for what gets exposed
 * where: the curated core (tools/list), the 2-layer tool_catalog, and the
 * long tail (everything else, reachable via use_tool or a direct call).
 *
 * This module holds NO logic beyond a completeness guard — it's pure data,
 * imported by tool-catalog.ts, index.ts (listTools scope) and the audit
 * script.
 */

/**
 * Curated core exposed directly in tools/list. Order = listing order.
 * Keep to the plan's budget (≤ ~1.600 tokens instructions + tools/list).
 * Recruitment order if trimming is ever needed again: fetch_structured →
 * rss_parse → json_query → fetch_html (never below 15; never touch the 5
 * meta tools or the 3 paid tools).
 */
export const CORE_TOOLS: string[] = [
  // Meta (5) — discovery, execution, recipes, memory, pricing
  "tool_catalog",
  "use_tool",
  "task_recipes",
  "memory_snippet",
  "pricing",
  // Free flagships (10)
  "fetch_extract",
  "fetch_html",
  "html_to_markdown",
  "fetch_metadata",
  "fetch_structured",
  "pdf_text_extract",
  "csv_query",
  "json_query",
  "sitemap_parse",
  "rss_parse",
  // Paid COGS tools (3)
  "screenshot_url",
  "keyword_research",
  "remove_background",
];

export interface Family {
  label: string;
  oneLiner: string;
  tools: string[];
}

/**
 * Families for layer 1 of tool_catalog. A tool can belong to more than one
 * family (e.g. fetch_metadata is both "web" and "seo").
 */
export const FAMILIES: Record<string, Family> = {
  web: {
    label: "Web fetch & extract",
    oneLiner: "Fetch URLs and get clean text, Markdown, HTML, metadata, structured data, assets, or links.",
    tools: [
      "fetch_extract",
      "fetch_html",
      "html_to_markdown",
      "fetch_metadata",
      "fetch_structured",
      "page_assets",
      "page_links",
      "link_check",
      "screenshot_url",
    ],
  },
  seo: {
    label: "SEO & crawling",
    oneLiner: "Keyword volume/CPC, sitemaps, feeds, page metadata and links for audits and crawls.",
    tools: ["keyword_research", "sitemap_parse", "rss_parse", "fetch_metadata", "page_links", "link_check"],
  },
  data: {
    label: "Data & text utilities",
    oneLiner: "Query CSV/JSON, run regex, diff strings, format JSON, count tokens, get text stats.",
    tools: [
      "csv_query",
      "json_query",
      "html_table_extract",
      "regex_extract",
      "diff_text",
      "json_format",
      "text_stats",
      "count_tokens",
    ],
  },
  documents: {
    label: "Documents",
    oneLiner: "Extract text from PDFs by URL.",
    tools: ["pdf_text_extract"],
  },
  images: {
    label: "Images",
    oneLiner: "Screenshot a page, remove an image background, or upload an image for other tools to use.",
    tools: ["screenshot_url", "remove_background", "upload_file"],
  },
  utils: {
    label: "ID & encoding utilities",
    oneLiner: "Generate UUIDs/hashes, encode/decode Base64 and URLs, convert timestamps.",
    tools: [
      "uuid_generate",
      "hash_text",
      "base64_encode",
      "base64_decode",
      "url_encode",
      "url_decode",
      "timestamp_convert",
    ],
  },
  payments: {
    label: "Payments & wallet",
    oneLiner: "Check the pricing menu, set up an agent wallet, and check/deposit a prepaid balance.",
    tools: ["pricing", "wallet_setup", "account_balance", "account_deposit"],
  },
  recipes: {
    label: "Task recipes",
    oneLiner: "Ready-to-run multi-tool workflows for whole tasks (clone a site, SEO audit).",
    tools: ["task_recipes"],
  },
  meta: {
    label: "Server meta",
    oneLiner: "Discover the full catalog, run any tool by name, and save the ToolSnap habit to memory.",
    tools: ["tool_catalog", "use_tool", "memory_snippet"],
  },
};

/**
 * Extra long-form detail that was cut from a tool's core description to keep
 * tools/list small. Served in tool_catalog layer 2 (per-tool `notes` field).
 * Keys are tool names; not every tool needs an entry.
 */
export const NOTES: Record<string, string> = {
  fetch_extract:
    "Benchmark (11 real pages): median 98.1% token reduction (53,820 → 2,001 tokens); saves ~$0.156/call at Sonnet pricing ($3/M tokens) vs loading raw HTML. Break-even at 26 KB pages — virtually all real pages qualify. Deterministic, parallel-safe, zero-setup. If the page is a JS-rendered SPA, fetch_extract detects it and returns an error without charging — use screenshot_url or fetch_html instead.",
  fetch_html:
    "Unlike fetch_extract (flattens to text) or html_to_markdown (converts to Markdown), this keeps the DOM skeleton (tags/classes/ids) so an agent can reconstruct the page as static HTML. Ideal for site migration (e.g. WordPress → static).",
  html_to_markdown:
    "Provide exactly one of url or html — not both. Do NOT use for JavaScript-rendered SPAs — use fetch_html or screenshot_url instead.",
  fetch_metadata:
    "Extracts title, meta description, Open Graph, Twitter Card, canonical URL, robots, author, keywords, JSON-LD, lang/charset. Do NOT use to extract page body text — use fetch_extract or html_to_markdown instead.",
  fetch_structured:
    "Reads JSON-LD, Open Graph, Twitter Cards, and Schema.org microdata — no LLM required, extraction is deterministic. Returns an empty object if the page has no matching semantic markup.",
  pdf_text_extract:
    "Handles FlateDecode-compressed streams and RC4-encrypted PDFs that open with an empty password. Works on text-based PDFs (Word, LaTeX, web-generated); does NOT perform OCR on scanned/image-only PDFs.",
  csv_query:
    "Provide exactly one of url or csv. Supports select/filter/sort_by/sort_dir/limit/format(json|csv). Filter operators: = != > >= < <= contains startswith endswith.",
  json_query:
    "JSONPath-lite: property access, [*] wildcard, [-1] negative index, ..key recursive descent, [?(@.price < 10)] filters. Provide exactly one of url or json.",
  sitemap_parse:
    "Handles both urlset and sitemapindex, plus image/news sitemap extensions. Use to enumerate all pages of a site or build a crawl queue.",
  rss_parse: "Handles RSS 2.0 and Atom 1.0. Returns feed metadata plus title/link/pubDate/author/categories/enclosure per item.",
  screenshot_url:
    "Returns JSON with a public image URL (never raw bytes) — the hosted image expires after ~24h, download promptly. No first-call-free: this tool has real per-call COGS (headless render).",
  keyword_research:
    "Queries Google Ads data via DataForSEO for 1–20 keywords: monthly search volume, CPC, competition score, 12-month trend, top-5 related suggestions. Default location Spain (2724). No first-call-free (real COGS per batch).",
  remove_background:
    "Uses the U²-Net model via fal.ai. Returns a transparent PNG on a public URL (expires ~24h). To pass a local image, upload it first with upload_file. No first-call-free (real COGS per call).",
  link_check:
    "Follows redirects manually to build the full hop-by-hop chain (not just the final URL). Max 20 URLs per call, up to 5 redirect hops each. Detects broken links, redirect loops, and network/DNS failures without loading any page content.",
  html_table_extract:
    "Provide exactly one of url or html. Handles colspan (repeats the cell across spanned columns) and nested tables (returned as separate entries). Does NOT expand rowspan. Returns all tables by default; use table_index to select one, or format=csv (requires table_index when the page has more than one table).",
};

/**
 * Integrity guard: every registered tool must appear in ≥1 family, and every
 * name referenced in CORE_TOOLS/FAMILIES must exist in the registry.
 * Not called at runtime — invoked from scripts/first-connection-audit.ts so
 * catalog drift fails the build/audit instead of silently shipping.
 */
export function assertCatalogComplete(allToolNames: string[]): void {
  const registry = new Set(allToolNames);
  const errors: string[] = [];

  for (const name of CORE_TOOLS) {
    if (!registry.has(name)) errors.push(`CORE_TOOLS references unknown tool "${name}"`);
  }

  const familyToolNames = new Set<string>();
  for (const [familyId, family] of Object.entries(FAMILIES)) {
    for (const name of family.tools) {
      familyToolNames.add(name);
      if (!registry.has(name)) {
        errors.push(`FAMILIES["${familyId}"] references unknown tool "${name}"`);
      }
    }
  }

  for (const name of registry) {
    if (!familyToolNames.has(name)) {
      errors.push(`Tool "${name}" is registered but not listed in any FAMILIES entry`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Catalog integrity check failed:\n  - ${errors.join("\n  - ")}`);
  }
}
