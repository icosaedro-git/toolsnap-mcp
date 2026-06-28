import type { McpTool } from "../mcp/types.js";

const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// HTML data extraction helpers
// ---------------------------------------------------------------------------

function extractJsonLd(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed: unknown = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            results.push(item as Record<string, unknown>);
          }
        }
      } else if (parsed && typeof parsed === "object") {
        results.push(parsed as Record<string, unknown>);
        // JSON-LD @graph
        const graph = (parsed as Record<string, unknown>)["@graph"];
        if (Array.isArray(graph)) {
          for (const node of graph) {
            if (node && typeof node === "object") {
              results.push(node as Record<string, unknown>);
            }
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return results;
}

function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  // og: / article: / twitter:
  let re = /<meta[^>]+property=["']([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    meta[m[1].toLowerCase()] = m[2];
  }

  // name= meta tags
  re = /<meta[^>]+name=["']([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  while ((m = re.exec(html)) !== null) {
    meta[m[1].toLowerCase()] = m[2];
  }

  // <title>
  const titleM = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (titleM) meta["title"] = titleM[1].trim();

  // canonical
  const canonM = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["'][^>]*>/i.exec(html);
  if (canonM) meta["canonical"] = canonM[1];

  return meta;
}

/** Flatten a JSON-LD object into dot-notation keys for easy lookup. */
function flattenObj(
  obj: Record<string, unknown>,
  prefix = "",
  acc: Record<string, unknown> = {}
): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenObj(v as Record<string, unknown>, key, acc);
    } else {
      acc[key] = v;
    }
  }
  return acc;
}

