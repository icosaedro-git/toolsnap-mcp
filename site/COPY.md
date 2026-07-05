# ToolSnap MCP — Website copy (final, EN)

> Source of truth for all human-facing copy on mcp.toolsnap.app. Written by Fable 5 (Fase 21.1, 2026-07-05).
> Rules for the builder: use this text VERBATIM (including punctuation and casing). Anything marked `{{…}}` is dynamic — pull it from code (`src/tools/catalog.ts`, `src/tools/pricing.ts`, `src/recipes.ts`) at build time. Do not invent copy; if something is missing, leave a TODO and flag it.

---

## Global

**Site name:** ToolSnap MCP
**Tagline (brand, use exactly):** One connection. Superpowers for your agent.
**Default meta description:** ToolSnap MCP gives any AI agent 38 server-side tools through one MCP connection. 35 free. No new accounts. Median 98.1% context savings on web content.

**Nav (header):** Tools · Recipes · Pricing · Docs · Blog — CTA button: `Connect free`
(`Connect free` scrolls to / links to the How-to-connect section on the landing: `/#connect`.)

**Footer columns:**
- Product: Tools · Recipes · Pricing · Docs · Wallet guide · Blog
- Endpoint: `https://mcp.toolsnap.app/mcp` (copy button) · Server card (`/.well-known/mcp.json`) · Pricing JSON (`/.well-known/pricing.json`)
- Legal: Terms · Privacy · Refunds
- Contact: support@toolsnap.app · X: @ToolSnapMCP · @icosaedro_one

**Footer line:** © {{year}} Icosaedro Music & Human Development LLC · ToolSnap MCP — One connection. Superpowers for your agent.

---

## Page: `/` (Landing)

**Meta title:** ToolSnap MCP — One connection. Superpowers for your agent.
**Meta description:** 38 server-side tools for AI agents through a single MCP connection. 35 free, no new accounts. Median 98.1% token savings on web content. Paid tools from $0.02.

### Hero

- Eyebrow (small, mono, above H1): `MCP SERVER · 38 TOOLS · LIVE`
- H1: `One connection.` (line 1, off-white) `Superpowers for your agent.` (line 2, "Superpowers" in lime)
- Subhead: `ToolSnap gives any MCP-capable agent 38 server-side tools — web extraction, SEO, documents, data, images. 35 are free. Zero new accounts. Your agent's context window stays clean, and your bill stays small.`
- Primary CTA: `Connect in 30 seconds` → `#connect`
- Secondary CTA (ghost): `Browse the tools` → `/tools`
- Hero stat strip (3 items, mono numbers):
  - `98.1%` — `median token savings on web content`
  - `35 / 38` — `tools free to call`
  - `$0` — `accounts, subscriptions or sign-ups required`
- Micro-caption under stat strip: `Benchmark: fetch_extract turns a 53,820-token page into 2,001 tokens. That's ~$0.156 saved on a single Sonnet call — more than most paid tools here cost.`

### Section: The problem (context is the bill)

- Eyebrow: `WHY IT EXISTS`
- H2: `Your agent's most expensive resource isn't compute. It's context.`
- Body: `Every raw webpage, PDF or CSV your agent loads gets re-sent with every turn of the conversation. That's how a "quick look at a URL" quietly becomes the biggest line on your API bill. ToolSnap tools work by reference: the server fetches, parses and filters the heavy data, and returns only the small, clean result. The raw input never touches your agent's context window.`
- 3 mini-cards (icon + title + one-liner):
  1. `By reference, not by value` — `Point a tool at a URL or file. It returns the answer, not the payload.`
  2. `Deterministic results` — `Parsers, not vibes: same input, same output, every time.`
  3. `Server-side muscle` — `Headless rendering, ML models and heavy parsing your agent's sandbox doesn't have.`

### Section: How to connect (`#connect`)

- Eyebrow: `GET STARTED`
- H2: `Connect in 30 seconds. Pay only if you want the paid three.`
- Intro: `One URL. No API key needed for the 35 free tools.`

**Tab 1 — Free (default):** label `Free — just the URL`
```bash
claude mcp add --transport http toolsnap https://mcp.toolsnap.app/mcp
```
Sub-tabs for other clients (same panel, small switcher): Claude Code (above) · Claude Desktop / claude.ai (`Add a custom connector with URL https://mcp.toolsnap.app/mcp`) · Cursor / generic JSON:
```json
{ "mcpServers": { "toolsnap": { "url": "https://mcp.toolsnap.app/mcp" } } }
```
Caption: `That's it. Your agent now has {{free_count}} free tools. Ask it to call tool_catalog to see everything.`

