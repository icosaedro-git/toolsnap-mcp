/**
 * x402 payment middleware for toolsnap-mcp.
 *
 * Phase 2 MVP: payment signalling and simplified receipt verification.
 * Phase 3 will replace verifyPayment with real on-chain verification via
 * the Coinbase x402 facilitator API.
 */

export interface PaymentConfig {
  payToAddress: string; // from env secret X402_PAY_TO_ADDRESS
  network: string;      // "base"
  priceUSDC: string;    // e.g. "0.001" (1 mill USDC = 1000 micro-USDC)
  resource: string;     // tool name, used in the payment context
}

/** Tools that require payment before execution. */
const PAID_TOOLS = new Set(["fetch_extract"]);

/** Returns true if the tool requires a payment receipt. */
export function requiresPayment(toolName: string): boolean {
  return PAID_TOOLS.has(toolName);
}

/**
 * Convert a USDC dollar amount string to micro-USDC integer string.
 * 1 USDC = 1,000,000 micro-USDC (6 decimals).
 * e.g. "0.001" → "1000"
 */
function toMicroUsdc(priceUSDC: string): string {
  const amount = parseFloat(priceUSDC);
  return String(Math.round(amount * 1_000_000));
}

/**
 * Build a JSON-RPC success response that signals payment is required.
 * The MCP result content text is "PAYMENT_REQUIRED" and the _meta.x402
 * field carries the payment details for the client/agent to act on.
 */
export function buildPaymentRequiredResponse(
  config: PaymentConfig,
  requestId: string | number | null
): object {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      content: [
        {
          type: "text",
          text: "PAYMENT_REQUIRED",
        },
      ],
      isError: false,
      _meta: {
        x402: {
          version: 1,
          accepts: [
            {
              scheme: "exact",
              network: config.network,
              maxAmountRequired: toMicroUsdc(config.priceUSDC),
              resource: `mcp://toolsnap-mcp/${config.resource}`,
              description: `Pay ${config.priceUSDC} USDC on ${config.network} to use this tool`,
              mimeType: "application/json",
              payTo: config.payToAddress,
              maxTimeoutSeconds: 300,
              // USDC on Base (ERC-20 contract address)
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        },
      },
    },
  };
}

/**
 * Verify a payment receipt.
 *
 * Phase 2 (MVP): simplified verification — checks that the receipt is a
 * non-empty, well-formed Ethereum transaction hash (0x-prefixed, 66 chars).
 *
 * NOTE: This does NOT verify the transaction on-chain. Phase 3 will call the
 * Coinbase x402 facilitator endpoint to confirm the tx was mined, the correct
 * amount was transferred to payToAddress, and it has not been replayed.
 */
export async function verifyPayment(
  receiptHeader: string | null,
  _config: PaymentConfig
): Promise<boolean> {
  if (!receiptHeader || receiptHeader.trim() === "") {
    return false;
  }

  const receipt = receiptHeader.trim();

  // A valid Ethereum tx hash is 0x followed by exactly 64 hex characters.
  const ETH_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
  return ETH_TX_HASH.test(receipt);
}
