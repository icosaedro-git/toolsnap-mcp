/**
 * x402 payment middleware for toolsnap-mcp.
 *
 * Implements real off-chain verification (EIP-712 / EIP-3009) and on-chain
 * settlement via viem on Base mainnet. Payment payload transport follows the
 * x402 v2 spec MCP transport: the PaymentPayload object is placed as-is in
 * _meta["x402/payment"] (no base64 wrapping for MCP).
 *
 * Spec reference: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 * EIP-3009 EVM scheme: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  recoverTypedDataAddress,
  getAddress,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// ---------------------------------------------------------------------------
// Constants – Base mainnet
// ---------------------------------------------------------------------------

/** CAIP-2 network identifier for Base mainnet. */
export const NETWORK = "eip155:8453" as const;

/** USDC contract on Base mainnet. */
export const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** USDC EIP-712 domain parameters (name + version required by EIP-3009). */
export const USDC_EIP712_NAME = "USD Coin";
export const USDC_EIP712_VERSION = "2";

/** Price: $0.02 USDC = 20 000 micro-USDC (6 decimals). */
export const PRICE_MICRO_USDC = 20_000n;
export const PRICE_MICRO_USDC_STR = "20000";

/** EIP-3009 typed-data types (from x402 EVM constants). */
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

/**
 * Minimal ABI covering:
 *  - transferWithAuthorization (v,r,s form — safest for Base USDC)
 *  - balanceOf
 *  - authorizationState (nonce used check)
 */
const EIP3009_ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    name: "authorizationState",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bindings relevant to x402 (subset of full Env). */
export interface X402Env {
  X402_PAY_TO_ADDRESS: string;
  X402_NETWORK: string;
  X402_PRICE_USDC: string;
  BASE_RPC_URL: string;
  RELAYER_PRIVATE_KEY: string;
  X402_NONCES: KVNamespace;
}

/**
 * EIP-3009 authorization parameters carried inside the x402 PaymentPayload.
 * All numeric fields are decimal strings (as per spec).
 */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string; // 0x-prefixed bytes32
}

/**
 * The scheme-specific payload inside PaymentPayload.payload for the EIP-3009
 * asset transfer method.
 */
export interface Eip3009Payload {
  signature: string; // 65-byte 0x-prefixed hex
  authorization: Eip3009Authorization;
}

/**
 * x402 v2 PaymentPayload as placed in _meta["x402/payment"] by the client.
 * MCP transport: plain JSON object (no base64 wrapping).
 */
export interface X402PaymentPayload {
  x402Version: number;
  resource?: {
    url?: string;
    description?: string;
    mimeType?: string;
  };
  accepted: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  };
  payload: Eip3009Payload;
  extensions?: Record<string, unknown>;
}

/** Structured result from verifyPayment. */
export interface VerifyResult {
  ok: boolean;
  reason?: string;
  authorization?: Eip3009Authorization;
  signature?: string;
  payer?: string;
}

/**
 * Legacy PaymentConfig kept for buildPaymentRequiredResponse signature compat.
 * (resource is the tool name)
 */
