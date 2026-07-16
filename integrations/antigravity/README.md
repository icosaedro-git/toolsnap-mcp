# ToolSnap × Google Antigravity

[Antigravity](https://antigravity.google) is Google's successor to Gemini CLI —
Gemini CLI stopped serving individual/free/Pro/Ultra accounts on 2026-06-18;
Antigravity (Antigravity 2.0, Antigravity IDE, Antigravity CLI `agy`) is where
that traffic moved. It speaks MCP, with its own config format.

## Connect (free tools, no account)

Antigravity uses **`serverUrl`**, not `url`/`httpUrl` (those are the legacy
Gemini CLI field names and are rejected here). Add to the MCP config:

```json
{
  "mcpServers": {
    "toolsnap": {
      "serverUrl": "https://mcp.toolsnap.app/mcp"
    }
  }
}
```

- **Antigravity CLI** — global: `~/.gemini/config/mcp_config.json`, or per-project: `.agents/mcp_config.json`.
- **Antigravity 2.0 / IDE** — same file, editable via Settings → Customizations → Installed MCP Servers → *View raw config*, or the MCP Store's *Add Custom* flow.

## Authenticated (paid tools)

```json
{
  "mcpServers": {
    "toolsnap": {
      "serverUrl": "https://mcp.toolsnap.app/mcp",
      "headers": { "Authorization": "Bearer sk_live_..." }
    }
  }
}
```

Buy a key at <https://mcp.toolsnap.app/checkout>. For x402 (USDC on Base), use
`command`/`args` to point at the local
[pay-proxy](../../README.md#paid-tools--connect-through-the-pay-proxy) instead
of `serverUrl`.

## Or install the plugin

The official ToolSnap plugin bundles the same config as a one-step install:

```bash
git clone https://github.com/icosaedro-git/toolsnap-antigravity-plugin ~/.gemini/antigravity-cli/plugins/toolsnap
agy plugin install ~/.gemini/antigravity-cli/plugins/toolsnap
```

Source: <https://github.com/icosaedro-git/toolsnap-antigravity-plugin>.

## Migrating from Gemini CLI

If you already had the [ToolSnap Gemini CLI extension](../gemini-cli/README.md)
installed, Antigravity's first-launch onboarding detects it and offers to
auto-convert it to a native plugin — no action needed. Manual conversion is
also available via the CLI's extension-import command if onboarding was
skipped.
