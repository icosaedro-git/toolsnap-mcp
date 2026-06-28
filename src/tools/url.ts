import type { McpTool } from "../mcp/types.js";

export const urlEncodeTool: McpTool = {
  name: "url_encode",
  description:
    "Percent-encode a string for safe inclusion in a URL query parameter or path segment (encodeURIComponent). Returns the encoded string. Has no side effects. Free. Use when building URLs that contain special characters, spaces, or non-ASCII text. Do NOT use to encode a full URL — only encode individual query values or path segments.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to URL-encode.",
      },
    },
    required: ["text"],
  },
  run(args) {
    if (typeof args.text !== "string") {
      throw new Error("text must be a string.");
    }
    return encodeURIComponent(args.text);
  },
};

export const urlDecodeTool: McpTool = {
  name: "url_decode",
  description:
    "Decode a percent-encoded URL string back to plain text (decodeURIComponent). Returns the decoded string, or an error if the input contains an invalid percent-escape sequence. Has no side effects. Free. Use to recover the original text from a URL-encoded value.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The URL-encoded string to decode.",
      },
    },
    required: ["text"],
  },
  run(args) {
    if (typeof args.text !== "string") {
      throw new Error("text must be a string.");
    }
    try {
      return decodeURIComponent(args.text);
    } catch {
      throw new Error("Invalid percent-encoded input: could not decode.");
    }
  },
};
