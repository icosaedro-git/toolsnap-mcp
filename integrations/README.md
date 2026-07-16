# Connecting ToolSnap to agent harnesses

ToolSnap is a remote MCP server (streamable HTTP) at:

```
https://mcp.toolsnap.app/mcp
```

Any MCP-capable client can use the free tools with no account, API key, or
local install. Paid tools ($0.02–$0.04) need either a fiat API key
(`Authorization: Bearer sk_live_…`, buy at <https://mcp.toolsnap.app/checkout>)
or x402 via the [pay-proxy](../README.md#paid-tools--connect-through-the-pay-proxy).

## Harness-specific guides

Some harnesses have their own config format or catalog worth documenting:

- **[Hermes](hermes/README.md)** — Nous Research agent; optional-MCP catalog + a `toolsnap` skill.
- **[Grok Build](grok-build/README.md)** — SpaceXAI CLI; `~/.grok/config.toml`, fits its 20KB MCP output cap.
- **[Gemini CLI](gemini-cli/README.md)** — Google's terminal agent; `settings.json` + extensions gallery.

## Any other MCP client

Every other harness we've checked connects the same way — point it at the URL
above. One-liners:

| Client | How |
|---|---|
| **Claude Code** | `claude mcp add --transport http toolsnap https://mcp.toolsnap.app/mcp` |
| **Claude Desktop / claude.ai** | Settings → Connectors → Add custom connector → the URL above |
| **Cursor / VS Code / generic JSON** | `{ "mcpServers": { "toolsnap": { "url": "https://mcp.toolsnap.app/mcp" } } }` |
| **OpenCode** | `opencode.json`: `{ "mcp": { "toolsnap": { "type": "remote", "url": "https://mcp.toolsnap.app/mcp" } } }` |
| **OpenHands** | Add an HTTP MCP server in Settings → MCP with the URL above |
| **OpenHarness** | `mcp_servers` block in `~/.openharness/settings` with the URL above |
| **Claude Agent SDK (Python)** | pass the URL as an HTTP MCP server in `ClaudeAgentOptions(mcp_servers=…)` |
| **OpenAI Agents SDK (Python)** | `MCPServerStreamableHttp(params={"url": "https://mcp.toolsnap.app/mcp"})` |
| **DeepAgents / LangGraph** | load via `langchain-mcp-adapters` `MultiServerMCPClient` with the URL above |

For authenticated (paid) use, add an `Authorization: Bearer sk_live_…` header in
whichever form the client supports. Full reference: <https://mcp.toolsnap.app/docs>.
