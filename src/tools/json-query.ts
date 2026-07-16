import type { McpTool } from "../mcp/types.js";
import { safeFetch, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 5_000_000; // 5 MB
const XL_FETCH_TIMEOUT_MS = 30_000;
const XL_MAX_JSON_BYTES = 25_000_000; // 25 MB — buffered (JSON needs the whole doc to parse), bounded by Worker RAM.

// ---------------------------------------------------------------------------
// JSONPath-lite evaluator
//
// Supported syntax:
//   $              root
//   .key           property access
//   ['key']        bracket property (handles keys with spaces/special chars)
//   [0]  [-1]      array index (negative counts from end)
//   [*]            all array elements (wildcard)
//   ..key          recursive descent — find 'key' anywhere in the tree
//   [?(@.k op v)]  filter — operators: = != > >= < <= =~
//
// Examples:
//   $.users[*].name
//   $.store.books[0].title
//   $..price
//   $.items[?(@.price < 10)].name
// ---------------------------------------------------------------------------

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [k: string]: JSONValue };

// Token types
type Token =
  | { t: "root" }
  | { t: "dot"; key: string }
  | { t: "bracket"; key: string }
  | { t: "index"; idx: number }
  | { t: "wildcard" }
  | { t: "recursive"; key: string }
  | { t: "filter"; expr: string };

function tokenize(path: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  // Must start with $
  if (path[0] !== "$") throw new Error("Path must start with $");
  tokens.push({ t: "root" });
  i = 1;

  while (i < path.length) {
    // Recursive descent ..
    if (path[i] === "." && path[i + 1] === ".") {
      i += 2;
      const key = readIdent(path, i);
      if (!key) throw new Error(`Expected key after '..' at position ${i}`);
      tokens.push({ t: "recursive", key });
      i += key.length;
      continue;
    }

    // Dot notation .key
    if (path[i] === ".") {
      i++;
      if (i >= path.length) break;
      const key = readIdent(path, i);
      if (!key) throw new Error(`Expected key after '.' at position ${i}`);
      tokens.push({ t: "dot", key });
      i += key.length;
      continue;
    }

    // Bracket notation [...]
    if (path[i] === "[") {
      i++;
      if (path[i] === "*" && path[i + 1] === "]") {
        tokens.push({ t: "wildcard" });
        i += 2;
        continue;
      }

      // Filter [?(@.key op value)]
      if (path[i] === "?" && path[i + 1] === "(") {
        const end = path.indexOf(")", i);
        if (end === -1) throw new Error("Unclosed filter expression");
        const expr = path.slice(i + 2, end); // skip ?( to get inner expression
        tokens.push({ t: "filter", expr });
        i = end + 2; // skip ) and ]
        continue;
      }

      // Index [0] or [-1]
      if (path[i] === "-" || (path[i] >= "0" && path[i] <= "9")) {
        let numStr = "";
        if (path[i] === "-") { numStr = "-"; i++; }
        while (i < path.length && path[i] >= "0" && path[i] <= "9") {
          numStr += path[i++];
        }
        if (path[i] !== "]") throw new Error(`Expected ] at position ${i}`);
        i++;
        tokens.push({ t: "index", idx: parseInt(numStr, 10) });
        continue;
      }

      // Quoted key ['key'] or ["key"]
      if (path[i] === "'" || path[i] === '"') {
        const quote = path[i++];
        let key = "";
        while (i < path.length && path[i] !== quote) {
          if (path[i] === "\\") i++;
          key += path[i++];
        }
        i++; // closing quote
        if (path[i] !== "]") throw new Error(`Expected ] after quoted key`);
        i++;
        tokens.push({ t: "bracket", key });
        continue;
      }

      // Bare key inside brackets [key] — less common but handle it
      let key = "";
      while (i < path.length && path[i] !== "]") key += path[i++];
      i++; // ]
      tokens.push({ t: "bracket", key });
      continue;
    }

    throw new Error(`Unexpected character '${path[i]}' at position ${i}`);
  }

  return tokens;
}

function readIdent(s: string, start: number): string {
  let end = start;
  while (end < s.length && s[end] !== "." && s[end] !== "[" && s[end] !== "]") {
    end++;
  }
  return s.slice(start, end);
}

