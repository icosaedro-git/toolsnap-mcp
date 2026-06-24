import type { McpTool, McpToolDefinition } from "../mcp/types.js";
import { uuidTool } from "./uuid.js";
import { hashTool } from "./hash.js";
import { base64EncodeTool, base64DecodeTool } from "./base64.js";
import { urlEncodeTool, urlDecodeTool } from "./url.js";
import { jsonFormatTool } from "./json.js";
import { timestampConvertTool } from "./timestamp.js";
import { textStatsTool } from "./text-stats.js";
import { fetchExtractTool } from "./fetch-extract.js";
import { htmlToMarkdownTool } from "./html-to-markdown.js";
import { extractStructuredTool } from "./extract-structured.js";
import { diffTextTool } from "./diff-text.js";
import { csvQueryTool } from "./csv-query.js";
import { jsonQueryTool } from "./json-query.js";
import { pdfTextExtractTool } from "./pdf-text-extract.js";
import { regexExtractTool } from "./regex-extract.js";
import { webpageMetadataTool } from "./webpage-metadata.js";
import { countTokensTool } from "./count-tokens.js";
import { rssParseTool } from "./rss-parse.js";
import { sitemapParseTool } from "./sitemap-parse.js";
import { fetchHtmlTool } from "./fetch-html.js";
import { pageAssetsTool } from "./page-assets.js";
import { pageLinksTool } from "./page-links.js";
import { pricingTool } from "./pricing.js";
import { accountBalanceTool, accountDepositTool } from "./account.js";

export const tools: McpTool[] = [
  pricingTool,
  accountBalanceTool,
  accountDepositTool,
  fetchExtractTool,
  fetchHtmlTool,
  pageAssetsTool,
  pageLinksTool,
  uuidTool,
  hashTool,
  base64EncodeTool,
  base64DecodeTool,
  urlEncodeTool,
  urlDecodeTool,
  jsonFormatTool,
  timestampConvertTool,
  textStatsTool,
  htmlToMarkdownTool,
  extractStructuredTool,
  diffTextTool,
  csvQueryTool,
  jsonQueryTool,
  pdfTextExtractTool,
  regexExtractTool,
  webpageMetadataTool,
  countTokensTool,
  rssParseTool,
  sitemapParseTool,
];

/** Returns the tool list for tools/list responses (no run function). */
export function listTools(): McpToolDefinition[] {
  return tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

/**
 * Find and run a tool by name.
 * Returns the string result.
 * Throws if tool not found or run throws.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return await tool.run(args);
}
