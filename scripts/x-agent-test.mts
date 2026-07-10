/**
 * Local end-to-end test for the ToolSnap X Agent: cola D1 + publisher +
 * quote dependency ordering (Fase 22.1) + veto window (Fase 22.2). Uses
 * X_DRY_RUN=1 (no real X API calls) and the local D1 (via `wrangler dev`),
 * so this is safe to run repeatedly.
 *
 * Run:
 *   (1) npx wrangler dev --test-scheduled --local-protocol http
 *       (make sure .dev.vars has ADMIN_API_KEY, X_DRY_RUN=1, X_TG_WEBHOOK_SECRET,
 *        TELEGRAM_CHAT_ID, and X_VETO_MIN_S set low — see .dev.vars.example)
 *   (2) npx tsx scripts/x-agent-test.mts
 *
 * Exercises:
 *  - loading a batch with a parent post + a quote that depends_on it
 *  - the child staying ineligible until the parent is published (min_gap_s)
 *  - the publisher cron tick (fired via /__scheduled, wrangler's
 *    --test-scheduled harness) claiming and publishing due rows
 *  - GET /x-api/queue reflecting the final published state
 *  - Fase 22.2: a `veto` row gets its cancel-window notice on the first
 *    tick, stays unpublished until scheduled_at AND the notice+X_VETO_MIN_S
 *    window are both satisfied, and a simulated Telegram "cancel" callback
 *    vetoes a row before it ever gets a chance to publish
 */
import { execSync } from "node:child_process";

const BASE = process.env.MCP_URL ?? "http://localhost:8787";
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const TG_WEBHOOK_SECRET = process.env.X_TG_WEBHOOK_SECRET;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!ADMIN_KEY) {
  console.error("Set ADMIN_API_KEY (same value as in .dev.vars) before running.");
  process.exit(1);
}
if (!TG_WEBHOOK_SECRET || !TG_CHAT_ID) {
  console.error("Set X_TG_WEBHOOK_SECRET and TELEGRAM_CHAT_ID (same values as in .dev.vars) before running.");
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

/** Simulate Telegram delivering a callback_query to /webhooks/telegram (veto cancel button). */
async function sendTelegramCancel(queueId: number) {
  const res = await fetch(`${BASE}/webhooks/telegram`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": TG_WEBHOOK_SECRET!,
    },
    body: JSON.stringify({
      callback_query: {
        id: `cb-${Date.now()}`,
        data: `xq:${queueId}:cancel`,
        message: { message_id: 1, chat: { id: Number(TG_CHAT_ID) } },
      },
    }),
  });
  return res.status;
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

  console.log("\n5) Fase 22.2 — veto row: accepted at creation as 'scheduled' (no approval card)");
  const vetoBatchId = `e2e-veto-${Date.now()}`;
  const vetoScheduledAt = now + 2; // due almost immediately — the real gate under test is the window, not scheduled_at
  const vetoLoad = await adminPost("/x-api/queue", {
    batch_id: vetoBatchId,
    items: [
      {
        local_id: "veto-a",
        account: "personal",
        kind: "post",
        text: "e2e veto test post",
        series: "e2e",
        approval_mode: "veto",
        scheduled_at: vetoScheduledAt,
      },
    ],
  });
  check("veto batch load 200", vetoLoad.status === 200, JSON.stringify(vetoLoad.json));
  const vetoId = (vetoLoad.json?.inserted ?? []).find((r: { local_id?: string }) => r.local_id === "veto-a")?.id;
  check("veto row inserted", Boolean(vetoId));

  console.log("\n6) First tick after load: notice sent (veto_notified_at set), NOT published yet (X_VETO_MIN_S window just opened)");
  await fireCron("*/5 * * * *");
  await sleep(2500); // real (fake-token) Telegram fetch inside ctx.waitUntil needs more than a beat
  let vetoRow = (await adminGet(`/x-api/queue?batch_id=${vetoBatchId}`)).json?.rows?.[0];
  check("veto_notified_at set after first tick", typeof vetoRow?.veto_notified_at === "number", JSON.stringify(vetoRow));
  check("still scheduled (not published) right after notice", vetoRow?.status === "scheduled", JSON.stringify(vetoRow));

  console.log("\n7) Tick ~3.5s after notice (X_VETO_MIN_S=6s in .dev.vars): window still open, must not publish");
  await sleep(1000);
  await fireCron("*/5 * * * *");
  await sleep(500);
  vetoRow = (await adminGet(`/x-api/queue?batch_id=${vetoBatchId}`)).json?.rows?.[0];
  check("veto row NOT published before the window closes", vetoRow?.status === "scheduled", JSON.stringify(vetoRow));

  console.log("\n8) Tick well after the X_VETO_MIN_S window closes: publishes");
  await sleep(4500); // total ~8s since notice — past the 6s window with clear margin
  await fireCron("*/5 * * * *");
  await sleep(500);
  vetoRow = (await adminGet(`/x-api/queue?batch_id=${vetoBatchId}`)).json?.rows?.[0];
  check("veto row published after the window closes", vetoRow?.status === "published", JSON.stringify(vetoRow));
  check("veto row has a dry-run tweet_id", typeof vetoRow?.tweet_id === "string" && vetoRow.tweet_id.startsWith("dryrun_"));

  console.log("\n9) Fase 22.2 — veto cancel: a Telegram 'cancel' callback vetoes a row before it publishes");
  const vetoBatchId2 = `e2e-veto-cancel-${Date.now()}`;
  const vetoLoad2 = await adminPost("/x-api/queue", {
    batch_id: vetoBatchId2,
    items: [
      {
        local_id: "veto-b",
        account: "product",
        kind: "post",
        text: "e2e veto-cancel test post",
        series: "e2e",
        approval_mode: "veto",
        scheduled_at: now + 2,
      },
    ],
  });
  const vetoId2 = (vetoLoad2.json?.inserted ?? []).find((r: { local_id?: string }) => r.local_id === "veto-b")?.id;
  check("second veto row inserted", Boolean(vetoId2));

  await fireCron("*/5 * * * *"); // sends the notice
  await sleep(2500);

  const cancelStatus = await sendTelegramCancel(vetoId2);
  check("Telegram cancel webhook accepted (200)", cancelStatus === 200, String(cancelStatus));
  await sleep(1000);

  let vetoRow2 = (await adminGet(`/x-api/queue?batch_id=${vetoBatchId2}`)).json?.rows?.[0];
  check("row canceled after Telegram veto", vetoRow2?.status === "canceled", JSON.stringify(vetoRow2));

  await sleep(6000); // well past scheduled_at + the veto window — proves cancellation is permanent, not just "not due yet"
  await fireCron("*/5 * * * *");
  await sleep(500);
  vetoRow2 = (await adminGet(`/x-api/queue?batch_id=${vetoBatchId2}`)).json?.rows?.[0];
  check("canceled row stays canceled (never published) on later ticks", vetoRow2?.status === "canceled", JSON.stringify(vetoRow2));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
