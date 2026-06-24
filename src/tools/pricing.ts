import type { McpTool } from "../mcp/types.js";

const PRICING_DATA = {
  server: "toolsnap-mcp",
  version: "0.1.0",
  endpoint: "https://mcp.toolsnap.app/mcp",
  docs: "https://toolsnap.app/agents",
  payment: {
    method: "x402 v2 — EIP-3009 USDC transfer authorisation",
    network: "eip155:8453 (Base mainnet)",
    asset: "USDC — 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    how: "Include signed PaymentPayload in _meta[\"x402/payment\"]. Server verifies off-chain, settles on-chain after successful execution.",
    first_call_free: true,
    first_call_free_note: "First call per wallet address is served free. A valid signed payment payload is still required for identification — it is verified but not settled.",
  },
  tools: [
    {
      name: "fetch_extract",
      tier: "paid",
      price_usdc: 0.02,
      value: {
        benchmark_token_savings_median_pct: 98.1,
        benchmark_input_tokens_median: 53820,
        benchmark_output_tokens_median: 2001,
        benchmark_savings_at_sonnet_usd_per_call: 0.1555,
        break_even_page_size_kb: 26,
        best_case_savings_pct: 99.3,
        best_case_source: "Cloudflare Workers docs (372 KB → 2.5 KB)",
        note: "Cost $0.02, saves ~$0.156 at Sonnet pricing — 7.8× ROI on an average page.",
      },
    },
    { name: "pricing", tier: "free" },
    { name: "uuid_generate", tier: "free" },
    { name: "hash_text", tier: "free" },
    { name: "base64_encode", tier: "free" },
    { name: "base64_decode", tier: "free" },
    { name: "url_encode", tier: "free" },
    { name: "url_decode", tier: "free" },
    { name: "json_format", tier: "free" },
    { name: "timestamp_convert", tier: "free" },
    { name: "text_stats", tier: "free" },
  ],
};

export const pricingTool: McpTool = {
  name: "pricing",
  description:
    "Returns the machine-readable pricing menu for this server: which tools are free vs paid, price per call, payment method, and quantified value (token savings, ROI). Call this first to understand what is available and at what cost before using paid tools.",
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
