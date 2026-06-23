import type { McpTool } from "../mcp/types.js";

// ---------------------------------------------------------------------------
// Myers diff — produces unified-diff output
// ---------------------------------------------------------------------------

type EditOp = { type: "keep" | "del" | "add"; line: string };

function computeDiff(aLines: string[], bLines: string[]): EditOp[] {
  const m = aLines.length;
  const n = bLines.length;

  // LCS dynamic programming table
  // Use Uint32Array for memory efficiency on large inputs
  const dp = new Array<Uint32Array>(m + 1);
  for (let i = 0; i <= m; i++) {
    dp[i] = new Uint32Array(n + 1);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }

  // Back-trace
  const ops: EditOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ type: "keep", line: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", line: bLines[j - 1] });
      j--;
    } else {
      ops.push({ type: "del", line: aLines[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

function formatUnifiedDiff(
  ops: EditOp[],
  aLines: string[],
  bLines: string[],
  context: number,
  labelA: string,
  labelB: string
): string {
  // Build hunks: groups of changed lines + `context` surrounding lines
  const hunks: string[] = [];
  const n = ops.length;

  // Map each op index to line numbers in a/b
  let aLine = 1;
  let bLine = 1;
  type IndexedOp = EditOp & { aLine: number; bLine: number };
  const indexed: IndexedOp[] = ops.map((op) => {
    const entry: IndexedOp = { ...op, aLine, bLine };
    if (op.type !== "add") aLine++;
    if (op.type !== "del") bLine++;
    return entry;
  });

  let i = 0;
  while (i < n) {
    // Find next change
    while (i < n && indexed[i].type === "keep") i++;
    if (i >= n) break;

    // Extend hunk: include `context` lines before and after
    const start = Math.max(0, i - context);
    let end = i;
    while (end < n && indexed[end].type !== "keep") end++;
    end = Math.min(n, end + context);
    // Expand to absorb adjacent hunks if context lines overlap
    let changed = true;
    while (changed) {
      changed = false;
      const newEnd = Math.min(n, end + context);
      for (let k = end; k < newEnd; k++) {
        if (indexed[k].type !== "keep") {
          end = Math.min(n, k + 1 + context);
          changed = true;
        }
      }
    }

    const slice = indexed.slice(start, end);
    const firstA = slice[0].aLine;
    const firstB = slice[0].bLine;
    const countA = slice.filter((o) => o.type !== "add").length;
    const countB = slice.filter((o) => o.type !== "del").length;

    const hunkLines: string[] = [
      `@@ -${firstA},${countA} +${firstB},${countB} @@`,
    ];
    for (const op of slice) {
      if (op.type === "keep") hunkLines.push(` ${op.line}`);
      else if (op.type === "del") hunkLines.push(`-${op.line}`);
      else hunkLines.push(`+${op.line}`);
    }
    hunks.push(hunkLines.join("\n"));

    i = end;
  }

  if (hunks.length === 0) return "(no differences)";

  const header = `--- ${labelA}\n+++ ${labelB}`;
  return header + "\n" + hunks.join("\n");
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const MAX_LINES = 5_000;

export const diffTextTool: McpTool = {
  name: "diff_text",
  description:
    "Compare two text strings and return a unified diff showing additions (+), deletions (-), and context lines. Useful for review agents, changelog generation, and patch creation. Returns '(no differences)' when inputs are identical. Free — no payment required.",
  inputSchema: {
    type: "object",
    properties: {
      a: {
        type: "string",
        description: 'The "before" text (original).',
      },
      b: {
        type: "string",
        description: 'The "after" text (modified).',
      },
      context: {
        type: "number",
        description: "Number of unchanged context lines around each change (default 3, max 10).",
      },
      label_a: {
        type: "string",
        description: 'Label for the "before" file header (default "a").',
      },
      label_b: {
        type: "string",
        description: 'Label for the "after" file header (default "b").',
      },
    },
    required: ["a", "b"],
  },
  run(args) {
    if (typeof args.a !== "string") throw new Error("`a` must be a string.");
    if (typeof args.b !== "string") throw new Error("`b` must be a string.");

    const rawContext =
      args.context !== undefined ? Number(args.context) : 3;
    const ctx = Math.min(Math.max(0, Math.floor(rawContext)), 10);

    const labelA =
      typeof args.label_a === "string" && args.label_a ? args.label_a : "a";
    const labelB =
      typeof args.label_b === "string" && args.label_b ? args.label_b : "b";

    const aLines = args.a.split("\n");
    const bLines = args.b.split("\n");

    if (aLines.length > MAX_LINES || bLines.length > MAX_LINES) {
      throw new Error(
        `Input too large: max ${MAX_LINES} lines per string (a: ${aLines.length}, b: ${bLines.length}).`
      );
    }

    const ops = computeDiff(aLines, bLines);
    return formatUnifiedDiff(ops, aLines, bLines, ctx, labelA, labelB);
  },
};
