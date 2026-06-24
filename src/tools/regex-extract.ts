import type { McpTool } from "../mcp/types.js";

const MAX_MATCHES = 500;

export const regexExtractTool: McpTool = {
  name: "regex_extract",
  description:
    "Run a regular expression against text and return all matches. Supports capture groups, named groups, and multiline input. Returns a JSON array of match objects — each has `match` (full match) and `groups` (array of capture groups, or object for named groups). Use for extracting emails, URLs, codes, patterns, or any structured data from unstructured text.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to search.",
      },
      pattern: {
        type: "string",
        description: "Regular expression pattern (without delimiters).",
      },
      flags: {
        type: "string",
        description:
          "Regex flags string (default \"gi\"). Common: g=global, i=case-insensitive, m=multiline, s=dotAll.",
      },
      maxMatches: {
        type: "number",
        description: `Max matches to return (default 100, max ${MAX_MATCHES}).`,
      },
    },
    required: ["text", "pattern"],
  },
  run(args) {
    const text = args.text as string;
    const pattern = args.pattern as string;
    const flags =
      typeof args.flags === "string" ? args.flags : "gi";
    const rawMax =
      args.maxMatches !== undefined ? Number(args.maxMatches) : 100;
    const maxMatches = Math.min(Math.max(1, Math.floor(rawMax)), MAX_MATCHES);

    if (!text) throw new Error("`text` is required.");
    if (!pattern) throw new Error("`pattern` is required.");

    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex pattern: ${msg}`);
    }

    const isGlobal = flags.includes("g");
    const results: Array<{
      match: string;
      index: number;
      groups: string[] | Record<string, string>;
    }> = [];

    if (isGlobal) {
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(text)) !== null && results.length < maxMatches) {
        if (m[0].length === 0) {
          re.lastIndex++;
          if (++guard > text.length + 1) break;
        } else {
          guard = 0;
        }
        results.push(buildEntry(m));
      }
    } else {
      const m = re.exec(text);
      if (m) results.push(buildEntry(m));
    }

    const out = {
      count: results.length,
      truncated: !isGlobal ? false : results.length >= maxMatches,
      matches: results,
    };
    return JSON.stringify(out, null, 2);
  },
};

function buildEntry(m: RegExpExecArray): {
  match: string;
  index: number;
  groups: string[] | Record<string, string>;
} {
  const namedGroups = m.groups;
  let groups: string[] | Record<string, string>;
  if (namedGroups && Object.keys(namedGroups).length > 0) {
    groups = namedGroups as Record<string, string>;
  } else {
    groups = (m.slice(1) as string[]).map((g) => (g === undefined ? "" : g));
  }
  return { match: m[0], index: m.index, groups };
}
