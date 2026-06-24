/**
 * Concurrency / double-spend test for the prepaid debit path.
 * Seeds a balance for exactly ONE call, fires 5 concurrent prepaid calls with
 * distinct nonces, and asserts exactly one is charged and the balance never
 * goes negative. Validates the atomic conditional D1 debit.
 *
 * Requires `npx wrangler dev` running (local D1).
 */
import { execSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex
);
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

const rn = (): Hex =>
  ("0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

async function sign(nonce: Hex) {
  const vb = BigInt(Math.floor(Date.now() / 1000) + 120);
  const signature = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "SpendAuthorization",
    message: { address: account.address, tool: "fetch_extract", maxAmount: 10000n, nonce, validBefore: vb },
  });
  return {
    authorization: { address: account.address, tool: "fetch_extract", maxAmount: "10000", nonce, validBefore: vb.toString() },
    signature,
  };
}

function d1(cmd: string): string {
  return execSync(`npx wrangler d1 execute toolsnap-prepaid --local --json --command "${cmd}"`, { encoding: "utf8" });
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  d1(
    `DELETE FROM balances WHERE address='${ADDR}'; DELETE FROM spend_nonces WHERE address='${ADDR}'; INSERT INTO balances (address,balance_micro,total_deposited_micro,created_at,updated_at) VALUES ('${ADDR}',10000,10000,${now},${now});`
  );

  const proofs = await Promise.all([rn(), rn(), rn(), rn(), rn()].map(sign));
  const results = await Promise.all(
    proofs.map((p) =>
      fetch("http://localhost:8787/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "fetch_extract", arguments: { url: "https://example.com" }, _meta: { "x402/prepaid-spend": p } },
        }),
      }).then((r) => r.json())
    )
  );

  const ok = results.filter((r: any) => r.result?._meta?.["x402/payment-response"]?.success === true).length;
  const recharge = results.filter((r: any) => r.error?.code === 402).length;

  const out = d1(`SELECT balance_micro FROM balances WHERE address='${ADDR}'`);
  // wrangler --json prints an array of statement results; find the row.
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  const bal = parsed[0].results[0].balance_micro;

  console.log(`5 concurrent calls, balance for 1 → successes=${ok}, recharge402=${recharge}, final_balance_micro=${bal}`);
  const passed = ok === 1 && bal === 0;
  console.log(passed ? "✅ exactly one charged, balance never negative" : "❌ RACE BUG");
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