export interface PaymentConfig {
  payToAddress: string;
  network: string;
  priceUSDC: string;
  resource: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tools that require payment before execution. */
const PAID_TOOLS = new Set(["fetch_extract"]);

/** Returns true if the tool requires a payment. */
export function requiresPayment(toolName: string): boolean {
  return PAID_TOOLS.has(toolName);
}

/** Split a 65-byte hex signature into { v, r, s } components. */
function splitSignature(sig: string): { v: number; r: Hex; s: Hex } {
  const clean = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (clean.length !== 130) {
    throw new Error(`Invalid signature length: expected 130 hex chars, got ${clean.length}`);
  }
  const r = `0x${clean.slice(0, 64)}` as Hex;
  const s = `0x${clean.slice(64, 128)}` as Hex;
  let v = parseInt(clean.slice(128, 130), 16);
  // Normalise Ethereum legacy v: 0 → 27, 1 → 28
  if (v < 27) v += 27;
  return { v, r, s };
}

// ---------------------------------------------------------------------------
// buildPaymentRequiredResponse
// ---------------------------------------------------------------------------

/**
 * Build a JSON-RPC error response (code 402) signalling payment is required.
 * Follows x402 v2 spec MCP transport: error.data = PaymentRequired object.
 * network is CAIP-2 "eip155:8453".
 */
export function buildPaymentRequiredResponse(
  config: PaymentConfig,
  requestId: string | number | null,
  reason?: string
): object {
  const paymentRequired = {
    x402Version: 2,
    error: reason ?? "Payment required to use this tool",
    resource: {
      url: `mcp://tool/${config.resource}`,
      description: `Pay $0.02 USDC on Base to call the ${config.resource} tool`,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: PRICE_MICRO_USDC_STR,
        asset: USDC_ADDRESS,
        payTo: config.payToAddress,
        maxTimeoutSeconds: 300,
        extra: {
          name: USDC_EIP712_NAME,
          version: USDC_EIP712_VERSION,
          assetTransferMethod: "eip3009",
        },
      },
    ],
    extensions: {},
  };

  return {
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: 402,
      message: reason ?? "Payment required",
      data: paymentRequired,
    },
  };
}

// ---------------------------------------------------------------------------
// verifyPayment — off-chain, no gas
// ---------------------------------------------------------------------------

/**
 * Verify an x402 PaymentPayload (EIP-3009 / exact scheme).
 *
 * Steps:
 *  1. Parse and validate the payload structure.
 *  2. Recover EIP-712 signer and assert it equals authorization.from.
 *  3. Assert authorization.to === env.X402_PAY_TO_ADDRESS (case-insensitive).
 *  4. Assert value >= PRICE_MICRO_USDC.
 *  5. Assert now within [validAfter, validBefore].
 *  6. Anti-replay: check nonce not already in KV.
 *  7. Balance guard: USDC balanceOf(from) >= value (via RPC).
 *
 * Does NOT write the nonce to KV (settlement does that).
 */
