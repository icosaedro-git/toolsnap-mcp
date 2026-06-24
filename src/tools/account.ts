import type { McpTool } from "../mcp/types.js";

/**
 * Account tools for the prepaid balance model (Fase 8).
 *
 * These two tools are env-aware (they touch payments + the D1 ledger), so the
 * MCP server intercepts them in the tools/call dispatcher and runs dedicated
 * handlers — the `run` functions here exist only to satisfy the McpTool shape
 * and should never be reached. They ARE listed in tools/list for discovery.
 */

const HANDLED_AT_SERVER = "This tool is handled by the server dispatcher and must not be run directly.";

export const accountBalanceTool: McpTool = {
  name: "account_balance",
  description:
    "Check the prepaid USDC balance for an address. Free. Returns remaining balance, the discounted prepaid per-call price, and how many paid calls it covers. Deposit once with account_deposit to pay a discounted per-call rate with no 402 round-trip and no gas per call.",
  inputSchema: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "The 0x EVM address whose prepaid balance to look up (the address that funded the deposit).",
      },
    },
    required: ["address"],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
};

export const accountDepositTool: McpTool = {
  name: "account_deposit",
  description:
    "Open or top up a prepaid balance by depositing USDC on Base via x402 (one on-chain settlement). After depositing, paid tools are debited off-chain at the discounted prepaid price with no per-call 402 and no per-call gas, until the balance runs out. Non-refundable credits. Minimum deposit $0.50. Call with the signed x402 PaymentPayload in _meta[\"x402/payment\"] for the amount you want to deposit (>= minimum); the full deposited amount is credited to the paying address.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
};
