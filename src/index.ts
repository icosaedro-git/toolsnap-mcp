import { handleMcpRequest } from "./mcp/server.js";
import { tools } from "./tools/index.js";
import { PRICING_DATA } from "./tools/pricing.js";

export interface Env {
  // x402 payment config (vars in wrangler.jsonc)
  X402_NETWORK: string;
  X402_PRICE_USDC: string;
  BASE_RPC_URL: string;

  // x402 secrets (set via: wrangler secret put <NAME>)
  X402_PAY_TO_ADDRESS: string;
  RELAYER_PRIVATE_KEY: string;

  // KV namespace for nonce replay-protection + first-call-free tracking
  X402_NONCES: KVNamespace;
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
          "MCP server selling context-efficient microtools to AI agents via x402 (USDC on Base). Flagship: fetch_extract — median 98.1% token reduction, saves ~$0.156/call at Sonnet pricing. First call free per wallet.",
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
          "Context-efficient microtools for AI agents. Flagship tool fetch_extract: median 98.1% token reduction vs raw HTML (53 820 → 2 001 tokens, 11 real pages). Saves ~$0.156/call at Sonnet pricing. Costs $0.02 USDC on Base — 7.8× ROI on a typical page. First call free per wallet. 10 free utility tools included (UUID, hash, Base64, URL encode/decode, JSON, timestamps, text stats).",
        transport: "streamable-http",
        endpoint: "/mcp",
        pricing_endpoint: "/.well-known/pricing.json",
        payment: {
          method: "x402 v2",
          network: "eip155:8453",
          asset: "USDC",
          first_call_free: true,
        },
        tools: tools.map(({ name, description }) => {
          const paid = name === "fetch_extract";
          return {
            name,
            description,
            ...(paid ? { tier: "paid", price_usdc: 0.02 } : { tier: "free" }),
          };
        }),
        docs: "https://toolsnap.app/agents",
      });
    }

    // Pricing menu (machine-readable)
    if (method === "GET" && url.pathname === "/.well-known/pricing.json") {
      return jsonResponse(PRICING_DATA);
    }

    // 404
    return jsonResponse({ error: "Not found" }, 404);
  },
};