**Tab 2 — Paid tools:** label `Paid — credits or crypto`
Copy: `Three tools have real per-call costs (screenshots, keyword data, background removal). Pay per call from $0.02 — two rails, pick one:`
- Card A: `Card → credits (no crypto)` — `Buy credits with a card ($5 minimum), get an API key, done.`
```bash
claude mcp add --transport http toolsnap https://mcp.toolsnap.app/mcp --header "Authorization: Bearer sk_live_…"
```
  Link: `Get credits →` → `/checkout` · Note: `Clients that can't set headers can embed the key in the URL: https://mcp.toolsnap.app/mcp/sk_live_…`
- Card B: `Crypto (x402) — agent pays autonomously` — `Give your agent its own wallet with a few USDC on Base. It pays per call, no account at all.`
  Link: `Wallet guide →` → `/wallet-guide`

### Section: Tools overview

- Eyebrow: `THE CATALOG`
- H2: `38 tools. One list your agent actually reads.`
- Intro: `Your agent sees a curated core of 18 tools on first connection (~1.6k tokens — most MCP servers burn 10× that). The full catalog is one tool_catalog call away.`
- Family grid: {{families from catalog.ts — name, blurb, tool count, free/paid badge}}. Use these family blurbs verbatim:
  - Web fetch & extract: `Clean text, HTML, metadata or Markdown from any URL — without loading the page into context.`
  - SEO & crawling: `Sitemaps, feeds, links, redirects and keyword data for audits and migrations.`
  - Data & text: `Query CSV and JSON by reference, extract tables, diff, count tokens.`
  - Documents: `Pull text out of PDFs without ever opening them in context.`
  - Images: `Screenshots and ML background removal — results come back as URLs, not bytes.`
  - Utilities: `The small stuff agents reach for constantly, deterministic and free.`
  - Payments & account: `Balance, deposits, pricing — the money plumbing, all free to call.`
  - Recipes & meta: `tool_catalog, use_tool, task_recipes — discovery and dispatch.`
- CTA: `See all 38 tools with prices →` → `/tools`

### Section: Recipes

- Eyebrow: `RECIPES`
- H2: `Don't orchestrate. Hand your agent a recipe.`
- Intro: `A recipe is a ready-made multi-tool plan your agent can execute end-to-end: which tools, in what order, with cost estimates. Served by the free task_recipes tool — or copy the prompt from here.`
- Recipe cards: {{from recipes.ts — title, summary, tools used, est_cost}} + `Copy prompt` button.
- CTA: `Browse recipes →` → `/recipes`

### Section: Pricing summary

- Eyebrow: `PRICING`
- H2: `Free is the product. Paid is the exception.`
- Three columns:
  1. `Free` / big `$0` / `35 tools, unlimited calls. No account, no key, no catch — free tools are how ToolSnap becomes your agent's habit.`
  2. `Credits` / big `from $5` / `Card checkout via Polar. Credits never expire. Paid tools cost $0.02–$0.025 per call on credits.`
  3. `Pay-per-call (x402)` / big `from $0.02` / `USDC on Base, settled on-chain per call. No account — your agent pays autonomously.`
- CTA: `Full pricing →` → `/pricing`

### Section: Trust / security strip

- H2: `Built like infrastructure, not a demo.`
- 4 bullets:
  - `We never see private keys. Agent wallets are generated and stored on your machine — we only ever receive signatures.`
  - `Card payments are handled by Polar (Merchant of Record). Card data never touches our servers.`
  - `API keys are stored hashed, shown once, revocable any time.`
  - `Every tool is deterministic and stateless: we process your URLs and inputs, return the result, and keep only usage metadata.`

### Final CTA band

- H2: `Give your agent superpowers today.`
- Sub: `One URL. 35 free tools. Your context window will thank you.`
- Code line (copyable): `https://mcp.toolsnap.app/mcp`
- Button: `Connect free` → `#connect`

---

## Page: `/tools`

**Meta title:** All 38 tools — ToolSnap MCP
**Meta description:** The full ToolSnap MCP catalog: 35 free tools and 3 paid ones, with per-call prices. Web extraction, SEO, data, documents, images, utilities.

