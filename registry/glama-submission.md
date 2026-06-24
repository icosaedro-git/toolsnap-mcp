# Glama.ai MCP submission
# Submit at: https://glama.ai/mcp/servers/submit (or equivalent)
# Fill the web form with values below.

**Server name:** ToolSnap MCP
**Endpoint:** https://mcp.toolsnap.app/mcp
**Transport:** streamable-http
**Docs:** https://toolsnap.app/agents
**Server card:** https://mcp.toolsnap.app/.well-known/mcp.json

**Short description (≤160 chars):**
AI agent microtools. fetch_extract: 98.1% token reduction. $0.02/call or $0.01 prepaid on Base. First call free. 23 free tools.

**Full description:**
Context-efficient MCP server for AI agents. fetch_extract reduces token usage by a
median 98.1% (53,820 → 2,001 tokens) vs raw HTML — saves ~$0.156/call at Sonnet
pricing. Pay $0.02 USDC on Base via x402, or $0.01 with prepaid balance (deposit
once ≥$0.50, calls debit off-chain at half price, no per-call gas). First call free
per wallet.

Includes 23 always-free utility tools: uuid_generate, hash_text, base64_encode,
base64_decode, url_encode, url_decode, json_format, timestamp_convert, text_stats,
pricing, html_to_markdown, extract_structured, csv_query, json_query, pdf_text_extract,
rss_parse, sitemap_parse, webpage_metadata, diff_text, regex_extract, count_tokens,
account_balance, account_deposit.

**Categories:** Developer Tools, Web Scraping, Paid
**Tags:** mcp, x402, usdc, base, fetch, token-reduction, cloudflare-workers
**Author/org:** Icosaedro.one
**GitHub:** https://github.com/icosaedro-git/toolsnap-mcp
