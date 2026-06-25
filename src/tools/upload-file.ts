import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";

/**
 * upload_file (Fase 13.0b) — accepts a base64-encoded image and stores it in
 * R2, returning a permanent public URL that can be passed to remove_background
 * or other image tools. Free — supporting operation for paid tools.
 *
 * Env-aware (needs SCREENSHOTS_BUCKET + R2_PUBLIC_URL).
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const uploadFileTool: McpTool = {
  name: "upload_file",
  description:
    "Upload a base64-encoded image to ToolSnap temporary storage and receive a URL to pass to tools like remove_background. The file is automatically deleted once consumed by a tool (e.g. remove_background deletes it immediately after reading). Do not use this URL as a permanent link. Accepts JPEG, PNG, WEBP, or GIF up to 10 MB. Free tool — no payment required. Returns: url (temporary), key, content_type, file_size_bytes.",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "Base64-encoded image data (no data: URI prefix — just the raw base64 string).",
      },
      content_type: {
        type: "string",
        description: 'MIME type of the image: "image/jpeg", "image/png", "image/webp", or "image/gif".',
        enum: ["image/jpeg", "image/png", "image/webp", "image/gif"],
      },
    },
    required: ["data", "content_type"],
  },
  run() {
    throw new Error("upload_file is env-aware and must be called via runWithEnv");
  },
  async runWithEnv(args, env) {
    const typedEnv = env as Env;
    if (!typedEnv.SCREENSHOTS_BUCKET) throw new Error("R2 bucket not configured");

    const data = typeof args.data === "string" ? args.data : "";
    const contentType = typeof args.content_type === "string" ? args.content_type.toLowerCase() : "";

    if (!data) throw new Error("`data` must be a non-empty base64 string");

    const ext = ALLOWED_MIME[contentType];
    if (!ext) {
      throw new Error(
        `Unsupported content_type "${contentType}". Allowed: ${Object.keys(ALLOWED_MIME).join(", ")}`
      );
    }

    let bytes: Uint8Array;
    try {
      const bin = atob(data.replace(/\s/g, ""));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      throw new Error("`data` is not valid base64");
    }

    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(`Image too large: ${bytes.byteLength} bytes (max ${MAX_BYTES})`);
    }

    const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
    await typedEnv.SCREENSHOTS_BUCKET.put(key, bytes, {
      httpMetadata: { contentType },
    });

    const publicBase = (typedEnv.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
    const url = `${publicBase.replace("pub-", "files-")}/${key}`;

    // Return the /files/ Worker-served URL (always accessible, bypasses R2 dev URL issues)
    const workerBase = "https://mcp.toolsnap.app";
    return JSON.stringify({
      url: `${workerBase}/files/${key}`,
      key,
      content_type: contentType,
      file_size_bytes: bytes.byteLength,
    });
  },
};