- H1: `The catalog`
- Intro: `Everything below is callable the moment you connect — no key needed for free tools. Prices shown are pay-per-call / with credits. Data on this page is generated from the live registry, the same one your agent reads.`
- Layout: grouped by family {{from catalog.ts FAMILIES}}; each tool row: name (mono), one-line description, badge `FREE` (lime) or price `$0.04 / $0.025` (mono).
- Callout box (after Images family): `Why are only three tools paid? Because only three have real per-call costs on our side (headless rendering, keyword data, ML inference). Everything we can serve for near-zero cost, we serve free.`
- Footer note: `Machine-readable version: /.well-known/pricing.json`

---

## Page: `/recipes`

**Meta title:** Recipes — ready-made agent workflows | ToolSnap MCP
**Meta description:** Copy-paste prompts that make your agent execute complete jobs — site migration, SEO audits — using ToolSnap tools, with cost estimates.

- H1: `Recipes`
- Intro: `A recipe is a complete job, pre-planned: the prompt tells your agent which ToolSnap tools to use, in what order, and what it will cost. Paste it, add your URL, walk away. Your agent can also fetch these itself with the free task_recipes tool.`
- Per recipe {{from recipes.ts}}: title, summary, `Audience:` line, tool chips (free/paid badges), `Estimated cost:` line, collapsible `<details>` with the full prompt + `Copy prompt` button.
- Closing note: `More recipes are coming — each one battle-tested on real work before it ships. Suggest one: support@toolsnap.app.`

---

## Page: `/pricing`

**Meta title:** Pricing — ToolSnap MCP
**Meta description:** 35 free tools. 3 paid tools from $0.02 per call. Pay with card credits (Polar) or USDC on Base (x402). No subscriptions, no expiry.

- H1: `Pricing`
- Lead: `No subscriptions. No seats. No expiry. You pay per call, only for the three tools that cost us real money to run.`

### Free tier
- H2: `Free — 35 tools, no limits that matter`
- Body: `The free tier isn't a trial, it's the product. Web extraction, SEO parsing, data queries, PDF text, utilities — all free, no account, no key. We keep it free because an agent that saves context with ToolSnap every day is worth more to us than a toll booth.`

### Paid tools table
- H2: `The paid three`
- Table {{from pricing data}}: tool · what it does · pay-per-call · with credits
  - `screenshot_url` · `Full-page or viewport screenshots, returned as a URL` · `$0.04` · `$0.025`
  - `keyword_research` · `Search volume, CPC and competition from Google Ads data` · `$0.04` · `$0.025`
  - `remove_background` · `ML background removal, returns a hosted PNG` · `$0.03` · `$0.02`
- Note: `Credits prices are ~35% cheaper because settlement is off-chain (we skip per-call gas).`

### Rails comparison
- H2: `Two ways to pay`
- Table: rows → Setup, Best for, Minimum, How it settles
  - `Credits (card)`: `2 minutes: checkout → API key` · `Humans who don't want crypto` · `$5` · `Deducted from your balance per call`
  - `x402 (USDC on Base)`: `Give your agent a wallet (guide takes ~3 min)` · `Autonomous agents, no account at all` · `$0.50 deposit for prepaid, or none for pay-per-call` · `Signed by your agent, settled on-chain`
- CTAs: `Buy credits →` `/checkout` · `Wallet guide →` `/wallet-guide`
- FAQ (3 items):
  - `Do credits expire?` → `No. They stay on your balance until you spend them.`
  - `Are credits refundable?` → `As a rule, no — see the refund policy for the two exceptions (purchase errors and tool failures reported within 14 days).`
  - `Is there a free trial of paid tools?` → `The three paid tools have real per-call costs, so every call settles. At $0.02–$0.04 a call, the trial is the price.`

---

## Page: `/docs`

**Meta title:** Docs — connect, pay, build | ToolSnap MCP
**Meta description:** Technical reference: connecting from Claude Code, Claude Desktop, claude.ai and Cursor; API keys; x402 payments; prepaid balance; pay-proxy.

- H1: `Docs`
- Intro: `Everything you need to wire ToolSnap into any MCP client, and to understand exactly how payment works when you use the paid three.`

