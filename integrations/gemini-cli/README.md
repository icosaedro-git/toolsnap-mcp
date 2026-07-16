# ToolSnap × Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli) speaks MCP over
streamable HTTP, so ToolSnap connects with no local install.

## Connect (free tools, no account)

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "toolsnap": {
      "httpUrl": "https://mcp.toolsnap.app/mcp"
    }
  }
}
```

Gemini CLI uses `httpUrl` for streamable-HTTP servers (`url` is for SSE). Next
session, `/mcp` lists the ToolSnap tools; the full catalog is reachable through
`tool_catalog` + `use_tool`.

## Authenticated (paid tools)

Add a header — Gemini CLI expands `$VAR` from the environment, so the key never
sits in the file:

```json
{
  "mcpServers": {
    "toolsnap": {
      "httpUrl": "https://mcp.toolsnap.app/mcp",
      "headers": { "Authorization": "Bearer $TOOLSNAP_KEY" }
    }
  }
}
```

Buy a key at <https://mcp.toolsnap.app/checkout>. For x402 (USDC on Base), point
`command`/`args` at the local [pay-proxy](../../README.md#paid-tools--connect-through-the-pay-proxy)
instead of `httpUrl`.

Leave `trust` at its default (`false`) so tool calls still confirm; ToolSnap's
free tools are read-only, but the paid ones settle real money per call.

## Or install the extension (one command)

The official ToolSnap extension bundles this MCP config plus a usage context
file:

```bash
gemini extensions install https://github.com/icosaedro-git/toolsnap-gemini-extension
```

Source: <https://github.com/icosaedro-git/toolsnap-gemini-extension> — also
listed in the [Gemini CLI extension gallery](https://geminicli.com/extensions/browse/)
(auto-discovered via the `gemini-cli-extension` topic).
