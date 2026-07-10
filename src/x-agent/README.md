# ToolSnap X Agent — content queue API contract

Cloudflare-native publishing agent for X (Twitter): a D1-backed content queue,
a cron publisher, and a dedicated Telegram bot for human approval/veto. This
document is the **stable contract** for the batch JSON format used to load
content — written so a planning session can load a week of posts without
reading the implementation.

Endpoints, gated by the same `x-admin-key` header pattern used across the
admin surface (`ADMIN_API_KEY` secret). Deliberately **outside** `/admin/*`
— see the routing note below.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/x-api/queue` | Load a batch (weekly planning session, or a single ad-hoc post) |
| `GET` | `/x-api/queue` | Inspect current queue state (filters: `status`, `account`, `batch_id`, `limit`) |
| `POST` | `/x-api/queue/:id/cancel` | Cancel/veto a `scheduled` or `pending_approval` row |
| `POST` | `/x-api/telegram/setup-webhook` | (Re-)register the Telegram webhook — one-time/diagnostic |
| `GET` | `/x-api/telegram/webhook-info` | Current webhook registration state |

**Routing note:** `mcp.toolsnap.app` has a Cloudflare Access application
covering `/admin*` (added for the blog CMS). Access intercepts requests at
the edge before the Worker ever sees them, so a headless client presenting
`x-admin-key` would get a 302 to an SSO login page instead of a JSON
response. Any new headless (key/token-auth) route must live outside
`/admin*` for this reason — `/x-api/*` and `/reports/*` follow this rule.
Browser-facing routes that *do* want Access (like a future panel) must NOT
share a prefix with a headless route, or Access will swallow the API too.

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
