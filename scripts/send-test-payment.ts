/**
 * End-to-end x402 test payment for toolsnap-mcp.
 *
 * Signs a real EIP-3009 TransferWithAuthorization for $0.04 USDC on Base and
 * sends it to the live MCP server as a `screenshot_url` call. On success the
 * server settles on-chain and returns the settlement tx hash.
 *
 * The payer wallet only needs USDC (the payment is gasless via EIP-3009 — the
 * relayer pays the gas). It does NOT need ETH.
 *
 * Your private key is read from the PAYER_PRIVATE_KEY env var and stays local —
 * it is never sent to the server (only the signature is).
 *
 * Run:
 *   PAYER_PRIVATE_KEY=0xyourkey npx tsx scripts/send-test-payment.ts
 *
 * Optional env:
 *   MCP_URL   (default https://mcp.toolsnap.app/mcp)
 *   TARGET_URL (default https://example.com — the page screenshot_url will capture)
 */

import { privateKeyToAccount } from "viem/accounts";
import { getAddress, type Address, type Hex } from "viem";

const PAY_TO: Address = "0xd5F96b537A05f196091502bCde038C572f88efba";
const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = 8453;
const VALUE = "40000"; // $0.04 USDC (6 decimals) — screenshot_url pay-per-call

const MCP_URL = process.env.MCP_URL ?? "https://mcp.toolsnap.app/mcp";
const TARGET_URL = process.env.TARGET_URL ?? "https://example.com";

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as Hex;
}

async function main(): Promise<void> {
  const key = process.env.PAYER_PRIVATE_KEY;
  if (!key) {
    console.error("ERROR: set PAYER_PRIVATE_KEY (a wallet holding >= $0.04 USDC on Base).");
    process.exit(1);
  }

  const account = privateKeyToAccount(key as Hex);
  console.log(`Payer:  ${account.address}`);
  console.log(`Pay to: ${PAY_TO}`);
  console.log(`Amount: ${VALUE} micro-USDC ($0.04) on Base\n`);

  const now = Math.floor(Date.now() / 1000);
  const validAfter = String(now - 10);
  const validBefore = String(now + 300);
  const nonce = randomNonce();

  const signature = await account.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: USDC_ADDRESS,
    },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: PAY_TO,
      value: BigInt(VALUE),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const paymentPayload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: VALUE,
      asset: USDC_ADDRESS,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    },
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: PAY_TO,
        value: VALUE,
        validAfter,
        validBefore,
        nonce,
      },
    },
  };

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "screenshot_url",
      arguments: { url: TARGET_URL },
      _meta: { "x402/payment": paymentPayload },
    },
  };

  console.log("Sending paid screenshot_url call...\n");
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as Record<string, unknown>;
  console.log(JSON.stringify(json, null, 2));

  const result = json.result as Record<string, unknown> | undefined;
  const meta = result?._meta as Record<string, unknown> | undefined;
  const settle = meta?.["x402/payment-response"] as Record<string, unknown> | undefined;
  if (settle?.success && settle.transaction) {
    console.log(`\n✅ Settled on-chain. Tx: https://basescan.org/tx/${settle.transaction}`);
  } else if (json.error) {
    console.log(`\n❌ Rejected: ${(json.error as Record<string, unknown>).message}`);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
