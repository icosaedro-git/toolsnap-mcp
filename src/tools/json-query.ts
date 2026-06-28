import type { McpTool } from "../mcp/types.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 5_000_000; // 5 MB

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
          results.push(...node);
        } else if (node !== null && typeof node === "object") {
          results.push(...Object.values(node as Record<string, JSONValue>));
        }
        break;
      }

      case "recursive": {
        // Find all occurrences of key in the subtree
        results.push(...findRecursive(node, token.key));
        break;
      }

      case "filter": {
        if (Array.isArray(node)) {
          results.push(...node.filter((item) => evalFilter(item, token.expr)));
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
      results.push(...findRecursive(item, key));
    }
  } else {
    const obj = node as Record<string, JSONValue>;
    if (key in obj) results.push(obj[key]);
    for (const val of Object.values(obj)) {
      results.push(...findRecursive(val, key));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const jsonQueryTool: McpTool = {
  name: "json_query",
  description:
    "Fetch JSON from a URL (or accept raw JSON) and query it with a JSONPath-lite expression. Supports property access, array indexing, wildcards ([*]), recursive descent (..), and filter expressions ([?(@.price < 10)]). Provide exactly one of url or json — not both. Returns only the matching values as JSON. Returns an error if the URL is unreachable, the response is not valid JSON, or the query expression is invalid. Has no side effects. Use instead of loading large JSON payloads into your context.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL returning JSON to query (http/https).",
      },
      json: {
        type: "string",
        description: "Raw JSON string to query (alternative to url).",
      },
      query: {
        type: "string",
        description:
          "JSONPath-lite expression. Examples: '$.users[*].name', '$..price', '$.items[?(@.stock > 0)].id', '$.store.books[0].title'",
      },
      limit: {
        type: "number",
        description: "Max number of results to return (default 100, max 1000).",
      },
    },
    required: ["query"],
  },
  async run(args) {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("`query` is required.");
    }

    const hasUrl = typeof args.url === "string" && (args.url as string).length > 0;
    const hasJson = typeof args.json === "string" && (args.json as string).length > 0;

    if (!hasUrl && !hasJson) throw new Error("Provide either `url` or `json`.");
    if (hasUrl && hasJson) throw new Error("Provide either `url` or `json`, not both.");

    let rawJson: string;
    if (hasUrl) {
      const url = args.url as string;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("`url` must start with http:// or https://");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "toolsnap-mcp/1.0 (json_query; +https://toolsnap.app)" },
        });
      } catch (err) {
        throw new Error(`Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const buf = await response.arrayBuffer();
      if (buf.byteLength > MAX_JSON_BYTES) {
        throw new Error(`JSON too large: ${buf.byteLength} bytes (max ${MAX_JSON_BYTES}).`);
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
  },
};
