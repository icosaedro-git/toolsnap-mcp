/**
 * Unit tests for Fase 13.1 — fal.ai media tools dynamic pricing + daily
 * budget breaker. Pure logic, no network/D1/wrangler dev required.
 *
 * Covers:
 *  - image_generate / image_upscale / audio_transcribe / text_to_speech
 *    pricing for concrete args, asserting exact micro-USDC amounts against
 *    the verified fal.ai rates in src/fal/pricing.ts.
 *  - Pricing errors on unpriceable args (never silently guesses).
 *  - firstCallFreeEligible excludes every dynamically-priced tool.
 *  - The daily budget breaker: rejects once the accumulated estimate would
 *    exceed the configured budget, and never rejects a first call under it.
 *  - Catalog integrity for the new tools (registered + in ≥1 family) is
 *    covered by scripts/first-connection-audit.ts (assertCatalogComplete) —
 *    not duplicated here.
 *
 * Run: npx tsx test/fal-media-pricing.ts
 */
import { getToolPrice, firstCallFreeEligible, DYNAMIC_PRICERS } from "../src/x402/middleware.js";
import { checkFalBudget, recordFalCost, type FalBudgetEnv } from "../src/fal/budget.js";

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

console.log("=== Fase 13.1 fal.ai pricing + budget breaker tests ===\n");

// ---------------------------------------------------------------------------
// image_generate
// ---------------------------------------------------------------------------
{
  // flux-schnell, default landscape_4_3 (1 MP), 1 image: COGS = $0.003 →
  // payPerCall = max(0.006, 0.02) = $0.02 (floor dominates), prepaid = $0.015.
  const p1 = getToolPrice("image_generate", {}, { model: "flux-schnell" });
  assertEq("image_generate flux-schnell 1MP payPerCall", p1.payPerCallStr, "0.020000");
  assertEq("image_generate flux-schnell 1MP prepaid", p1.prepaidStr, "0.015000");

  // flux-dev, landscape_4_3 (1 MP), 1 image: COGS = $0.025 → payPerCall =
  // max(0.05, 0.02) = $0.05, prepaid = 0.75 * 0.05 = $0.0375 → ceil milli = $0.038.
  const p2 = getToolPrice("image_generate", {}, { model: "flux-dev" });
  assertEq("image_generate flux-dev 1MP payPerCall", p2.payPerCallStr, "0.050000");
  assertEq("image_generate flux-dev 1MP prepaid", p2.prepaidStr, "0.038000");

  // flux-dev, square_hd (2 MP per fal's round-up-to-nearest-MP rule), 1 image:
  // COGS = 2 * 0.025 = $0.05 → payPerCall = max(0.10, 0.02) = $0.10.
  const p3 = getToolPrice("image_generate", {}, { model: "flux-dev", image_size: "square_hd" });
  assertEq("image_generate flux-dev square_hd payPerCall", p3.payPerCallStr, "0.100000");

  // Unknown model → throws (real args object, must not silently default).
  let threw = false;
  try {
    getToolPrice("image_generate", {}, { model: "flux-ultra-nonexistent" });
  } catch {
    threw = true;
  }
  assert("image_generate unknown model throws", threw, "expected a throw for an unrecognized model");

  // num_images out of range → throws.
  let threw2 = false;
  try {
    getToolPrice("image_generate", {}, { num_images: 99 });
  } catch {
    threw2 = true;
  }
  assert("image_generate num_images over cap throws", threw2, "expected a throw for num_images=99");

  // Representative quote (args=undefined) must NOT throw.
  let ok = true;
  try {
    getToolPrice("image_generate", {});
  } catch {
    ok = false;
  }
  assert("image_generate representative quote (no args) does not throw", ok, "should return a default quote");
}

// ---------------------------------------------------------------------------
// image_upscale
// ---------------------------------------------------------------------------
{
  // scale=2: assumed 8 compute-seconds * $0.00111 = $0.00888 → payPerCall =
  // max(0.01776, 0.02) = $0.02 (floor), prepaid = $0.015.
  const p1 = getToolPrice("image_upscale", {}, { scale: 2 });
  assertEq("image_upscale scale=2 payPerCall", p1.payPerCallStr, "0.020000");

  // scale=4: assumed 15 compute-seconds * $0.00111 = $0.01665 → payPerCall =
  // max(0.0333, 0.02) = $0.0333 → ceil milli = $0.034.
  const p2 = getToolPrice("image_upscale", {}, { scale: 4 });
  assertEq("image_upscale scale=4 payPerCall", p2.payPerCallStr, "0.034000");

  let threw = false;
  try {
    getToolPrice("image_upscale", {}, { scale: 3 });
  } catch {
    threw = true;
  }
  assert("image_upscale unsupported scale throws", threw, "expected a throw for scale=3");
}

