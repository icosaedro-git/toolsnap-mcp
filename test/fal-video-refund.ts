/**
 * Refund-on-failure test for Fase 13.1b's async video_generate/media_job
 * flow — exercises the REAL debitBalance/refundDebit money logic
 * (src/x402/prepaid.ts) against a minimal in-memory D1 fake (no wrangler
 * dev / local D1 needed), simulating exactly what media-job.ts does when a
 * queued video render is later discovered to have failed:
 *
 *   1. seed a prepaid balance,
 *   2. debitBalance() at "submit" time (same call video_generate's payment
 *      gate makes before creating the media_jobs row),
 *   3. simulate the render failing — call refundDebit() with the SAME
 *      (address, priceMicro, tool, nonce) media-job.ts would use from the
 *      stored row,
 *   4. assert the balance is back to its pre-debit value and the ledger
 *      recorded both the debit and the refund.
 *
 * Run: npx tsx test/fal-video-refund.ts
 */
import { debitBalance, refundDebit, getBalanceMicro } from "../src/x402/prepaid.js";

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name} — ${detail}`);
    failed++;
  }
}
function assertEq(name: string, actual: unknown, expected: unknown): void {
  assert(name, actual === expected, `expected ${expected}, got ${actual}`);
}

// --- Minimal in-memory D1 fake covering exactly the statements prepaid.ts issues ---
interface FakeRow {
  balance_micro: number;
  total_spent_micro: number;
}
function makeFakeD1() {
  const balances = new Map<string, FakeRow>();
  const spendNonces = new Set<string>();
  const ledger: Array<{ address: string; kind: string; amount_micro: number; tool: string; nonce: string }> = [];

  function prep(sql: string) {
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            if (sql.startsWith("UPDATE balances SET balance_micro = balance_micro - ?")) {
              const [price, priceAgain, _now, addr, minBalance] = args as [number, number, number, string, number];
              const row = balances.get(addr) ?? { balance_micro: 0, total_spent_micro: 0 };
              if (row.balance_micro < minBalance) return { meta: { changes: 0 } };
              row.balance_micro -= price;
              row.total_spent_micro += priceAgain;
              balances.set(addr, row);
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE balances SET balance_micro = balance_micro + ?")) {
              const [price, priceAgain, _now, addr] = args as [number, number, number, string];
              const row = balances.get(addr) ?? { balance_micro: 0, total_spent_micro: 0 };
              row.balance_micro += price;
              row.total_spent_micro -= priceAgain;
              balances.set(addr, row);
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("INSERT INTO spend_nonces")) {
              const [nonce] = args as [string];
              if (spendNonces.has(nonce)) throw new Error("UNIQUE constraint failed: spend_nonces.nonce");
              spendNonces.add(nonce);
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("INSERT INTO ledger")) {
              const [addr, amount, _balanceAfter, tool, nonce] = args as [string, number, number, string, string];
              ledger.push({ address: addr, kind: "debit", amount_micro: amount, tool, nonce });
              return { meta: { changes: 1 } };
            }
            throw new Error(`Unhandled SQL in fake D1: ${sql}`);
          },
          async first<T>() {
            if (sql.startsWith("SELECT balance_micro FROM balances")) {
              const [addr] = args as [string];
              const row = balances.get(addr);
              return (row ? { balance_micro: row.balance_micro } : null) as T | null;
            }
            if (sql.startsWith("SELECT 1 FROM spend_nonces")) {
              const [nonce] = args as [string];
              return (spendNonces.has(nonce) ? { 1: 1 } : null) as T | null;
            }
            throw new Error(`Unhandled SQL in fake D1 (first): ${sql}`);
          },
        };
      },
    };
  }

  const db = { prepare: (sql: string) => prep(sql) } as unknown as D1Database;
  return { db, ledger, seed: (addr: string, micro: number) => balances.set(addr, { balance_micro: micro, total_spent_micro: 0 }) };
}

console.log("=== Fase 13.1b video_generate refund-on-failure test ===\n");

async function main() {
  const { db, ledger, seed } = makeFakeD1();
  const ADDR = "0xabc0000000000000000000000000000000dead";
  const PRICE_MICRO = 700_000n; // $0.70 — kling-pro 5s quote

  seed(ADDR, 5_000_000); // $5.00 starting balance

  // 1. Debit at "submit" time (payment gate, before the media_jobs row is created).
  const submitNonce = "0xsubmit-nonce-1";
  const debit = await debitBalance(db, ADDR, PRICE_MICRO, submitNonce, "video_generate");
  assert(
    "debit at submit succeeds",
    debit.ok === true,
    `ok=${debit.ok} reason=${debit.reason} balanceAfter=${debit.balanceAfter}`
  );
  assertEq("balance after debit", (await getBalanceMicro(db, ADDR)).toString(), "4300000");

  // 2. Simulate the render failing hours later — media_job.ts's refund path,
  //    using the SAME nonce/priceMicro that would be stored in media_jobs
  //    (refund_nonce/price_micro columns).
  const balanceAfterRefund = await refundDebit(db, ADDR, PRICE_MICRO, "video_generate", submitNonce);
  assertEq("balance restored after refund", balanceAfterRefund.toString(), "5000000");
  assertEq("balance matches via getBalanceMicro too", (await getBalanceMicro(db, ADDR)).toString(), "5000000");

  // 3. Ledger recorded both movements (debit then refund credit).
  assertEq("ledger has 2 entries", ledger.length, 2);
  assertEq("first ledger entry is the debit (negative)", ledger[0].amount_micro < 0, true);
  assertEq("second ledger entry is the refund (positive)", ledger[1].amount_micro > 0, true);
  assertEq("refund ledger entry tagged as refund", ledger[1].tool, "video_generate:refund");

  // 4. Replay protection still holds even across a refund cycle: the same
  //    submit nonce can't be debited again (spend_nonces is append-only).
  const replay = await debitBalance(db, ADDR, PRICE_MICRO, submitNonce, "video_generate");
  assertEq("replaying the same submit nonce is rejected", replay.ok, false);
}

await main();

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) process.exit(1);