// ---------------------------------------------------------------------------
// Filter expression evaluator: @.key op value
// ---------------------------------------------------------------------------

function evalFilter(item: JSONValue, expr: string): boolean {
  // expr like: @.price < 10  or  @.name = "Alice"  or  @.tag =~ /foo/
  const m = expr.match(/^@\.(.+?)\s*(=~|!=|>=|<=|>|<|=)\s*(.+)$/);
  if (!m) return false;

  const [, key, op, rawVal] = m;
  const actual = getNestedKey(item, key);
  if (actual === undefined) return false;

  // String value: strip optional quotes
  const valStr = rawVal.trim().replace(/^["']|["']$/g, "");

  // Regex match
  if (op === "=~") {
    const regexMatch = rawVal.trim().match(/^\/(.+)\/([gimu]*)$/);
    if (!regexMatch) return false;
    try {
      return new RegExp(regexMatch[1], regexMatch[2]).test(String(actual));
    } catch { return false; }
  }

  const actualNum = typeof actual === "number" ? actual : parseFloat(String(actual));
  const valNum = parseFloat(valStr);

  switch (op) {
    case "=":
      return String(actual).toLowerCase() === valStr.toLowerCase();
    case "!=":
      return String(actual).toLowerCase() !== valStr.toLowerCase();
    case ">":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum > valNum;
    case ">=":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum >= valNum;
    case "<":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum < valNum;
    case "<=":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum <= valNum;
    default:
      return false;
  }
}

/** Append every element of `src` to `dest` without spreading — `dest.push(...src)`
 *  throws RangeError on large arrays (engines cap spread/apply argument counts). */
function pushAll<T>(dest: T[], src: readonly T[]): void {
  for (const item of src) dest.push(item);
}

function getNestedKey(obj: JSONValue, key: string): JSONValue | undefined {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return undefined;
  }
  return (obj as Record<string, JSONValue>)[key];
}

// ---------------------------------------------------------------------------
// Path evaluator
// ---------------------------------------------------------------------------

function evalTokens(
  nodes: JSONValue[],
  tokens: Token[],
  startIdx: number
): JSONValue[] {
  if (startIdx >= tokens.length) return nodes;

  const token = tokens[startIdx];
  const results: JSONValue[] = [];

  for (const node of nodes) {
    switch (token.t) {
      case "root":
        results.push(node);
        break;

      case "dot":
      case "bracket": {
        const key = token.t === "dot" ? token.key : token.key;
        if (node !== null && typeof node === "object" && !Array.isArray(node)) {
          const val = (node as Record<string, JSONValue>)[key];
          if (val !== undefined) results.push(val);
        }
        break;
      }

      case "index": {
        if (Array.isArray(node)) {
          const idx = token.idx < 0 ? node.length + token.idx : token.idx;
          if (idx >= 0 && idx < node.length) results.push(node[idx]);
        }
        break;
      }

      case "wildcard": {
        if (Array.isArray(node)) {
          pushAll(results, node);
        } else if (node !== null && typeof node === "object") {
          pushAll(results, Object.values(node as Record<string, JSONValue>));
        }
        break;
      }

      case "recursive": {
        // Find all occurrences of key in the subtree
        pushAll(results, findRecursive(node, token.key));
        break;
      }

      case "filter": {
        if (Array.isArray(node)) {
          pushAll(results, node.filter((item) => evalFilter(item, token.expr)));
        }
        break;
      }
    }
  }

  return evalTokens(results, tokens, startIdx + 1);
}

function findRecursive(node: JSONValue, key: string): JSONValue[] {
  const results: JSONValue[] = [];
  if (node === null || typeof node !== "object") return results;

  if (Array.isArray(node)) {
    for (const item of node) {
      pushAll(results, findRecursive(item, key));
    }
  } else {
    const obj = node as Record<string, JSONValue>;
    if (key in obj) results.push(obj[key]);
    for (const val of Object.values(obj)) {
      pushAll(results, findRecursive(val, key));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

interface JsonQueryEngineOptions {
  toolName: string;
  allowInline: boolean;
  maxBytes: number;
  fetchTimeoutMs: number;
  tooLargeHint: string;
}

async function runJsonQuery(args: Record<string, unknown>, opts: JsonQueryEngineOptions): Promise<string> {
  if (typeof args.query !== "string" || !args.query.trim()) {
    throw new Error("`query` is required.");
  }

  const hasUrl = typeof args.url === "string" && (args.url as string).length > 0;
  const hasJson = opts.allowInline && typeof args.json === "string" && (args.json as string).length > 0;

  if (!hasUrl && !hasJson) {
    throw new Error(opts.allowInline ? "Provide either `url` or `json`." : "`url` is required.");
  }
  if (hasUrl && hasJson) throw new Error("Provide either `url` or `json`, not both.");

  let rawJson: string;
  if (hasUrl) {
    const url = args.url as string;
    const forwardHeaders = parseForwardHeaders(args.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs);
    let response: Response;
    try {
      response = await safeFetch(
        url,
        {
          signal: controller.signal,
          headers: { "User-Agent": `toolsnap-mcp/1.0 (${opts.toolName}; +https://toolsnap.app)` },
        },
        { forwardHeaders }
      );
    } catch (err) {
      throw new Error(`Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
    const buf = await response.arrayBuffer();
    if (buf.byteLength > opts.maxBytes) {
      throw new Error(`JSON too large for ${opts.toolName}: ${buf.byteLength} bytes (max ${opts.maxBytes}). ${opts.tooLargeHint}`);
    }
    rawJson = new TextDecoder().decode(buf);
  } else {
    rawJson = args.json as string;
  }

  let data: JSONValue;
  try {
    data = JSON.parse(rawJson) as JSONValue;
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse and evaluate the path
  let tokens: Token[];
  try {
    tokens = tokenize((args.query as string).trim());
  } catch (err) {
    throw new Error(`Invalid query: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Start evaluation from root
  const results = evalTokens([data], tokens, 1); // skip root token; data IS the root

  // Limit
  const rawLimit = args.limit !== undefined ? Number(args.limit) : 100;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 1000);
  const total = results.length;
  const sliced = results.slice(0, limit);
  const truncated = total > limit;

  const output = sliced.length === 1 ? sliced[0] : sliced;

  return JSON.stringify(
    truncated ? { results: output, total, returned: sliced.length } : output,
    null,
    2
  );
}

export const jsonQueryTool: McpTool = {
  name: "json_query",
  description: "Query JSON with JSONPath-lite ($.a[*].b, ..key). One of url or json.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "JSON URL (alt. to json)." },
      json: { type: "string", description: "Raw JSON (alt. to url)." },
      query: { type: "string", description: "e.g. '$.users[*].name'." },
      limit: { type: "number", description: "Max results." },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  run(args) {
    return runJsonQuery(args, {
      toolName: "json_query",
      allowInline: true,
      maxBytes: MAX_JSON_BYTES,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
      tooLargeHint:
        "Use `json_query_xl` (paid: $0.02/call or $0.01 prepaid, up to 25 MB) with the same url and query.",
    });
  },
};

export const jsonQueryXlTool: McpTool = {
  name: "json_query_xl",
  description:
    "Paid sibling of json_query for larger URL-hosted JSON (up to 25 MB, vs 5 MB free). Same JSONPath-lite query language. URL-only (no inline json — a 25 MB payload would blow out your context anyway). $0.02/call pay-per-call or $0.01 prepaid; no first-call-free (a paid file-size tier, not a marketing freebie). Below 5 MB, use the free json_query instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "JSON URL." },
      query: { type: "string", description: "e.g. '$.users[*].name'." },
      limit: { type: "number", description: "Max results." },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["url", "query"],
  },
  annotations: { readOnlyHint: true },
  run(args) {
    return runJsonQuery(args, {
      toolName: "json_query_xl",
      allowInline: false,
      maxBytes: XL_MAX_JSON_BYTES,
      fetchTimeoutMs: XL_FETCH_TIMEOUT_MS,
      tooLargeHint: "This file exceeds even json_query_xl's 25 MB cap.",
    });
  },
};
