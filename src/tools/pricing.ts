import type { McpTool } from "../mcp/types.js";

const FREE_TOOLS = [
  "pricing",
  "account_balance",
  "account_deposit",
  "uuid_generate",
  "hash_text",
  "base64_encode",
  "base64_decode",
  "url_encode",
  "url_decode",
  "json_format",
  "timestamp_convert",
  "text_stats",
  "html_to_markdown",
  "extract_structured",
  "diff_text",
  "csv_query",
  "json_query",
  "pdf_text_extract",
  "regex_extract",
  "webpage_metadata",
  "count_tokens",
  "rss_parse",
  "sitemap_parse",
  "page_assets",
  "page_links",
  "task_recipes",
];

const PRICING_DATA = {
  server: "toolsnap-mcp",
  version: "0.1.0",
  endpoint: "https://mcp.toolsnap.app/mcp",
  docs: "https://toolsnap.app/agents",
  payment: {
    method: "x402 v2 — EIP-3009 USDC transfer authorisation",
    network: "eip155:8453 (Base mainnet)",
    asset: "USDC — 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Pay-per-call: one on-chain settlement per call.
    pay_per_call: {
      price_usdc: 0.02,
      how: 'Include a signed PaymentPayload in _meta["x402/payment"]. Server verifies off-chain, settles on-chain after successful execution.',
      first_call_free: true,
      first_call_free_note:
        "First call per wallet address is served free. A valid signed payment payload is still required for identification — it is verified but not settled.",
    },
    // Prepaid: deposit once, then debit off-chain per call at a discount.
    prepaid: {
      price_usdc: 0.01,
      discount_vs_pay_per_call: "50%",
      min_deposit_usdc: 0.5,
      non_refundable: true,
      how_to_deposit:
        'Call account_deposit with a signed x402 PaymentPayload in _meta["x402/payment"] for any amount >= the minimum. One on-chain settlement; the full amount is credited to the paying address.',
      how_to_spend:
        'Call a paid tool with a signed SpendAuthorization in _meta["x402/prepaid-spend"]. Debited off-chain from your balance — no per-call 402, no per-call gas. Insufficient balance returns a 402 recharge.',
      check_balance: "account_balance (free) returns remaining balance and calls covered.",
      spend_authorization: {
        eip712_domain: { name: "ToolSnap Prepaid", version: "1", chainId: 8453 },
        primary_type: "SpendAuthorization",
        fields:
          "address (payer), tool (the tool name), maxAmount (micro-USDC you authorise for this call, >= price), nonce (bytes32, single-use), validBefore (unix seconds, <= now + 600)",
        safety_note:
          "This signature is NOT a token transfer authorisation (no verifyingContract, ToolSnap-specific domain). Signing it cannot move on-chain funds — it only authorises debiting your own prepaid balance on this server.",
      },
    },
  },
  tools: [
    {
      name: "fetch_extract",
      tier: "paid",
      price_usdc: 0.02,
      prepaid_price_usdc: 0.01,
      value: {
        benchmark_token_savings_median_pct: 98.1,
        benchmark_input_tokens_median: 53820,
        benchmark_output_tokens_median: 2001,
        benchmark_savings_at_sonnet_usd_per_call: 0.1555,
        break_even_page_size_kb: 26,
        best_case_savings_pct: 99.3,
        best_case_source: "Cloudflare Workers docs (372 KB → 2.5 KB)",
        note: "Saves ~$0.156/call at Sonnet pricing. Costs $0.02 pay-per-call or $0.01 prepaid.",
      },
    },
    {
      name: "fetch_html",
      tier: "paid",
      price_usdc: 0.02,
      prepaid_price_usdc: 0.01,
      value: {
        note: "Clean HTML with structure preserved (tags/classes/ids, no scripts/styles/tracking) for site migration and reconstruction. Costs $0.02 pay-per-call or $0.01 prepaid.",
      },
    },
    {
      name: "screenshot_url",
      tier: "paid",
      price_usdc: 0.04,
      prepaid_price_usdc: 0.025,
      first_call_free: false,
      value: {
        note: "Captures a page (full-page or viewport, PNG/JPEG), uploads to R2 and returns a public URL — never the bytes, so it does not bloat context. For visual reference during site migration and visual QA. Priced above the flat rate because each call drives a real headless/render cost. No first-call-free (real per-call cost). Costs $0.04 pay-per-call or $0.025 prepaid.",
      },
    },
    {
      name: "keyword_research",
      tier: "paid",
      price_usdc: 0.04,
      prepaid_price_usdc: 0.025,
      first_call_free: false,
      value: {
        note: "Queries Google Ads data via DataForSEO for 1–20 keywords per call. Returns monthly search volume, CPC (USD), competition score (0–1), 12-month trend, and top-5 related suggestions per keyword. Default location: Spain (2724). Priced above the flat rate due to DataForSEO COGS per batch. No first-call-free. Costs $0.04 pay-per-call or $0.025 prepaid.",
      },
    },
    {
      name: "remove_background",
      tier: "paid",
      price_usdc: 0.03,
      prepaid_price_usdc: 0.02,
      first_call_free: false,
      value: {
        note: "Removes the background from any public image URL (JPEG/PNG/WEBP) using the U²-Net model. Returns a transparent PNG hosted on a permanent public URL — never raw bytes. Priced above the flat rate due to generative AI inference COGS. No first-call-free. Costs $0.03 pay-per-call or $0.02 prepaid.",
      },
    },
    ...FREE_TOOLS.map((name) => ({ name, tier: "free" as const })),
  ],
};

export const pricingTool: McpTool = {
  name: "pricing",
  description:
    "Returns the machine-readable pricing menu for this server: which tools are free vs paid, pay-per-call vs discounted prepaid pricing, how to deposit and spend a prepaid balance, payment method, and quantified value (token savings, ROI). Call this first to understand what is available and at what cost before using paid tools.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  run() {
    return JSON.stringify(PRICING_DATA, null, 2);
  },
};

export { PRICING_DATA };
