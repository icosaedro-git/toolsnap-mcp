# ToolSnap X Agent — content queue API contract

Cloudflare-native publishing agent for X (Twitter): a D1-backed content queue,
a cron publisher, a dedicated Telegram bot for human approval/veto, and a
private web panel (`/x-agent`, behind Cloudflare Access) for viewing and
acting on the queue from a browser. This document is the **stable contract**
for the batch JSON format used to load content — written so a planning
session can load a week of posts without reading the implementation.

Endpoints, gated by the same `x-admin-key` header pattern used across the
admin surface (`ADMIN_API_KEY` secret). Deliberately **outside** `/admin/*`
— see the routing note below.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/x-api/queue` | Load a batch (weekly planning session, or a single ad-hoc post) — items may include `media_keys` (Fase 22.3) |
| `GET` | `/x-api/queue` | Inspect current queue state (filters: `status`, `account`, `batch_id`, `series`, `from`, `to`, `limit`) |
| `POST` | `/x-api/queue/:id/approve` | Approve a `pending_approval` row |
| `POST` | `/x-api/queue/:id/reject` | Reject a `pending_approval` row |
| `POST` | `/x-api/queue/:id/cancel` | Cancel/veto a `scheduled` or `pending_approval` row |
| `POST` | `/x-api/queue/:id/edit` | Edit a row's text (`{ "text": "..." }`) — in place if `scheduled`, auto-approves if `pending_approval` |
| `POST` | `/x-api/queue/:id/reschedule` | Change `scheduled_at` (`{ "scheduled_at": <epoch> }`); resets the veto notice so it re-fires against the new time |
| `POST` | `/x-api/queue/:id/publish-now` | Fast-track to the next publisher tick (auto-approves if `pending_approval`) |
| `POST` | `/x-api/queue/:id/mark-published` | Mark published outside the agent (`{ "tweet_url"?: "..." }`) — see below |
| `POST` | `/x-api/media` | Upload one image (raw bytes, `Content-Type: image/*`, ≤5MB) → `{ media_key }` for use in `media_keys` |
| `GET` | `/x-api/stats` | Correction rate and engagement by series/account |
| `POST` | `/x-api/corrections` | Backfill a correction made outside the running system (`source: "vault_review"`) |
| `POST` | `/x-api/telegram/setup-webhook` | (Re-)register the Telegram webhook and the bot's command menu (`/status`, `/pause`, `/stop`, `/resume`) — one-time/diagnostic |
| `GET` | `/x-api/telegram/webhook-info` | Current webhook registration state |

Reply-guy (Fase 22.4) — discovery, scoring and drafting of replies to
external posts. This machinery is generic; the actual discovery/scoring/
drafting prompt and its parameters are loaded from `x_prompts` (not present
in this repo — see the operational notes below) rather than hardcoded here.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/x-api/replies` | Recent reply candidates, joined with their queue row's current status/text (`limit`, default 50) |
| `GET` | `/x-api/replies/status` | Pause state, today's counters (sweeps/replies/spend), the active config, plus a computed `today` (state, sweeps done/target, window, earliest possible next sweep) and `week` (sweeps/day, Monday-first) for the panel/Telegram overview |
| `POST` | `/x-api/replies/pause` | Pause discovery (`{ "hours"?: number, "until"?: <epoch> }`, default 2h; `{ "forever": true }` for an indefinite pause — same as the `/stop` Telegram command) — does not affect the rest of the queue |
| `POST` | `/x-api/replies/resume` | Resume discovery (clears both a timed pause and an indefinite one) |
| `GET` | `/x-api/push/vapid-public-key` | VAPID public key for the panel's `PushManager.subscribe()` call (501 if Web Push isn't configured) |
| `POST` | `/x-api/push/subscribe` | Register a browser's push subscription (`PushSubscriptionJSON` body) |
| `POST` | `/x-api/prompts` | Load/replace the active `reply_discovery` prompt or `reply_config` JSON (`{ "name": "reply_discovery"\|"reply_config", "content": "..." }`) — the only way this content enters D1, see below |
| `GET` | `/x-api/prompts` | Currently-active prompt/config rows |
| `POST` | `/x-api/replies/sweep` | Diagnostic: run one discovery sweep right now, bypassing the window/calendar/min-gap schedule gate (pause/budget/cap stay enforced) |

A discovered candidate is queued as an ordinary `x_queue` row
(`kind='reply'`, `approval_mode='per_post'`) — every existing action
(`approve`/`reject`/`edit`/`mark-published`) works on it unchanged. Approving
a `kind='reply'` row publishes it immediately (does not wait for the next
cron tick) since timing matters for a reply in a way it doesn't for a
scheduled post; *editing* one does NOT auto-publish (UX fix 2026-07-11) — it
corrects the draft and hands the decision back, since the primary path is
manual and the X API can legitimately 403 a restricted conversation.

The Telegram alert for a candidate is two messages, not one: a code-block
message with only the draft (Telegram copies a full code block with a
single tap — no long-press/select needed, and the draft always
renders/copies byte-for-byte regardless of characters that would otherwise
need Markdown-escaping) followed by a metadata message (author/score/a link
button to the original post) with the decision keyboard — Approve via API,
"published manually" (marks the row published without ever calling the X
API, the same "publish it yourself, tell the system after" path the panel's
`mark-published` already supports, at zero X API cost), Edit, Reject. A
failed API publish attempt keeps the same manual-publish path available on
the failure notice itself, so a real X rejection (a legitimate, non-bug 403
on a restricted conversation) never strands the row.

The same handlers are also mounted at `/x-agent/api/*` behind a Cloudflare
Access application (the interactive panel at `/x-agent`) — see the routing
note below for why there are two mounts instead of one.

**"Publish now" vs. "mark published"** (Fase 22.3, panel-only actions):
`publish-now` still goes through the X API on the next cron tick — same
publish path, just skipping the wait. `mark-published` is for when a post
was published by hand outside the agent entirely: it flips the row straight
to `published` without ever calling the X API. Passing `tweet_url` lets the
row participate in metrics and in any `depends_on` chaining exactly like an
API-published row; omitting it leaves `tweet_id` null (no metrics) and
immediately blocks any dependent rows, the same as a cancel/reject/failure.

**Routing note:** `mcp.toolsnap.app` has a Cloudflare Access application
covering `/admin*` (added for the blog CMS). Access intercepts requests at
the edge before the Worker ever sees them, so a headless client presenting
`x-admin-key` would get a 302 to an SSO login page instead of a JSON
response. Any new headless (key/token-auth) route must live outside
`/admin*` for this reason — `/x-api/*` and `/reports/*` follow this rule.
Browser-facing routes that *do* want Access must NOT share a prefix with a
headless route, or Access will swallow the API too — the Fase 22.3 panel
lives at `/x-agent` + `/x-agent/api/*` (its own Access application) for
exactly this reason, separate from `/x-api/*`.

## `POST /x-api/queue` — batch schema

```ts
interface BatchInput {
  batch_id?: string;            // default: "batch-YYYY-MM-DD-xxxxxxxx"
  approval_mode?: ApprovalMode; // default for items that don't override
  items: BatchItem[];           // 1-100 per request
}

interface BatchItem {
  local_id?: string;             // batch-local id, for depends_on cross-references
  account: "product" | "personal"; // "product" = @ToolSnapMCP, "personal" = @icosaedro_one
  kind?: "post" | "quote" | "reply" | "thread_part" | "repost"; // default "post"
  text?: string;                 // required unless kind === "repost"
  depends_on?: string;           // a sibling item's local_id, OR an existing numeric queue id (as a string)
  min_gap_s?: number;            // min wait after the parent publishes (default 3600)
  quote_tweet_id?: string;       // quoting an EXTERNAL tweet directly (not a queue row)
  reply_to_tweet_id?: string;    // replying to an EXTERNAL tweet directly
  series?: string;                // e.g. "tool-spotlight", "recipe-thread", "build-in-public"
  scheduled_at: number;           // epoch seconds — required
  approval_mode?: ApprovalMode;   // per-item override of the batch default
  media_keys?: string[];          // Fase 22.3 — R2 keys from POST /x-api/media, prefix "x-media/", max 4
}

type ApprovalMode = "per_post" | "batch" | "veto";
// "auto" (L3, full autonomy) exists in the state machine but is never
// accepted at creation time — it's a ladder promotion applied later, and
// currently unused (see vault nota 13).
```

**Rules enforced on load:**
- `items` must be non-empty, max 100.
- `text` required for every `kind` except `repost` (a pure retweet has no text).
- `scheduled_at` must be a positive epoch-seconds integer.
- `depends_on` must resolve to either a `local_id` present in the same batch,
  or an existing numeric queue row id (validated as `/^\d+$/`) — anything
  else is rejected with 400 before any row is inserted (two-pass: validate
  everything, then insert, then resolve `depends_on` once every row has a
  real DB id).

## Approval modes (what happens on load)

| Mode | Status on insert | What triggers publication |
|---|---|---|
| `per_post` (**L0**) | `pending_approval` | A Telegram approval card is sent immediately; publishes only after a human taps ✅ Aprobar (or edits, which auto-approves) |
| `batch` (**L1**) | `scheduled` | No card — this row was already reviewed and approved in the planning session that produced the batch. Publishes as soon as it's due. |
| `veto` (**L2**) | `scheduled` | No card at load time. The publisher cron sends a cancel-window Telegram notice ("🚫 Cancelar" button) `X_VETO_NOTICE_S` seconds before `scheduled_at` (default 4h; skipped during Madrid quiet hours 00:00–12:00, retried on the next tick). The row can only publish once the notice has been sent **and** at least `X_VETO_MIN_S` (default 30min) has passed since — silence is consent. |

`auto` (**L3**, full autonomy, no notice at all) exists in the type but is
rejected at creation — never set it in a batch. See vault nota 13 for the
autonomy-ladder promotion policy (which mode a series/account graduates to,
and why replies never reach L3).

## State machine

```
draft -> pending_approval -> scheduled -> publishing -> published
                           \-> rejected            \-> failed (retry, max 3)
scheduled -> canceled (vetoed via Telegram or POST /x-api/queue/:id/cancel)
```

A `published` row's `published_via` column records how it got there: `api`
(the normal publisher cron path) or `manual` (Fase 22.3 — marked published
via `POST .../mark-published` after being posted by hand, outside the
agent).

A row whose `depends_on` parent ends in `failed`/`rejected`/`canceled` is
automatically marked `blocked` (its children can never publish orphaned).

## Internal chaining (quote/reply/thread)

Use `depends_on` + `min_gap_s` instead of an external `quote_tweet_id` /
`reply_to_tweet_id` when the target is *another row in the same system* —
the publisher resolves the parent's real `tweet_id` once it has actually
published, and only considers the child due once
`parent.published_at + min_gap_s <= now`. A `repost` row's target is either
an external `quote_tweet_id` or, via `depends_on`, an internal parent's
`tweet_id`.

## Example: a week with a cross-account quote

```json
{
  "batch_id": "batch-2026-07-13-week29",
  "approval_mode": "batch",
  "items": [
    {
      "local_id": "mon-product",
      "account": "product",
      "series": "tool-spotlight",
      "text": "fetch_extract turns a 50k-token page into ~2k tokens of exactly what you asked for. No link, no login, just the answer.",
      "scheduled_at": 1783958400
    },
    {
      "local_id": "mon-personal-quote",
      "account": "personal",
      "kind": "quote",
      "depends_on": "mon-product",
      "min_gap_s": 3600,
      "text": "Been dogfooding this one daily — the token math on long docs is not subtle.",
      "scheduled_at": 1783958400
    },
    {
      "local_id": "wed-veto-post",
      "account": "product",
      "series": "recipe-thread",
      "approval_mode": "veto",
      "text": "How we migrated a WordPress site to static in one afternoon, with the receipts: https://mcp.toolsnap.app/blog/replicate-website-case-study",
      "scheduled_at": 1784131200
    }
  ]
}
```

`mon-personal-quote` will only become eligible once `mon-product` has
actually published (its `tweet_id` becomes the quote target automatically).
`wed-veto-post` is the one item in this batch loaded as **L2** — it publishes
on its own once its cancel window closes, unless vetoed from Telegram first.

## Operational notes

- `X_DRY_RUN=1` (local/e2e only) makes the publisher log instead of calling
  the real X API, returning a `dryrun_...` fake tweet id.
- Failed publishes retry up to 3 times (5-minute cron interval) before
  moving to `failed` and blocking children; retryability is based on the X
  API response (429/5xx retryable, other 4xx are not).
- X API is pay-per-use since 2026-02-06: **$0.015/post**, **$0.20/post if it
  contains a link** (posts read: $0.005 each, capped at 2M reads/month, no
  monthly minimum). This is why series policy (vault nota 13) restricts
  links to 2–3 high-intent posts per week rather than every post.
- Reply-guy (Fase 22.4) has no strategy in this repo: the discovery/scoring/
  drafting prompt is a row in `x_prompts` (`name='reply_discovery'`), and its
  tunables (active window, per-weekday sweep count, daily budget/cap, score
  threshold, candidate TTL, seed accounts, query rotation) are a JSON row
  (`name='reply_config'`). Neither is inserted by any migration or seeded by
  any script — without a prompt loaded, the discovery sweep is a documented
  no-op (`{ ran: false, reason: "no reply_discovery prompt loaded in
  x_prompts" }`), never a hardcoded fallback (config falls back to safe P1
  defaults if no `reply_config` row exists, since those numbers are pure
  rate-limiting, not strategy). The prompt text may contain
  `{max_searches}`/`{max_candidates}`/`{min_score}`/`{seed_accounts}`/
  `{query_rotation}` placeholders — `discovery.ts` fills them from the active
  config before every call, so the prompt document itself never hardcodes
  numbers that belong in config. Discovery calls the xAI Responses API
  (`x_search` tool) — `src/x-agent/xai.ts` parses the response defensively
  and is written to fail loudly (not silently misparse) if xAI's actual
  response shape differs from what its public docs describe; the first real
  sweep against production (`POST /x-api/replies/sweep`) is the real
  verification of that parsing.
- Telegram control commands (`/status`, `/pause [2h|hoy]`, `/stop`,
  `/resume`) are registered with Telegram's command menu (`setMyCommands`,
  called alongside `setWebhook` by `POST /x-api/telegram/setup-webhook`) so
  they're discoverable from the "/" button instead of needing to be
  remembered. `/status` also carries a contextual inline keyboard — only the
  action(s) that make sense for the current pause state (resume when
  paused/stopped; pause/stop when active) — and tapping one edits the same
  message in place with the new state, so `/status` doubles as a live
  mini-panel. Both `/status` and the panel's Replies tab show a daily plan
  (sweeps done/target, active window, earliest possible next sweep) and a
  Monday-first weekly overview (sweeps/day, including the days a 0 by
  design) — computed from existing config/state (`discovery.ts`'s
  `getDiscoveryStatus`), no new state. Sweeps never have fixed times (only a
  minimum gap enforced by `shouldRunSweep`), so "earliest possible next
  sweep" is exactly that — never an invented schedule.
- Web Push notifications are a "tickle" with no payload: the push wakes the
  service worker (`GET /x-agent-sw.js`), which fetches
  `GET /x-agent/api/replies/pending` same-origin (the Access session cookie
  travels with it) to build the notification from real data. This sidesteps
  payload encryption (RFC 8291) entirely — only a VAPID-signed
  `Authorization` header is needed. Not configured (no `VAPID_PUBLIC_KEY`/
  `VAPID_PRIVATE_KEY` secrets) → `/x-api/push/vapid-public-key` returns 501
  and the panel's notification button surfaces that instead of failing silently.
