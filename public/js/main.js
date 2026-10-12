// App shell: networking, panels, and wiring between the world, the mic and the server.
import { loadArt } from './assets.js';
import * as game from './game.js';
import * as voice from './voice.js';
import * as talk from './talk.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

let state = null;
let selected = null;   // session id | 'lidia' | null
let tab = null;        // which panel is open
const panel = $('#panel');
const body = $('#panel-body');

// ------------------------------------------------------------------ socket
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'state') { state = m.state; game.setState(state); refresh(); }
    else if (m.type === 'bubble') {
      game.bubble(m);
      if (m.who === 'lidia' && m.speak && state?.settings.speakLidia) voice.speak(m.text);
    } else if (m.type === 'report') game.report(m.sessionId);
    else if (m.type === 'alert') {
      const s = state?.sessions.find(x => x.id === m.sessionId);
      chime();
      toast(`! ${s?.name || 'A dweller'} needs you: ${m.text}`, () => openSession(m.sessionId));
      if (state?.settings.speakLidia) voice.speak(`Jav, ${s?.name || 'a dweller'} needs you.`);
    }
  };
  ws.onclose = () => { $('#conn').textContent = '● reconnecting'; setTimeout(connect, 1500); };
  ws.onopen = () => { $('#conn').textContent = ''; };
}