### 1. Endpoint
`The server speaks Streamable HTTP MCP at:`
```
https://mcp.toolsnap.app/mcp
```
`Server card: /.well-known/mcp.json · Machine-readable pricing: /.well-known/pricing.json`
`On first connection your agent sees a curated core of 18 tools (~1.6k tokens). The other 20 are listed by the free tool_catalog tool and callable directly by name or through use_tool.`

### 2. Connect by client
- **Claude Code**
```bash
claude mcp add --transport http toolsnap https://mcp.toolsnap.app/mcp
# with an API key (paid tools):
claude mcp add --transport http toolsnap https://mcp.toolsnap.app/mcp --header "Authorization: Bearer sk_live_…"
```
- **Claude Desktop / claude.ai** — `Settings → Connectors → Add custom connector → URL: https://mcp.toolsnap.app/mcp. These clients can't set custom headers; if you have an API key, embed it in the URL instead: https://mcp.toolsnap.app/mcp/sk_live_…`
- **Cursor / generic JSON**
```json
{ "mcpServers": { "toolsnap": { "url": "https://mcp.toolsnap.app/mcp", "headers": { "Authorization": "Bearer sk_live_…" } } } }
```

### 3. API keys (credits rail)
`Buy credits at /checkout ($5, $10 or $25 — card checkout by Polar). You get an API key shown exactly once: sk_live_…. We store only its hash.`
- `Send it as Authorization: Bearer <key> or x-api-key: <key> — or embed it in the path (/mcp/<key>) for clients without header support.`
- `Header beats URL if both are present. URL keys can end up in logs — prefer the header when your client allows it.`
- `Lost a key? Keys are revocable and reissuable — contact support@toolsnap.app (self-serve portal coming).`

### 4. Paying with x402 (crypto rail)
`Paid tools respond with HTTP 402 + payment requirements. A capable client signs an EIP-3009 USDC authorization (Base mainnet) and retries; we verify and settle on-chain. No account, no key — the wallet is the identity.`
`Most MCP clients can't sign x402 out of the box. That's what the pay-proxy is for:`

### 5. The pay-proxy
`A tiny local stdio MCP server that wraps the remote endpoint. On a 402 it signs with your agent's wallet and retries automatically. The key never leaves your machine; only signatures travel.`
```json
{ "mcpServers": { "toolsnap": { "command": "node", "args": ["/ABS/PATH/toolsnap-mcp/scripts/pay-proxy.mjs"] } } }
```
`Key resolution order: TOOLSNAP_WALLET_KEY env → ~/.toolsnap/wallet.key → OS keychain (toolsnap-agent-wallet). Useful env: TOOLSNAP_MAX_PRICE_USDC (per-call cap, default 0.10), TOOLSNAP_PREPAID=1, TOOLSNAP_AUTO_DEPOSIT_USDC.`
`No wallet yet? → Wallet guide.`

### 6. Prepaid balance (crypto)
`Deposit once (≥ $0.50 USDC), spend per call at the discounted prepaid price (~35% off). Your agent signs a SpendAuthorization per call — off-chain, instant, no gas. Check anytime with the free account_balance tool. Deposits are non-refundable; spend them down.`

### 7. Limits & good citizenship
`Free tools are genuinely free; don't hammer them from a load tester. Practical limits: link_check batches ≤20 URLs, csv_query ≤5000 rows returned, fetch tools read up to ~512 KB–2 MB depending on the tool. If you need more, talk to us.`

---

## Page: `/wallet-guide`

**Meta title:** Give your agent a wallet — ToolSnap MCP
**Meta description:** Set up a self-custodied wallet for your AI agent in ~3 minutes. We never see the private key. USDC on Base, minimal-balance safety model, pay-proxy included.

- H1: `Give your agent a wallet`
- Lead: `~3 minutes. Your agent generates its own wallet on its own machine — we never create, see or store the key. You just send it a few dollars of USDC on Base.`

### How it works (numbered, 5 steps)
1. **The agent creates it itself.** `When your agent hits a paid tool without a wallet, ToolSnap points it to the free wallet_setup tool. That tool doesn't generate anything on our servers — it hands your agent an open, auditable procedure to generate the key on its own machine and store it in the OS keychain (Keychain / Credential Manager / Secret Service, with a locked-down file fallback on headless Linux). The private key never passes through the conversation or our infrastructure.`
2. **You get the public address (and a QR).** `The agent shows you its public 0x… address and an EIP-681 QR. A public address is safe to share — it can only receive.`
3. **You fund it.** `Send USDC on Base from your usual wallet. Signing that transfer is the only irreducibly human step.`
4. **Wire the pay-proxy (once).** `A funded wallet isn't enough: your MCP client must answer the 402 charge (sign + retry), and most can't. The pay-proxy does it for you — point your client at it and payments become invisible. See Docs §5.`
5. **Done.** `Your agent now pays per call. Ask it for its address anytime.`

