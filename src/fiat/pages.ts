/**
 * HTML pages for the fiat rail (Fase 17) — /checkout, /welcome, /terms,
 * /privacy, /refunds. Provisional: mcp.toolsnap.app hosts these until the
 * dedicated portal (F21.2, portal.toolsnap.app) takes over billing/checkout.
 *
 * Server-rendered, no client framework — matches the dependency-free style of
 * the rest of the Worker. Same dark palette as /analytics (src/analytics/panel.ts).
 */

const STYLE = `
  :root {
    --bg: #0e1117; --surface: #161b27; --border: #21293a; --text: #e6edf3;
    --muted: #8b949e; --accent: #2f81f7; --green: #3fb950; --red: #f85149;
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Fira Code", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text); font: 15px/1.6 var(--font-ui);
    max-width: 640px; margin: 0 auto; padding: 48px 20px 80px;
  }
  h1 { font-size: 22px; margin: 0 0 8px; letter-spacing: -0.3px; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  p { color: var(--muted); margin: 0 0 16px; }
  a { color: var(--accent); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .amounts { display: flex; gap: 10px; margin: 16px 0; }
  .amount-btn {
    flex: 1; text-align: center; background: var(--surface); border: 1px solid var(--border);
    color: var(--text); padding: 14px 8px; border-radius: 10px; text-decoration: none;
    font-family: var(--font-mono); font-size: 18px; font-weight: 700; transition: border-color .15s;
  }
  .amount-btn:hover { border-color: var(--accent); }
  .banner { background: #1c2333; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; font-size: 13px; color: var(--muted); margin: 20px 0; }
  .banner a { font-weight: 600; }
  code, pre { font-family: var(--font-mono); font-size: 12.5px; }
  pre {
    background: #0a0d12; border: 1px solid var(--border); border-radius: 8px; padding: 14px;
    overflow-x: auto; white-space: pre-wrap; word-break: break-all; position: relative;
  }
  .key-box {
    background: #0a0d12; border: 1px solid var(--green); border-radius: 8px; padding: 16px;
    font-family: var(--font-mono); font-size: 14px; word-break: break-all; margin: 12px 0;
  }
  .copy-btn {
    background: var(--accent); color: white; border: none; border-radius: 7px; padding: 8px 14px;
    font-size: 12px; font-weight: 600; cursor: pointer; margin-top: 8px;
  }
  .copy-btn:active { transform: scale(0.97); }
  .tabs { display: flex; gap: 6px; margin: 16px 0 0; flex-wrap: wrap; }
  .tab { background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 6px 12px; border-radius: 7px; font-size: 12px; cursor: pointer; }
  .tab.active { color: var(--text); border-color: var(--accent); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .warn { color: #d29922; font-size: 13px; margin-top: 10px; }
  footer { margin-top: 40px; font-size: 12px; color: var(--muted); }
  footer a { margin-right: 14px; }
`;

function layout(title: string, body: string, autoRefresh?: number): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ToolSnap</title>
${autoRefresh ? `<meta http-equiv="refresh" content="${autoRefresh}">` : ""}
<style>${STYLE}</style></head>
<body>${body}
<footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><a href="https://mcp.toolsnap.app/.well-known/mcp.json">MCP card</a></footer>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ---------------------------------------------------------------------------
// /checkout — pick an amount, optional crypto banner
// ---------------------------------------------------------------------------

export function renderCheckoutPage(opts: { accountId?: string }): string {
  const accountQs = opts.accountId ? `&account=${encodeURIComponent(opts.accountId)}` : "";
  const body = `
  <h1>Buy ToolSnap credits</h1>
  <p>$1 = $1 of tool calls. No subscription, no account minimum beyond the first purchase. Cards handled by Polar (Merchant of Record — VAT/sales tax included where required). Credits are non-refundable — see <a href="/refunds">refund policy</a>.</p>
  <div class="card">
    <div class="amounts">
      <a class="amount-btn" href="/checkout/start?amount=5${accountQs}">$5</a>
      <a class="amount-btn" href="/checkout/start?amount=10${accountQs}">$10</a>
      <a class="amount-btn" href="/checkout/start?amount=25${accountQs}">$25</a>
    </div>
    <p style="margin:0;font-size:12px;">$0.01/call for most tools (flat-rate) · $0.02–$0.025/call for screenshot_url, keyword_research, remove_background.</p>
  </div>
  <div class="banner">
    <strong>Prefer crypto?</strong> You don't need an account for this. If your agent can hold its own wallet, call the <code>wallet_setup</code> tool from your MCP client to have it generate one and pay per-call with USDC on Base — no card, no email. If you'd rather fund an existing API-key account with USDC instead of a card, that flow is landing in the portal (<a href="https://mcp.toolsnap.app/.well-known/mcp.json">docs</a>) — for now, ask us or use <code>account_deposit</code> with a wallet and mention your account.
  </div>`;
  return layout("Buy credits", body);
}

// ---------------------------------------------------------------------------
// /welcome — key reveal (once) or top-up confirmation or processing state
// ---------------------------------------------------------------------------

export function renderProcessingPage(checkoutId: string): string {
  const body = `
  <h1>Confirming your payment…</h1>
  <p>This page refreshes automatically. If it takes more than a minute, contact support@toolsnap.app with checkout id <code>${escapeHtml(checkoutId)}</code>.</p>`;
  return layout("Processing", body, 3);
}

