# Glama.ai MCP submission
# Submit at: https://glama.ai/mcp/servers/submit (or equivalent)
# Fill the web form with values below.

**Server name:** ToolSnap MCP
**Endpoint:** https://mcp.toolsnap.app/mcp
**Transport:** streamable-http
**Docs:** https://mcp.toolsnap.app/docs
**Server card:** https://mcp.toolsnap.app/.well-known/mcp.json

**Short description (≤160 chars):**
AI agent microtools, 38 total, 35 free. fetch_extract: 98.1% token reduction. $0.02/call or $0.01 prepaid on Base. First call free.

**Full description:**
Context-efficient MCP server for AI agents. fetch_extract reduces token usage by a
median 98.1% (53,820 → 2,001 tokens) vs raw HTML — saves ~$0.156/call at Sonnet
pricing. Pay $0.02 USDC on Base via x402, or $0.01 with prepaid balance (deposit
once ≥$0.50, calls debit off-chain at half price, no per-call gas). First call free
per wallet.

35 of 38 tools are always free — web extraction (fetch_extract, fetch_html,
html_table_extract), documents/data (pdf_text_extract, csv_query, json_query,
rss_parse, sitemap_parse), SEO/web (fetch_metadata, fetch_structured, link_check),
plus general utilities (uuid_generate, hash_text, base64_encode, base64_decode,
url_encode, url_decode, json_format, timestamp_convert, text_stats, pricing,
html_to_markdown, extract_structured, diff_text, regex_extract, count_tokens,
account_balance, account_deposit) and more — discoverable via the free tool_catalog
tool. Only 3 tools carry real per-call COGS and are paid: screenshot_url,
keyword_research, remove_background.

**Categories:** Developer Tools, Web Scraping, Paid
**Tags:** mcp, x402, usdc, base, fetch, token-reduction, cloudflare-workers
**Author/org:** Icosaedro.one
**GitHub:** https://github.com/icosaedro-git/toolsnap-mcp
