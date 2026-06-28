# ToolSnap MCP

> Context-efficient microtools for AI agents. Pay per call with USDC on Base.

[![toolsnap-mcp MCP server](https://glama.ai/mcp/servers/icosaedro-git/toolsnap-mcp/badges/score.svg)](https://glama.ai/mcp/servers/icosaedro-git/toolsnap-mcp)
[![MCP](https://img.shields.io/badge/MCP-streamable--http-6366f1)](https://mcp.toolsnap.app/.well-known/mcp.json)
[![x402](https://img.shields.io/badge/payment-x402%20v2-orange)](https://x402.org)
[![Base](https://img.shields.io/badge/network-Base%20mainnet-0052FF)](https://base.org)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F48120)](https://workers.cloudflare.com)

**Live endpoint:** `https://mcp.toolsnap.app/mcp`  
**Server card:** [/.well-known/mcp.json](https://mcp.toolsnap.app/.well-known/mcp.json)  
**Pricing:** [/.well-known/pricing.json](https://mcp.toolsnap.app/.well-known/pricing.json)  
**Docs:** [toolsnap.app/agents](https://toolsnap.app/agents)

---

## Why

The biggest cost for AI agents isn't generation — it's context. When an agent loads a raw webpage to extract information it can burn 50,000+ tokens on HTML boilerplate. ToolSnap MCP moves that work server-side.

**Benchmark (11 real pages, June 2026):**

| | Raw HTML | Extracted | Saving |
|---|---|---|---|
| Median tokens | 53,820 | 2,001 | **98.1%** |
| Cost @ Sonnet ($3/M) | $0.162 | $0.006 | **$0.156/call** |
| Break-even page size | — | — | 26 KB |

The tool costs $0.02 USDC → 7.8× ROI on a typical page.

---

## Connect

### Claude Desktop

```json
{
  "mcpServers": {
    "toolsnap": {
      "url": "https://mcp.toolsnap.app/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Free tools work immediately with the URL connection above. **Paid tools need an
x402 payment client** — a wallet alone is not enough, because most MCP clients
can't satisfy a `402 Payment Required` on their own. Use the pay-proxy below.

### Paid tools — connect through the pay-proxy

`scripts/pay-proxy.mjs` is a local stdio MCP server that wraps the remote
endpoint, reads your wallet, and signs + retries automatically when the server
asks for payment. The private key never leaves your host; only signatures are sent.

```json
{
  "mcpServers": {
    "toolsnap": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/to/toolsnap-mcp/scripts/pay-proxy.mjs"]
    }
  }
}
```

No wallet yet? Call the `wallet_setup` tool — it generates a wallet you control,
helps your human fund it with USDC on Base, and wires this proxy. Key resolution
order: `TOOLSNAP_WALLET_KEY` → `~/.toolsnap/wallet.key` → macOS Keychain
(`toolsnap-agent-wallet/default`).

Useful env: `TOOLSNAP_MAX_PRICE_USDC` (per-call spend cap, default `0.10`),
`TOOLSNAP_PREPAID=1` + `TOOLSNAP_AUTO_DEPOSIT_USDC` (use the cheaper prepaid balance).

### Direct MCP call

```bash
curl -X POST https://mcp.toolsnap.app/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Tools

### Paid (x402)

| Tool | Description | Price |
|---|---|---|
| `fetch_extract` | Fetch a URL → clean text. 98.1% median token reduction. | $0.02 USDC |

**First call free per wallet address.** After that, your agent pays $0.02 USDC on Base using [x402 v2](https://x402.org) (EIP-3009 `transferWithAuthorization`). No API key, no subscription — pay only when you call.

### Free (always)

| Tool | Description |
|---|---|
| `pricing` | Machine-readable pricing menu + ROI. Call this first. |
| `uuid_generate` | 1–100 random UUID v4 values |
| `hash_text` | SHA-256 / SHA-1 / SHA-512 (hex) |
| `base64_encode` | UTF-8 → Base64 |
| `base64_decode` | Base64 → UTF-8 |
| `url_encode` | Percent-encode (encodeURIComponent) |
| `url_decode` | Decode percent-encoded string |
| `json_format` | Parse + pretty-print or minify JSON |
| `timestamp_convert` | Unix ↔ ISO 8601 (auto-detects direction) |
| `text_stats` | Chars, words, lines, sentences |

---

## Payment (x402)

When an agent calls `fetch_extract` without payment, the server returns:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": 402,
    "message": "Payment required",
    "data": {
      "x402Version": 2,
      "accepts": [{
        "scheme": "exact",
        "network": "eip155:8453",
        "amount": "20000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
      }]
    }
  }
}
```

An x402-enabled client reads `accepts[0]`, signs an EIP-3009 `TransferWithAuthorization`, and retries with `_meta["x402/payment"]` set. See [x402 spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md).

---

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars  # fill in wallet secrets
npm run dev
# Worker at http://localhost:8787
```

## Type-check

```bash
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

---

## Stack

- **Runtime:** Cloudflare Workers (edge, 0 ms cold start)
- **Protocol:** MCP streamable-http (JSON-RPC 2.0)
- **Payment:** x402 v2 · EIP-3009 on Base mainnet · USDC
- **Verification:** off-chain EIP-712 signature recovery (viem)
- **Settlement:** on-chain `transferWithAuthorization` via relayer wallet
- **Anti-replay:** Cloudflare KV nonce store (7-day TTL)
- **First-call-free:** KV key `first_free:{address}`, verified but not settled

---

## Contributing

PRs welcome for **new free tools** in `src/tools/`. Follow the pattern in [`src/tools/text-stats.ts`](src/tools/text-stats.ts) and add the tool to [`src/tools/index.ts`](src/tools/index.ts).

For paid tools or changes to the x402 payment logic, open an issue first.

**Do not commit wallet private keys, `.dev.vars`, or any secrets.**

---

[![toolsnap-mcp MCP server](https://glama.ai/mcp/servers/icosaedro-git/toolsnap-mcp/badges/card.svg)](https://glama.ai/mcp/servers/icosaedro-git/toolsnap-mcp)

---

## License

MIT
