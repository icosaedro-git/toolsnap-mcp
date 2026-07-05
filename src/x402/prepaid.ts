/**
 * Prepaid balance logic for toolsnap-mcp (Fase 8 — retention).
 *
 * Model (non-refundable credits):
 *  - An agent makes ONE x402 deposit (>= min) -> we settle on-chain once and
 *    credit its balance in D1, keyed by the depositing address.
 *  - Subsequent paid calls are DEBITED off-chain from that balance at a
 *    discounted price ($0.01 vs $0.02 pay-per-call) — no 402, no gas per call.
 *  - balance < price -> 402 recharge.
 *
 * Money-safety properties:
 *  1. No double-spend / no negative balance: debits use an atomic conditional
 *     UPDATE ... WHERE balance_micro >= price on D1 (strongly consistent).
 *  2. No charge for failed tool runs: debit is refunded if the tool throws.
 *  3. No replay of a spend authorization: spend_nonces has PRIMARY KEY(nonce),
 *     in the same D1 transactional domain as the balance, so a concurrent
 *     replay of the same signed auth cannot double-debit (the loser refunds).
 *  4. The spend signature CANNOT move on-chain funds: it is an EIP-712 message
 *     over a ToolSnap-specific domain (no verifyingContract), NOT an EIP-3009
 *     token transfer authorization. Signing it only authorizes debiting the
 *     signer's own prepaid balance on this server.
 *
 * All monetary amounts are integers in micro-USDC (6 decimals). Never floats.
 */

import { recoverTypedDataAddress, getAddress, type Hex, type Address } from "viem";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Convert a "USDC" decimal string (e.g. "0.01") to integer micro-USDC. */
export function usdcToMicro(usdc: string): bigint {
  const [whole, frac = ""] = usdc.trim().split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
}