### Callouts (use exactly)
- Tip — `Want your money back? Tell your agent: "Send your wallet balance to my address 0x…". It controls the key, so it can sign the transfer. Your funds are never trapped.`
- Note — `Several agents on one computer? Same OS user → same keychain → same wallet, automatically. One wallet, all your agents.`
- Warning — `This is a hot wallet. The key lives on the agent's machine so it can pay autonomously — if that machine is compromised, the key is compromised. That's the nature of any hot wallet, not a flaw in this design. The rule that actually protects you: treat it like pocket change, never like a vault. Keep a few dollars in it, top up little and often. Worst case is then capped at pocket change. (Prepaid balance caps exposure even harder: deposit a fixed amount, spend it down.)`
- Trust — `The procedure your agent runs is public and auditable, and your agent can show you exactly what it will execute before running it. We never receive the key — only signatures.`

### Prefer to create the wallet yourself?
`Also supported — you keep a backup and custody. Golden rules: use a dedicated fresh wallet (never reuse one that holds funds or identity), and never paste a private key into the chat — it goes straight from a hidden terminal prompt into the OS keychain.`
- Method A (recommended): `Import via hidden stdin` — intro: `One-time requirement: pip install eth-account keyring. Then run this in YOUR terminal (not in the chat) — it will prompt for the key with hidden input:`
```bash
python3 - <<'PY'
import keyring, getpass
from eth_account import Account

# getpass = HIDDEN prompt: what you paste is never displayed, never enters
# your shell history and never touches the chat.
pk = getpass.getpass("Paste the private key (hidden) and press Enter: ").strip()

acct = Account.from_key(pk)                                    # validates the key
keyring.set_password("toolsnap-agent-wallet", "default", pk)   # stores it in the OS keychain
assert keyring.get_password("toolsnap-agent-wallet", "default") == pk   # verifies re-read
print("OK. Wallet imported. Public address:", acct.address)
del pk
PY
```
  Caption: `Line by line: reads the key through a hidden prompt → validates it → writes it to the native keychain (Keychain / Credential Manager / Secret Service, file fallback on headless Linux) → confirms it can be read back → prints only the public address. Then tell your agent just the address; it signs from the keychain from now on.`
- Method B: `Encrypted keystore JSON (V3) + passphrase` — intro: `Use this if you created the wallet in MetaMask/Foundry/geth, or you want an encrypted backup. The file is low-risk at rest — without the passphrase it's useless.`
  B.1 — `No wallet yet? Create a dedicated one + encrypted backup in one step:`
```bash
python3 - <<'PY'
import json, getpass
from eth_account import Account

acct = Account.create()                                  # fresh wallet, dedicated to the agent
pw = getpass.getpass("Passphrase to ENCRYPT the backup (remember it): ")
enc = Account.encrypt(acct.key, pw)                      # keystore JSON V3 (key encrypted)
open("agent-wallet-backup.json", "w").write(json.dumps(enc))
print("Encrypted backup written to agent-wallet-backup.json")
print("Public address:", acct.address)
PY
```
  B.2 — `Load that keystore into the agent (decrypts in memory → OS keychain):`
```bash
python3 - <<'PY'
import json, getpass, keyring
from eth_account import Account

blob = open("agent-wallet-backup.json").read()
pw = getpass.getpass("Backup passphrase (hidden): ")
pk = Account.decrypt(json.loads(blob), pw).hex()          # decrypts in memory, never to disk
acct = Account.from_key(pk)
keyring.set_password("toolsnap-agent-wallet", "default", pk)
assert keyring.get_password("toolsnap-agent-wallet", "default") == pk
print("OK. Loaded into the keychain. Public address:", acct.address)
del pk
PY
```
  Note: `Exported the JSON from MetaMask/Foundry? Skip B.1 and point B.2 at that file.`