// ------------------------------------------------------------------ panels
const ARMORY = ['repos', 'connectors', 'skills'];
function open(t, sel = null) {
  if (t === 'base') return close();
  tab = t; selected = sel ?? (t === 'lidia' ? 'lidia' : null);
  game.select(selected);
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-open');
  const navTab = ARMORY.includes(t) ? 'connectors' : t === 'session' || t === 'new' ? null : t;
  document.querySelectorAll('#nav [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === navTab));
  $('#armory-tabs').hidden = !ARMORY.includes(t);
  document.querySelectorAll('#armory-tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  mount();
  refresh();
}
function close() {
  tab = null; selected = null; game.select(null);
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('sheet-open');
  document.querySelectorAll('#nav [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'base'));
}
function openLidia(start) {
  game.select('lidia');
  document.querySelectorAll('#nav [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'lidia'));
  talk.openTalk(start);
}
function openSession(id) { open('session', id); game.focusOn(id, sheetInset()); }
const sheetInset = () => (innerWidth < 900 ? panel.offsetHeight : 0);

$('#panel-close').onclick = close;
document.querySelectorAll('#nav [data-tab], #armory-tabs [data-tab]').forEach(b => b.onclick = () => {
  const t = b.dataset.tab;
  if (t === 'lidia') { close(); return openLidia(); }
  if (b.closest('#nav') && (tab === t || (ARMORY.includes(tab) && b.hasAttribute('data-armory')))) return close();
  open(t);
});
$('#btn-new').onclick = () => open('new');
$('#stats').onclick = () => (tab === 'ledger' ? close() : open('ledger'));
$('#zoom-in').onclick = () => game.zoomBy(1.2);
$('#zoom-out').onclick = () => game.zoomBy(1 / 1.2);
$('#home').onclick = () => game.focusOn('lidia', tab ? sheetInset() : 0);

// Swipe the sheet down by its header to close it.
(() => {
  const head = $('.panel-head');
  let y0 = null;
  head.addEventListener('pointerdown', (e) => { if (innerWidth >= 900 || e.target.closest('button')) return; y0 = e.clientY; panel.classList.add('drag'); head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (y0 == null) return; panel.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; });
  const end = (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0; y0 = null;
    panel.classList.remove('drag'); panel.style.transform = '';
    if (dy > 80) close();
  };
  head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
})();

// Static part of each panel (forms). Rebuilt only when the tab/selection changes.
function mount() {
  const M = {
    session: mountSession, lidia: mountLidia, new: mountNew, repos: mountRepos,
    connectors: mountConnectors, skills: mountSkills, settings: mountSettings, ledger: mountLedger,
  }[tab];
  body.innerHTML = '';
  M?.();
}

// Live parts. Called on every state push.
function refresh() {
  if (!state) return;
  talk.update(state);
  renderTopbar();
  renderFeed();
  if (!tab) return;
  ({ session: refreshSession, lidia: refreshLidia, repos: refreshRepos, connectors: refreshConnectors,
     skills: refreshSkills, new: refreshNew, ledger: refreshLedger })[tab]?.();
}

function renderTopbar() {
  const alerts = state.sessions.filter(s => s.status === 'needs_jav').length;
  const month = monthSpend();
  $('#stats').innerHTML = `${state.sessions.length} alive${alerts ? ` · <b class="red">${alerts}!</b>` : ''} · <u>$${month.total.toFixed(2)}</u>${state.mock ? ' · <i>mock</i>' : ''}`;
  document.title = alerts ? `(${alerts}!) Underground Fortress` : 'Underground Fortress';
  const base = $('#nav [data-tab="base"]');
  base.querySelector('.badge')?.remove();
  if (alerts) base.insertAdjacentHTML('beforeend', `<span class="badge">${alerts}</span>`);
}

const monthKey = () => new Date().toISOString().slice(0, 7);
const monthSpend = () => state.spend?.months?.[monthKey()] || { total: 0, lidia: 0, agents: {} };
const money = (v) => `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

function renderFeed() {
  const item = (f) => `<div class="feed-${esc(f.kind)}" ${f.sessionId ? `data-sid="${esc(f.sessionId)}"` : ''}>${esc(f.text)}</div>`;
  $('#feed').innerHTML = state.feed.slice(-6).map(item).join('');
  const last = state.feed[state.feed.length - 1];
  $('#ticker').innerHTML = last ? item(last) : '';
  document.querySelectorAll('#feed [data-sid], #ticker [data-sid]').forEach(el => el.onclick = () => openSession(el.dataset.sid));
}

// ---- session
const MODEL_OPTS = [['', 'Fortress default'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (latest)'],
  ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']];
const STATUS_LABEL = { idle: 'Idle', working: 'Working', reporting: 'Reporting to Lidia', needs_jav: 'Needs you', done: 'Done', error: 'Error' };

function mountSession() {
  body.innerHTML = `
    <div id="s-head"></div>
    <div id="s-alert"></div>
    <div id="s-log" class="log"></div>
    <form id="s-form" class="composer">
      <textarea id="s-input" rows="1" placeholder="Orders for this survivor…"></textarea>
      <button type="button" class="mic-inline" title="Speak"><span class="mic-ico"></span></button>
      <button type="submit" class="primary">SEND</button>
    </form>
    <details class="sub"><summary>Room settings</summary><div id="s-settings"></div></details>`;
  const form = $('#s-form'), input = $('#s-input');
  form.onsubmit = async (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ''; await api('POST', `/api/sessions/${selected}/message`, { text: t }); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); } };
  $('.mic-inline', form).onclick = () => startMic();
  mountSessionSettings();
}

function mountSessionSettings() {
  const s = state?.sessions.find(x => x.id === selected);
  if (!s) return;
  $('#s-settings').innerHTML = `
    <label>Name <input id="ss-name" value="${esc(s.name)}"></label>
    <label>Goal <textarea id="ss-goal" rows="3">${esc(s.goal)}</textarea></label>
    <label>Room <select id="ss-room">${['workshop', 'library', 'server', 'lab'].map(r => `<option ${r === s.roomType ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    <label>Model <select id="ss-model">${MODEL_OPTS.map(([v, l]) => `<option value="${v}" ${v === (s.model || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Repository <select id="ss-repo"><option value="">(own workspace)</option>${state.repos.map(r => `<option value="${r.id}" ${r.id === s.repoId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    <div class="row"><button id="ss-save" class="primary">Save</button><button id="ss-stop">Stop turn</button><button id="ss-del" class="danger">Evict</button></div>
    <p class="muted">Claude session id: <code>${esc(s.sdkSessionId || '—')}</code></p>`;
  $('#ss-save').onclick = () => api('PATCH', `/api/sessions/${s.id}`, { name: $('#ss-name').value, goal: $('#ss-goal').value, roomType: $('#ss-room').value, repoId: $('#ss-repo').value || null, model: $('#ss-model').value });
  $('#ss-stop').onclick = () => api('POST', `/api/sessions/${s.id}/stop`);
  $('#ss-del').onclick = async () => { if (confirm(`Evict ${s.name}? Their room is torn down.`)) { await api('DELETE', `/api/sessions/${s.id}`); close(); } };
}

function refreshSession() {
  const s = state.sessions.find(x => x.id === selected);
  if (!s) { close(); return; }
  $('#panel-title').textContent = s.name;
  $('#s-head').innerHTML = `<div class="chips"><span class="chip st-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
    <span class="chip">${esc(s.roomType)}</span><span class="chip">${esc(s.model || 'default model')}</span><span class="chip">${esc(s.activity || '')}</span><span class="chip">would-cost $${(s.costUsd || 0).toFixed(2)}</span></div>
    ${s.goal ? `<p class="goal"><b>Goal:</b> ${esc(s.goal)}</p>` : ''}`;
  let alert = '';
  if (s.pendingPermission) {
    alert = `<div class="alert"><b>${esc(s.name)} asks permission</b> to use <code>${esc(s.pendingPermission.tool)}</code>
      <pre>${esc(s.pendingPermission.input)}</pre>
      <div class="row"><button class="primary" data-allow="1">Allow</button><button class="danger" data-allow="0">Deny</button></div></div>`;
  } else if (s.pendingQuestion) {
    alert = `<div class="alert"><b>Lidia doesn't know how to continue:</b><p>${esc(s.pendingQuestion)}</p><p class="muted">Your answer goes to ${esc(s.name)}, and Lidia remembers it for next time.</p></div>`;
  }
  $('#s-alert').innerHTML = alert;
  $('#s-alert').querySelectorAll('[data-allow]').forEach(b => b.onclick = () =>
    api('POST', `/api/sessions/${s.id}/permission`, { permissionId: s.pendingPermission.id, allow: b.dataset.allow === '1' }));
  renderLog($('#s-log'), s.log);
}

const ROLE = { jav: 'Jav', lidia: 'Lidia', claude: 'Dweller', tool: 'Tool', system: 'System' };
function renderLog(el, log) {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = log.map(e => `<div class="msg m-${e.role}"><span class="who">${ROLE[e.role] || e.role}${e.tool ? ` · ${esc(e.tool)}` : ''}</span><div>${esc(e.text)}</div></div>`).join('')
    || '<p class="muted">No activity yet. Give this dweller something to do.</p>';
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ---- Lidia
function mountLidia() {
  $('#panel-title').textContent = 'Standing orders';
  body.innerHTML = `
    <p class="muted">Lidia judges every report against these orders and your past answers. Text her from the LIDIA tab.</p>
    <textarea id="l-orders" rows="6"></textarea>
    <div class="row"><button id="l-save" class="primary">SAVE ORDERS</button>
      <label class="inline"><input type="checkbox" id="l-auto"> Autopilot</label></div>
    <p class="muted small">Autopilot on: Lidia answers finished agents herself. Off: they wait for you.</p>
    <h4>What Lidia learned from you</h4><div id="l-prec"></div>`;
  $('#l-orders').value = state.standingOrders;
  $('#l-auto').checked = state.settings.lidiaAutopilot;
  $('#l-auto').onchange = (e) => api('PATCH', '/api/settings', { lidiaAutopilot: e.target.checked });
  $('#l-save').onclick = () => api('PUT', '/api/orders', { text: $('#l-orders').value }).then(() => toast('Orders saved'));
}
function refreshLidia() {
  $('#l-prec').innerHTML = state.precedents.slice().reverse().map(p => `<div class="prec"><b>${esc(p.session)}:</b> ${esc(p.question)}<br>→ ${esc(p.answer)}</div>`).join('') || '<p class="muted">Nothing yet. Answer a red agent and it shows up here.</p>';
}

// ---- new dweller
function mountNew() {
  $('#panel-title').textContent = 'Excavate room';
  body.innerHTML = `
    <p class="muted">Every dweller is a full Claude Code session with its own room. Their workspace is their own folder, or a repository you connected.</p>
    <form id="n-form" class="stack">
      <label>Name <input id="n-name" placeholder="e.g. Builder" required></label>
      <label>First task / goal <textarea id="n-goal" rows="4" placeholder="What should they work on? Leave empty to brief them later."></textarea></label>
      <label>Room <select id="n-room"><option value="workshop">Workshop (building)</option><option value="library">Library (research)</option><option value="server">Server room (ops)</option><option value="lab">Laboratory (experiments)</option></select></label>
      <label>Repository <select id="n-repo"></select></label>
      <button class="primary" type="submit">⛏ Dig room &amp; move in</button>
    </form>`;
  $('#n-form').onsubmit = async (e) => {
    e.preventDefault();
    const s = await api('POST', '/api/sessions', { name: $('#n-name').value, goal: $('#n-goal').value, roomType: $('#n-room').value, repoId: $('#n-repo').value || null });
    // The socket update may land after this; don't let the panel think the dweller is gone.
    if (!state.sessions.some(x => x.id === s.id)) { state.sessions.push(s); game.setState(state); }
    openSession(s.id);
  };
  refreshNew();
}
function refreshNew() {
  const sel = $('#n-repo'); if (!sel || document.activeElement === sel) return;
  const v = sel.value;
  sel.innerHTML = `<option value="">(own workspace)</option>` + state.repos.filter(r => r.status === 'ready').map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  sel.value = v;
}

// ---- repos
function mountRepos() {
  $('#panel-title').textContent = 'Armory';
  body.innerHTML = `
    <p class="muted">Repos are cloned on this machine with your own git credentials and can be assigned to any room.</p>
    <form id="r-form" class="row"><input id="r-url" placeholder="owner/repo or https://github.com/owner/repo.git" required><button class="primary">Connect</button></form>
    <div id="r-list"></div>`;
  $('#r-form').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/repos', { url: $('#r-url').value }); $('#r-url').value = ''; } catch (err) { toast(err.message); } };
}
function refreshRepos() {
  $('#r-list').innerHTML = state.repos.map(r => `<div class="card"><div><b>${esc(r.name)}</b> <span class="chip st-${r.status === 'ready' ? 'done' : r.status === 'error' ? 'needs_jav' : 'working'}">${esc(r.status)}</span>
    <div class="muted small">${esc(r.url)}</div>${r.error ? `<pre>${esc(r.error)}</pre>` : ''}
    <div class="muted small">Rooms: ${esc(state.sessions.filter(s => s.repoId === r.id).map(s => s.name).join(', ') || 'none')}</div></div>
    <button data-del="${r.id}" class="danger small">Disconnect</button></div>`).join('') || '<p class="muted">No repositories yet.</p>';
  $('#r-list').querySelectorAll('[data-del]').forEach(b => b.onclick = () => api('DELETE', `/api/repos/${b.dataset.del}`));
}

// ---- connectors
function mountConnectors() {
  $('#panel-title').textContent = 'Armory';
  body.innerHTML = `
    <p class="muted">Connectors are MCP servers. Every enabled connector is available to every dweller.</p>
    <h4>Connected</h4><div id="c-list"></div>
    <h4>Quick add</h4><div id="c-catalog" class="grid"></div>
    <h4>Find any app</h4>
    <form id="c-search" class="row"><input id="c-q" placeholder="Search the MCP registry: slack, gmail, figma…"><button>Search</button></form>
    <div id="c-results"></div>
    <details class="sub"><summary>Add a custom server</summary>
      <form id="c-custom" class="stack">
        <label>Name <input id="cc-name" required></label>
        <label>Type <select id="cc-type"><option value="http">http</option><option value="sse">sse</option><option value="stdio">stdio (local command)</option></select></label>
        <label>URL (http/sse) <input id="cc-url"></label>
        <label>Command (stdio) <input id="cc-cmd" placeholder="npx"></label>
        <label>Args (stdio, space separated) <input id="cc-args" placeholder="-y @scope/server"></label>
        <label>Bearer token (optional) <input id="cc-token" type="password"></label>
        <button class="primary">Add</button>
      </form></details>`;
  api('GET', '/api/connectors/catalog').then(cat => {
    $('#c-catalog').innerHTML = cat.map((c, i) => `<button class="tile" data-i="${i}"><b>${esc(c.label)}</b><span>${esc(c.auth)}</span></button>`).join('');
    $('#c-catalog').querySelectorAll('[data-i]').forEach(b => b.onclick = () => addConnector(cat[b.dataset.i]));
  });
  $('#c-search').onsubmit = async (e) => {
    e.preventDefault();
    $('#c-results').innerHTML = '<p class="muted">Searching…</p>';
    try {
      const res = await api('GET', `/api/connectors/search?q=${encodeURIComponent($('#c-q').value)}`);
      $('#c-results').innerHTML = res.map((c, i) => `<div class="card"><div><b>${esc(c.label)}</b> <span class="chip">${esc(c.type)}</span><div class="muted small">${esc(c.description).slice(0, 160)}</div></div><button data-i="${i}" class="small">Connect</button></div>`).join('') || '<p class="muted">Nothing found.</p>';
      $('#c-results').querySelectorAll('[data-i]').forEach(b => b.onclick = () => addConnector(res[b.dataset.i]));
    } catch (err) { $('#c-results').innerHTML = `<p class="red">${esc(err.message)}</p>`; }
  };
  $('#c-custom').onsubmit = (e) => {
    e.preventDefault();
    addConnector({ name: $('#cc-name').value, type: $('#cc-type').value, url: $('#cc-url').value, command: $('#cc-cmd').value,
                   args: $('#cc-args').value.split(' ').filter(Boolean) }, $('#cc-token').value);
  };
}
async function addConnector(c, token) {
  if (token === undefined && c.type !== 'stdio') token = prompt(`Token for ${c.label || c.name}? (leave empty if it uses no auth or OAuth)`) || '';
  try { await api('POST', '/api/connectors', { ...c, token: token || undefined }); toast(`${c.label || c.name} connected`); }
  catch (err) { toast(err.message); }
}
function refreshConnectors() {
  $('#c-list').innerHTML = state.connectors.map(c => `<div class="card"><div><b>${esc(c.label)}</b> <span class="chip">${esc(c.type)}</span> ${c.hasToken ? '<span class="chip">🔑 token</span>' : ''}
      <div class="muted small">${esc(c.url || `${c.command} ${(c.args || []).join(' ')}`)}</div></div>
      <div class="row"><label class="inline"><input type="checkbox" data-tog="${c.id}" ${c.enabled ? 'checked' : ''}> on</label>
      <button data-tok="${c.id}" class="small">Token</button><button data-del="${c.id}" class="danger small">✕</button></div></div>`).join('') || '<p class="muted">No connectors yet.</p>';
  $('#c-list').querySelectorAll('[data-tog]').forEach(b => b.onchange = () => api('PATCH', `/api/connectors/${b.dataset.tog}`, { enabled: b.checked }));
  $('#c-list').querySelectorAll('[data-tok]').forEach(b => b.onclick = () => { const t = prompt('New bearer token'); if (t) api('PATCH', `/api/connectors/${b.dataset.tok}`, { token: t }); });
  $('#c-list').querySelectorAll('[data-del]').forEach(b => b.onclick = () => api('DELETE', `/api/connectors/${b.dataset.del}`));
}

// ---- skills
function mountSkills() {
  $('#panel-title').textContent = 'Armory';
  body.innerHTML = `
    <p class="muted">Skills install to <code>~/.claude/skills</code>, so every dweller can use them.</p>
    <h4>Installed</h4><div id="k-list"></div>
    <h4>Skill finder</h4>
    <form id="k-form" class="stack">
      <div class="row"><input id="k-q" placeholder="Search: pdf, docx, design, testing…"><button class="primary">Find</button></div>
      <input id="k-repo" placeholder="Also search a GitHub repo (owner/name), optional">
    </form>
    <div id="k-results"></div>`;
  const run = async () => {
    $('#k-results').innerHTML = '<p class="muted">Searching the skill shelves…</p>';
    try {
      const r = await api('GET', `/api/skills/find?q=${encodeURIComponent($('#k-q').value)}&repo=${encodeURIComponent($('#k-repo').value)}`);
      $('#k-results').innerHTML = (r.errors.length ? `<p class="red">${esc(r.errors.join('; '))}</p>` : '') +
        (r.skills.map((k, i) => `<div class="card"><div><b>${esc(k.name)}</b> <span class="muted small">${esc(k.repo)}</span><div class="muted small">${esc(k.description).slice(0, 220)}</div></div>
          ${k.installed ? '<span class="chip st-done">installed</span>' : `<button data-i="${i}" class="small primary">Install</button>`}</div>`).join('') || '<p class="muted">No skills matched.</p>');
      $('#k-results').querySelectorAll('[data-i]').forEach(b => b.onclick = async () => {
        b.disabled = true; b.textContent = '…';
        try { const k = r.skills[b.dataset.i]; await api('POST', '/api/skills/install', { repo: k.repo, dir: k.dir }); b.outerHTML = '<span class="chip st-done">installed</span>'; }
        catch (err) { toast(err.message); b.disabled = false; b.textContent = 'Install'; }
      });
    } catch (err) { $('#k-results').innerHTML = `<p class="red">${esc(err.message)}</p>`; }
  };
  $('#k-form').onsubmit = (e) => { e.preventDefault(); run(); };
  run();
}
function refreshSkills() {
  $('#k-list').innerHTML = state.skills.map(k => `<div class="card"><div><b>${esc(k.name)}</b><div class="muted small">${esc(k.description).slice(0, 180)}</div></div><button data-del="${esc(k.dir)}" class="danger small">Remove</button></div>`).join('') || '<p class="muted">No skills installed yet.</p>';
  $('#k-list').querySelectorAll('[data-del]').forEach(b => b.onclick = () => confirm(`Remove ${b.dataset.del}?`) && api('DELETE', `/api/skills/${encodeURIComponent(b.dataset.del)}`));
}

// ---- ledger: what this would have cost at API prices
const PLANS = [['Claude Pro', 20], ['Claude Max 5x', 100], ['Claude Max 20x', 200]];
function mountLedger() {
  $('#panel-title').textContent = 'Ledger';
  body.innerHTML = `<div id="lg"></div>
    <label>Your plan <select id="lg-plan">${PLANS.map(([n, v]) => `<option value="${v}" ${state.plan.monthlyUsd === v ? 'selected' : ''}>${n} · $${v}/mo</option>`).join('')}</select></label>
    <p class="muted small">Every turn is priced by Claude Code at public API list prices, so this is what pay-per-token would have cost you. Your subscription covers it: <b>$0 extra</b>. It counts against your plan's usage limits, not your wallet.</p>`;
  $('#lg-plan').onchange = (e) => { const [n, v] = PLANS.find(p => p[1] === +e.target.value); api('PUT', '/api/plan', { name: n, monthlyUsd: v }); };
  refreshLedger();
}
function refreshLedger() {
  const m = monthSpend(), plan = state.plan, now = new Date();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const pace = m.total / Math.max(1, now.getDate()) * days;
  const pct = Math.min(100, (m.total / plan.monthlyUsd) * 100);
  const ahead = m.total - plan.monthlyUsd;
  const rows = Object.entries(m.agents).map(([id, v]) => [state.sessions.find(s => s.id === id)?.name || 'retired agent', v]);
  if (m.lidia) rows.push(['Lidia (reviews + chat)', m.lidia]);
  rows.sort((a, b) => b[1] - a[1]);
  const top = rows[0]?.[1] || 1;
  $('#lg').innerHTML = `
    <div class="ledger-hero">
      <small>WOULD HAVE COST THIS MONTH</small>
      <div class="big">${money(m.total)}</div>
      <div class="bar"><i style="width:${pct}%"></i><b style="left:100%"></b></div>
      <div class="row ledger-sub"><span>${plan.name} · $${plan.monthlyUsd}/mo</span>
        <span class="${ahead >= 0 ? 'win' : ''}">${ahead >= 0 ? `+${money(ahead)} ahead · ${(m.total / plan.monthlyUsd).toFixed(1)}× value` : `${pct.toFixed(0)}% of plan price`}</span></div>
      <div class="muted small">On pace for ~${money(pace)} by month end · ${money(state.spend.total)} all-time</div>
    </div>
    <h4>By survivor</h4>
    ${rows.map(([n, v]) => `<div class="ledger-row"><span>${esc(n)}</span><i style="width:${(v / top) * 100}%"></i><b>${money(v)}</b></div>`).join('') || '<p class="muted">Nothing spent yet this month.</p>'}`;
}

// ---- settings
function mountSettings() {
  $('#panel-title').textContent = 'Fortress settings';
  const st = state.settings;
  body.innerHTML = `
    <form id="g-form" class="stack">
      <label>Dweller model <input id="g-model" value="${esc(st.model)}" placeholder="default (e.g. claude-opus-5-5, claude-sonnet-5-5)"></label>
      <label>Lidia's model <input id="g-lmodel" value="${esc(st.lidiaModel)}" placeholder="default"></label>
      <label>Permission mode <select id="g-perm">${[['default', 'Ask me for every risky tool'], ['acceptEdits', 'Auto-accept file edits, ask for the rest'], ['auto', 'Classifier decides, asks when unsure'], ['plan', 'Plan only, no changes'], ['bypassPermissions', 'Never ask (dangerous)']].map(([v, l]) => `<option value="${v}" ${v === st.permissionMode ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Max automatic nudges in a row before Lidia asks you <input id="g-max" type="number" min="1" max="50" value="${st.maxAutoTurns}"></label>
      <label class="inline"><input type="checkbox" id="g-speak" ${st.speakLidia ? 'checked' : ''}> Lidia speaks out loud</label>
      <label>Skill sources (GitHub repos, one per line) <textarea id="g-src" rows="3">${esc(st.skillSources.join('\n'))}</textarea></label>
      <button class="primary">Save</button>
    </form>
    <h4>Claude account</h4>
    <div id="g-health" class="card"><div class="muted">Checking…</div></div>
    <h4>Home screen</h4>
    <p class="muted" id="g-install-note">${matchMedia('(display-mode: standalone)').matches ? 'Installed. You are running the home-screen app.' : 'Install the fortress as an app: own icon, full screen, no browser bar.'}</p>
    <button id="g-install" class="primary" ${installPrompt ? '' : 'hidden'}>INSTALL APP</button>
    <p class="muted small" ${installPrompt ? 'hidden' : ''}>No install button? In Chrome open the ⋮ menu → <b>Add to Home screen</b> → Install.</p>
    <h4>Voice</h4>
    <p class="muted">${voice.voiceSupported ? 'Tap <b>TALK</b> (or press <kbd>M</kbd> on a keyboard) and speak. Start with “Lidia, …” or a dweller’s name to address them; otherwise it goes to whoever is open.' : 'Your browser has no speech recognition. Use Chrome or Edge.'}</p>`;
  api('GET', '/api/health').then(h => {
    const line = h.mock ? '<b>Mock mode.</b> Survivors are fake; no Claude usage.'
      : !h.subscription ? '<b class="red">Not signed in.</b> On the phone run <code>fortress login</code>, then <code>/login</code> with your Claude account.'
      : '<b style="color:var(--green)">Signed in with your Claude subscription.</b> No API key in use.';
    const stripped = h.apiKeyStripped ? '<div class="small" style="color:var(--accent2)">An API key was set on this device. The fortress ignores it, so nothing bills per token.</div>' : '';
    $('#g-health').innerHTML = `<div>${line}${stripped}<div class="muted small">${esc(h.platform)} · node ${esc(h.node)}</div></div>`;
  }).catch(() => {});
  $('#g-install').onclick = async () => { installPrompt?.prompt(); await installPrompt?.userChoice; installPrompt = null; mount(); };
  $('#g-form').onsubmit = async (e) => {
    e.preventDefault();
    await api('PATCH', '/api/settings', { model: $('#g-model').value.trim(), lidiaModel: $('#g-lmodel').value.trim(), permissionMode: $('#g-perm').value,
      maxAutoTurns: Number($('#g-max').value) || 6, speakLidia: $('#g-speak').checked, skillSources: $('#g-src').value.split('\n').map(s => s.trim()).filter(Boolean) });
    toast('Settings saved');
  };
}

// ------------------------------------------------------------------ mic
const micBtn = $('#mic');
function startMic() {
  if (voice.isListening()) { voice.stop(); return; }
  const target = talk.isOpen() ? 'Lidia' : (state?.sessions.find(s => s.id === selected)?.name || 'Lidia');
  voiceBar.open(target);
  voice.listen({
    onStart: () => voiceBar.live(),
    onSound: (l) => voiceBar.level(l),
    onInterim: (t) => voiceBar.text(t),
    onResult: async (t) => {
      const r = voice.route(t, state.sessions, talk.isOpen() ? 'lidia' : selected);
      const name = r.to === 'lidia' ? 'Lidia' : state.sessions.find(s => s.id === r.to)?.name;
      voiceBar.sent(name, r.text);
      if (r.to === 'lidia') { if (!talk.isOpen()) openLidia('chat'); await talk.send(r.text); }
      else { if (selected !== r.to) openSession(r.to); await api('POST', `/api/sessions/${r.to}/message`, { text: r.text }); }
    },
    onEnd: () => voiceBar.ended(),
    onError: (m) => voiceBar.error(m),
  });
}

/** The listening bar: red, live waves, words as you speak, cancel/send. */
const voiceBar = (() => {
  const el = document.createElement('div');
  el.id = 'voicebar';
  el.hidden = true;
  el.innerHTML = `<div class="vb-top"><span class="vb-dot"></span><span class="vb-to"></span>
      <button class="small" data-vb="cancel">CANCEL</button><button class="small primary" data-vb="send">SEND</button></div>
    <canvas class="vb-waves" width="320" height="56"></canvas>
    <div class="vb-text"></div>`;
  document.body.appendChild(el);
  const cv = el.querySelector('canvas'), g = cv.getContext('2d');
  let level = 0, target = 0, raf = 0, hideTimer = 0, t = 0;
  const N = 32;
  const draw = () => {
    level += (target - level) * 0.25;
    target *= 0.94;                                 // decay unless speech keeps coming
    t += 0.18;
    const w = cv.width, h = cv.height, bw = w / N;
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < N; i++) {
      const center = 1 - Math.abs(i - N / 2) / (N / 2);   // taller in the middle
      const wobble = 0.55 + 0.45 * Math.sin(t * 1.7 + i * 0.9) * Math.cos(t * 0.6 + i * 0.35);
      const amp = Math.max(0.06, (0.08 + level * 0.92) * (0.35 + 0.65 * center) * wobble);
      const bh = Math.max(4, Math.round((amp * h) / 4) * 4);       // pixel-stepped
      g.fillStyle = i % 2 ? '#ff3b2a' : '#ff6a4a';
      g.fillRect(Math.round(i * bw + 2), Math.round((h - bh) / 2), Math.max(2, Math.round(bw - 4)), bh);
    }
    raf = requestAnimationFrame(draw);
  };
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-vb]')?.dataset.vb;
    if (a === 'cancel') { voice.cancel(); hide(0); }
    if (a === 'send') voice.stop();
  });
  const setButtons = (on) => el.querySelectorAll('[data-vb]').forEach(b => { b.hidden = !on; });
  function hide(after) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { el.hidden = true; cancelAnimationFrame(raf); raf = 0; }, after); }
  return {
    open(to) {
      clearTimeout(hideTimer);
      document.body.classList.add('listening');
      el.hidden = false; el.classList.remove('err', 'done');
      el.querySelector('.vb-to').textContent = `LISTENING → ${to.toUpperCase()}`;
      el.querySelector('.vb-text').textContent = 'Starting the mic…';
      setButtons(true);
      level = 0; target = 0.15;
      if (!raf) draw();
    },
    live() { el.querySelector('.vb-text').textContent = 'Go ahead, I\'m listening…'; },
    level(l) { target = Math.max(target, l); },
    text(s) { el.querySelector('.vb-text').textContent = s; },
    sent(to, s) {
      el.classList.add('done');
      el.querySelector('.vb-to').textContent = `SENT → ${String(to).toUpperCase()}`;
      el.querySelector('.vb-text').textContent = `“${s}”`;
    },
    error(m) {
      el.hidden = false; el.classList.add('err');
      el.querySelector('.vb-to').textContent = 'MIC PROBLEM';
      el.querySelector('.vb-text').textContent = m;
      document.body.classList.remove('listening');
      setButtons(false);
      hide(6000);
    },
    ended() {
      document.body.classList.remove('listening');
      setButtons(false);
      target = 0;
      if (!el.classList.contains('err')) hide(el.classList.contains('done') ? 1800 : 600);
    },
  };
})();
micBtn.onclick = startMic;
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'm' || e.key === 'M') startMic();
  if (e.key === 'Escape') { if (talk.isOpen()) talk.closeTalk(); else close(); }
  if (e.key === 'l' || e.key === 'L') openLidia();
});

let transcriptTimer;
function showTranscript(t, hideAfter) {
  const el = $('#transcript');
  el.textContent = t; el.classList.add('show');
  clearTimeout(transcriptTimer);
  if (hideAfter) transcriptTimer = setTimeout(() => el.classList.remove('show'), hideAfter);
}

// ------------------------------------------------------------------ toasts & sound
function toast(text, onClick) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  if (onClick) { el.style.cursor = 'pointer'; el.onclick = () => { onClick(); el.remove(); }; }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 7000);
}
let audio;
function chime() {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(880, audio.currentTime); o.frequency.setValueAtTime(660, audio.currentTime + 0.12);
    g.gain.setValueAtTime(0.15, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
  } catch {}
}

// ------------------------------------------------------------------ home-screen app
let installPrompt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (tab === 'settings') mount(); renderInstallGate(); });
addEventListener('appinstalled', () => { installPrompt = null; $('#install-gate')?.remove(); toast('Installed. Open the fortress from your home screen.'); });

/** Opened in a browser tab? Offer to install as an app, right away. */
function renderInstallGate() {
  if (standalone()) return;
  try { if (localStorage.getItem('fortress-install-later') === new Date().toDateString()) return; } catch {}
  let gate = $('#install-gate');
  if (!gate) {
    gate = document.createElement('div');
    gate.id = 'install-gate';
    document.body.appendChild(gate);
  }
  gate.innerHTML = `
    <div class="gate-box">
      <img src="icons/icon-192.png" alt="" width="96" height="96">
      <h3>INSTALL THE FORTRESS</h3>
      <p>Run it as an app: its own icon, full screen, no browser bar.</p>
      ${installPrompt
        ? '<button class="primary" id="gate-install">INSTALL APP</button>'
        : '<p class="gate-manual">Tap Chrome\'s <b>⋮</b> menu (top right) → <b>Install app</b><br>(or <b>Add to Home screen</b> → <b>Install</b>)</p>'}
      <button id="gate-later" class="small">NOT NOW</button>
    </div>`;
  $('#gate-install')?.addEventListener('click', async () => {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') gate.remove(); else renderInstallGate();
  });
  $('#gate-later').onclick = () => { try { localStorage.setItem('fortress-install-later', new Date().toDateString()); } catch {} gate.remove(); };
}
// Give Chrome a moment to offer its install prompt; fall back to menu instructions.
setTimeout(renderInstallGate, 1200);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ------------------------------------------------------------------ boot
game.initGame($('#world'), {
  onPick: (hit) => {
    if (hit.kind === 'lidia') openLidia();
    else if (hit.kind === 'session') open('session', hit.id);
    else if (hit.kind === 'dig') open('new');
    else if (hit.kind === 'tab') open(hit.tab);
  },
});
game.focusOn('lidia');
close();
talk.initTalk({
  api, getState: () => state,
  openSession: (id) => openSession(id),
  openOrders: () => open('lidia'),
  startMic: () => startMic(),
  speak: (t) => state?.settings.speakLidia && voice.speak(t),
  onClose: () => { game.select(selected); document.querySelectorAll('#nav [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === (tab && !['session', 'new'].includes(tab) ? (['repos','connectors','skills'].includes(tab) ? 'connectors' : tab) : 'base'))); },
});
loadArt().then(connect);
