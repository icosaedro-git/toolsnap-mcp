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
    --muted: #8b949e;
    --accent: #2f81f7;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #a371f7;
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Fira Code", Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    background-image: radial-gradient(900px 360px at 50% -80px, rgba(47,129,247,0.08), transparent 70%);
    color: var(--text);
    font: 14px/1.5 var(--font-ui);
    min-height: 100vh;
  }
  header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.2px; display: flex; align-items: center; }
  header span { font-size: 11px; color: var(--muted); font-family: var(--font-mono); }
  .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); margin-left: 8px; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .refresh-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 5px 12px; border-radius: 7px; cursor: pointer; font: 12px var(--font-ui); transition: border-color 0.15s ease; }
  .refresh-btn:hover { border-color: var(--accent); }
  .refresh-btn:active { transform: scale(0.96); }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .error { background: #2d1b1b; border: 1px solid var(--red); border-radius: 8px; padding: 16px; color: var(--red); margin-bottom: 20px; font-size: 13px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: border-color 0.15s ease; }
  .kpi:hover { border-color: #2a3448; }
  .kpi-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; }
  .kpi-value { font-size: 28px; font-weight: 700; margin-top: 4px; letter-spacing: -0.5px; font-family: var(--font-mono); }
  .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 3px; }
  .kpi-delta { font-size: 12px; font-weight: 600; margin-left: 6px; font-family: var(--font-mono); }
  .kpi-delta.up { color: var(--green); }
  .kpi-delta.down { color: var(--red); }
  .controls-bar { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .seg-group { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 3px; gap: 2px; }
  .seg-btn { background: transparent; border: none; color: var(--muted); font: 12px var(--font-ui); padding: 5px 11px; border-radius: 6px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
  .seg-btn:hover:not(.active) { color: var(--text); }
  .seg-btn.active { background: var(--accent); color: #fff; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .grid3 { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: border-color 0.15s ease; }
  .card:hover { border-color: #2a3448; }
  .card h3 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; font-weight: 500; }
  .bar-chart { width: 100%; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; }
  .bar-label { width: 80px; color: var(--muted); text-align: right; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; background: var(--border); border-radius: 3px; height: 14px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
  .bar-count { width: 44px; text-align: right; color: var(--text); flex-shrink: 0; font-family: var(--font-mono); }
  .pay-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 20px; padding: 4px 10px; font-size: 12px; margin: 3px 2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .pay-count { color: var(--muted); font-family: var(--font-mono); }
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .stat-row:last-child { border-bottom: none; }
  .stat-val { font-weight: 600; font-family: var(--font-mono); }
  .green { color: var(--green); }
  .accent { color: var(--accent); }
  .yellow { color: var(--yellow); }
  .loading { text-align: center; padding: 60px 0; color: var(--muted); font-size: 13px; }
  .err-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .err-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
  .err-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .err-table tr:last-child td { border-bottom: none; }
  .err-table tr:hover td { background: rgba(255,255,255,0.02); }
  .err-detail { color: var(--muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .err-detail:hover { white-space: normal; overflow: visible; }
  .grid-wide { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; margin-bottom: 24px; }
  .chart-wrap { position: relative; }
  .chart-wrap text { font-family: var(--font-mono); }
  .chart-empty { padding: 56px 0; text-align: center; color: var(--muted); font-size: 12px; }
  .chart-tip { position: absolute; top: 6px; left: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; font-size: 11px; box-shadow: 0 4px 14px rgba(0,0,0,0.45); pointer-events: none; white-space: nowrap; z-index: 5; }
  .tip-date { color: var(--muted); margin-bottom: 2px; }
  .tip-val { font-weight: 600; font-family: var(--font-mono); }
  @media (max-width: 768px) {
    .kpis { grid-template-columns: 1fr 1fr; }
    .grid2, .grid3, .grid-wide { grid-template-columns: 1fr; }
    .controls-bar { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  }
</style>
</head>
<body>
<header>
  <h1>toolsnap · analytics<span class="live-dot" title="live"></span></h1>
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
  '402_no_wallet': '#7d8590',
  '402_pay_failed': '#f85149',
  prepaid_insufficient: '#d29922',
  prepaid_rejected: '#e3b341',
  deposit_success: '#58a6ff',
  deposit_failed: '#f85149',
  settle_failed: '#f85149',
  tool_error: '#f85149',
};

const LS_KEY = 'ts_panel';
const state = { days: 30, view: 'line', internal: false };
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  if ([7, 30, 90, 365].includes(saved.days)) state.days = saved.days;
  if (saved.view === 'line' || saved.view === 'bar') state.view = saved.view;
  if (saved.internal === true) state.internal = true;
} catch (e) {}
let lastData = null;

function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}
function setTimeframe(days) {
  state.days = days;
  saveState();
  if (lastData) render(lastData);
}
function setView(view) {
  state.view = view;
  saveState();
  if (lastData) render(lastData);
}
function setInternal(on) {
  if (state.internal === on) return;
  state.internal = on;
  saveState();
  load(); // server-side filter — must refetch
}

function fmt(n, decimals = 2) {
  if (n === undefined || n === null) return '—';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  if (decimals === 0) return Math.round(n).toString();
  return Number(n).toFixed(decimals);
}

function fmtUsd(n) {
  if (n === undefined || n === null) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
  let s = v.toFixed(4).replace(/0+$/, '').replace(/\\.$/, '');
  if (s === '' || s === '-') s = '0';
  return '$' + s;
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeLabel(ts) {
  return new Date(ts).toISOString().slice(11, 19) + ' UTC · ' + new Date(ts).toISOString().slice(5, 10);
}

function errorTable(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no errors 🎉</div>';
  const rows = items.map(e => \`<tr>
    <td>\${timeLabel(e.ts)}</td>
    <td>\${esc(e.tool)}</td>
    <td><span class="dot" style="background:\${PAY_COLORS[e.type] ?? '#555'};display:inline-block;margin-right:5px"></span>\${esc(e.type)}</td>
    <td title="\${esc(e.client)}">\${esc((e.client || '').slice(0, 24))}</td>
    <td class="err-detail" title="\${esc(e.detail)}">\${esc(e.detail) || '—'}</td>
  </tr>\`).join('');
  return \`<table class="err-table">
    <thead><tr><th>Time</th><th>Tool</th><th>Type</th><th>Client</th><th>Detail</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

function errorRateChart(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no errors yet</div>';
  return items.map(item => \`<div class="bar-row">
    <div class="bar-label" title="\${esc(item.tool)}">\${esc(item.tool)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:\${item.error_pct}%;background:#f85149"></div></div>
    <div class="bar-count">\${item.errors}/\${item.total}</div>
  </div>\`).join('');
}

function conversion(breakdown) {
  if (!breakdown || breakdown.length === 0) return { rate: 0, paid402: 0, total402: 0 };
  const paid = (breakdown.find(b => b.type === 'x402_paid')?.calls ?? 0)
             + (breakdown.find(b => b.type === 'x402_free_first')?.calls ?? 0);
  // 402_rejected is split into 402_no_wallet (benign handshake) + 402_pay_failed
  // (real verification failure) — both count as "prompted for payment".
  const rejected = (breakdown.find(b => b.type === '402_no_wallet')?.calls ?? 0)
                  + (breakdown.find(b => b.type === '402_pay_failed')?.calls ?? 0);
  const total = paid + rejected;
  return { rate: total > 0 ? Math.round((paid / total) * 100) : 0, paid, total };
}

// ---------------------------------------------------------------------------
// Time-series helpers: zero-fill, weekly bucketing, deltas.
// ---------------------------------------------------------------------------

function zeroFillDaily(raw, valueKey, days) {
  const map = new Map((raw || []).map(r => [r.day, r[valueKey]]));
  const now = new Date();
  const endUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = endUTC - i * 86400000;
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, value: map.get(day) ?? 0 });
  }
  return out;
}

function bucketWeekly(daily) {
  const rem = daily.length % 7;
  const trimmed = rem ? daily.slice(rem) : daily;
  const weeks = [];
  for (let i = 0; i < trimmed.length; i += 7) {
    const chunk = trimmed.slice(i, i + 7);
    const sum = chunk.reduce((s, c) => s + c.value, 0);
    weeks.push({ day: chunk[0].day, value: sum });
  }
  return weeks;
}

function sumSeries(arr) {
  return arr.reduce((s, x) => s + x.value, 0);
}

function windowDelta(dailyArr, days) {
  const n = dailyArr.length;
  const prevStart = n - days * 2;
  if (prevStart < 0) return null;
  const current = dailyArr.slice(n - days);
  const previous = dailyArr.slice(prevStart, n - days);
  const curSum = sumSeries(current);
  const prevSum = sumSeries(previous);
  if (prevSum === 0) return null;
  const pct = Math.round(((curSum - prevSum) / prevSum) * 100);
  return { pct, up: curSum >= prevSum };
}

function deltaBadge(delta) {
  if (!delta) return '';
  const cls = delta.up ? 'up' : 'down';
  const arrow = delta.up ? '▲' : '▼';
  return \` <span class="kpi-delta \${cls}">\${arrow} \${Math.abs(delta.pct)}%</span>\`;
}

function tfLabel(days) {
  return { 7: '7d', 30: '30d', 90: '90d', 365: '1y' }[days] || (days + 'd');
}

// ---------------------------------------------------------------------------
// Chart rendering: nice axis scaling + line/bar SVG + hover tooltip.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function niceMax(max) {
  if (!max || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  const norm = max / base;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function formatXLabel(dayStr, gran) {
  const dt = new Date(dayStr + 'T00:00:00Z');
  const d = dt.getUTCDate(), m = MONTHS[dt.getUTCMonth()];
  return gran === 'week' ? m : (d + ' ' + m);
}

function formatFullDate(dayStr, gran) {
  const dt = new Date(dayStr + 'T00:00:00Z');
  const d = dt.getUTCDate(), m = MONTHS[dt.getUTCMonth()], y = dt.getUTCFullYear();
  return gran === 'week' ? ('week of ' + d + ' ' + m + ' ' + y) : (d + ' ' + m + ' ' + y);
}

function valueFormatter(kind) {
  return kind === 'usd' ? fmtUsd : (v => fmt(v, 0));
}

function timeChart(series, opts) {
  const fmtV = valueFormatter(opts.kind);
  if (!series || series.length === 0 || series.every(s => s.value === 0)) {
    return '<div class="chart-empty">no activity in this period</div>';
  }
  const W = 560, H = 200, ML = 46, MR = 12, MT = 10, MB = 24;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const n = series.length;
  const maxVal = Math.max(...series.map(s => s.value));
  const niceMaxVal = niceMax(maxVal);
  const xAt = i => n === 1 ? ML + plotW / 2 : ML + (i / (n - 1)) * plotW;
  const yAt = v => niceMaxVal === 0 ? (MT + plotH) : MT + plotH - (v / niceMaxVal) * plotH;

  let grid = '';
  const GRID_STEPS = 4;
  for (let g = 0; g <= GRID_STEPS; g++) {
    const v = niceMaxVal * g / GRID_STEPS;
    const y = yAt(v);
    grid += \`<line x1="\${ML}" y1="\${y}" x2="\${W - MR}" y2="\${y}" stroke="var(--border)" stroke-width="1" opacity="\${g === 0 ? 0.9 : 0.45}"/>\`;
    grid += \`<text x="\${ML - 6}" y="\${y + 3}" text-anchor="end" font-size="9" fill="var(--muted)">\${fmtV(v)}</text>\`;
  }

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  let xLabels = '';
  for (let i = 0; i < n; i++) {
    if (i !== n - 1 && i % labelEvery !== 0) continue;
    xLabels += \`<text x="\${xAt(i)}" y="\${H - 6}" text-anchor="middle" font-size="9" fill="var(--muted)">\${formatXLabel(series[i].day, opts.granularity)}</text>\`;
  }

  let viz = '';
  if (state.view === 'bar') {
    const bw = Math.max(2, (plotW / n) * 0.6);
    viz = series.map((s, i) => {
      const y = yAt(s.value);
      const h = Math.max((MT + plotH) - y, 0);
      return \`<rect x="\${xAt(i) - bw / 2}" y="\${y}" width="\${bw}" height="\${h}" fill="\${opts.color}" rx="2"/>\`;
    }).join('');
  } else {
    const pts = series.map((s, i) => \`\${xAt(i)},\${yAt(s.value)}\`).join(' ');
    const areaPts = \`\${xAt(0)},\${MT + plotH} \${pts} \${xAt(n - 1)},\${MT + plotH}\`;
    const gid = 'g' + Math.random().toString(36).slice(2, 9);
    const lastX = xAt(n - 1), lastY = yAt(series[n - 1].value);
    viz = \`<defs><linearGradient id="\${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="\${opts.color}" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="\${opts.color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="\${areaPts}" fill="url(#\${gid})"/>
      <polyline points="\${pts}" fill="none" stroke="\${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="\${lastX}" cy="\${lastY}" r="3" fill="\${opts.color}"/>
      <text x="\${lastX}" y="\${lastY - 10}" text-anchor="\${n > 1 ? 'end' : 'middle'}" font-size="10" font-weight="600" fill="\${opts.color}">\${fmtV(series[n - 1].value)}</text>\`;
  }

  const seriesAttr = esc(JSON.stringify(series.map(s => ({ d: s.day, v: s.value }))));

  return \`<div class="chart-wrap">
    <svg viewBox="0 0 \${W} \${H}" width="100%" style="overflow:visible;display:block"
      onmousemove="chartHover(event, this)" onmouseleave="chartLeave(this)"
      data-series="\${seriesAttr}" data-kind="\${opts.kind}" data-gran="\${opts.granularity}"
      data-ml="\${ML}" data-mr="\${MR}" data-mt="\${MT}" data-mb="\${MB}" data-w="\${W}" data-h="\${H}">
      \${grid}
      \${viz}
      \${xLabels}
      <line class="hover-guide" x1="0" y1="\${MT}" x2="0" y2="\${MT + plotH}" stroke="var(--border)" stroke-width="1" style="display:none"/>
      <circle class="hover-dot" r="4" fill="\${opts.color}" stroke="var(--bg)" stroke-width="2" style="display:none"/>
      <rect x="\${ML}" y="\${MT}" width="\${plotW}" height="\${plotH}" fill="transparent" pointer-events="all"/>
    </svg>
    <div class="chart-tip" style="display:none"></div>
  </div>\`;
}

function chartHover(evt, svgEl) {
  try {
    const series = JSON.parse(svgEl.getAttribute('data-series'));
    const kind = svgEl.getAttribute('data-kind');
    const gran = svgEl.getAttribute('data-gran');
    const W = +svgEl.getAttribute('data-w');
    const ML = +svgEl.getAttribute('data-ml'), MR = +svgEl.getAttribute('data-mr');
    const MT = +svgEl.getAttribute('data-mt'), MB = +svgEl.getAttribute('data-mb');
    const H = +svgEl.getAttribute('data-h');
    const plotW = W - ML - MR, plotH = H - MT - MB;
    const n = series.length;

    const rect = svgEl.getBoundingClientRect();
    const scaleX = W / rect.width;
    const xUser = (evt.clientX - rect.left) * scaleX;
    let idx = n === 1 ? 0 : Math.round(((xUser - ML) / plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));

    const point = series[idx];
    const maxVal = Math.max(...series.map(s => s.v));
    const niceMaxVal = niceMax(maxVal);
    const xAt = n === 1 ? ML + plotW / 2 : ML + (idx / (n - 1)) * plotW;
    const yAt = niceMaxVal === 0 ? MT + plotH : MT + plotH - (point.v / niceMaxVal) * plotH;

    const guide = svgEl.querySelector('.hover-guide');
    const dot = svgEl.querySelector('.hover-dot');
    if (guide) { guide.setAttribute('x1', xAt); guide.setAttribute('x2', xAt); guide.style.display = ''; }
    if (dot) { dot.setAttribute('cx', xAt); dot.setAttribute('cy', yAt); dot.style.display = ''; }

    const wrap = svgEl.closest('.chart-wrap');
    const tip = wrap && wrap.querySelector('.chart-tip');
    if (tip) {
      const fmtV = valueFormatter(kind);
      const unit = kind === 'usd' ? '' : ' calls';
      tip.innerHTML = '<div class="tip-date">' + formatFullDate(point.d, gran) + '</div><div class="tip-val">' + fmtV(point.v) + unit + '</div>';
      const leftPct = (xAt / W) * 100;
      tip.style.left = leftPct + '%';
      tip.style.transform = leftPct > 65 ? 'translateX(calc(-100% - 6px))' : 'translateX(6px)';
      tip.style.display = 'block';
    }
  } catch (e) {}
}

function chartLeave(svgEl) {
  const guide = svgEl.querySelector('.hover-guide');
  const dot = svgEl.querySelector('.hover-dot');
  if (guide) guide.style.display = 'none';
  if (dot) dot.style.display = 'none';
  const wrap = svgEl.closest('.chart-wrap');
  const tip = wrap && wrap.querySelector('.chart-tip');
  if (tip) tip.style.display = 'none';
}

function controlsBar() {
  const frames = [[7, '7d'], [30, '30d'], [90, '90d'], [365, '1y']];
  const chips = frames.map(([days, label]) =>
    \`<button class="seg-btn \${state.days === days ? 'active' : ''}" aria-pressed="\${state.days === days}" onclick="setTimeframe(\${days})">\${label}</button>\`
  ).join('');
  const views = [['line', '⟋ line'], ['bar', '▥ bars']];
  const viewChips = views.map(([v, label]) =>
    \`<button class="seg-btn \${state.view === v ? 'active' : ''}" aria-pressed="\${state.view === v}" onclick="setView('\${v}')">\${label}</button>\`
  ).join('');
  const sources = [[false, 'external'], [true, '+ internal']];
  const sourceChips = sources.map(([on, label]) =>
    \`<button class="seg-btn \${state.internal === on ? 'active' : ''}" aria-pressed="\${state.internal === on}" onclick="setInternal(\${on})">\${label}</button>\`
  ).join('');
  return \`<div class="controls-bar">
    <div class="seg-group">\${chips}</div>
    <div class="seg-group">\${viewChips}</div>
    <div class="seg-group" title="external = real demand only; + internal also counts our own dev/testing traffic">\${sourceChips}</div>
  </div>\`;
}

function render(d) {
  lastData = d;
  const cv = conversion(d.payment_breakdown);

  const callsDaily = zeroFillDaily(d.calls_by_day, 'calls', 365);
  const revDaily = zeroFillDaily(d.revenue_by_day, 'revenue', 365);

  const callsWindow = callsDaily.slice(365 - state.days);
  const revWindow = revDaily.slice(365 - state.days);
  const callsPlot = state.days === 365 ? bucketWeekly(callsWindow) : callsWindow;
  const revPlot = state.days === 365 ? bucketWeekly(revWindow) : revWindow;
  const granularity = state.days === 365 ? 'week' : 'day';

  const callsSum = sumSeries(callsWindow);
  const revSum = sumSeries(revWindow);
  const callsDelta = windowDelta(callsDaily, state.days);
  const revDelta = windowDelta(revDaily, state.days);

  const html = \`
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Calls · \${tfLabel(state.days)}</div>
        <div class="kpi-value accent">\${fmt(callsSum, 0)}\${deltaBadge(callsDelta)}</div>
        <div class="kpi-sub">MCP tool calls</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Revenue · \${tfLabel(state.days)}</div>
        <div class="kpi-value green">\${fmtUsd(revSum)}\${deltaBadge(revDelta)}</div>
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
        <div class="kpi-sub">\${cv.paid} paid / \${cv.total} prompted · 30d</div>
      </div>
    </div>

    \${controlsBar()}

    <div class="grid2">
      <div class="card">
        <h3>Calls</h3>
        \${timeChart(callsPlot, { color: '#2f81f7', kind: 'num', granularity })}
      </div>
      <div class="card">
        <h3>Revenue (USDC)</h3>
        \${timeChart(revPlot, { color: '#3fb950', kind: 'usd', granularity })}
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
        <div class="stat-row"><span>Avg / p50 / p95 latency</span><span class="stat-val">\${d.summary.avg_latency_ms} / \${d.summary.p50_latency_ms} / \${d.summary.p95_latency_ms} ms</span></div>
      </div>
    </div>

    <div class="grid-wide">
      <div class="card">
        <h3>Recent errors · 30d</h3>
        \${errorTable(d.recent_errors)}
      </div>
      <div class="card">
        <h3>Error rate by tool · 30d</h3>
        \${errorRateChart(d.error_rate_by_tool)}
      </div>
    </div>
  \`;
  document.getElementById('root').innerHTML = html;
}

async function load() {
  document.getElementById('last-updated').textContent = 'loading…';
  try {
    const res = await fetch('/analytics/data' + (state.internal ? '?include_internal=1' : ''));
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