/** Lookup a field by trying common aliases across JSON-LD + meta. */
function resolveField(
  fieldName: string,
  jsonLd: Record<string, unknown>[],
  meta: Record<string, string>,
  html: string
): unknown {
  const key = fieldName.toLowerCase();

  // --- Title ---
  if (["title", "name", "headline"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v =
        flat["headline"] ??
        flat["name"] ??
        flat["title"] ??
        flat["og:title"];
      if (typeof v === "string" && v) return v;
    }
    return (
      meta["og:title"] ??
      meta["twitter:title"] ??
      meta["title"] ??
      null
    );
  }

  // --- Description ---
  if (["description", "summary", "abstract"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v = flat["description"] ?? flat["abstract"];
      if (typeof v === "string" && v) return v;
    }
    return (
      meta["og:description"] ??
      meta["twitter:description"] ??
      meta["description"] ??
      null
    );
  }

  // --- Author ---
  if (["author", "creator", "byline"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v =
        flat["author.name"] ??
        flat["author"] ??
        flat["creator.name"] ??
        flat["creator"];
      if (typeof v === "string" && v) return v;
    }
    return meta["author"] ?? meta["article:author"] ?? null;
  }

  // --- Date published ---
  if (
    [
      "date",
      "datepublished",
      "publishdate",
      "publishedat",
      "published_at",
      "published",
    ].includes(key)
  ) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v =
        flat["datePublished"] ??
        flat["dateCreated"] ??
        flat["uploadDate"] ??
        flat["startDate"];
      if (typeof v === "string" && v) return v;
    }
    // <time datetime="...">
    const timeM = /<time[^>]+datetime=["']([^"']*)["'][^>]*>/i.exec(html);
    if (timeM) return timeM[1];
    return (
      meta["article:published_time"] ??
      meta["date"] ??
      meta["publish_date"] ??
      null
    );
  }

  // --- Date modified ---
  if (["datemodified", "modified", "updatedat", "updated_at"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v = flat["dateModified"] ?? flat["modified"];
      if (typeof v === "string" && v) return v;
    }
    return meta["article:modified_time"] ?? meta["last-modified"] ?? null;
  }

  // --- Image ---
  if (["image", "thumbnail", "cover", "photo"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v =
        flat["image.url"] ??
        flat["image"] ??
        flat["thumbnailUrl"];
      if (typeof v === "string" && v) return v;
    }
    return meta["og:image"] ?? meta["twitter:image"] ?? null;
  }

  // --- URL / canonical ---
  if (["url", "link", "canonical", "permalink"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v = flat["url"] ?? flat["@id"];
      if (typeof v === "string" && v && v.startsWith("http")) return v;
    }
    return meta["og:url"] ?? meta["canonical"] ?? null;
  }

  // --- Price ---
  if (["price", "amount", "cost"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v =
        flat["offers.price"] ??
        flat["offers.lowPrice"] ??
        flat["price"];
      if (v !== undefined) return v;
    }
    // itemprop="price"
    const priceM = /itemprop=["']price["'][^>]+content=["']([^"']*)["']/i.exec(html);
    if (priceM) return priceM[1];
    // heuristic pattern: $12.99 or 12.99 USD
    const heurM = /\$\s*([\d,]+\.?\d{0,2})/.exec(html);
    if (heurM) return parseFloat(heurM[1].replace(/,/g, ""));
    return null;
  }

  // --- Currency ---
  if (["currency", "pricecurrency"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v = flat["offers.priceCurrency"] ?? flat["priceCurrency"];
      if (typeof v === "string" && v) return v;
    }
    return null;
  }

  // --- Rating ---
  if (["rating", "ratingvalue", "score"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v =
        flat["aggregateRating.ratingValue"] ??
        flat["ratingValue"];
      if (v !== undefined) return v;
    }
    return null;
  }

  // --- Type / @type ---
  if (["type", "@type", "pagetype"].includes(key)) {
    for (const obj of jsonLd) {
      const v = obj["@type"];
      if (v) return v;
    }
    return meta["og:type"] ?? null;
  }

  // --- Site name ---
  if (["sitename", "site_name", "publisher", "brand"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v =
        flat["publisher.name"] ??
        flat["publisher"] ??
        flat["provider.name"] ??
        flat["brand.name"];
      if (typeof v === "string" && v) return v;
    }
    return meta["og:site_name"] ?? null;
  }

  // --- Keywords / tags ---
  if (["keywords", "tags", "categories"].includes(key)) {
    for (const obj of jsonLd) {
      const flat = flattenObj(obj);
      const v = flat["keywords"] ?? flat["articleSection"];
      if (v !== undefined) return v;
    }
    return meta["keywords"] ?? meta["article:tag"] ?? null;
  }

  // Generic fallback: scan JSON-LD flat keys for exact/partial match
  for (const obj of jsonLd) {
    const flat = flattenObj(obj);
    // exact key match
    if (flat[fieldName] !== undefined) return flat[fieldName];
    // case-insensitive partial match on last segment
    for (const [k, v] of Object.entries(flat)) {
      const lastSegment = k.split(".").pop()?.toLowerCase();
      if (lastSegment === key) return v;
    }
  }

  // Fallback to meta tags
  if (meta[key] !== undefined) return meta[key];
  if (meta[`og:${key}`] !== undefined) return meta[`og:${key}`];

  return null;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const extractStructuredTool: McpTool = {
  name: "fetch_structured",
  description:
    "Fetch a URL and extract structured data matching a JSON Schema — title, author, date, price, description, rating, image, and more. Reads JSON-LD, Open Graph, Twitter Cards, and Schema.org microdata embedded in the page; returns only the extracted JSON object. No LLM required: extraction is deterministic. Returns an empty object if the page has no matching semantic markup. Returns an error if the URL is unreachable or the schema parameter is not valid JSON. Has no side effects. Ideal for articles, products, recipes, and events with semantic markup. Do NOT use for pages without structured markup — use fetch_extract or html_to_markdown instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch and extract data from.",
      },
      schema: {
        type: "string",
        description:
          'JSON Schema (as a JSON string) describing the fields to extract. E.g. {"type":"object","properties":{"title":{"type":"string"},"price":{"type":"number"}}}',
      },
    },
    required: ["url", "schema"],
  },
  async run(args) {
    if (typeof args.url !== "string" || !args.url.startsWith("http")) {
      throw new Error("`url` must be a string starting with http:// or https://");
    }
    if (typeof args.schema !== "string" || !args.schema.trim()) {
      throw new Error("`schema` must be a non-empty JSON string.");
    }

    let schemaParsed: Record<string, unknown>;
    try {
      schemaParsed = JSON.parse(args.schema) as Record<string, unknown>;
    } catch {
      throw new Error("`schema` is not valid JSON.");
    }

    // Fetch page
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(args.url as string, {
        signal: controller.signal,
        headers: {
          "User-Agent": "toolsnap-mcp/1.0 (fetch_structured; +https://toolsnap.app)",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch URL: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    // Extract all data sources
    const jsonLd = extractJsonLd(html);
    const meta = extractMetaTags(html);

    // Get field names from schema
    const properties =
      (schemaParsed["properties"] as Record<string, unknown>) ?? {};
    const fieldNames = Object.keys(properties);

    if (fieldNames.length === 0) {
      throw new Error(
        "Schema must have at least one property in `properties`."
      );
    }

    // Build result
    const result: Record<string, unknown> = {};
    for (const field of fieldNames) {
      const value = resolveField(field, jsonLd, meta, html);
      result[field] = value;
    }

    return JSON.stringify(result, null, 2);
  },
};
