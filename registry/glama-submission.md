# Glama.ai MCP submission
# Submit at: https://glama.ai/mcp/servers/submit (or equivalent)
# Fill the web form with values below.

**Server name:** ToolSnap MCP
**Endpoint:** https://mcp.toolsnap.app/mcp
**Transport:** streamable-http
**Docs:** https://toolsnap.app/agents
**Server card:** https://mcp.toolsnap.app/.well-known/mcp.json

**Short description (≤160 chars):**
Context-efficient MCP microtools. fetch_extract: 98.1% token reduction. $0.02 USDC/call on Base. First call free. 10 free utility tools.

**Full description:**
MCP server that turns expensive context operations into cheap server-side calls.
Flagship tool `fetch_extract` fetches a URL and returns clean text, stripping HTML,
scripts, styles, and navigation. Benchmark (11 real pages): median 98.1% token
reduction (53 820 → 2 001 tokens). Saves ~$0.156/call at Sonnet pricing vs loading
raw HTML. Costs $0.02 USDC on Base via x402 (EIP-3009). First call free per wallet.

Includes 10 always-free utility tools: uuid_generate, hash_text, base64_encode,
base64_decode, url_encode, url_decode, json_format, timestamp_convert, text_stats,
pricing.

**Categories:** Developer Tools, Web Scraping, Paid
**Tags:** mcp, x402, usdc, base, fetch, token-reduction, cloudflare-workers
**Author/org:** Icosaedro.one
**GitHub:** https://github.com/icosaedro-git/toolsnap-mcp
