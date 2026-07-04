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

- `curl -X POST https://mcp.toolsnap.app/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → curated core list.
- <!-- TODO before submitting: install the manifest in a local Hermes, run fetch_extract /
  html_table_extract / tool_catalog from a session, and replace this line with the results. -->

Happy to adjust the default tool selection or manifest fields to whatever the catalog
maintainers prefer.
