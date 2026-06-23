import type { McpTool } from "../mcp/types.js";

/** UTF-8-safe base64 encode: TextEncoder → Uint8Array → base64 string */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** UTF-8-safe base64 decode: base64 string → Uint8Array → UTF-8 text */
function decodeBase64(data: string): string {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new Error("Invalid base64 input: could not decode.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export const base64EncodeTool: McpTool = {
  name: "base64_encode",
  description:
    "Encode a UTF-8 text string to Base64. Handles non-ASCII characters correctly. Use when you need to embed binary or unicode data in JSON, URLs, or HTTP headers.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The UTF-8 text to encode as Base64.",
      },
    },
    required: ["text"],
  },
  run(args) {
    if (typeof args.text !== "string") {
      throw new Error("text must be a string.");
    }
    return encodeBase64(args.text);
  },
};

export const base64DecodeTool: McpTool = {
  name: "base64_decode",
  description:
    "Decode a Base64 string back to UTF-8 text. Handles non-ASCII characters correctly. Use to recover the original text from a Base64-encoded value.",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "The Base64-encoded string to decode.",
      },
    },
    required: ["data"],
  },
  run(args) {
    if (typeof args.data !== "string") {
      throw new Error("data must be a string.");
    }
    return decodeBase64(args.data);
  },
};