export async function verifyPayment(
  paymentPayload: unknown,
  config: PaymentConfig,
  env: X402Env
): Promise<VerifyResult> {
  // --- 1. Parse payload ---
  if (!paymentPayload || typeof paymentPayload !== "object") {
    return { ok: false, reason: "Missing or invalid x402 payment payload" };
  }

  const p = paymentPayload as Record<string, unknown>;

  if (p["x402Version"] !== 2) {
    return { ok: false, reason: `Unsupported x402 version: ${p["x402Version"]}` };
  }

  const innerPayload = p["payload"] as Record<string, unknown> | undefined;
  if (!innerPayload || typeof innerPayload !== "object") {
    return { ok: false, reason: "Missing payload field" };
  }

  const signature = innerPayload["signature"] as string | undefined;
  if (!signature || typeof signature !== "string") {
    return { ok: false, reason: "Missing payload.signature" };
  }

  const auth = innerPayload["authorization"] as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== "object") {
    return { ok: false, reason: "Missing payload.authorization" };
  }

  const authorization: Eip3009Authorization = {
    from: String(auth["from"] ?? ""),
    to: String(auth["to"] ?? ""),
    value: String(auth["value"] ?? "0"),
    validAfter: String(auth["validAfter"] ?? "0"),
    validBefore: String(auth["validBefore"] ?? "0"),
    nonce: String(auth["nonce"] ?? ""),
  };

  const { from, to, value, validAfter, validBefore, nonce } = authorization;

  if (!from || !to || !nonce) {
    return { ok: false, reason: "Incomplete authorization fields" };
  }

  // --- 2. Recover EIP-712 signer ---
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: USDC_EIP712_NAME,
        version: USDC_EIP712_VERSION,
        chainId: 8453,
        verifyingContract: USDC_ADDRESS,
      },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(from) as Address,
        to: getAddress(to) as Address,
        value: BigInt(value),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: nonce as Hex,
      },
      signature: signature as Hex,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Signature recovery failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (recovered.toLowerCase() !== from.toLowerCase()) {
    return {
      ok: false,
      reason: `Signer mismatch: recovered ${recovered}, expected ${from}`,
    };
  }

  // --- 3. Recipient check ---
  if (to.toLowerCase() !== env.X402_PAY_TO_ADDRESS.toLowerCase()) {
    return {
      ok: false,
      reason: `Wrong recipient: got ${to}, expected ${env.X402_PAY_TO_ADDRESS}`,
    };
  }

  // --- 4. Amount check ---
  let valueBigInt: bigint;
  try {
    valueBigInt = BigInt(value);
  } catch {
    return { ok: false, reason: `Invalid authorization.value: ${value}` };
  }
  if (valueBigInt < PRICE_MICRO_USDC) {
    return {
      ok: false,
      reason: `Insufficient payment: got ${value}, required ${PRICE_MICRO_USDC_STR}`,
    };
  }

  // --- 5. Time window check ---
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let validAfterBig: bigint;
  let validBeforeBig: bigint;
  try {
    validAfterBig = BigInt(validAfter);
    validBeforeBig = BigInt(validBefore);
  } catch {
    return { ok: false, reason: "Invalid validAfter/validBefore values" };
  }

  if (nowSec < validAfterBig) {
    return {
      ok: false,
      reason: `Authorization not yet valid (validAfter=${validAfter}, now=${nowSec})`,
    };
  }
  // 6-second buffer for block time (matching x402 reference impl)
  if (validBeforeBig < nowSec + 6n) {
    return {
      ok: false,
      reason: `Authorization expired or expiring too soon (validBefore=${validBefore}, now=${nowSec})`,
    };
  }

  // --- 6. Anti-replay: KV nonce check ---
  const nonceKey = nonce.toLowerCase();
  const existingTx = await env.X402_NONCES.get(nonceKey);
  if (existingTx !== null) {
    return {
      ok: false,
      reason: `Nonce already used (settled in tx ${existingTx})`,
    };
  }

  // --- 7. Balance guard: RPC call ---
  try {
    const publicClient = createPublicClient({
      chain: base,
      transport: http(env.BASE_RPC_URL),
    });

    const balance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: EIP3009_ABI,
      functionName: "balanceOf",
      args: [getAddress(from) as Address],
    });

    if ((balance as bigint) < valueBigInt) {
      return {
        ok: false,
        reason: `Insufficient USDC balance: have ${balance}, need ${valueBigInt}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Balance check RPC error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    authorization,
    signature,
    payer: from,
  };
}

// ---------------------------------------------------------------------------
// settlePayment — on-chain, uses relayer private key
// ---------------------------------------------------------------------------

/**
 * Settle an EIP-3009 payment by calling transferWithAuthorization on Base USDC.
 *
 * Uses the v,r,s form (safest/most widely supported by Base USDC).
 * Does NOT wait for the transaction receipt to keep latency low — the tx hash
 * is returned immediately after submission.
 *
 * After successful submission, the nonce is written to KV with a 7-day TTL.
 */
export async function settlePayment(
  authorization: Eip3009Authorization,
  signature: string,
  env: X402Env
): Promise<{ txHash: string }> {
  const { from, to, value, validAfter, validBefore, nonce } = authorization;

  const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(env.BASE_RPC_URL),
  });

  const { v, r, s } = splitSignature(signature);

  const txHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: EIP3009_ABI,
    functionName: "transferWithAuthorization",
    args: [
      getAddress(from) as Address,
      getAddress(to) as Address,
      BigInt(value),
      BigInt(validAfter),
      BigInt(validBefore),
      nonce as Hex,
      v,
      r,
      s,
    ],
  });

  // Mark nonce as used in KV (TTL: 7 days = 604 800 s)
  await env.X402_NONCES.put(nonce.toLowerCase(), txHash, {
    expirationTtl: 604_800,
  });

  return { txHash };
}