/** Format integer micro-USDC as a decimal USDC string (e.g. 10000n -> "0.010000"). */
export function microToUsdc(micro: bigint): string {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Max validity window for a spend authorization (seconds). */
const SPEND_AUTH_MAX_WINDOW_SEC = 600n;

/**
 * EIP-712 domain for prepaid spend authorizations.
 * Deliberately has NO verifyingContract and a ToolSnap-specific name, so the
 * USDC contract (or any token) can never honour a signature of this type —
 * signing it is safe and only proves control of the address for off-chain
 * balance debiting on this server.
 */
const SPEND_AUTH_DOMAIN = {
  name: "ToolSnap Prepaid",
  version: "1",
  chainId: 8453,
} as const;

const SPEND_AUTH_TYPES = {
  SpendAuthorization: [
    { name: "address", type: "address" },
    { name: "tool", type: "string" },
    { name: "maxAmount", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** D1 + config bindings used by prepaid logic. */
export interface PrepaidEnv {
  PREPAID_DB: D1Database;
  X402_PREPAID_PRICE_USDC: string;
  X402_MIN_DEPOSIT_USDC: string;
}

/** A signed spend authorization carried in _meta["x402/prepaid-spend"]. */
export interface SpendAuthProof {
  authorization: {
    address: string;
    tool: string;
    maxAmount: string; // micro-USDC the agent authorizes for this call
    nonce: string; // 0x bytes32
    validBefore: string; // unix seconds
  };
  signature: string; // 0x 65-byte
}

export interface VerifySpendResult {
  ok: boolean;
  reason?: string;
  payer?: string; // lowercase address
  maxAmount?: bigint;
  nonce?: string;
}

// ---------------------------------------------------------------------------
// Spend-authorization verification (off-chain, no gas, cannot move funds)
// ---------------------------------------------------------------------------

/**
 * Verify a prepaid SpendAuthorization signature and fields.
 * Does NOT touch the balance or consume the nonce — the caller does that
 * atomically against D1.
 */
export async function verifySpendAuthorization(
  proof: unknown,
  toolName: string,
  priceMicro: bigint
): Promise<VerifySpendResult> {
  if (!proof || typeof proof !== "object") {
    return { ok: false, reason: "Missing or invalid prepaid spend authorization" };
  }
  const p = proof as Record<string, unknown>;
  const auth = p["authorization"] as Record<string, unknown> | undefined;
  const signature = p["signature"];
  if (!auth || typeof auth !== "object") {
    return { ok: false, reason: "Missing authorization object" };
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    return { ok: false, reason: "Missing or malformed signature" };
  }

  const address = String(auth["address"] ?? "");
  const tool = String(auth["tool"] ?? "");
  const maxAmountStr = String(auth["maxAmount"] ?? "0");
  const nonce = String(auth["nonce"] ?? "");
  const validBeforeStr = String(auth["validBefore"] ?? "0");

  if (!address || !nonce) {
    return { ok: false, reason: "Incomplete authorization fields" };
  }

  // Bind the auth to THIS tool — a signature for one tool can't be used for another.
  if (tool !== toolName) {
    return { ok: false, reason: `Authorization tool mismatch: signed for "${tool}", called "${toolName}"` };
  }

  let maxAmount: bigint;
  let validBefore: bigint;
  try {
    maxAmount = BigInt(maxAmountStr);
    validBefore = BigInt(validBeforeStr);
  } catch {
    return { ok: false, reason: "Invalid maxAmount/validBefore" };
  }

  // The agent must authorize at least the price (caps its per-call exposure).
  if (maxAmount < priceMicro) {
    return { ok: false, reason: `Authorized maxAmount ${maxAmount} below price ${priceMicro}` };
  }

  // Time window: must be in the future but not absurdly far (bounds replay window).
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (validBefore <= now) {
    return { ok: false, reason: "Spend authorization expired" };
  }
  if (validBefore > now + SPEND_AUTH_MAX_WINDOW_SEC) {
    return { ok: false, reason: `validBefore too far in the future (max ${SPEND_AUTH_MAX_WINDOW_SEC}s)` };
  }

  // Recover signer and assert it equals the claimed address.
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: SPEND_AUTH_DOMAIN,
      types: SPEND_AUTH_TYPES,
      primaryType: "SpendAuthorization",
      message: {
        address: getAddress(address) as Address,
        tool,
        maxAmount,
        nonce: nonce as Hex,
        validBefore,
      },
      signature: signature as Hex,
    });
  } catch (err) {
    return { ok: false, reason: `Spend signature recovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, reason: `Spend signer mismatch: recovered ${recovered}, expected ${address}` };
  }

  return { ok: true, payer: address.toLowerCase(), maxAmount, nonce: nonce.toLowerCase() };
}

// ---------------------------------------------------------------------------
// D1 balance operations
// ---------------------------------------------------------------------------

/** Read the current prepaid balance (micro-USDC) for an address. 0 if none. */
export async function getBalanceMicro(db: D1Database, address: string): Promise<bigint> {
  const row = await db
    .prepare("SELECT balance_micro FROM balances WHERE address = ?")
    .bind(address.toLowerCase())
    .first<{ balance_micro: number }>();
  return row ? BigInt(row.balance_micro) : 0n;
}

export interface DebitResult {
  ok: boolean;
  reason?: "insufficient" | "replay" | "error";
  balanceAfter?: bigint;
}

/**
 * Atomically debit `priceMicro` from `address`, consuming the single-use
 * `nonce`. Returns ok=false with reason "insufficient" if the balance can't
 * cover it (no state changed), or "replay" if the nonce was already used.
 *
 * Safety: the conditional UPDATE guarantees the balance never goes negative
 * and concurrent debits can't oversell. The nonce INSERT (PRIMARY KEY) detects
 * replays of the same signed authorization; if a replay slips past the balance
 * check concurrently, the duplicate INSERT throws and we refund.
 */
export async function debitBalance(
  db: D1Database,
  address: string,
  priceMicro: bigint,
  nonce: string,
  tool: string
): Promise<DebitResult> {
  const addr = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const price = Number(priceMicro);

  // Early replay check (cheap; the INSERT below is the real guard).
  const seen = await db
    .prepare("SELECT 1 FROM spend_nonces WHERE nonce = ?")
    .bind(nonce)
    .first();
  if (seen) return { ok: false, reason: "replay" };

  // 1. Atomic conditional debit — never goes negative, never oversells.
  const upd = await db
    .prepare(
      "UPDATE balances SET balance_micro = balance_micro - ?, total_spent_micro = total_spent_micro + ?, updated_at = ? WHERE address = ? AND balance_micro >= ?"
    )
    .bind(price, price, now, addr, price)
    .run();

  if (upd.meta.changes !== 1) {
    return { ok: false, reason: "insufficient" };
  }

  // 2. Consume the nonce. Duplicate PRIMARY KEY => concurrent replay won the
  //    race against our early check; refund the debit and report replay.
  try {
    await db
      .prepare("INSERT INTO spend_nonces (nonce, address, created_at) VALUES (?, ?, ?)")
      .bind(nonce, addr, now)
      .run();
  } catch {
    await db
      .prepare(
        "UPDATE balances SET balance_micro = balance_micro + ?, total_spent_micro = total_spent_micro - ?, updated_at = ? WHERE address = ?"
      )
      .bind(price, price, now, addr)
      .run();
    return { ok: false, reason: "replay" };
  }

  const balanceAfter = await getBalanceMicro(db, addr);

  // 3. Ledger (audit). Best-effort: balance is the source of truth.
  await db
    .prepare(
      "INSERT INTO ledger (address, kind, amount_micro, balance_after, tool, nonce, created_at) VALUES (?, 'debit', ?, ?, ?, ?, ?)"
    )
    .bind(addr, -price, Number(balanceAfter), tool, nonce, now)
    .run();

  return { ok: true, balanceAfter };
}

/**
 * Refund a previously-debited amount (e.g. the tool failed after debit).
 * Credits the balance back and writes a refund ledger entry. Best-effort.
 */
export async function refundDebit(
  db: D1Database,
  address: string,
  priceMicro: bigint,
  tool: string,
  nonce: string
): Promise<bigint> {
  const addr = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const price = Number(priceMicro);
  await db
    .prepare(
      "UPDATE balances SET balance_micro = balance_micro + ?, total_spent_micro = total_spent_micro - ?, updated_at = ? WHERE address = ?"
    )
    .bind(price, price, now, addr)
    .run();
  const balanceAfter = await getBalanceMicro(db, addr);
  await db
    .prepare(
      "INSERT INTO ledger (address, kind, amount_micro, balance_after, tool, nonce, created_at) VALUES (?, 'debit', ?, ?, ?, ?, ?)"
    )
    .bind(addr, price, Number(balanceAfter), `${tool}:refund`, nonce, now)
    .run();
  return balanceAfter;
}

/**
 * Credit a settled deposit to an address (upsert) and write a deposit ledger
 * entry. Called AFTER the on-chain settle succeeds.
 */
export async function creditDeposit(
  db: D1Database,
  address: string,
  amountMicro: bigint,
  txHash: string,
  nonce: string
): Promise<bigint> {
  const addr = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const amount = Number(amountMicro);

  await db
    .prepare(
      `INSERT INTO balances (address, balance_micro, total_deposited_micro, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         balance_micro = balance_micro + excluded.balance_micro,
         total_deposited_micro = total_deposited_micro + excluded.total_deposited_micro,
         updated_at = excluded.updated_at`
    )
    .bind(addr, amount, amount, now, now)
    .run();

  const balanceAfter = await getBalanceMicro(db, addr);

  await db
    .prepare(
      "INSERT INTO ledger (address, kind, amount_micro, balance_after, tx_hash, nonce, created_at) VALUES (?, 'deposit', ?, ?, ?, ?, ?)"
    )
    .bind(addr, amount, Number(balanceAfter), txHash, nonce, now)
    .run();

  return balanceAfter;
}