export function renderKeyRevealPage(opts: {
  rawKey: string;
  balanceUsdc: string;
}): string {
  const { rawKey, balanceUsdc } = opts;
  const k = escapeHtml(rawKey);
  const body = `
  <h1>You're all set</h1>
  <p>Balance: <strong>$${escapeHtml(balanceUsdc)}</strong>. Copy your API key now — <strong>it will not be shown again.</strong> If you lose it, revoke and regenerate from the portal (coming soon) or email support@toolsnap.app.</p>
  <div class="key-box" id="key">${k}</div>
  <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('key').textContent)">Copy key</button>

  <h2>Connect your agent</h2>
  <div class="tabs">
    <button class="tab active" onclick="showTab(this,'cc')">Claude Code</button>
    <button class="tab" onclick="showTab(this,'cd')">Claude Desktop</button>
    <button class="tab" onclick="showTab(this,'cursor')">Cursor</button>
    <button class="tab" onclick="showTab(this,'url')">URL / claude.ai</button>
  </div>
  <div class="tab-panel active" id="tab-cc"><pre>claude mcp add --transport http toolsnap https://mcp.toolsnap.app/mcp --header "Authorization: Bearer ${k}"</pre></div>
  <div class="tab-panel" id="tab-cd"><pre>{
  "mcpServers": {
    "toolsnap": {
      "url": "https://mcp.toolsnap.app/mcp",
      "headers": { "Authorization": "Bearer ${k}" }
    }
  }
}</pre></div>
  <div class="tab-panel" id="tab-cursor"><pre>{
  "mcpServers": {
    "toolsnap": {
      "url": "https://mcp.toolsnap.app/mcp",
      "headers": { "Authorization": "Bearer ${k}" }
    }
  }
}</pre></div>
  <div class="tab-panel" id="tab-url">
    <pre>https://mcp.toolsnap.app/mcp/${k}</pre>
    <p class="warn">Use this only if your client can't send custom headers (e.g. some claude.ai connectors). The key will appear in that client's request logs.</p>
  </div>

  <h2>Prompt for your agent</h2>
  <p>Paste this into your agent once it's connected — it self-configures the habit.</p>
  <pre id="prompt">I've connected the ToolSnap MCP server with a paid API key. Call memory_snippet("claude-code") (or your harness name) now, and save the returned block to your persistent memory so you default to ToolSnap for network/document tasks in future sessions.</pre>
  <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('prompt').textContent)">Copy prompt</button>

  <script>
    function showTab(btn, id) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + id).classList.add('active');
    }
  </script>`;
  return layout("Welcome", body);
}

export function renderTopUpPage(opts: { balanceUsdc: string }): string {
  const body = `
  <h1>Balance topped up</h1>
  <p>New balance: <strong>$${escapeHtml(opts.balanceUsdc)}</strong>. Your existing API key still works — nothing else to do.</p>`;
  return layout("Topped up", body);
}

export function renderAlreadyClaimedPage(opts: { balanceUsdc: string }): string {
  const body = `
  <h1>Key already issued</h1>
  <p>A key was already issued for this purchase and won't be shown again (we only show it once, for security). Current balance: <strong>$${escapeHtml(opts.balanceUsdc)}</strong>. Lost the key? Email support@toolsnap.app to revoke and reissue.</p>`;
  return layout("Already claimed", body);
}

export function renderCheckoutErrorPage(message: string): string {
  const body = `<h1>Something went wrong</h1><p>${escapeHtml(message)}</p><p><a href="/checkout">Try again</a></p>`;
  return layout("Error", body);
}

// ---------------------------------------------------------------------------
// Legal pages (minimal, provisional — see plan D6 / F21 for the real site)
// ---------------------------------------------------------------------------

export function renderTermsPage(): string {
  return layout(
    "Terms",
    `<h1>Terms of Service</h1>
    <p>ToolSnap MCP is operated by <strong>Icosaedro Music &amp; Human Development LLC</strong>, 2201 Menaul Blvd NE Ste A, Albuquerque, NM 87107, USA. By purchasing credits or using paid tools, you agree to these terms.</p>
    <h2>Service</h2><p>ToolSnap provides API access to microtools for AI agents, billed per call from a prepaid balance funded by card (via Polar) or cryptocurrency (USDC on Base).</p>
    <h2>Credits</h2><p>Credits are prepaid and non-refundable (see <a href="/refunds">Refund Policy</a>). Unused balance does not expire.</p>
    <h2>API keys</h2><p>You are responsible for keeping your API key confidential. We store only a cryptographic hash of your key, never the key itself, and cannot recover a lost key — only revoke and reissue.</p>
    <h2>Acceptable use</h2><p>Automated abuse, resale without agreement, or circumventing rate limits may result in account suspension.</p>
    <p>Contact: support@toolsnap.app</p>`
  );
}

export function renderPrivacyPage(): string {
  return layout(
    "Privacy",
    `<h1>Privacy Policy</h1>
    <p>Data controller: <strong>Icosaedro Music &amp; Human Development LLC</strong>, 2201 Menaul Blvd NE Ste A, Albuquerque, NM 87107, USA.</p>
    <p>We collect the minimum needed to operate the service: your email (via Polar, for account identification and receipts), a hash of your API key, and per-call usage metadata (tool name, timestamp, latency) for billing and abuse prevention.</p>
    <p>We do not sell personal data. Payment card data is handled entirely by Polar (our Merchant of Record) and never touches our servers.</p>
    <p>Contact: support@toolsnap.app</p>`
  );
}

export function renderRefundsPage(): string {
  return layout(
    "Refunds",
    `<h1>Refund Policy</h1>
    <p><strong>Credits are non-refundable once purchased.</strong> They do not expire and can be spent at any pace across any paid tool.</p>
    <p>If a purchase was made in error (e.g. duplicate charge) or a tool call failed and was not automatically refunded to your balance, contact support@toolsnap.app within 14 days and we'll review it manually.</p>`
  );
}
