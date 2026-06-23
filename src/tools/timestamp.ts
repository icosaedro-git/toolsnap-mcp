import type { McpTool } from "../mcp/types.js";

/**
 * Convert between Unix timestamps (seconds) and ISO 8601 date strings.
 *
 * Auto-detection (when `to` is omitted):
 *   - If input is a number (or a string that parses as one) → treat as Unix → return ISO.
 *   - Numbers > 1e12 are assumed to be milliseconds, divided by 1000 first.
 *   - Otherwise treat as a date string → return Unix seconds.
 */
export const timestampConvertTool: McpTool = {
  name: "timestamp_convert",
  description:
    "Convert between Unix timestamps (seconds) and ISO 8601 date strings. Auto-detects direction: numbers → ISO, date strings → Unix seconds. Accepts Unix in seconds or milliseconds (auto-detected). Use when you need to convert epoch values to human-readable dates or vice-versa.",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          'The value to convert. Either a Unix timestamp (as a number or numeric string, seconds or ms) or an ISO/date string like "2024-01-15T10:30:00Z".',
      },
      to: {
        type: "string",
        description:
          '"iso" to force output as ISO 8601, "unix" to force output as Unix seconds. Omit to auto-detect.',
        enum: ["iso", "unix"],
      },
    },
    required: ["input"],
  },
  run(args) {
    const raw = args.input;
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new Error("input must be a string or number.");
    }

    const toMode = typeof args.to === "string" ? args.to : null;
    if (toMode !== null && toMode !== "iso" && toMode !== "unix") {
      throw new Error('to must be "iso" or "unix".');
    }

    const asNumber = Number(raw);
    const isNumeric = !isNaN(asNumber) && String(raw).trim() !== "";

    // Determine effective unix seconds
    function getUnixSeconds(): number {
      if (!isNumeric) {
        throw new Error(`Cannot interpret "${raw}" as a Unix timestamp.`);
      }
      // If > 1e12 assume milliseconds
      return asNumber > 1e12 ? asNumber / 1000 : asNumber;
    }

    // Determine effective Date from string input
    function getDateFromString(): Date {
      const d = new Date(String(raw));
      if (isNaN(d.getTime())) {
        throw new Error(`Cannot parse "${raw}" as a date.`);
      }
      return d;
    }

    // Resolve target mode
    const effectiveTo: "iso" | "unix" = toMode
      ? toMode
      : isNumeric
      ? "iso"
      : "unix";

    if (effectiveTo === "iso") {
      // Input is a unix timestamp → ISO
      const seconds = getUnixSeconds();
      return new Date(seconds * 1000).toISOString();
    } else {
      // Input is a date string → unix seconds
      if (isNumeric) {
        // Forced to unix output from a number input — convert ms to seconds or return as-is
        const seconds = getUnixSeconds();
        return String(Math.floor(seconds));
      }
      const d = getDateFromString();
      return String(Math.floor(d.getTime() / 1000));
    }
  },
};
