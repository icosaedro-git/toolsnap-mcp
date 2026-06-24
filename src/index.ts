import { handleMcpRequest } from "./mcp/server.js";
import { tools } from "./tools/index.js";
import { PRICING_DATA } from "./tools/pricing.js";
import { getDashboardData } from "./analytics/queries.js";
import { PANEL_HTML } from "./analytics/panel.js";

export interface Env {
  // x402 payment config (vars in wrangler.jsonc)
  X402_NETWORK: string;
  X402_PRICE_USDC: string;
  X402_PREPAID_PRICE_USDC: string;
  X402_MIN_DEPOSIT_USDC: string;
  BASE_RPC_URL: string;

  // x402 secrets (set via: wrangler secret put <NAME>)
  X402_PAY_TO_ADDRESS: string;
  RELAYER_PRIVATE_KEY: string;

  // KV namespace for nonce replay-protection + first-call-free tracking
  X402_NONCES: KVNamespace;

  // D1 database for prepaid balances + money ledger (Fase 8)
  PREPAID_DB: D1Database;

}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // MCP endpoint
    if (method === "POST" && url.pathname === "/mcp") {
      let body: string;
      try {
        body = await request.text();
      } catch {
        return jsonResponse({ error: "Failed to read request body." }, 400);
      }

      const { response, status } = await handleMcpRequest(body, env);

      if (response === null) {
        // Notification — 202 empty body with CORS
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }

      return withCors(
        new Response(response, {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Root info
    if (method === "GET" && url.pathname === "/") {
      return jsonResponse({
        name: "toolsnap-mcp",
        description:
          "MCP server with microtools for AI agents. 23 free tools + fetch_extract (98.1% median token reduction, saves $0.156/call at Sonnet, ROI positive even at DeepSeek pricing with $0.01 prepaid). x402 USDC on Base, first call free.",
        mcp_endpoint: "/mcp",
        well_known: "/.well-known/mcp.json",
        pricing: "/.well-known/pricing.json",
        tools: tools.length,
        docs: "https://toolsnap.app/agents",
      });
    }

    // Well-known MCP server card
    if (method === "GET" && url.pathname === "/.well-known/mcp.json") {
      return jsonResponse({
        name: "toolsnap-mcp",
        version: "0.1.0",
        description:
          "Context-efficient microtools for AI agents. 23 free utility tools (UUID, hash, diff, regex, CSV/JSON/PDF query, HTML→Markdown, RSS, sitemap, token count, and more). Flagship fetch_extract: median 98.1% token reduction (53 820 → 2 001 tokens, 11 real pages). Saves $0.156/call at Sonnet pricing; ROI positive at DeepSeek R1 pricing ($0.019/call net at $0.01 prepaid). Pay per call $0.02 USDC on Base via x402 — first call free per wallet. Or deposit once ($0.50 min) and debit off-chain at $0.01/call, no per-call gas.",
        transport: "streamable-http",
        endpoint: "/mcp",
        pricing_endpoint: "/.well-known/pricing.json",
        payment: {
          method: "x402 v2",
          network: "eip155:8453",
          asset: "USDC",
          pay_per_call: { price_usdc: 0.02, first_call_free: true },
          prepaid: {
            price_usdc: 0.01,
            min_deposit_usdc: 0.5,
            non_refundable: true,
            deposit_tool: "account_deposit",
            balance_tool: "account_balance",
            spend_meta_key: "x402/prepaid-spend",
          },
        },
        tools: tools.map(({ name, description }) => {
          const paid = name === "fetch_extract";
          return {
            name,
            description,
            ...(paid
              ? { tier: "paid", price_usdc: 0.02, prepaid_price_usdc: 0.01 }
              : { tier: "free" }),
          };
        }),
        docs: "https://toolsnap.app/agents",
      });
    }

    // Pricing menu (machine-readable)
    if (method === "GET" && url.pathname === "/.well-known/pricing.json") {
      return jsonResponse(PRICING_DATA);
    }

    // Glama connector claim file
    if (method === "GET" && url.pathname === "/.well-known/glama.json") {
      return jsonResponse({
        $schema: "https://glama.ai/mcp/schemas/connector.json",
        name: "ToolSnap MCP",
        description:
          "Context-efficient microtools for AI agents. Flagship: fetch_extract converts raw HTML to clean text with a median 98.1% token reduction (53,820 → 2,001 tokens, 11 real pages) — saving ~$0.156/call at Sonnet pricing. 23 free utility tools included. Pay-per-call $0.02 USDC on Base via x402, first call free. Prepaid: deposit once ($0.50 min), debit at $0.01/call off-chain.",
        categories: ["developer-tools", "web-scraping", "data-extraction", "paid"],
        transport: "streamable-http",
        homepage: "https://toolsnap.app/agents",
        endpoint: "https://mcp.toolsnap.app/mcp",
        pricing_endpoint: "https://mcp.toolsnap.app/.well-known/pricing.json",
        maintainers: [{ email: "icosaedro.one@proton.me" }],
      });
    }

    // Analytics dashboard (Fase 9)
    // Protected externally via Cloudflare Access (mcp.toolsnap.app/analytics*)
    // Setup: https://one.dash.cloudflare.com → Access → Applications → add app for /analytics*
    if (method === "GET" && url.pathname === "/analytics") {
      return new Response(PANEL_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Analytics data API — called by the dashboard panel via fetch('/analytics/data')
    if (method === "GET" && url.pathname === "/analytics/data") {
      try {
        const data = await getDashboardData(env.PREPAID_DB);
        return jsonResponse(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, 502);
      }
    }

    // 404
    return jsonResponse({ error: "Not found" }, 404);
  },
};
