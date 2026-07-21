/**
 * Fase 22.3 — private interactive panel for the X Agent content queue.
 * Same pattern as src/analytics/panel.ts: one HTML string, CSS+JS inline,
 * fetches its API with no credentials of its own — Cloudflare Access
 * (mcp.toolsnap.app/x-agent*) puts the session cookie on every request.
 *
 * Calendar week math (mondayOf/addDays) runs in the BROWSER's local
 * timezone — a reasonable assumption since the only real user is Unai
 * viewing this from Europe/Madrid. Display formatting of individual
 * timestamps still goes through Intl with timeZone:'Europe/Madrid'
 * explicitly, so times shown are always correct regardless of that
 * assumption.
 */

export const X_PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>toolsnap x-agent</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/img/favicon-32.png" sizes="32x32" type="image/png">
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
  header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  header h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.2px; display: flex; align-items: center; }
  header span { font-size: 11px; color: var(--muted); font-family: var(--font-mono); }
  .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); margin-left: 8px; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 7px; cursor: pointer; font: 12px var(--font-ui); transition: border-color 0.15s ease; }
  .btn:hover { border-color: var(--accent); }
  .btn:active { transform: scale(0.97); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.danger { background: #2d1b1b; border-color: var(--red); color: var(--red); }
  .btn.small { padding: 3px 9px; font-size: 11px; }
  main { padding: 20px 24px 60px; max-width: 1200px; margin: 0 auto; }
  .error { background: #2d1b1b; border: 1px solid var(--red); border-radius: 8px; padding: 16px; color: var(--red); margin-bottom: 20px; font-size: 13px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); margin-bottom: 20px; }
  .card h3 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; font-weight: 500; }
  .controls-bar { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .seg-group { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 3px; gap: 2px; }
  .seg-btn { background: transparent; border: none; color: var(--muted); font: 12px var(--font-ui); padding: 5px 11px; border-radius: 6px; cursor: pointer; }
  .seg-btn:hover:not(.active) { color: var(--text); }
  .seg-btn.active { background: var(--accent); color: #fff; }
  select, input[type=text], input[type=datetime-local], input[type=number], textarea {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 6px 8px; font: 12px var(--font-ui);
  }
  textarea { width: 100%; resize: vertical; font: 13px var(--font-ui); }
  label { font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px; }
  .field { margin-bottom: 12px; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .week-nav { display: flex; align-items: center; gap: 10px; }
  .week-label { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
  .cal-day { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 8px; min-height: 120px; }
  .cal-day-header { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 6px; text-align: center; }
  .cal-day-header.today { color: var(--accent); }
  .chip { display: block; width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--muted); border-radius: 6px; padding: 5px 7px; margin-bottom: 5px; cursor: pointer; font-size: 11px; color: var(--text); }
  .chip:hover { border-color: var(--accent); }
  .chip.offhours { opacity: 0.55; border-left-style: dashed; }
  .chip-time { font-family: var(--font-mono); color: var(--muted); margin-right: 4px; }
  .chip-series { color: var(--muted); font-size: 10px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 5px; }
  .badge.manual { background: var(--purple); color: #fff; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; z-index: 50; overflow-y: auto; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; max-width: 560px; width: 100%; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }
  .modal h2 { font-size: 14px; margin-bottom: 12px; }
  .modal .row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .modal .row:last-child { border-bottom: none; }
  .modal-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .modal-close { float: right; cursor: pointer; color: var(--muted); font-size: 18px; line-height: 1; }
  .sub-panel { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-top: 10px; }
  .thumb { width: 60px; height: 60px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); margin-right: 6px; }
  .table-scroll { overflow-x: auto; }
  .today-state { font-size: 16px; font-weight: 700; }
  .today-state-detail { font-size: 12px; color: var(--muted); }
  .week-strip { display: flex; gap: 6px; margin-top: 14px; }
  .week-pill { flex: 1; text-align: center; padding: 8px 4px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); }
  .week-pill.today { border-color: var(--accent); }
  .week-pill.off { opacity: 0.45; }
  .week-pill-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
  .week-pill.today .week-pill-label { color: var(--accent); }
  .week-pill-count { font-family: var(--font-mono); font-size: 14px; font-weight: 600; margin-top: 2px; }
  .stat-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .stat-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; font-size: 10px; }
  .stat-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); }
  .warn { color: var(--yellow); }
  .ok { color: var(--green); }
  .bad { color: var(--red); }
  .loading { text-align: center; padding: 40px 0; color: var(--muted); font-size: 13px; }
  @media (max-width: 900px) {
    .cal-grid { grid-template-columns: repeat(7, minmax(110px, 1fr)); overflow-x: auto; }
    .form-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header>
  <h1>toolsnap · x-agent<span class="live-dot" title="live"></span></h1>
  <div style="display:flex;align-items:center;gap:12px">
    <div class="seg-group">
      <button class="seg-btn" id="tab-calendar" onclick="setTab('calendar')">Calendar</button>
      <button class="seg-btn" id="tab-replies" onclick="setTab('replies')">Replies</button>
    </div>
    <button class="btn" id="notif-btn" onclick="enablePushNotifications()">🔔 notifications</button>
    <span id="last-updated">loading…</span>
    <button class="btn" onclick="load()">↻ refresh</button>
  </div>
</header>
<main>
  <div id="root"><div class="loading">fetching queue…</div></div>
</main>
<script>
const ACCOUNT_COLORS = { product: '#2f81f7', personal: '#a371f7' };
const STATUS_COLORS = {
  draft: '#8b949e', pending_approval: '#d29922', scheduled: '#2f81f7', publishing: '#d29922',
  published: '#3fb950', rejected: '#f85149', canceled: '#8b949e', blocked: '#f85149', failed: '#f85149'
};
const KNOWN_SERIES = ['tool-spotlight', 'recipe-thread', 'build-in-public', 'changelog', 'cross-quote'];

const state = {
  tab: 'calendar', // 'calendar' | 'replies'
  weekStart: mondayOf(new Date()),
  filters: { status: '', account: '', series: '' },
  rows: [],
  stats: null,
  modalRowId: null,
  modalMode: null, // null | 'edit' | 'reschedule' | 'mark-published'
  newPost: { media_key: null, media_preview: null },
  replyCandidates: [],
  replyStatus: null
};

function setTab(tab) { state.tab = tab; load(); }

function mondayOf(d) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function toEpoch(d) { return Math.floor(d.getTime() / 1000); }

function madridParts(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = fmt.formatToParts(d);
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = parts.find(p => p.type === 'minute').value;
  return { hour, label: parts.find(p => p.type === 'hour').value + ':' + minute };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function weekLabel() {
  const start = state.weekStart, end = addDays(start, 6);
  const f = (d) => d.toLocaleDateString('en-GB', { timeZone: 'Europe/Madrid', day: '2-digit', month: 'short' });
  return f(start) + ' – ' + f(end);
}

function prevWeek() { state.weekStart = addDays(state.weekStart, -7); load(); }
function nextWeek() { state.weekStart = addDays(state.weekStart, 7); load(); }
function thisWeek() { state.weekStart = mondayOf(new Date()); load(); }

function setFilter(key, value) { state.filters[key] = value; renderAll(); }

function statusOptions() {
  return ['', 'pending_approval', 'scheduled', 'publishing', 'published', 'rejected', 'canceled', 'blocked', 'failed'];
}

function controlsBar() {
  const statuses = statusOptions().map(s => \`<option value="\${s}" \${state.filters.status === s ? 'selected' : ''}>\${s || 'all statuses'}</option>\`).join('');
  const accounts = ['', 'product', 'personal'].map(a => \`<option value="\${a}" \${state.filters.account === a ? 'selected' : ''}>\${a || 'all accounts'}</option>\`).join('');
  return \`<div class="controls-bar">
    <div class="week-nav">
      <button class="btn small" onclick="prevWeek()">◀</button>
      <span class="week-label">\${weekLabel()}</span>
      <button class="btn small" onclick="nextWeek()">▶</button>
      <button class="btn small" onclick="thisWeek()">today</button>
    </div>
    <select onchange="setFilter('status', this.value)">\${statuses}</select>
    <select onchange="setFilter('account', this.value)">\${accounts}</select>
    <input type="text" placeholder="series filter…" value="\${esc(state.filters.series)}" oninput="setFilter('series', this.value)" style="width:140px">
  </div>\`;
}

function filteredRows() {
  return state.rows.filter(r => {
    if (state.filters.status && r.status !== state.filters.status) return false;
    if (state.filters.account && r.account !== state.filters.account) return false;
    if (state.filters.series && !(r.series || '').toLowerCase().includes(state.filters.series.toLowerCase())) return false;
    return true;
  });
}

function chip(row) {
  const t = madridParts(row.scheduled_at);
  const offhours = t.hour < 16 || t.hour >= 23;
  const manualBadge = row.published_via === 'manual' ? '<span class="badge manual">manual</span>' : '';
  return \`<button class="chip \${offhours ? 'offhours' : ''}" style="border-left-color:\${STATUS_COLORS[row.status] || '#555'}" onclick="openModal(\${row.id})">
    <span class="chip-time">\${t.label}</span>
    <span class="dot" style="background:\${ACCOUNT_COLORS[row.account] || '#555'}"></span>\${esc(row.account)}\${manualBadge}
    <div class="chip-series">\${esc(row.series || row.kind)} · \${esc(row.status)}</div>
  </button>\`;
}

function calendar() {
  const rows = filteredRows();
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const todayStr = new Date().toDateString();
  const cols = days.map((day, i) => {
    const dayStart = toEpoch(day), dayEnd = dayStart + 86400;
    const dayRows = rows.filter(r => r.scheduled_at >= dayStart && r.scheduled_at < dayEnd).sort((a, b) => a.scheduled_at - b.scheduled_at);
    const isToday = day.toDateString() === todayStr;
    const label = day.toLocaleDateString('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', day: '2-digit' });
    const chips = dayRows.length ? dayRows.map(chip).join('') : '<div style="color:var(--muted);font-size:11px;text-align:center;padding-top:10px">—</div>';
    return \`<div class="cal-day"><div class="cal-day-header \${isToday ? 'today' : ''}">\${label}</div>\${chips}</div>\`;
  }).join('');
  return \`<div class="cal-grid">\${cols}</div>\`;
}

function fmtWhen(row) {
  const d = new Date(row.scheduled_at * 1000);
  return d.toLocaleString('en-GB', { timeZone: 'Europe/Madrid', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' Madrid';
}

function tweetUrl(row) {
  if (!row.tweet_id || row.tweet_id.startsWith('dryrun_')) return null;
  return 'https://x.com/i/web/status/' + row.tweet_id;
}

// The post being replied to / quoted — distinct from tweetUrl(row), which is
// the id OF this row's own tweet (NULL for a manual reply/quote until Unai
// pastes it back in). Found 2026-07-21: a reply marked "published manually"
// had no way back to the original post in the panel, because the queue view
// only ever linked via tweet_id. reply_to_tweet_id/quote_tweet_id are always
// known up front (set at discovery/creation time), so this works in every
// status, not just published.
function originalPostUrl(row) {
  if (row.kind === 'reply' && row.reply_to_tweet_id) {
    return 'https://x.com/i/web/status/' + row.reply_to_tweet_id;
  }
  if (row.kind === 'quote' && row.quote_tweet_id) {
    return 'https://x.com/i/web/status/' + row.quote_tweet_id;
  }
  return null;
}

function modalActions(row) {
  const btns = [];
  const editableStates = ['pending_approval', 'scheduled'];
  if (row.status === 'pending_approval') {
    btns.push('<button class="btn primary small" onclick="doAction(' + row.id + ', \\'approve\\')">✅ Aprobar</button>');
    btns.push('<button class="btn danger small" onclick="doAction(' + row.id + ', \\'reject\\')">❌ Rechazar</button>');
  }
  if (editableStates.includes(row.status)) {
    btns.push('<button class="btn small" onclick="toggleModalMode(\\'edit\\')">✏️ Editar</button>');
    btns.push('<button class="btn small" onclick="toggleModalMode(\\'reschedule\\')">🗓 Reprogramar</button>');
    btns.push('<button class="btn small" onclick="doAction(' + row.id + ', \\'publish-now\\')">⚡ Publish now</button>');
    btns.push('<button class="btn small" onclick="toggleModalMode(\\'mark-published\\')">📝 Publicado manualmente</button>');
    btns.push('<button class="btn danger small" onclick="doCancel(' + row.id + ')">🚫 Cancelar</button>');
  }
  // A failed API attempt (e.g. X 403ing an automated quote/reply) can still
  // be recovered: Unai posts it by hand and marks it here so it counts as
  // published and picks up metrics once he pastes the tweet URL.
  if (row.status === 'failed') {
    btns.push('<button class="btn small" onclick="toggleModalMode(\\'mark-published\\')">📝 Publicado manualmente</button>');
  }
  return btns.join('');
}

function modalSubPanel(row) {
  if (state.modalMode === 'edit') {
    return \`<div class="sub-panel">
      <label>New text</label>
      <textarea id="edit-text" rows="4">\${esc(row.text || '')}</textarea>
      <div class="modal-actions"><button class="btn primary small" onclick="submitEdit(\${row.id})">Guardar</button><button class="btn small" onclick="toggleModalMode(null)">Cancelar</button></div>
    </div>\`;
  }
  if (state.modalMode === 'reschedule') {
    const iso = new Date(row.scheduled_at * 1000).toISOString().slice(0, 16);
    return \`<div class="sub-panel">
      <label>New date/time (local browser time)</label>
      <input type="datetime-local" id="reschedule-at" value="\${iso}">
      <div class="modal-actions"><button class="btn primary small" onclick="submitReschedule(\${row.id})">Reprogramar</button><button class="btn small" onclick="toggleModalMode(null)">Cancelar</button></div>
    </div>\`;
  }
  if (state.modalMode === 'mark-published') {
    return \`<div class="sub-panel">
      <p style="font-size:12px;margin-bottom:8px">1. Copia el texto y publícalo tú mismo en X. 2. Pega aquí el link del tweet (opcional — sin link no habrá métricas y se bloquearán los posts dependientes).</p>
      <button class="btn small" onclick="copyText(\${row.id})">📋 Copiar texto</button>
      <div class="field" style="margin-top:8px"><input type="text" id="tweet-url" placeholder="https://x.com/.../status/1234567890" style="width:100%"></div>
      <div class="modal-actions"><button class="btn primary small" onclick="submitMarkPublished(\${row.id})">Confirmar publicado</button><button class="btn small" onclick="toggleModalMode(null)">Cancelar</button></div>
    </div>\`;
  }
  return '';
}

function modal() {
  if (!state.modalRowId) return '';
  const row = state.rows.find(r => r.id === state.modalRowId);
  if (!row) return '';
  const link = tweetUrl(row);
  const originalLink = originalPostUrl(row);
  return \`<div class="overlay" onclick="if(event.target===this) closeModal()">
    <div class="modal">
      <span class="modal-close" onclick="closeModal()">×</span>
      <h2>#\${row.id} · \${esc(row.account)} · \${esc(row.kind)}</h2>
      <div class="row"><span>Status</span><span style="color:\${STATUS_COLORS[row.status]}">\${esc(row.status)}\${row.published_via === 'manual' ? ' <span class="badge manual">manual</span>' : ''}</span></div>
      <div class="row"><span>Series</span><span>\${esc(row.series || '—')}</span></div>
      <div class="row"><span>Scheduled</span><span>\${fmtWhen(row)}</span></div>
      <div class="row"><span>Approval mode</span><span>\${esc(row.approval_mode)}</span></div>
      \${row.depends_on ? '<div class="row"><span>Depends on</span><span>#' + row.depends_on + '</span></div>' : ''}
      \${originalLink ? '<div class="row"><span>Post original</span><span><a href="' + originalLink + '" target="_blank" style="color:var(--accent)">abrir post original ↗</a></span></div>' : ''}
      \${link ? '<div class="row"><span>Tweet</span><span><a href="' + link + '" target="_blank" style="color:var(--accent)">open on X ↗</a></span></div>' : ''}
      <div style="margin-top:10px;padding:10px;background:var(--bg);border-radius:8px;font-size:13px;white-space:pre-wrap">\${esc(row.text || '(sin texto — repost puro)')}</div>
      <div class="modal-actions">\${modalActions(row)}</div>
      \${modalSubPanel(row)}
    </div>
  </div>\`;
}

function openModal(id) { state.modalRowId = id; state.modalMode = null; renderAll(); }
function closeModal() { state.modalRowId = null; state.modalMode = null; renderAll(); }
function toggleModalMode(mode) { state.modalMode = state.modalMode === mode ? null : mode; renderAll(); }

function copyText(id) {
  const row = state.rows.find(r => r.id === id);
  if (row && row.text) navigator.clipboard.writeText(row.text).catch(() => {});
}

async function apiPost(path, body) {
  const res = await fetch('/x-agent/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

async function doAction(id, action) {
  const r = await apiPost('/queue/' + id + '/' + action);
  if (!r.ok) { alert('Error: ' + JSON.stringify(r.json)); return; }
  closeModal();
  load();
}

async function doCancel(id) {
  if (!confirm('¿Cancelar este post? No se podrá deshacer.')) return;
  await doAction(id, 'cancel');
}

async function submitEdit(id) {
  const text = document.getElementById('edit-text').value.trim();
  if (!text) return;
  const r = await apiPost('/queue/' + id + '/edit', { text });
  if (!r.ok) { alert('Error: ' + JSON.stringify(r.json)); return; }
  closeModal();
  load();
}

async function submitReschedule(id) {
  const val = document.getElementById('reschedule-at').value;
  if (!val) return;
  const scheduled_at = Math.floor(new Date(val).getTime() / 1000);
  const r = await apiPost('/queue/' + id + '/reschedule', { scheduled_at });
  if (!r.ok) { alert('Error: ' + JSON.stringify(r.json)); return; }
  closeModal();
  load();
}

async function submitMarkPublished(id) {
  const tweet_url = document.getElementById('tweet-url').value.trim();
  if (!tweet_url && !confirm('Sin link no habrá métricas y los posts dependientes quedarán bloqueados. ¿Continuar?')) return;
  const r = await apiPost('/queue/' + id + '/mark-published', { tweet_url: tweet_url || undefined });
  if (!r.ok) { alert('Error: ' + JSON.stringify(r.json)); return; }
  closeModal();
  load();
}

// ---------------------------------------------------------------------------
// New post form
// ---------------------------------------------------------------------------

function seriesDatalist() {
  const known = new Set(KNOWN_SERIES);
  state.rows.forEach(r => { if (r.series) known.add(r.series); });
  return Array.from(known).map(s => '<option value="' + esc(s) + '">').join('');
}

function newPostForm() {
  const nowLocal = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 16);
  const thumb = state.newPost.media_preview ? '<img class="thumb" src="' + state.newPost.media_preview + '">' : '';
  return \`<div class="card">
    <h3>New post</h3>
    <div class="form-grid">
      <div class="field"><label>Account</label>
        <select id="np-account"><option value="product">product (@ToolSnapMCP)</option><option value="personal">personal (@icosaedro_one)</option></select>
      </div>
      <div class="field"><label>Kind</label>
        <select id="np-kind"><option value="post">post</option><option value="quote">quote</option><option value="reply">reply</option><option value="thread_part">thread_part</option><option value="repost">repost</option></select>
      </div>
      <div class="field"><label>Series</label>
        <input type="text" id="np-series" list="np-series-list" placeholder="tool-spotlight…">
        <datalist id="np-series-list">\${seriesDatalist()}</datalist>
      </div>
      <div class="field"><label>Approval mode</label>
        <select id="np-mode"><option value="batch">batch (L1 — publishes as scheduled)</option><option value="veto">veto (L2 — cancel-window notice)</option><option value="per_post">per_post (L0 — Telegram approval)</option></select>
      </div>
    </div>
    <div class="field"><label>Text</label>
      <textarea id="np-text" rows="3" oninput="document.getElementById('np-count').textContent = this.value.length"></textarea>
      <div style="text-align:right;font-size:11px;color:var(--muted)"><span id="np-count">0</span> chars</div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Image (optional, ≤ 5MB)</label>
        <input type="file" id="np-media" accept="image/jpeg,image/png,image/webp,image/gif" onchange="uploadNewPostMedia(this)">
        <div style="margin-top:6px">\${thumb}</div>
      </div>
      <div class="field">
        <label><input type="checkbox" id="np-publish-now" onchange="document.getElementById('np-when-wrap').style.display = this.checked ? 'none' : 'block'"> Publish now (next cron tick, ≤ 5 min)</label>
        <div id="np-when-wrap"><label>Scheduled at (local time)</label><input type="datetime-local" id="np-when" value="\${nowLocal}"></div>
      </div>
    </div>
    <button class="btn primary" onclick="submitNewPost()">Crear</button>
  </div>\`;
}

async function uploadNewPostMedia(input) {
  const file = input.files[0];
  if (!file) return;
  const res = await fetch('/x-agent/api/media', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
  const json = await res.json().catch(() => null);
  if (!res.ok) { alert('Error subiendo imagen: ' + JSON.stringify(json)); input.value = ''; return; }
  state.newPost.media_key = json.media_key;
  state.newPost.media_preview = URL.createObjectURL(file);
  renderAll();
}

async function submitNewPost() {
  const account = document.getElementById('np-account').value;
  const kind = document.getElementById('np-kind').value;
  const series = document.getElementById('np-series').value.trim();
  const approval_mode = document.getElementById('np-mode').value;
  const text = document.getElementById('np-text').value.trim();
  const publishNow = document.getElementById('np-publish-now').checked;
  const whenVal = document.getElementById('np-when').value;
  if (kind !== 'repost' && !text) { alert('Text is required'); return; }
  const scheduled_at = publishNow ? Math.floor(Date.now() / 1000) + 30 : Math.floor(new Date(whenVal).getTime() / 1000);
  const item = { account, kind, text: text || undefined, series: series || undefined, approval_mode, scheduled_at };
  if (state.newPost.media_key) item.media_keys = [state.newPost.media_key];
  const r = await apiPost('/queue', { approval_mode, items: [item] });
  if (!r.ok) { alert('Error: ' + JSON.stringify(r.json)); return; }
  if (publishNow) {
    const id = r.json.inserted && r.json.inserted[0] && r.json.inserted[0].id;
    if (id) await apiPost('/queue/' + id + '/publish-now');
  }
  state.newPost = { media_key: null, media_preview: null };
  load();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function statsSection() {
  if (!state.stats) return '<div class="card"><h3>Stats</h3><div class="loading">loading…</div></div>';
  const rates = state.stats.correction_rates || [];
  const eng = state.stats.engagement || [];
  const rateRows = rates.length ? rates.map(r => {
    const cls = r.rate < 20 ? 'ok' : r.rate < 40 ? 'warn' : 'bad';
    return '<tr><td>' + esc(r.series) + '</td><td>' + esc(r.account) + '</td><td>' + r.total + '</td><td class="' + cls + '">' + r.rate + '%</td></tr>';
  }).join('') : '<tr><td colspan="4" style="color:var(--muted)">no data yet</td></tr>';
  const engRows = eng.length ? eng.map(e =>
    '<tr><td>' + esc(e.series) + '</td><td>' + esc(e.account) + '</td><td>' + e.n + '</td><td>' + Math.round(e.avg_impressions || 0) + '</td><td>' + Math.round(e.avg_likes || 0) + '</td><td>' + Math.round(e.avg_reposts || 0) + '</td></tr>'
  ).join('') : '<tr><td colspan="6" style="color:var(--muted)">no metrics yet</td></tr>';
  return \`<div class="card">
    <h3>Correction rate by series · promotion threshold &lt;20%</h3>
    <div class="table-scroll"><table class="stat-table"><thead><tr><th>Series</th><th>Account</th><th>N</th><th>Rate</th></tr></thead><tbody>\${rateRows}</tbody></table></div>
  </div>
  <div class="card">
    <h3>Engagement by series (avg)</h3>
    <div class="table-scroll"><table class="stat-table"><thead><tr><th>Series</th><th>Account</th><th>N</th><th>Impr.</th><th>Likes</th><th>Reposts</th></tr></thead><tbody>\${engRows}</tbody></table></div>
  </div>\`;
}

// ---------------------------------------------------------------------------
// Fase 22.4 — reply-guy tab: candidates list, pause/resume, budget/cap status.
// Reply rows are ordinary x_queue rows (kind='reply') under the hood, so the
// action buttons reuse the same /queue/:id/(approve|reject|mark-published)
// endpoints the calendar modal already calls.
// ---------------------------------------------------------------------------

function candidateStatusBadge(c) {
  const s = c.queue_status || c.status;
  const color = s === 'published' ? 'var(--green)' : s === 'pending_approval' ? 'var(--yellow)' : s === 'rejected' || s === 'canceled' || s === 'failed' ? 'var(--red)' : 'var(--muted)';
  return '<span style="color:' + color + '">' + esc(s) + '</span>';
}

function candidateRow(c) {
  const link = c.tweet_url || ('https://x.com/i/web/status/' + c.tweet_id);
  const text = c.queue_text || c.draft_reply || '';
  // Fase 22.4 fix (2026-07-11): a real X 403 ("not allowed to reply unless
  // mentioned/engaged by the author") showed a failure has no dead end —
  // 'failed' rows can still be marked published-by-hand, same button as
  // pending_approval, just without approve/reject (the API attempt already
  // happened and won't be retried automatically for a non-retryable error).
  const actions = c.queue_status === 'pending_approval'
    ? '<button class="btn small primary" onclick="replyAction(' + c.queue_id + ', \\'approve\\')">✅</button> ' +
      '<button class="btn small" onclick="replyAction(' + c.queue_id + ', \\'mark-published\\', {})">📋</button> ' +
      '<button class="btn small danger" onclick="replyAction(' + c.queue_id + ', \\'reject\\')">❌</button>'
    : c.queue_status === 'failed'
    ? '<button class="btn small" onclick="replyAction(' + c.queue_id + ', \\'mark-published\\', {})">📋 publicada a mano</button>'
    : '';
  return \`<tr>
    <td>\${new Date(c.created_at * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Madrid', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
    <td>@\${esc(c.author_handle || '?')} <span style="color:var(--muted)">(\${(c.author_followers || 0).toLocaleString()})</span></td>
    <td>\${c.score ?? '—'}</td>
    <td style="max-width:320px;white-space:normal">\${esc(text)}</td>
    <td><a href="\${link}" target="_blank" style="color:var(--accent)">open ↗</a></td>
    <td>\${candidateStatusBadge(c)}</td>
    <td>\${actions}</td>
  </tr>\`;
}

const PAUSE_FOREVER_TS = 32503680000; // year 3000 — matches discovery.ts's PAUSE_FOREVER_TS sentinel for /stop

// Fase: daily plan + weekly overview (2026-07-11) — "today" reflects
// discovery.ts's getDiscoveryStatus().today; sweeps have no fixed times (see
// discovery.ts's header comment), so this shows done/target + the earliest
// possible next sweep, never an invented schedule.
// Fase: status word made visually distinct (2026-07-11, Unai's request) —
// icon+word in a bigger/bolder/colored badge so the state reads at a glance
// instead of blending into the rest of the line's plain-size text.
const TODAY_STATE_STYLE = {
  active: { icon: '▶️', word: 'Active', color: 'var(--green)' },
  paused: { icon: '⏸', word: 'Paused', color: 'var(--accent)' },
  stopped: { icon: '⏹', word: 'Stopped', color: 'var(--red)' },
  off_today: { icon: '💤', word: 'Off today', color: 'var(--muted)' },
  quota_done: { icon: '✅', word: 'Quota done', color: 'var(--green)' },
  budget_reached: { icon: '💰', word: 'Budget reached', color: 'var(--yellow)' },
  cap_reached: { icon: '🧢', word: 'Cap reached', color: 'var(--yellow)' }
};

function fmtMadridTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function todayLine(rs) {
  const t = rs.today;
  if (!t) return '';
  const st = TODAY_STATE_STYLE[t.state] || { icon: '', word: t.state, color: 'var(--text)' };
  let badge = '<span class="today-state" style="color:' + st.color + '">' + st.icon + ' ' + esc(st.word) + '</span>';
  if (t.state === 'paused') badge += '<span class="today-state-detail">until ' + fmtMadridTime(rs.pausedUntil) + '</span>';
  else if (t.state === 'stopped') badge += '<span class="today-state-detail">(permanent)</span>';
  else if (t.state === 'off_today') badge += '<span class="today-state-detail">by design</span>';
  const parts = ['Sweeps: ' + t.sweepsDone + '/' + t.targetSweeps, 'Window ' + t.windowStartHour + '–' + t.windowEndHour + 'h'];
  if (t.nextSweepEarliest) parts.push('next not before ' + fmtMadridTime(t.nextSweepEarliest));
  return badge + parts.map(p => '<span>' + esc(p) + '</span>').join('');
}

function weekStrip(rs) {
  if (!rs.week) return '';
  const pills = rs.week.map(d =>
    '<div class="week-pill' + (d.isToday ? ' today' : '') + (d.sweeps === 0 ? ' off' : '') + '">' +
      '<div class="week-pill-label">' + esc(d.label) + '</div>' +
      '<div class="week-pill-count">' + (d.sweeps || '—') + '</div>' +
    '</div>'
  ).join('');
  return '<div class="week-strip">' + pills + '</div>';
}

function repliesSection() {
  const rs = state.replyStatus;
  const statusCard = rs ? \`<div class="card">
    <h3>Status</h3>
    <div class="controls-bar">
      \${todayLine(rs)}
      <span>Replies today: \${rs.counters.repliesQueued}/\${rs.config.dailyCap}</span>
      <span>Spend today: $\${rs.counters.spendUsd.toFixed(3)}/$\${rs.config.dailyBudgetUsd.toFixed(2)}</span>
      <button class="btn small" onclick="pauseReplies(2)">⏸ pause 2h</button>
      <button class="btn small danger" onclick="stopReplies()">⏹ stop</button>
      <button class="btn small" onclick="resumeReplies()">▶️ resume</button>
    </div>
    \${weekStrip(rs)}
  </div>\` : '';
  const rows = state.replyCandidates.length
    ? state.replyCandidates.map(candidateRow).join('')
    : '<tr><td colspan="7" style="color:var(--muted)">no candidates yet</td></tr>';
  return \`\${statusCard}
  <div class="card">
    <h3>Reply candidates (most recent first)</h3>
    <div class="table-scroll"><table class="stat-table"><thead><tr><th>When</th><th>Author</th><th>Score</th><th>Draft</th><th>Post</th><th>Status</th><th></th></tr></thead><tbody>\${rows}</tbody></table></div>
  </div>\`;
}

async function replyAction(id, action, body) {
  const r = body !== undefined ? await apiPost('/queue/' + id + '/' + action, body) : await apiPost('/queue/' + id + '/' + action);
  if (!r.ok) { alert('Error: ' + JSON.stringify(r.json)); return; }
  load();
}

async function pauseReplies(hours) {
  await apiPost('/replies/pause', { hours });
  load();
}
async function stopReplies() {
  await apiPost('/replies/pause', { forever: true });
  load();
}
async function resumeReplies() {
  await apiPost('/replies/resume');
  load();
}

// ---------------------------------------------------------------------------
// Web Push subscription (desktop notifications for new reply candidates).
// ---------------------------------------------------------------------------

async function enablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push notifications are not supported in this browser.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notification permission denied.'); return; }
    const reg = await navigator.serviceWorker.register('/x-agent-sw.js');
    const keyRes = await fetch('/x-agent/api/push/vapid-public-key');
    if (!keyRes.ok) { alert('Web Push not configured on the server yet.'); return; }
    const { public_key } = await keyRes.json();
    const applicationServerKey = Uint8Array.from(atob(public_key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    await fetch('/x-agent/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
    document.getElementById('notif-btn').textContent = '🔔 enabled';
  } catch (e) {
    alert('Could not enable push notifications: ' + e.message);
  }
}

// ---------------------------------------------------------------------------

function renderAll() {
  document.getElementById('tab-calendar').classList.toggle('active', state.tab === 'calendar');
  document.getElementById('tab-replies').classList.toggle('active', state.tab === 'replies');
  const html = state.tab === 'replies'
    ? repliesSection()
    : \`\${controlsBar()}
       <div class="card">\${calendar()}</div>
       \${newPostForm()}
       \${statsSection()}
       \${modal()}\`;
  document.getElementById('root').innerHTML = html;
}

async function load() {
  document.getElementById('last-updated').textContent = 'loading…';
  try {
    if (state.tab === 'replies') {
      const [candRes, statusRes] = await Promise.all([
        fetch('/x-agent/api/replies?limit=100'),
        fetch('/x-agent/api/replies/status')
      ]);
      state.replyCandidates = candRes.ok ? (await candRes.json()).candidates || [] : [];
      state.replyStatus = statusRes.ok ? await statusRes.json() : null;
      renderAll();
      document.getElementById('last-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
      return;
    }
    const from = toEpoch(state.weekStart);
    const to = from + 7 * 86400 - 1;
    const [queueRes, statsRes] = await Promise.all([
      fetch('/x-agent/api/queue?from=' + from + '&to=' + to + '&limit=500'),
      fetch('/x-agent/api/stats')
    ]);
    if (!queueRes.ok) {
      const txt = await queueRes.text();
      document.getElementById('root').innerHTML = '<div class="error">Error ' + queueRes.status + ': ' + esc(txt) + '</div>';
      return;
    }
    const queueData = await queueRes.json();
    state.rows = queueData.rows || [];
    state.stats = statsRes.ok ? await statsRes.json() : null;
    renderAll();
    document.getElementById('last-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('root').innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  }
}

load();
setInterval(load, 60_000);
</script>
</body>
</html>`;
