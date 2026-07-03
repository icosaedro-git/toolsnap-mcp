/**
 * Local end-to-end test for the Fase 8 prepaid balance flow.
 *
 * Exercises the MONEY logic (no chain needed for the prepaid debit path):
 *  - seed a balance directly in the LOCAL D1,
 *  - sign SpendAuthorizations and call the paid tool via the prepaid path,
 *  - assert the balance decrements, replays are rejected, and an empty balance
 *    returns a 402 recharge.
 *
 * Run:  (1) npx wrangler dev      (in another shell, uses local D1)
 *       (2) npx tsx scripts/prepaid-test.ts
 */
import { execSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const ENDPOINT = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const PAID_TOOL = "screenshot_url";
const PREPAID_PRICE_MICRO = 25_000n; // $0.025 (TOOL_PRICE_OVERRIDES)
const TEST_URL = "https://example.com";

// Deterministic throwaway test key (NOT a funded wallet — local D1 only).
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const account = privateKeyToAccount(TEST_KEY);
const ADDR = account.address.toLowerCase();

const DOMAIN = { name: "ToolSnap Prepaid", version: "1", chainId: 8453 } as const;
const TYPES = {
  SpendAuthorization: [
    { name: "address", type: "address" },
    { name: "tool", type: "string" },
    { name: "maxAmount", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

function randNonce(): Hex {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

async function signSpend(nonce: Hex, maxAmount = PREPAID_PRICE_MICRO) {
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 120);
  const signature = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "SpendAuthorization",
    message: { address: account.address, tool: PAID_TOOL, maxAmount, nonce, validBefore },
  });
  return {
    authorization: {
      address: account.address,
      tool: PAID_TOOL,
      maxAmount: maxAmount.toString(),
      nonce,
      validBefore: validBefore.toString(),
    },
    signature,
  };
}

async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function callPrepaid(nonce: Hex, maxAmount = PREPAID_PRICE_MICRO) {
  const proof = await signSpend(nonce, maxAmount);
  return rpc("tools/call", {
    name: PAID_TOOL,
    arguments: { url: TEST_URL },
    _meta: { "x402/prepaid-spend": proof },
  });
}

async function balance(): Promise<string> {
  const r = await rpc("tools/call", { name: "account_balance", arguments: { address: ADDR } });
  const data = JSON.parse(r.result.content[0].text);
  return data.balance_usdc;
}

function seedBalance(micro: number) {
  const now = Math.floor(Date.now() / 1000);
  const sql = `DELETE FROM balances WHERE address='${ADDR}'; DELETE FROM spend_nonces WHERE address='${ADDR}'; INSERT INTO balances (address, balance_micro, total_deposited_micro, created_at, updated_at) VALUES ('${ADDR}', ${micro}, ${micro}, ${now}, ${now});`;
  execSync(`npx wrangler d1 execute toolsnap-prepaid --local --command "${sql}"`, { stdio: "ignore" });
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label} ${extra}`);
  }
}

async function main() {
  console.log(`Test address: ${ADDR}`);
  console.log("Seeding local D1 balance: $0.075 (3 prepaid calls)\n");
  seedBalance(75_000);

  console.log("1) balance starts at 0.075");
  check("balance == 0.075000", (await balance()) === "0.075000");

  console.log("2) prepaid call #1 → success, balance 0.05");
  const n1 = randNonce();
  const r1 = await callPrepaid(n1);
  const m1 = r1.result?._meta?.["x402/payment-response"];
  check("success + prepaid + not error", r1.result?.isError !== true && m1?.success === true && m1?.prepaid === true, JSON.stringify(r1.result?._meta ?? r1.error));
  check("balance_usdc == 0.050000", m1?.balance_usdc === "0.050000", m1?.balance_usdc);

  console.log("3) prepaid call #2 (fresh nonce) → balance 0.025");
  const n2 = randNonce();
  const r2 = await callPrepaid(n2);
  const m2 = r2.result?._meta?.["x402/payment-response"];
  check("balance_usdc == 0.025000", m2?.balance_usdc === "0.025000", m2?.balance_usdc);

  console.log("4) REPLAY nonce from #2 → rejected, balance unchanged");
  const r3 = await callPrepaid(n2);
  check("replay isError", r3.result?.isError === true && /replay/i.test(r3.result?.content?.[0]?.text ?? ""), JSON.stringify(r3.result));
  check("balance still 0.025000 after replay", (await balance()) === "0.025000");

  console.log("5) prepaid call #3 (fresh nonce) → balance 0.00");
  const r4 = await callPrepaid(randNonce());
  const m4 = r4.result?._meta?.["x402/payment-response"];
  check("balance_usdc == 0.000000", m4?.balance_usdc === "0.000000", m4?.balance_usdc);

  console.log("6) prepaid call on empty balance → 402 recharge, no negative");
  const r5 = await callPrepaid(randNonce());
  check("JSON-RPC error 402", r5.error?.code === 402, JSON.stringify(r5.error ?? r5.result));
  check("balance still 0.000000 (never negative)", (await balance()) === "0.000000");

  console.log("7) maxAmount below price → rejected");
  const r6 = await callPrepaid(randNonce(), 5_000n);
  check("rejected for low maxAmount", r6.result?.isError === true, JSON.stringify(r6.result));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
