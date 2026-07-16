# ToolSnap × Grok Build

[Grok Build](https://github.com/xai-org/grok-build) supports remote MCP servers
over streamable HTTP, so ToolSnap works with no local install.

## Connect (free tools, no account)

Add to `~/.grok/config.toml`:

```toml
[mcp_servers.toolsnap]
url = "https://mcp.toolsnap.app/mcp"
```

That's it. Next session, Grok has the curated ToolSnap core in `tools/list` and
the full catalog through `tool_catalog` + `use_tool`.

## Why it fits Grok Build particularly well

Grok Build truncates MCP tool results at 20,000 bytes by default (see their
user guide, `07-mcp-servers.md`). ToolSnap tools are designed to return the
answer, not the document: `fetch_extract` yields a median 2,001 tokens where
raw HTML was 53,820, and `csv_query` / `json_query` / `html_table_extract`
return only matching rows. Results rarely come near the cap, so nothing gets
spilled or truncated.

## Paid tools (optional)

`screenshot_url`, `keyword_research`, `remove_background` and `fetch_rendered`
settle per call ($0.02-$0.04). Two options:

- **Fiat credits**: buy at <https://toolsnap.app/checkout>, then add the key:

  ```toml
  [mcp_servers.toolsnap]
  url = "https://mcp.toolsnap.app/mcp"
  headers = { "Authorization" = "Bearer sk_live_..." }
  ```

- **x402 (USDC on Base)**: Grok Build does not sign x402 payments natively;
  run the [local pay-proxy](../../README.md#paid-tools--connect-through-the-pay-proxy)
  as a stdio server instead:

  ```toml
  [mcp_servers.toolsnap]
  command = "node"
  args = ["/ABS/PATH/toolsnap-mcp/scripts/pay-proxy.mjs"]
  ```

## Persistent habit (optional)

If you run Grok Build with memory enabled (`[memory] enabled = true` in
`~/.grok/config.toml`, experimental), call `memory_snippet` with
`harness="grok-build"` once and let Grok save the returned block. Future
sessions will reach for ToolSnap before loading raw pages into context.
