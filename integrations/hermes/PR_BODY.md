## What

Adds **ToolSnap MCP** to the Nous-approved catalog (`optional-mcps/toolsnap/`) plus a companion
skill (`optional-skills/web/toolsnap/`) that teaches Hermes when to prefer it.

ToolSnap is a remote MCP server (Cloudflare Workers, streamable HTTP) with 38 deterministic
web/data microtools: clean page extraction, HTML tables → JSON/CSV, PDF text, CSV/JSON query,
sitemaps, RSS, link checks, SEO metadata. 35 of 38 tools are free with no account, no API key,
no wallet. Endpoint: `https://mcp.toolsnap.app/mcp` · Server card:
[`/.well-known/mcp.json`](https://mcp.toolsnap.app/.well-known/mcp.json).

## Why it complements Hermes

- **Deterministic, no LLM in the loop.** Hermes' `web_extract` compresses big pages with an
  auxiliary model. ToolSnap is pure parsing: exact quotes, stable output, zero added inference
  cost. For citations, tables, and structured data the two approaches are complementary — the
  skill spells out when to use which (and defers to `web_search`/`browser_navigate` where those
  are the right tool).
- **Context-frugal by design.** Work happens server-side; a 372 KB docs page comes back as
  2.5 KB of text (median 98.1% token reduction over 11 real pages). `tools/list` stays small —
  the long tail is behind `tool_catalog()`/`use_tool`, so the default checklist enables a
  curated 17-tool surface.
- **No credentials.** `auth: type: none`. The three paid tools ($0.03–$0.04) settle per call
  via x402 USDC on Base for users who opt in; everything in the default set is free.

## Testing

Tested against a local Hermes Agent install (v0.18.0) with `toolsnap` added as an MCP server
(`hermes mcp add`, `url: https://mcp.toolsnap.app/mcp`, `auth: none`):

- `hermes mcp test toolsnap` → `✓ Connected (1949ms)`, `✓ Tools discovered: 18` (curated core
  from `tools/list`, matching the manifest's default selection).
- `fetch_extract` on `https://example.com` → clean text, no HTML noise, single tool call.
- `tool_catalog()` (no args) → 9 families, `total_tools: 38`, correct `how_to_run` guidance
  pointing to `use_tool`.
- `html_table_extract` (not in the curated 18, called via `use_tool(name="html_table_extract",
  args={...})` per the manifest's documented pattern) on a Wikipedia population table →
  `total_tables: 2`, 238 rows parsed with headers, as structured JSON.

All three calls round-tripped through the live production endpoint (server v1.1.0, deployed
2026-07-04) with correct, deterministic output — no LLM in the loop on ToolSnap's side.

Happy to adjust the default tool selection or manifest fields to whatever the catalog
maintainers prefer.
