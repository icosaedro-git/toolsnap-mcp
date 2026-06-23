# toolsnap-mcp

An MCP (Model Context Protocol) server running on Cloudflare Workers. It exposes small, free, deterministic utility tools to AI agents over Streamable HTTP.

Deploy target: `mcp.toolsnap.app`

## Run locally

```bash
npm install
npm run dev
# Worker available at http://localhost:8787
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Server info (name, tool count, links) |
| `GET` | `/.well-known/mcp.json` | MCP server card with tool list |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 endpoint (Streamable HTTP) |

## Tools

| Name | Description |
|------|-------------|
| `uuid_generate` | Generate 1–100 random UUID v4 values |
| `hash_text` | SHA-256 / SHA-1 / SHA-512 hash of a text string (hex) |
| `base64_encode` | UTF-8–safe Base64 encode |
| `base64_decode` | UTF-8–safe Base64 decode |
| `url_encode` | Percent-encode a string (encodeURIComponent) |
| `url_decode` | Decode a percent-encoded string |
| `json_format` | Parse and reformat JSON with configurable indent (0 = minified) |
| `timestamp_convert` | Convert between Unix timestamps (seconds) and ISO 8601 dates |
| `text_stats` | Count characters, words, lines, and sentences in text |

## MCP usage example

```bash
# Initialize
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

# List tools
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"uuid_generate","arguments":{"count":3}}}'
```

## Type-check

```bash
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

> **Note:** The custom domain `mcp.toolsnap.app` is configured via Cloudflare DNS after deployment. The route entry in `wrangler.jsonc` is commented out until then.

## Phase 2 (payments — not yet implemented)

A later phase will add x402 payment gating for premium / compute-heavy tools using the [x402 protocol](https://x402.org). See `.dev.vars.example` for the environment variables that will be required at that point. All tools in this phase 1 are permanently free.
