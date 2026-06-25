/**
 * Task recipes — pre-designed multi-tool workflows that ToolSnap makes easy.
 *
 * Each recipe bundles a whole task that is normally scattered across several
 * separate services/accounts (B6 "task-completeness" thesis): the agent gets a
 * ready-to-paste prompt that drives the right ToolSnap tools end-to-end.
 *
 * This is the single source of truth, served by the free `task_recipes` tool
 * and mirrored (prose/marketing form) in vault note "08 — Recetas de tareas".
 */

export interface Recipe {
  id: string;
  title: string;
  /** One-line summary for the menu. */
  summary: string;
  /** Who it serves / in what context. */
  audience: string;
  /** ToolSnap tools the recipe uses (free + paid). */
  tools: string[];
  /** Rough cost note (pay-per-call / prepaid), in USDC. */
  est_cost: string;
  /** Ready-to-paste prompt for the user to hand to their agent. */
  prompt: string;
}

export const RECIPES: Recipe[] = [
  {
    id: "replicate_website",
    title: "Replicate a website as static HTML (e.g. WordPress → static)",
    summary:
      "Crawl a site and reconstruct it as clean, dependency-free static HTML — structure, assets and a visual reference per page.",
    audience:
      "Web devs/agencies migrating WordPress (or any CMS) to fast static hosting; anyone archiving or rebuilding a site without the original source.",
    tools: [
      "sitemap_parse (free)",
      "page_links (free)",
      "fetch_html (paid)",
      "page_assets (free)",
      "screenshot_url (paid)",
    ],
    est_cost:
      "Free tools for discovery; per page ≈ fetch_html $0.02 + screenshot_url $0.04 = $0.06 pay-per-call (≈ $0.035 prepaid). A 10-page site ≈ $0.60 pay-per-call / ≈ $0.35 prepaid. Skip screenshots to roughly halve it.",
    prompt: `You are migrating a website to clean static HTML using the ToolSnap MCP tools. Target site: <PUT THE SITE URL HERE>.

Do the whole job end-to-end, using ToolSnap for everything that touches the network:
1. Discover all pages: call sitemap_parse on the site's sitemap (try /sitemap.xml). If there's no sitemap, call page_links on the homepage and follow internal links to build the page list.
2. For each page (cap at a sensible number, ask me if it's large):
   a. fetch_html — get clean structured HTML (tags/classes/ids preserved, scripts/tracking stripped). This is the basis for the static page.
   b. page_assets — inventory every image/CSS/font/script/icon with absolute URLs (and srcset). Download these to a local /assets folder and rewrite references to relative paths.
   c. screenshot_url (fullPage:true) — capture a visual reference of the original page; save the returned URL so I can compare the rebuild against it.
3. Reconstruct each page as a standalone static .html file with local assets, no WordPress/CMS runtime, no tracking. Preserve semantic structure and visible content.
4. Output a folder tree (pages + /assets), and a short report: pages processed, assets downloaded, and the screenshot URLs for visual QA.
Stop and ask me only if you hit auth walls, JS-only content, or an unexpectedly large site.`,
  },
  {
    id: "seo_audit",
    title: "Technical + on-page SEO audit of a site",
    summary:
      "Crawl a site and produce a per-page SEO report (titles, metas, Open Graph, canonicals, headings), visual snapshots, and keyword volume data — mostly with free tools.",
    audience:
      "SEO consultants, marketers and site owners who want a fast, deterministic audit without signing up for an SEO suite.",
    tools: [
      "sitemap_parse (free)",
      "webpage_metadata (free)",
      "fetch_extract (paid, optional)",
      "screenshot_url (paid, optional)",
      "keyword_research (paid, optional)",
    ],
    est_cost:
      "Mostly FREE: sitemap_parse + webpage_metadata per page cost nothing. Optional extras: fetch_extract $0.02/page (content/word-count), screenshot_url $0.04/page (visual snapshot), keyword_research $0.04/batch of ≤20 keywords (volume + CPC + competition). A 20-page metadata-only audit ≈ $0.",
    prompt: `You are running an SEO audit of a website using the ToolSnap MCP tools. Target site: <PUT THE SITE URL HERE>.

Do it end-to-end:
1. Enumerate pages: call sitemap_parse on /sitemap.xml (fall back to page_links from the homepage if there's no sitemap).
2. For each page, call webpage_metadata and collect: title (+ length), meta description (+ length), canonical, robots, Open Graph + Twitter Card tags, lang, and JSON-LD presence.
3. Flag issues per page: missing/duplicate/over-length titles (>60 chars) or descriptions (>160 chars), missing canonical, missing/incomplete Open Graph, noindex where it shouldn't be, missing structured data.
4. (Optional) For key pages, call fetch_extract to assess content depth/word count, and screenshot_url to capture how the page renders.
5. (Optional) Extract the main target keyword(s) from each page's title/metadata, then call keyword_research with up to 20 at once to get monthly search volume, CPC, competition, and top-5 related suggestions. Use this to validate keyword targeting and spot gaps.
6. Produce a prioritized report: a table of all pages with their SEO fields + keyword metrics, a list of issues grouped by severity, and concrete fixes. Note site-wide patterns (e.g. all titles missing the brand, pages targeting zero-volume keywords).
Keep it deterministic and cite the exact field values you found.`,
  },
];

/** Compact menu (no full prompts) for the tool's default response. */
export function recipeMenu(): Array<Omit<Recipe, "prompt">> {
  return RECIPES.map(({ prompt, ...rest }) => rest);
}
