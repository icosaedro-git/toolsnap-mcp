import type { McpTool, McpToolDefinition } from "../mcp/types.js";
import { uuidTool } from "./uuid.js";
import { hashTool } from "./hash.js";
import { base64EncodeTool, base64DecodeTool } from "./base64.js";
import { urlEncodeTool, urlDecodeTool } from "./url.js";
import { jsonFormatTool } from "./json.js";
import { timestampConvertTool } from "./timestamp.js";
import { textStatsTool } from "./text-stats.js";

export const tools: McpTool[] = [
  uuidTool,
  hashTool,
  base64EncodeTool,
  base64DecodeTool,
  urlEncodeTool,
  urlDecodeTool,
  jsonFormatTool,
  timestampConvertTool,
  textStatsTool,
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
