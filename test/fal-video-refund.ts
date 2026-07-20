/**
 * Refund-on-failure test for Fase 13.1b/13.1c's async video_generate/media_job
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
 * Fase 13.1c adds two more cases against the same fake D1 (now extended to
 * also cover the media_jobs table's guarded UPDATE statements):
 *   - two concurrent polls discovering the same failure -> markMediaJobFailed
 *     only lets ONE of them win the queued/running -> failed transition
 *     (D1's meta.changes), so only one refund is ever issued;
 *   - a transient error (plain network Error, or a fal.ai 5xx) must NOT
 *     fail or refund the job at all — only a definitive 4xx (or the age
 *     cutoff) does.
 *
 * Run: npx tsx test/fal-video-refund.ts
 */
import { debitBalance, refundDebit, getBalanceMicro } from "../src/x402/prepaid.js";
import { markMediaJobFailed } from "../src/fal/media-jobs.js";
import { FalQueueHttpError } from "../src/fal/queue.js";
import { isDefinitiveHttpError } from "../src/tools/media-job.js";

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

// --- Minimal in-memory D1 fake covering exactly the statements prepaid.ts
// AND media-jobs.ts issue (the latter extended in Fase 13.1c to test the
// double-refund guard against a fake `media_jobs` table). ---
interface FakeRow {
  balance_micro: number;
  total_spent_micro: number;
}
interface FakeMediaJobRow {
  status: string;
  error: string | null;
}
function makeFakeD1() {
  const balances = new Map<string, FakeRow>();
  const spendNonces = new Set<string>();
  const ledger: Array<{ address: string; kind: string; amount_micro: number; tool: string; nonce: string }> = [];
  const mediaJobs = new Map<string, FakeMediaJobRow>();

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
            // media_jobs.ts's markMediaJobFailed — Fase 13.1c: only transitions
            // rows still 'queued'/'running', reporting meta.changes so two
            // concurrent callers racing on the same job_id only have one win.
            if (sql.startsWith("UPDATE media_jobs SET status = 'failed'")) {
              const [error, _updatedAt, jobId] = args as [string, number, string];
              const row = mediaJobs.get(jobId);
              if (!row || (row.status !== "queued" && row.status !== "running")) {
                return { meta: { changes: 0 } };
              }
              row.status = "failed";
              row.error = error.slice(0, 500);
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
  return {
    db,
    ledger,
    mediaJobs,
    seed: (addr: string, micro: number) => balances.set(addr, { balance_micro: micro, total_spent_micro: 0 }),
  };
}

console.log("=== Fase 13.1b video_generate refund-on-failure test ===\n");

async function main() {
  const { db, ledger, mediaJobs, seed } = makeFakeD1();
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

async function testConcurrentFailureOnlyRefundsOnce() {
  console.log("\n=== Fase 13.1c: concurrent polls -> exactly one refund ===\n");
  const { db, mediaJobs, seed } = makeFakeD1();
  const ADDR = "0xbee0000000000000000000000000000000f00d";
  const PRICE_MICRO = 700_000n;
  const jobId = "job-concurrent-1";
  const nonce = "0xsubmit-nonce-concurrent";

  seed(ADDR, 3_000_000);
  await debitBalance(db, ADDR, PRICE_MICRO, nonce, "video_generate");
  mediaJobs.set(jobId, { status: "running", error: null });

  // Two polls (e.g. two overlapping media_job calls) both discover the same
  // failure at ~the same time and both call markMediaJobFailed for the same
  // job_id. Mirrors media-job.ts's failJobOnce: only refund if you won.
  const [wonA, wonB] = await Promise.all([
    markMediaJobFailed(db, jobId, "poll A: fal timeout"),
    markMediaJobFailed(db, jobId, "poll B: fal timeout"),
  ]);
  assertEq("exactly one poll wins the queued/running -> failed transition", [wonA, wonB].filter(Boolean).length, 1);

  let refundCount = 0;
  for (const won of [wonA, wonB]) {
    if (won) {
      await refundDebit(db, ADDR, PRICE_MICRO, "video_generate", nonce);
      refundCount++;
    }
  }
  assertEq("exactly one refund issued despite two concurrent polls", refundCount, 1);
  assertEq("balance refunded exactly once (not double-credited)", (await getBalanceMicro(db, ADDR)).toString(), "3000000");
  assertEq("job row landed in 'failed'", mediaJobs.get(jobId)?.status, "failed");

  // A third, later poll (after the job already resolved) must also lose —
  // the guard isn't a one-shot race artifact, it holds for any subsequent call.
  const wonLate = await markMediaJobFailed(db, jobId, "poll C: arrives after resolution");
  assertEq("a poll arriving after resolution also loses the transition", wonLate, false);
}

function testTransientErrorClassification() {
  console.log("\n=== Fase 13.1c: transient vs definitive fal.ai error classification ===\n");
  const networkErr = new Error("fal.ai queue status check timed out after 15s");
  const httpErr500 = new FalQueueHttpError("fal.ai queue status check failed: HTTP 500 — internal error", 500);
  const httpErr404 = new FalQueueHttpError("fal.ai queue status check failed: HTTP 404 — request not found", 404);

  assertEq("a plain network/timeout Error is NOT definitive (transient)", isDefinitiveHttpError(networkErr), false);
  assertEq("a fal.ai 5xx is NOT definitive (transient)", isDefinitiveHttpError(httpErr500), false);
  assertEq("a fal.ai 4xx IS definitive", isDefinitiveHttpError(httpErr404), true);
}

async function testTransientErrorDoesNotFailOrRefund() {
  console.log("\n=== Fase 13.1c: transient error leaves the job untouched, no refund ===\n");
  const { db, mediaJobs, seed } = makeFakeD1();
  const ADDR = "0xcaf0000000000000000000000000000000babe";
  const PRICE_MICRO = 700_000n;
  const jobId = "job-transient-1";
  const nonce = "0xsubmit-nonce-transient";

  seed(ADDR, 2_000_000);
  await debitBalance(db, ADDR, PRICE_MICRO, nonce, "video_generate");
  mediaJobs.set(jobId, { status: "running", error: null });

  // Mirrors media-job.ts's branch: a plain network Error from
  // getFalQueueStatus is classified transient, so markMediaJobFailed must
  // NEVER be called for it — the job stays exactly as it was.
  const networkErr = new Error("fal.ai queue status check timed out after 15s");
  if (isDefinitiveHttpError(networkErr)) {
    await markMediaJobFailed(db, jobId, networkErr.message);
  }
  assertEq("job status untouched after a transient error", mediaJobs.get(jobId)?.status, "running");
  assertEq(
    "balance untouched after a transient error (no refund fired)",
    (await getBalanceMicro(db, ADDR)).toString(),
    "1300000" // 2_000_000 - 700_000, still debited, not refunded
  );
}

await main();
await testConcurrentFailureOnlyRefundsOnce();
testTransientErrorClassification();
await testTransientErrorDoesNotFailOrRefund();

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) process.exit(1);
