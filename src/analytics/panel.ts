/** HTML for the private analytics dashboard. Fetches /analytics/data client-side. */

export const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>toolsnap analytics</title>
<style>
  :root {
    --bg: #0e1117;
    --surface: #161b27;
    --border: #21293a;
    --text: #e6edf3;
    --muted: #7d8590;
    --accent: #2f81f7;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #a371f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 "SF Mono", "Fira Code", monospace; min-height: 100vh; }
  header { padding: 20px 24px 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.3px; }
  header span { font-size: 11px; color: var(--muted); }
  .refresh-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .refresh-btn:hover { border-color: var(--accent); }
  main { padding: 24px; max-width: 1200px; }
  .error { background: #2d1b1b; border: 1px solid var(--red); border-radius: 8px; padding: 16px; color: var(--red); margin-bottom: 20px; font-size: 13px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .kpi-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi-value { font-size: 28px; font-weight: 700; margin-top: 4px; letter-spacing: -1px; }
  .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .grid3 { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .card h3 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
  .bar-chart { width: 100%; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; }
  .bar-label { width: 80px; color: var(--muted); text-align: right; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; background: var(--border); border-radius: 3px; height: 14px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
  .bar-count { width: 44px; text-align: right; color: var(--text); flex-shrink: 0; }
  .pay-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 20px; padding: 4px 10px; font-size: 12px; margin: 3px 2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .pay-count { color: var(--muted); }
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .stat-row:last-child { border-bottom: none; }
  .stat-val { font-weight: 600; }
  .green { color: var(--green); }
  .accent { color: var(--accent); }
  .yellow { color: var(--yellow); }
  .loading { text-align: center; padding: 60px 0; color: var(--muted); font-size: 13px; }
  @media (max-width: 768px) {
    .kpis { grid-template-columns: 1fr 1fr; }
    .grid2, .grid3 { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header>
  <h1>toolsnap · analytics</h1>
  <div style="display:flex;align-items:center;gap:12px">
    <span id="last-updated">loading…</span>
    <button class="refresh-btn" onclick="load()">↻ refresh</button>
  </div>
</header>
<main>
  <div id="root"><div class="loading">fetching data…</div></div>
</main>
<script>
const PAY_COLORS = {
  free_tool: '#7d8590',
  x402_paid: '#3fb950',
  x402_free_first: '#2f81f7',
  prepaid: '#a371f7',
  '402_rejected': '#f85149',
  prepaid_insufficient: '#d29922',
  prepaid_rejected: '#e3b341',
  deposit_success: '#58a6ff',
  deposit_failed: '#f85149',
  tool_error: '#f85149',
};

function fmt(n, decimals = 2) {
  if (n === undefined || n === null) return '—';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  if (decimals === 0) return Math.round(n).toString();
  return Number(n).toFixed(decimals);
}

function barChart(items, valueKey, labelKey, color) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no data yet</div>';
  const max = Math.max(...items.map(i => i[valueKey] ?? 0), 1);
  return items.map(item => {
    const pct = Math.round(((item[valueKey] ?? 0) / max) * 100);
    return \`<div class="bar-row">
      <div class="bar-label" title="\${item[labelKey]}">\${item[labelKey]}</div>
      <div class="bar-track"><div class="bar-fill" style="width:\${pct}%;background:\${color}"></div></div>
      <div class="bar-count">\${fmt(item[valueKey], 0)}</div>
    </div>\`;
  }).join('');
}

function dayChart(days, valueKey, color) {
  if (!days || days.length === 0) return '<div style="color:var(--muted);font-size:12px">no data yet</div>';
  const max = Math.max(...days.map(d => d[valueKey] ?? 0), 1);
  const w = 480, h = 80, pad = 4;
  const bw = Math.max(4, Math.floor((w - pad * (days.length + 1)) / days.length));
  const bars = days.map((d, i) => {
    const bh = Math.max(2, Math.round(((d[valueKey] ?? 0) / max) * (h - 10)));
    const x = pad + i * (bw + pad);
    const y = h - bh;
    const label = (d.day || '').slice(5); // MM-DD
    return \`<rect x="\${x}" y="\${y}" width="\${bw}" height="\${bh}" fill="\${color}" rx="2">
      <title>\${label}: \${fmt(d[valueKey], valueKey === 'revenue' ? 4 : 0)}</title>
    </rect>
    <text x="\${x + bw / 2}" y="\${h + 12}" text-anchor="middle" fill="var(--muted)" font-size="9">\${label}</text>\`;
  }).join('');
  return \`<svg viewBox="0 0 \${w} \${h + 16}" width="100%" style="overflow:visible">\${bars}</svg>\`;
}

function payChips(breakdown) {
  if (!breakdown || breakdown.length === 0) return '<div style="color:var(--muted);font-size:12px">no data yet</div>';
  const total = breakdown.reduce((s, b) => s + (b.calls ?? 0), 0);
  return breakdown.map(b => {
    const pct = total > 0 ? Math.round((b.calls / total) * 100) : 0;
    return \`<span class="pay-chip">
      <span class="dot" style="background:\${PAY_COLORS[b.type] ?? '#555'}"></span>
      \${b.type} <span class="pay-count">\${b.calls} · \${pct}%</span>
    </span>\`;
  }).join('');
}

function conversion(breakdown) {
  if (!breakdown || breakdown.length === 0) return { rate: 0, paid402: 0, total402: 0 };
  const paid = (breakdown.find(b => b.type === 'x402_paid')?.calls ?? 0)
             + (breakdown.find(b => b.type === 'x402_free_first')?.calls ?? 0);
  const rejected = breakdown.find(b => b.type === '402_rejected')?.calls ?? 0;
  const total = paid + rejected;
  return { rate: total > 0 ? Math.round((paid / total) * 100) : 0, paid, total };
}

function render(d) {
  const cv = conversion(d.payment_breakdown);
  const html = \`
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Calls · 30d</div>
        <div class="kpi-value accent">\${fmt(d.summary.calls_30d, 0)}</div>
        <div class="kpi-sub">MCP tool calls</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Revenue · 30d</div>
        <div class="kpi-value green">$\${fmt(d.summary.revenue_30d, 4)}</div>
        <div class="kpi-sub">USDC on Base</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Unique agents</div>
        <div class="kpi-value">\${fmt(d.summary.unique_payers_30d, 0)}</div>
        <div class="kpi-sub">payer wallets · 30d</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">402→paid conv.</div>
        <div class="kpi-value yellow">\${cv.rate}%</div>
        <div class="kpi-sub">\${cv.paid} paid / \${cv.total} prompted</div>
      </div>
    </div>

    <div class="grid2">
      <div class="card">
        <h3>Calls / day · 7d</h3>
        \${dayChart(d.calls_by_day, 'calls', '#2f81f7')}
      </div>
      <div class="card">
        <h3>Revenue / day · 7d (USDC)</h3>
        \${dayChart(d.revenue_by_day, 'revenue', '#3fb950')}
      </div>
    </div>

    <div class="grid3">
      <div class="card">
        <h3>Top tools · 30d</h3>
        <div class="bar-chart">\${barChart(d.top_tools, 'calls', 'tool', '#a371f7')}</div>
      </div>
      <div class="card">
        <h3>Payment mix</h3>
        \${payChips(d.payment_breakdown)}
      </div>
      <div class="card">
        <h3>Deposits · 30d</h3>
        <div class="stat-row"><span>Count</span><span class="stat-val accent">\${d.deposits.count}</span></div>
        <div class="stat-row"><span>Total deposited</span><span class="stat-val green">$\${fmt(d.deposits.total_usdc, 4)}</span></div>
        <div class="stat-row"><span>Avg latency</span><span class="stat-val">\${d.summary.avg_latency_ms} ms</span></div>
      </div>
    </div>
  \`;
  document.getElementById('root').innerHTML = html;
}

async function load() {
  document.getElementById('last-updated').textContent = 'loading…';
  try {
    const res = await fetch('/analytics/data');
    if (!res.ok) {
      const txt = await res.text();
      document.getElementById('root').innerHTML = \`<div class="error">Error \${res.status}: \${txt}</div>\`;
      return;
    }
    const data = await res.json();
    render(data);
    document.getElementById('last-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('root').innerHTML = \`<div class="error">\${e.message}</div>\`;
  }
}

load();
setInterval(load, 60_000);
</script>
</body>
</html>`;
