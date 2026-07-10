/**
 * Local end-to-end test for the Fase 22.1 X Agent: cola D1 + publisher +
 * quote dependency ordering. Uses X_DRY_RUN=1 (no real X API calls) and the
 * local D1 (via `wrangler dev`), so this is safe to run repeatedly.
 *
 * Run:
 *   (1) npx wrangler dev --test-scheduled --local-protocol http
 *       (make sure .dev.vars has ADMIN_API_KEY and X_DRY_RUN=1)
 *   (2) npx tsx scripts/x-agent-test.mts
 *
 * Exercises:
 *  - loading a batch with a parent post + a quote that depends_on it
 *  - the child staying ineligible until the parent is published (min_gap_s)
 *  - the publisher cron tick (fired via /__scheduled, wrangler's
 *    --test-scheduled harness) claiming and publishing due rows
 *  - GET /x-api/queue reflecting the final published state
 */
import { execSync } from "node:child_process";

const BASE = process.env.MCP_URL ?? "http://localhost:8787";
const ADMIN_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_KEY) {
  console.error("Set ADMIN_API_KEY (same value as in .dev.vars) before running.");
  process.exit(1);
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

function applyMigrationLocally() {
  console.log("Applying migrations/0009_x_agent.sql to local D1 (idempotent)...");
  execSync(`npx wrangler d1 execute toolsnap-prepaid --local --file=migrations/0009_x_agent.sql`, {
    stdio: "inherit",
  });
}

async function adminPost(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY! },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function adminGet(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-admin-key": ADMIN_KEY! } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function fireCron(cron: string) {
  const res = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent(cron)}`);
  return res.status;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  applyMigrationLocally();

  const now = Math.floor(Date.now() / 1000);
  const batchId = `e2e-${Date.now()}`;

  console.log("\n1) Load batch: product post (due now) + personal quote depending on it (min_gap_s=0)");
  const load = await adminPost("/x-api/queue", {
    batch_id: batchId,
    approval_mode: "batch",
    items: [
      {
        local_id: "parent",
        account: "product",
        kind: "post",
        text: "e2e test parent post",
        series: "e2e",
        scheduled_at: now - 60,
      },
      {
        local_id: "child",
        account: "personal",
        kind: "quote",
        text: "e2e test quote of the parent",
        depends_on: "parent",
        min_gap_s: 0,
        scheduled_at: now - 60,
      },
    ],
  });
  check("batch load 200", load.status === 200, JSON.stringify(load.json));
  const insertedIds: { local_id?: string; id: number }[] = load.json?.inserted ?? [];
  const parentId = insertedIds.find((r) => r.local_id === "parent")?.id;
  const childId = insertedIds.find((r) => r.local_id === "child")?.id;
  check("both rows inserted", Boolean(parentId && childId));

  console.log("\n2) First publisher tick: only the parent should be eligible (child blocked on depends_on)");
  const tick1 = await fireCron("*/5 * * * *");
  check("cron tick 1 fired (200)", tick1 === 200, String(tick1));
  await sleep(500); // ctx.waitUntil is fire-and-forget; give it a beat

  const afterTick1 = await adminGet(`/x-api/queue?batch_id=${batchId}`);
  const parentRow1 = (afterTick1.json?.rows ?? []).find((r: { id: number }) => r.id === parentId);
  const childRow1 = (afterTick1.json?.rows ?? []).find((r: { id: number }) => r.id === childId);
  check("parent published after tick 1", parentRow1?.status === "published", JSON.stringify(parentRow1));
  check("parent has a dry-run tweet_id", typeof parentRow1?.tweet_id === "string" && parentRow1.tweet_id.startsWith("dryrun_"));
  check("child still scheduled after tick 1 (parent just published)", childRow1?.status === "scheduled", JSON.stringify(childRow1));

  console.log("\n3) Second publisher tick: child should now be eligible and publish, quoting the parent's tweet_id");
  const tick2 = await fireCron("*/5 * * * *");
  check("cron tick 2 fired (200)", tick2 === 200, String(tick2));
  await sleep(500);

  const afterTick2 = await adminGet(`/x-api/queue?batch_id=${batchId}`);
  const childRow2 = (afterTick2.json?.rows ?? []).find((r: { id: number }) => r.id === childId);
  check("child published after tick 2", childRow2?.status === "published", JSON.stringify(childRow2));

  console.log("\n4) Reject validation: a batch with a bad depends_on is rejected with 400");
  const badLoad = await adminPost("/x-api/queue", {
    items: [{ account: "product", kind: "quote", text: "orphan", depends_on: "not-a-real-id", scheduled_at: now }],
  });
  check("bad depends_on rejected (400)", badLoad.status === 400, JSON.stringify(badLoad.json));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
