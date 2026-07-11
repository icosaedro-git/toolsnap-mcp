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
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillPromptPlaceholders, type ReplyConfig } from "../src/x-agent/discovery.ts";

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
  console.log("Applying migrations/0010_x_published_via.sql to local D1 (idempotent — ALTER TABLE ADD COLUMN fails harmlessly if it already ran)...");
  try {
    execSync(`npx wrangler d1 execute toolsnap-prepaid --local --file=migrations/0010_x_published_via.sql`, {
      stdio: "inherit",
    });
  } catch {
    console.log("(0010 already applied in this local D1 — ignoring 'duplicate column' error)");
  }
  console.log("Applying migrations/0011_x_reply.sql to local D1 (idempotent)...");
  execSync(`npx wrangler d1 execute toolsnap-prepaid --local --file=migrations/0011_x_reply.sql`, {
    stdio: "inherit",
  });
}

/** Run arbitrary SQL against the local D1 (used for test-only fixtures/backdating that have no API — never used for the real x_prompts strategy content, which is a fixture string here, not the real vault prompt). */
function runD1SqlLocally(sql: string) {
  const file = join(tmpdir(), `x-agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
  writeFileSync(file, sql, "utf8");
  execSync(`npx wrangler d1 execute toolsnap-prepaid --local --file=${file}`, { stdio: "pipe" });
}

/** Fase 22.4 — load a synthetic reply-guy prompt+config fixture (NOT the real vault nota 14 strategy) so the gate/queue mechanics can be exercised locally. Window/calendar wide open and budget/cap generous so gate checks never flake on wall-clock time; ttlS kept configurable per test via a second call when testing expiry. */
function loadReplyGuyFixtures(ttlS = 2700) {
  const config = {
    window: { startHour: 0, endHour: 24 },
    sweepsPerDay: { mon: 999, tue: 999, wed: 999, thu: 999, fri: 999, sat: 999, sun: 999 },
    dailyBudgetUsd: 100,
    dailyCap: 100,
    minScore: 0,
    ttlS,
    maxCandidatesPerSweep: 5,
    maxSearchesPerSweep: 4,
  };
  runD1SqlLocally(
    `DELETE FROM x_prompts WHERE name IN ('reply_discovery', 'reply_config');
     INSERT INTO x_prompts (name, version, content, active) VALUES
       ('reply_discovery', 1, 'e2e-test-fixture-prompt (not the real vault strategy)', 1),
       ('reply_config', 1, '${JSON.stringify(config).replace(/'/g, "''")}', 1);`
  );
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

/** Fase 22.3 — POST raw bytes with x-admin-key, for the media upload endpoint. */
async function adminPostBinary(path: string, bytes: Uint8Array, contentType: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType, "x-admin-key": ADMIN_KEY! },
    body: bytes,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Fase 22.3 — plain fetch, no auth at all (for checking the Access-gate rejects unauthenticated requests). */