// ---------------------------------------------------------------------------
// audio_transcribe
// ---------------------------------------------------------------------------
{
  // Real args, no duration_seconds → must throw (never silently guess a duration).
  let threw = false;
  try {
    getToolPrice("audio_transcribe", {}, {});
  } catch {
    threw = true;
  }
  assert("audio_transcribe without duration_seconds throws", threw, "expected a throw");

  // 60s: COGS = $0.0005/min * 1min = $0.0005 → floor $0.02.
  const p1 = getToolPrice("audio_transcribe", {}, { duration_seconds: 60 });
  assertEq("audio_transcribe 60s payPerCall (floor)", p1.payPerCallStr, "0.020000");

  // 1800s (30 min): COGS = 0.0005 * 30 = $0.015 → payPerCall = max(0.03, 0.02) = $0.03.
  const p2 = getToolPrice("audio_transcribe", {}, { duration_seconds: 1800 });
  assertEq("audio_transcribe 1800s payPerCall", p2.payPerCallStr, "0.030000");

  // Over the 60-minute cap → throws.
  let threwCap = false;
  try {
    getToolPrice("audio_transcribe", {}, { duration_seconds: 3601 });
  } catch {
    threwCap = true;
  }
  assert("audio_transcribe over 60min cap throws", threwCap, "expected a throw for 3601s");
}

// ---------------------------------------------------------------------------
// text_to_speech
// ---------------------------------------------------------------------------
{
  // Real args, no text → throws.
  let threw = false;
  try {
    getToolPrice("text_to_speech", {}, {});
  } catch {
    threw = true;
  }
  assert("text_to_speech without text throws", threw, "expected a throw");

  // 500 chars: COGS = 0.02/1000 * 500 = $0.01 → floor $0.02.
  const p1 = getToolPrice("text_to_speech", {}, { text: "x".repeat(500) });
  assertEq("text_to_speech 500 chars payPerCall (floor)", p1.payPerCallStr, "0.020000");

  // 2000 chars: COGS = 0.02/1000 * 2000 = $0.04 → payPerCall = max(0.08, 0.02) = $0.08.
  const p2 = getToolPrice("text_to_speech", {}, { text: "x".repeat(2000) });
  assertEq("text_to_speech 2000 chars payPerCall", p2.payPerCallStr, "0.080000");
}

// ---------------------------------------------------------------------------
// firstCallFreeEligible must exclude every dynamically-priced tool
// ---------------------------------------------------------------------------
{
  for (const name of Object.keys(DYNAMIC_PRICERS)) {
    assertEq(`firstCallFreeEligible("${name}") is false`, firstCallFreeEligible(name), false);
  }
}

// ---------------------------------------------------------------------------
// Daily budget breaker (in-memory KV mock, no wrangler needed)
// ---------------------------------------------------------------------------
async function testBudgetBreaker(): Promise<void> {
  const store = new Map<string, string>();
  const fakeKv = {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;

  const env: FalBudgetEnv = { X402_NONCES: fakeKv, FAL_DAILY_BUDGET_USD: "0.10" }; // $0.10/day for the test

  // First call well under budget ($0.02) must pass.
  let firstOk = true;
  try {
    await checkFalBudget(env, 20_000n);
  } catch {
    firstOk = false;
  }
  assert("budget breaker allows a call under budget", firstOk, "should not throw for $0.02 against a $0.10 budget");

  await recordFalCost(env, 20_000n); // running total: $0.02

  // A call that would push the total over $0.10 must be rejected.
  let rejected = false;
  try {
    await checkFalBudget(env, 90_000n); // 0.02 + 0.09 = 0.11 > 0.10
  } catch {
    rejected = true;
  }
  assert("budget breaker rejects a call that would exceed the daily cap", rejected, "expected a throw");

  // A call that fits exactly must still pass.
  let fits = true;
  try {
    await checkFalBudget(env, 80_000n); // 0.02 + 0.08 = 0.10, exactly at the cap
  } catch {
    fits = false;
  }
  assert("budget breaker allows a call that exactly fits the remaining budget", fits, "should not throw");
}

await testBudgetBreaker();

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
  process.exit(1);
}