- Never: `pasting the key in the chat. If you already did, consider it burned: create a fresh wallet, move the funds, abandon the old one.`
- Hygiene: `clear your clipboard, shred any plaintext temp file, keep the encrypted backup in your password manager. Keep the minimal-balance rule either way.`
- Comparison table (Route 1 vs Route 2): exposure `minimal — key never moves` vs `one handover step to protect` · backup `none (host dies → funds gone)` vs `you keep a copy` · custody `agent` vs `you` · best for `autonomous agents, small balances` vs `people who already manage keys`.

---

## Page: `/blog`

**Meta title:** Blog — ToolSnap MCP
**Meta description:** Context engineering, agent recipes and product notes from ToolSnap MCP.

- H1: `Blog`
- Sub: `Context engineering, recipes and product notes — everything we learn making agents cheaper and more capable.`
- "More articles" label: `More articles`

**Categories (CMS select options, use exactly):** `Context engineering` · `Recipes` · `Product` · `Engineering`

### Launch post (content collection entry #1, featured: true)

- slug: `one-connection-superpowers`
- title: `One connection. Superpowers for your agent.`
- date: {{deploy date}}
- category: `Product`
- tags: `launch, mcp, context`
- read_time: 4
- description: `ToolSnap MCP is live: 38 server-side tools for any AI agent, 35 of them free, through one MCP connection. Here's what it is, why context is the real bill, and how to connect in 30 seconds.`

Body (verbatim):

```
Your agent can already write code, browse docs and reason about your business. What it can't do is escape one brutal accounting fact: every raw webpage, PDF or CSV it loads gets re-sent on every turn of the conversation. Context is the bill.

We measured it. Asking an agent to read one ordinary article page put 53,820 tokens into its context. Running the same page through ToolSnap's `fetch_extract` returned 2,001 tokens of clean text — a 98.1% reduction, worth about $0.156 on a single Sonnet call. One call. One page. Now multiply by every page, every feed, every PDF your agent touches in a working day.

ToolSnap MCP is our answer: a catalog of 38 single-purpose, server-side tools that any MCP-capable agent can use through **one connection**:

    https://mcp.toolsnap.app/mcp

No sign-up. No API key for the free tier. 35 of the 38 tools are free — web extraction, HTML, metadata, sitemaps, RSS, CSV/JSON queries, PDF text, link checking, diffs, token counting and more. They all share one design rule: **operate by reference**. You hand the tool a URL or a blob, it does the heavy work server-side, and only the small, deterministic result enters your agent's context.

The three paid tools are the ones that cost us real money per call: full-page screenshots ($0.04), Google Ads keyword data ($0.04) and ML background removal ($0.03). Pay with card credits — $5 gets you an API key in two minutes, no crypto involved — or let your agent pay autonomously with USDC on Base via x402. Both rails are live today.

Two more things your agent will like:

**A first connection that doesn't cost a fortune.** Most MCP servers dump their entire catalog into your agent's context — we've seen 30k tokens before the first tool call. ToolSnap serves a curated core of 18 tools (~1.6k tokens); the rest is one `tool_catalog` call away.

**Recipes.** A recipe is a complete job, pre-planned: migrate a WordPress site to static HTML, run a technical SEO audit. The free `task_recipes` tool serves the prompt, the tool list and the cost estimate. Paste, add your URL, walk away.

Connect it now, then ask your agent to call `tool_catalog`. Thirty seconds from reading this to superpowers.
```

---

## Page: `404`

- H1: `404 — nothing at this URL`
- Body: `The page you're after doesn't exist (or moved). If you were looking for the MCP endpoint, it's a POST to https://mcp.toolsnap.app/mcp — this website is just its human face.`
- Button: `Back home` → `/`

---

## Pages: `/terms` · `/privacy` · `/refunds`

Migrate the EXACT current text from `src/fiat/pages.ts` (entity: Icosaedro Music & Human Development LLC, 2201 Menaul Blvd NE Ste A, Albuquerque, NM 87107, USA; contact support@toolsnap.app). Do not rewrite legal content — restyle only, inside the new site layout.

---

## Copy QA checklist (for the builder)

- [ ] Numbers consistent everywhere: 38 tools, 35 free, 3 paid, 18 in core list, 98.1%, 53,820→2,001, $0.02–$0.04, credits $5/$10/$25, prepaid min $0.50.
- [ ] `sk_live_…` used in examples (never a real-looking full key).
- [ ] All prices rendered in mono font.
- [ ] Brand tagline appears exactly as `One connection. Superpowers for your agent.` — never paraphrased.
- [ ] Blog categories match CMS config exactly.
