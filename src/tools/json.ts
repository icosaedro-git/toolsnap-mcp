import type { McpTool } from "../mcp/types.js";

export const jsonFormatTool: McpTool = {
  name: "json_format",
  description:
    "Parse and reformat a JSON string with a configurable indent level (0 = minified, 2 = standard pretty-print). Use to pretty-print, validate, or minify JSON.",
  inputSchema: {
    type: "object",
    properties: {
      json: {
        type: "string",
        description: "The JSON string to parse and reformat.",
      },
      indent: {
        type: "number",
        description: "Indentation spaces (0–8). 0 = minified. Default 2.",
        minimum: 0,
        maximum: 8,
        default: 2,
      },
    },
    required: ["json"],
  },
  run(args) {
    if (typeof args.json !== "string") {
      throw new Error("json must be a string.");
    }
    const indent = args.indent !== undefined ? Number(args.indent) : 2;
    if (!Number.isInteger(indent) || indent < 0 || indent > 8) {
      throw new Error("indent must be an integer between 0 and 8.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.json);
    } catch (err) {
      throw new Error(
        `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return JSON.stringify(parsed, null, indent === 0 ? undefined : indent);
  },
};