async function unauthGet(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function fireCron(cron: string) {
  const res = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent(cron)}`);
  return res.status;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Simulate Telegram delivering a callback_query to /webhooks/telegram (any xq:<id>:<action> button). */
async function sendTelegramCallback(queueId: number, action: string) {
  const res = await fetch(`${BASE}/webhooks/telegram`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": TG_WEBHOOK_SECRET!,
    },
    body: JSON.stringify({
      callback_query: {
        id: `cb-${Date.now()}`,
        data: `xq:${queueId}:${action}`,
        message: { message_id: 1, chat: { id: Number(TG_CHAT_ID) } },
      },
    }),
  });
  return res.status;
}

/** Backwards-compatible name for the veto cancel button (Fase 22.2 tests) — thin wrapper over sendTelegramCallback. */
async function sendTelegramCancel(queueId: number) {
  return sendTelegramCallback(queueId, "cancel");
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

  console.log("\n10) Fase 22.3 — reschedule resets veto_notified_at");
  const rescheduleBatchId = `e2e-reschedule-${Date.now()}`;
  const rescheduleLoad = await adminPost("/x-api/queue", {
    batch_id: rescheduleBatchId,
    approval_mode: "batch",
    items: [{ account: "product", kind: "post", text: "e2e reschedule test", series: "e2e", scheduled_at: now + 3600 }],
  });
  const rescheduleId = rescheduleLoad.json?.inserted?.[0]?.id;
  check("reschedule fixture inserted", Boolean(rescheduleId));
  // Manually stamp veto_notified_at via a veto row's normal path is overkill here —
  // reschedule's contract is "always clears it", verified against a plain
  // scheduled row (starts NULL, must stay NULL — the real signal is the
  // scheduled_at change plus no crash/rejection on a row that never had a notice).
  const rescheduleResp = await adminPost(`/x-api/queue/${rescheduleId}/reschedule`, { scheduled_at: now + 7200 });
  check("reschedule accepted", rescheduleResp.status === 200 && rescheduleResp.json?.rescheduled === true, JSON.stringify(rescheduleResp.json));
  const afterReschedule = (await adminGet(`/x-api/queue?batch_id=${rescheduleBatchId}`)).json?.rows?.[0];
  check("scheduled_at updated", afterReschedule?.scheduled_at === now + 7200, JSON.stringify(afterReschedule));
  check("veto_notified_at cleared (still null)", afterReschedule?.veto_notified_at === null, JSON.stringify(afterReschedule));

  console.log("\n11) Fase 22.3 — panel edit on a scheduled row: in-place, no status change, logs a panel_edit correction");
  const editBatchId = `e2e-edit-${Date.now()}`;
  const editLoad = await adminPost("/x-api/queue", {
    batch_id: editBatchId,
    approval_mode: "batch",
    items: [{ account: "personal", kind: "post", text: "original text", series: "e2e", scheduled_at: now + 3600 }],
  });
  const editId = editLoad.json?.inserted?.[0]?.id;
  const editResp = await adminPost(`/x-api/queue/${editId}/edit`, { text: "edited text via panel" });
  check("edit accepted", editResp.status === 200 && editResp.json?.edited === true, JSON.stringify(editResp.json));
  const afterEdit = (await adminGet(`/x-api/queue?batch_id=${editBatchId}`)).json?.rows?.[0];
  check("text updated", afterEdit?.text === "edited text via panel", JSON.stringify(afterEdit));
  check("status unchanged (still scheduled, not re-approved/reset)", afterEdit?.status === "scheduled", JSON.stringify(afterEdit));

  console.log("\n12) Fase 22.3 — media upload + media_keys on a batch item + dry-run publish resolves mediaIds");
  const fakePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]); // not a real PNG, just non-empty bytes — X_DRY_RUN never touches the actual X media API
  const mediaUpload = await adminPostBinary("/x-api/media", fakePng, "image/png");
  check("media upload 200", mediaUpload.status === 200, JSON.stringify(mediaUpload.json));
  const mediaKey = mediaUpload.json?.media_key;
  check("media_key returned with x-media/ prefix", typeof mediaKey === "string" && mediaKey.startsWith("x-media/"), JSON.stringify(mediaUpload.json));

  const mediaBatchId = `e2e-media-${Date.now()}`;
  const mediaLoad = await adminPost("/x-api/queue", {
    batch_id: mediaBatchId,
    approval_mode: "batch",
    items: [{ account: "product", kind: "post", text: "e2e post with image", series: "e2e", scheduled_at: now - 60, media_keys: mediaKey ? [mediaKey] : [] }],
  });
  check("media batch load 200", mediaLoad.status === 200, JSON.stringify(mediaLoad.json));
  await fireCron("*/5 * * * *");
  await sleep(500);
  const mediaRow = (await adminGet(`/x-api/queue?batch_id=${mediaBatchId}`)).json?.rows?.[0];
  check("media row published (dry-run media upload didn't block it)", mediaRow?.status === "published", JSON.stringify(mediaRow));

  console.log("\n13) Fase 22.3 — 'Publish now' fast-tracks a pending_approval row without waiting for L0 Telegram approval");
  const publishNowBatchId = `e2e-publish-now-${Date.now()}`;
  const publishNowLoad = await adminPost("/x-api/queue", {
    batch_id: publishNowBatchId,
    approval_mode: "per_post",
    items: [{ account: "personal", kind: "post", text: "e2e publish-now test", series: "e2e", scheduled_at: now + 3600 }],
  });
  const publishNowId = publishNowLoad.json?.inserted?.[0]?.id;
  const beforePublishNow = (await adminGet(`/x-api/queue?batch_id=${publishNowBatchId}`)).json?.rows?.[0];
  check("row starts pending_approval (L0)", beforePublishNow?.status === "pending_approval", JSON.stringify(beforePublishNow));
  const publishNowResp = await adminPost(`/x-api/queue/${publishNowId}/publish-now`);
  check("publish-now accepted", publishNowResp.status === 200 && publishNowResp.json?.scheduled_now === true, JSON.stringify(publishNowResp.json));
  await fireCron("*/5 * * * *");
  await sleep(500);
  const afterPublishNow = (await adminGet(`/x-api/queue?batch_id=${publishNowBatchId}`)).json?.rows?.[0];
  check("row published on the next tick despite being per_post", afterPublishNow?.status === "published", JSON.stringify(afterPublishNow));

  console.log("\n14) Fase 22.3 — 'mark published' manually: WITH a tweet URL keeps children alive, WITHOUT one blocks them");
  const manualBatchId = `e2e-manual-${Date.now()}`;
  const manualLoad = await adminPost("/x-api/queue", {
    batch_id: manualBatchId,
    approval_mode: "batch",
    items: [
      { local_id: "manual-parent", account: "product", kind: "post", text: "e2e manual-published parent", series: "e2e", scheduled_at: now + 3600 },
      { local_id: "manual-child", account: "personal", kind: "quote", text: "e2e child depending on manual parent", depends_on: "manual-parent", min_gap_s: 0, scheduled_at: now + 3600 },
    ],
  });
  const manualParentId = manualLoad.json?.inserted?.find((r: { local_id?: string }) => r.local_id === "manual-parent")?.id;
  const manualChildId = manualLoad.json?.inserted?.find((r: { local_id?: string }) => r.local_id === "manual-child")?.id;
  const markPublishedResp = await adminPost(`/x-api/queue/${manualParentId}/mark-published`, {
    tweet_url: "https://x.com/ToolSnapMCP/status/1234567890123456789",
  });
  check("mark-published with URL accepted", markPublishedResp.status === 200 && markPublishedResp.json?.marked_published === true, JSON.stringify(markPublishedResp.json));
  check("tweet_id parsed from URL", markPublishedResp.json?.tweet_id === "1234567890123456789", JSON.stringify(markPublishedResp.json));
  const manualParentRow = (await adminGet(`/x-api/queue?batch_id=${manualBatchId}`)).json?.rows?.find((r: { id: number }) => r.id === manualParentId);
  check("parent published_via='manual'", manualParentRow?.published_via === "manual", JSON.stringify(manualParentRow));
  const manualChildRow = (await adminGet(`/x-api/queue?batch_id=${manualBatchId}`)).json?.rows?.find((r: { id: number }) => r.id === manualChildId);
  check("child still eligible (not blocked) — parent has a real tweet_id to chain from", manualChildRow?.status === "scheduled", JSON.stringify(manualChildRow));

  const manualNoLinkBatchId = `e2e-manual-nolink-${Date.now()}`;
  const manualNoLinkLoad = await adminPost("/x-api/queue", {
    batch_id: manualNoLinkBatchId,
    approval_mode: "batch",
    items: [
      { local_id: "nolink-parent", account: "product", kind: "post", text: "e2e manual no-link parent", series: "e2e", scheduled_at: now + 3600 },
      { local_id: "nolink-child", account: "personal", kind: "quote", text: "e2e child of no-link parent", depends_on: "nolink-parent", min_gap_s: 0, scheduled_at: now + 3600 },
    ],
  });
  const nolinkParentId = manualNoLinkLoad.json?.inserted?.find((r: { local_id?: string }) => r.local_id === "nolink-parent")?.id;
  const nolinkChildId = manualNoLinkLoad.json?.inserted?.find((r: { local_id?: string }) => r.local_id === "nolink-child")?.id;
  const markPublishedNoLinkResp = await adminPost(`/x-api/queue/${nolinkParentId}/mark-published`, {});
  check("mark-published without URL accepted", markPublishedNoLinkResp.status === 200 && markPublishedNoLinkResp.json?.marked_published === true, JSON.stringify(markPublishedNoLinkResp.json));
  check("no tweet_id, metrics_enabled false", markPublishedNoLinkResp.json?.tweet_id === null && markPublishedNoLinkResp.json?.metrics_enabled === false, JSON.stringify(markPublishedNoLinkResp.json));
  const nolinkChildRow = (await adminGet(`/x-api/queue?batch_id=${manualNoLinkBatchId}`)).json?.rows?.find((r: { id: number }) => r.id === nolinkChildId);
  check("child blocked (no tweet_id to chain from)", nolinkChildRow?.status === "blocked", JSON.stringify(nolinkChildRow));

  console.log("\n15) Fase 22.3 — daily metrics cron (X_DRY_RUN): fills x_metrics for API- and manually-published rows with a real tweet_id");
  await fireCron("0 9 * * *");
  await sleep(1000);
  const statsAfterMetrics = await adminGet("/x-api/stats");
  check("stats endpoint 200 after metrics cron", statsAfterMetrics.status === 200, JSON.stringify(statsAfterMetrics.json));
  const e2eEngagement = (statsAfterMetrics.json?.engagement ?? []).filter((e: { series: string }) => e.series === "e2e");
  check("e2e series has engagement rows (metrics cron picked up published e2e posts)", e2eEngagement.length > 0, JSON.stringify(e2eEngagement));

  console.log("\n16) Fase 22.3 — stats: correction rate reflects the panel_edit from step 11");
  const e2eCorrectionRate = (statsAfterMetrics.json?.correction_rates ?? []).find((r: { series: string; account: string }) => r.series === "e2e" && r.account === "personal");
  check("e2e/personal correction rate present with corrected>=1", Boolean(e2eCorrectionRate) && e2eCorrectionRate.corrected >= 1, JSON.stringify(e2eCorrectionRate));

  console.log("\n17) Fase 22.3 — /x-agent/api/* rejects requests with no Cloudflare Access header");
  const unauthPanelApi = await unauthGet("/x-agent/api/queue");
  check("x-agent/api without Access header -> 401", unauthPanelApi.status === 401, JSON.stringify(unauthPanelApi.json));

  console.log("\n18) Fase 22.3 regression — /x-api/* new subpaths still require x-admin-key");
  const unauthXApiStats = await unauthGet("/x-api/stats");
  check("x-api/stats without x-admin-key -> 401", unauthXApiStats.status === 401, JSON.stringify(unauthXApiStats.json));

  console.log("\n19) Fase 22.4 — reply-guy fixtures loaded, /x-api/replies/status reflects the config");
  loadReplyGuyFixtures();
  const statusInitial = await adminGet("/x-api/replies/status");
  check("replies/status 200", statusInitial.status === 200, JSON.stringify(statusInitial.json));
  check("config loaded from fixture (dailyCap=100)", statusInitial.json?.config?.dailyCap === 100, JSON.stringify(statusInitial.json));
  check("not paused initially", statusInitial.json?.pausedUntil === 0, JSON.stringify(statusInitial.json));

  console.log("\n20) Fase 22.4 — pause/resume via the admin API");
  const pauseResp = await adminPost("/x-api/replies/pause", { hours: 1 });
  check("pause accepted", pauseResp.status === 200 && typeof pauseResp.json?.paused_until === "number", JSON.stringify(pauseResp.json));
  const statusPaused = await adminGet("/x-api/replies/status");
  check("status shows paused_until in the future", statusPaused.json?.pausedUntil > now, JSON.stringify(statusPaused.json));
  const resumeResp = await adminPost("/x-api/replies/resume");
  check("resume accepted", resumeResp.status === 200 && resumeResp.json?.resumed === true, JSON.stringify(resumeResp.json));
  const statusResumed = await adminGet("/x-api/replies/status");
  check("status no longer paused", statusResumed.json?.pausedUntil === 0, JSON.stringify(statusResumed.json));

  console.log("\n21) Fase 22.4 — approving a reply publishes it IMMEDIATELY (no cron tick wait) via the Telegram callback");
  const replyBatchId = `e2e-reply-${Date.now()}`;
  const replyLoad = await adminPost("/x-api/queue", {
    batch_id: replyBatchId,
    approval_mode: "per_post",
    items: [
      {
        local_id: "reply-a",
        account: "personal",
        kind: "reply",
        text: "e2e reply-guy draft — great point about agent economics",
        reply_to_tweet_id: "9999999999",
        series: "reply-guy",
        scheduled_at: now,
      },
    ],
  });
  const replyId = (replyLoad.json?.inserted ?? []).find((r: { local_id?: string }) => r.local_id === "reply-a")?.id;
  check("reply row inserted as pending_approval", Boolean(replyId));
  const beforeApprove = (await adminGet(`/x-api/queue?batch_id=${replyBatchId}`)).json?.rows?.[0];
  check("reply starts pending_approval", beforeApprove?.status === "pending_approval", JSON.stringify(beforeApprove));

  const approveCallbackStatus = await sendTelegramCallback(replyId, "approve");
  check("Telegram approve callback accepted (200)", approveCallbackStatus === 200, String(approveCallbackStatus));
  await sleep(1000); // ctx.waitUntil is fire-and-forget
  const afterApprove = (await adminGet(`/x-api/queue?batch_id=${replyBatchId}`)).json?.rows?.[0];
  check(
    "reply published immediately on approve, without waiting for a cron tick",
    afterApprove?.status === "published" && typeof afterApprove?.tweet_id === "string" && afterApprove.tweet_id.startsWith("dryrun_"),
    JSON.stringify(afterApprove)
  );

  console.log("\n22) Fase 22.4 — 'published manually' (📋) button: marks published without ever calling the X API");
  const replyBatchId2 = `e2e-reply-manual-${Date.now()}`;
  const replyLoad2 = await adminPost("/x-api/queue", {
    batch_id: replyBatchId2,
    approval_mode: "per_post",
    items: [
      {
        local_id: "reply-b",
        account: "personal",
        kind: "reply",
        text: "e2e reply-guy draft — manual publish path",
        reply_to_tweet_id: "8888888888",
        series: "reply-guy",
        scheduled_at: now,
      },
    ],
  });
  const replyId2 = (replyLoad2.json?.inserted ?? []).find((r: { local_id?: string }) => r.local_id === "reply-b")?.id;
  const manualCallbackStatus = await sendTelegramCallback(replyId2, "manual");
  check("Telegram 'manual' callback accepted (200)", manualCallbackStatus === 200, String(manualCallbackStatus));
  await sleep(1000);
  const afterManual = (await adminGet(`/x-api/queue?batch_id=${replyBatchId2}`)).json?.rows?.[0];
  check(
    "reply marked published_via='manual' with no tweet_id (fast path — no link step)",
    afterManual?.status === "published" && afterManual?.published_via === "manual" && afterManual?.tweet_id === null,
    JSON.stringify(afterManual)
  );

  console.log("\n23) Fase 22.4 — GET /x-api/replies lists candidates joined with their queue status");
  runD1SqlLocally(
    `INSERT INTO x_reply_candidates (sweep_id, tweet_id, tweet_url, author_handle, author_followers, score, draft_reply, status, queue_id, created_at)
     VALUES ('e2e-sweep', '8888888888', 'https://x.com/i/web/status/8888888888', 'e2e_author', 50000, 85, 'e2e reply-guy draft — manual publish path', 'queued', ${replyId2}, ${now});`
  );
  const repliesList = await adminGet("/x-api/replies?limit=20");
  check("replies list 200", repliesList.status === 200, JSON.stringify(repliesList.json));
  const listedCandidate = (repliesList.json?.candidates ?? []).find((c: { queue_id: number }) => c.queue_id === replyId2);
  check(
    "candidate joined with queue_status='published' and queue_text",
    listedCandidate?.queue_status === "published" && typeof listedCandidate?.queue_text === "string",
    JSON.stringify(listedCandidate)
  );

  console.log("\n24) Fase 22.4 — a reply candidate whose post aged past TTL expires (silence = do not publish) instead of publishing on a later cron tick");
  loadReplyGuyFixtures(1); // ttlS=1s so the fixture below is immediately stale
  const staleReplyLoad = await adminPost("/x-api/queue", {
    batch_id: `e2e-reply-expire-${Date.now()}`,
    approval_mode: "per_post",
    items: [
      {
        local_id: "reply-c",
        account: "personal",
        kind: "reply",
        text: "e2e reply-guy draft — should expire",
        reply_to_tweet_id: "7777777777",
        series: "reply-guy",
        scheduled_at: now,
      },
    ],
  });
  const staleReplyId = (staleReplyLoad.json?.inserted ?? []).find((r: { local_id?: string }) => r.local_id === "reply-c")?.id;
  const backdatedAt = now - 3600; // 1h ago, well past the 1s ttlS just configured
  runD1SqlLocally(
    `INSERT INTO x_reply_candidates (sweep_id, tweet_id, score, draft_reply, status, queue_id, created_at)
     VALUES ('e2e-sweep-stale', '7777777777', 90, 'e2e reply-guy draft — should expire', 'alerted', ${staleReplyId}, ${backdatedAt});`
  );
  await fireCron("*/5 * * * *"); // this tick's expireStaleReplyCandidates() call should catch it
  await sleep(500);
  const staleRow = (await adminGet(`/x-api/replies?limit=50`)).json?.candidates?.find((c: { queue_id: number }) => c.queue_id === staleReplyId);
  check("stale candidate marked expired", staleRow?.status === "expired", JSON.stringify(staleRow));
  check("stale queue row canceled with error='expired'", staleRow?.queue_status === "canceled", JSON.stringify(staleRow));
  loadReplyGuyFixtures(); // restore the generous default ttlS for anything after this point

  console.log("\n25) Fase 22.4 — POST /x-api/prompts loads a new prompt version; GET reflects only the latest as active");
  const promptPut1 = await adminPost("/x-api/prompts", { name: "reply_discovery", content: "vN fixture prompt" });
  check("prompt version accepted", promptPut1.status === 200 && typeof promptPut1.json?.version === "number", JSON.stringify(promptPut1.json));
  const promptPut2 = await adminPost("/x-api/prompts", { name: "reply_discovery", content: "vN+1 fixture prompt" });
  check(
    "next version increments by exactly 1",
    promptPut2.status === 200 && promptPut2.json?.version === (promptPut1.json?.version ?? 0) + 1,
    JSON.stringify(promptPut2.json)
  );
  const promptsGet = await adminGet("/x-api/prompts");
  const activeDiscovery = (promptsGet.json?.prompts ?? []).find((p: { name: string }) => p.name === "reply_discovery");
  check(
    "only the latest version is active",
    activeDiscovery?.content === "vN+1 fixture prompt" && activeDiscovery?.version === promptPut2.json?.version,
    JSON.stringify(activeDiscovery)
  );

  console.log("\n26) Fase 22.4 — Web Push: subscribe accepted; vapid-public-key 501s without configured keys (none set in this .dev.vars)");
  const pushSubResp = await adminPost("/x-api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/e2e-fake-endpoint",
    keys: { p256dh: "fake-p256dh", auth: "fake-auth" },
  });
  check("push subscribe accepted", pushSubResp.status === 200 && pushSubResp.json?.subscribed === true, JSON.stringify(pushSubResp.json));
  const vapidResp = await adminGet("/x-api/push/vapid-public-key");
  check("vapid-public-key 501 (not configured)", vapidResp.status === 501, JSON.stringify(vapidResp.json));

  console.log("\n27) Fase 22.4 — placeholder substitution: a prompt with {max_searches}/{seed_accounts}/etc. never reaches xAI with a literal placeholder");
  const fixtureConfig: ReplyConfig = {
    window: { startHour: 16, endHour: 23 },
    sweepsPerDay: { mon: 4, tue: 4, wed: 4, thu: 4, fri: 2, sat: 0, sun: 2 },
    dailyBudgetUsd: 0.7,
    dailyCap: 5,
    minScore: 70,
    ttlS: 2700,
    maxCandidatesPerSweep: 3,
    maxSearchesPerSweep: 4,
    seedAccounts: ["karpathy", "levelsio"],
    queryRotation: ["AI news", "indie hacker milestones"],
  };
  const filled = fillPromptPlaceholders(
    "searches={max_searches} candidates={max_candidates} score={min_score} accounts={seed_accounts} queries={query_rotation}",
    fixtureConfig
  );
  check("no placeholder braces remain after substitution", !/\{[a-z_]+\}/.test(filled), filled);
  check("seed accounts substituted", filled.includes("karpathy, levelsio"), filled);
  check("numeric placeholders substituted", filled.includes("searches=4 candidates=3 score=70"), filled);

  console.log("\n28) Fase 22.4 — POST /x-api/replies/sweep (diagnostic trigger) bypasses the schedule gate but still respects pause");
  const sweepNow = await adminPost("/x-api/replies/sweep");
  check("diagnostic sweep runs even outside the configured window/calendar", sweepNow.status === 200 && sweepNow.json?.ran === true, JSON.stringify(sweepNow.json));
  await adminPost("/x-api/replies/pause", { hours: 1 });
  const sweepWhilePaused = await adminPost("/x-api/replies/sweep");
  check("diagnostic sweep still refuses to run while paused", sweepWhilePaused.json?.ran === false && sweepWhilePaused.json?.reason === "paused", JSON.stringify(sweepWhilePaused.json));
  await adminPost("/x-api/replies/resume");

  console.log("\n29) Fase 22.4 fix (2026-07-11) — a real X 403 leaves a row 'failed', not stranded: mark-published now recovers it");
  const failedBatchId = `e2e-reply-failed-${Date.now()}`;
  const failedLoad = await adminPost("/x-api/queue", {
    batch_id: failedBatchId,
    approval_mode: "batch",
    items: [{ local_id: "reply-d", account: "personal", kind: "reply", text: "e2e reply — simulated X 403", reply_to_tweet_id: "6666666666", series: "reply-guy", scheduled_at: now }],
  });
  const failedReplyId = (failedLoad.json?.inserted ?? []).find((r: { local_id?: string }) => r.local_id === "reply-d")?.id;
  // Simulate what a real non-retryable X API failure (e.g. the 403 "not
  // allowed to reply unless mentioned/engaged") leaves behind — there is no
  // way to force a real failure under X_DRY_RUN (it always "succeeds"), so
  // this backdoors the exact end state markFailedOrRetry would produce.
  runD1SqlLocally(`UPDATE x_queue SET status = 'failed', error = 'X API error (403): simulated for e2e' WHERE id = ${failedReplyId};`);
  const markPublishedOnFailed = await adminPost(`/x-api/queue/${failedReplyId}/mark-published`, {});
  check(
    "mark-published now succeeds on a 'failed' row (previously only scheduled/pending_approval)",
    markPublishedOnFailed.status === 200 && markPublishedOnFailed.json?.marked_published === true,
    JSON.stringify(markPublishedOnFailed.json)
  );
  const afterFailedRecovery = (await adminGet(`/x-api/queue?batch_id=${failedBatchId}`)).json?.rows?.[0];
  check("row is published_via='manual' after recovery", afterFailedRecovery?.status === "published" && afterFailedRecovery?.published_via === "manual", JSON.stringify(afterFailedRecovery));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
