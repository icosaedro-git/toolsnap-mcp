import type { McpTool } from "../mcp/types.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CSV_BYTES = 5_000_000; // 5 MB

// ---------------------------------------------------------------------------
// CSV parser — handles quoted fields, commas, and newlines inside quotes
// ---------------------------------------------------------------------------

function parseCSVRow(line: string): string[] {
  const values: string[] = [];
  let inQuotes = false;
  let current = "";

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

interface ParsedCSV {
  headers: string[];
  rows: Record<string, string>[];
}

function parseCSV(text: string): ParsedCSV {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = parseCSVRow(nonEmpty[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < nonEmpty.length; i++) {
    const values = parseCSVRow(nonEmpty[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Filter: "column op value"
// Operators: = != > >= < <= contains startswith endswith
// ---------------------------------------------------------------------------

function applyFilter(
  rows: Record<string, string>[],
  filter: string
): Record<string, string>[] {
  const m = filter.match(
    /^(.+?)\s*(=|!=|>=|<=|>|<|contains|startswith|endswith)\s*(.+)$/i
  );
  if (!m) {
    throw new Error(
      `Invalid filter: "${filter}". Expected: column op value  (op: = != > >= < <= contains startswith endswith)`
    );
  }

  const col = m[1].trim();
  const op = m[2].toLowerCase();
  const val = m[3].trim().replace(/^["']|["']$/g, "");

  return rows.filter((row) => {
    const cellRaw = row[col] ?? "";
    const cell = cellRaw.toLowerCase();
    const v = val.toLowerCase();

    switch (op) {
      case "=":
        return cell === v;
      case "!=":
        return cell !== v;
      case "contains":
        return cell.includes(v);
      case "startswith":
        return cell.startsWith(v);
      case "endswith":
        return cell.endsWith(v);
      case ">":
        return parseFloat(cellRaw) > parseFloat(val);
      case ">=":
        return parseFloat(cellRaw) >= parseFloat(val);
      case "<":
        return parseFloat(cellRaw) < parseFloat(val);
      case "<=":
        return parseFloat(cellRaw) <= parseFloat(val);
      default:
        return true;
    }
  });
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function escapeCSVCell(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCSV(rows: Record<string, string>[], headers: string[]): string {
  const lines = [headers.map(escapeCSVCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCSVCell(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const csvQueryTool: McpTool = {
  name: "csv_query",
  description: "Query a CSV: select/filter/sort/limit. One of url or csv.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      csv: { type: "string" },
      select: { type: "string" },
      filter: { type: "string", description: "'col op value'." },
      sort_by: { type: "string" },
      sort_dir: { type: "string", enum: ["asc", "desc"] },
      limit: { type: "number" },
      format: { type: "string", enum: ["json", "csv"] },
    },
  },
  async run(args) {
    const hasUrl = typeof args.url === "string" && (args.url as string).length > 0;
    const hasCSV = typeof args.csv === "string" && (args.csv as string).length > 0;

    if (!hasUrl && !hasCSV) throw new Error("Provide either `url` or `csv`.");
    if (hasUrl && hasCSV) throw new Error("Provide either `url` or `csv`, not both.");

    let raw: string;
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
          headers: { "User-Agent": "toolsnap-mcp/1.0 (csv_query; +https://toolsnap.app)" },
        });
      } catch (err) {
        throw new Error(`Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const buf = await response.arrayBuffer();
      if (buf.byteLength > MAX_CSV_BYTES) {
        throw new Error(`CSV too large: ${buf.byteLength} bytes (max ${MAX_CSV_BYTES}).`);
      }
      raw = new TextDecoder().decode(buf);
    } else {
      raw = args.csv as string;
    }

    const { headers, rows: allRows } = parseCSV(raw);

    if (headers.length === 0) throw new Error("CSV is empty or has no header row.");

    // Filter
    let rows = allRows;
    if (typeof args.filter === "string" && args.filter.trim()) {
      rows = applyFilter(rows, args.filter.trim());
    }

    // Sort
    if (typeof args.sort_by === "string" && args.sort_by.trim()) {
      const col = args.sort_by.trim();
      const dir = (args.sort_dir as string | undefined) === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const av = a[col] ?? "";
        const bv = b[col] ?? "";
        const an = parseFloat(av);
        const bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
        return av.localeCompare(bv) * dir;
      });
    }

    // Limit
    const rawLimit = args.limit !== undefined ? Number(args.limit) : 500;
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 5000);
    const totalBefore = rows.length;
    rows = rows.slice(0, limit);

    // Select columns
    let outHeaders = headers;
    if (typeof args.select === "string" && args.select.trim()) {
      const wanted = args.select.split(",").map((c) => c.trim());
      const missing = wanted.filter((c) => !headers.includes(c));
      if (missing.length > 0) {
        throw new Error(`Column(s) not found: ${missing.join(", ")}. Available: ${headers.join(", ")}`);
      }
      outHeaders = wanted;
      rows = rows.map((row) => {
        const r: Record<string, string> = {};
        for (const h of wanted) r[h] = row[h] ?? "";
        return r;
      });
    }

    const truncated = totalBefore > limit;

    if (args.format === "csv") {
      const csvOut = rowsToCSV(rows, outHeaders);
      return truncated
        ? `${csvOut}\n# [Showing ${limit} of ${totalBefore} rows]`
        : csvOut;
    }

    // Default: JSON
    const meta = {
      total_rows: totalBefore,
      returned_rows: rows.length,
      columns: outHeaders,
      ...(truncated ? { truncated: true, limit } : {}),
    };
    return JSON.stringify({ meta, rows }, null, 2);
  },
};
