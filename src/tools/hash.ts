import type { McpTool } from "../mcp/types.js";

type HashAlgorithm = "SHA-256" | "SHA-1" | "SHA-512";

const ALGORITHMS: HashAlgorithm[] = ["SHA-256", "SHA-1", "SHA-512"];

export const hashTool: McpTool = {
  name: "hash_text",
  description:
    "Compute a cryptographic hash (SHA-256, SHA-1, or SHA-512) of any text string. Returns the hash as a lowercase hex string. Has no side effects. Use for integrity checks, content fingerprinting, or generating deterministic IDs from content. Do NOT use for password storage — use a dedicated KDF (bcrypt, argon2) instead.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to hash.",
      },
      algorithm: {
        type: "string",
        description: 'Hash algorithm to use. Default "SHA-256".',
        enum: ["SHA-256", "SHA-1", "SHA-512"],
        default: "SHA-256",
      },
    },
    required: ["text"],
  },
  async run(args) {
    const text = args.text;
    if (typeof text !== "string") {
      throw new Error("text must be a string.");
    }
    const algorithm: HashAlgorithm =
      typeof args.algorithm === "string" && ALGORITHMS.includes(args.algorithm as HashAlgorithm)
        ? (args.algorithm as HashAlgorithm)
        : "SHA-256";

    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest(algorithm, data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  },
};
