import type { McpTool } from "../mcp/types.js";

export const uuidTool: McpTool = {
  name: "uuid_generate",
  description:
    "Generate one or more random UUID v4 values. Use when you need unique identifiers for records, sessions, tokens, or any entity requiring a globally unique ID.",
  inputSchema: {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "Number of UUIDs to generate (1–100, default 1).",
        minimum: 1,
        maximum: 100,
        default: 1,
      },
    },
    required: [],
  },
  run(args) {
    const count = args.count !== undefined ? Number(args.count) : 1;
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error("count must be an integer between 1 and 100.");
    }
    const uuids: string[] = [];
    for (let i = 0; i < count; i++) {
      uuids.push(crypto.randomUUID());
    }
    return uuids.join("\n");
  },
};
