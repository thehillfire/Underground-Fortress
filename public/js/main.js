// App shell: networking, panels, and wiring between the world, the mic and the server.
import { loadArt } from './assets.js';
import * as game from './game.js';
import * as voice from './voice.js';

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
function openSession(id) { open('session', id); game.focusOn(id, sheetInset()); }
const sheetInset = () => (innerWidth < 900 ? panel.offsetHeight : 0);

$('#panel-close').onclick = close;
document.querySelectorAll('#nav [data-tab], #armory-tabs [data-tab]').forEach(b => b.onclick = () => {
  const t = b.dataset.tab;
  if (b.closest('#nav') && (tab === t || (ARMORY.includes(tab) && b.hasAttribute('data-armory')))) return close();
  open(t);
});
$('#btn-new').onclick = () => open('new');
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
    connectors: mountConnectors, skills: mountSkills, settings: mountSettings,
  }[tab];
  body.innerHTML = '';
  M?.();
}

// Live parts. Called on every state push.
function refresh() {
  if (!state) return;
  renderTopbar();
  renderFeed();
  if (!tab) return;
  ({ session: refreshSession, lidia: refreshLidia, repos: refreshRepos, connectors: refreshConnectors,
     skills: refreshSkills, new: refreshNew })[tab]?.();
}

function renderTopbar() {
  const alerts = state.sessions.filter(s => s.status === 'needs_jav').length;
  const cost = state.sessions.reduce((a, s) => a + (s.costUsd || 0), 0);
  $('#stats').innerHTML = `${state.sessions.length} alive${alerts ? ` · <b class="red">${alerts}!</b>` : ''}${cost ? ` · $${cost.toFixed(2)}` : ''}${state.mock ? ' · <i>mock</i>' : ''}`;
  document.title = alerts ? `(${alerts}!) Underground Fortress` : 'Underground Fortress';
  const base = $('#nav [data-tab="base"]');
  base.querySelector('.badge')?.remove();
  if (alerts) base.insertAdjacentHTML('beforeend', `<span class="badge">${alerts}</span>`);
}

function renderFeed() {
  const item = (f) => `<div class="feed-${esc(f.kind)}" ${f.sessionId ? `data-sid="${esc(f.sessionId)}"` : ''}>${esc(f.text)}</div>`;
  $('#feed').innerHTML = state.feed.slice(-6).map(item).join('');
  const last = state.feed[state.feed.length - 1];
  $('#ticker').innerHTML = last ? item(last) : '';
  document.querySelectorAll('#feed [data-sid], #ticker [data-sid]').forEach(el => el.onclick = () => openSession(el.dataset.sid));
}

// ---- session
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
    <label>Repository <select id="ss-repo"><option value="">(own workspace)</option>${state.repos.map(r => `<option value="${r.id}" ${r.id === s.repoId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    <div class="row"><button id="ss-save" class="primary">Save</button><button id="ss-stop">Stop turn</button><button id="ss-del" class="danger">Evict</button></div>
    <p class="muted">Claude session id: <code>${esc(s.sdkSessionId || '—')}</code></p>`;
  $('#ss-save').onclick = () => api('PATCH', `/api/sessions/${s.id}`, { name: $('#ss-name').value, goal: $('#ss-goal').value, roomType: $('#ss-room').value, repoId: $('#ss-repo').value || null });
  $('#ss-stop').onclick = () => api('POST', `/api/sessions/${s.id}/stop`);
  $('#ss-del').onclick = async () => { if (confirm(`Evict ${s.name}? Their room is torn down.`)) { await api('DELETE', `/api/sessions/${s.id}`); close(); } };
}

function refreshSession() {
  const s = state.sessions.find(x => x.id === selected);
  if (!s) { close(); return; }
  $('#panel-title').textContent = s.name;
  $('#s-head').innerHTML = `<div class="chips"><span class="chip st-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
    <span class="chip">${esc(s.roomType)}</span><span class="chip">${esc(s.activity || '')}</span><span class="chip">$${(s.costUsd || 0).toFixed(3)}</span></div>
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
  $('#panel-title').textContent = 'Captain Lidia';
  body.innerHTML = `
    <p class="muted">Every dweller reports to Lidia when they finish a turn. She tells them how to continue, or turns them red with a <b class="red">!</b> when she needs you. Talk to her to change orders, relay instructions, or open new rooms.</p>
    <div id="l-log" class="log"></div>
    <form id="l-form" class="composer">
      <textarea id="l-input" rows="1" placeholder="Talk to Lidia…"></textarea>
      <button type="button" class="mic-inline"><span class="mic-ico"></span></button>
      <button type="submit" class="primary">SEND</button>
    </form>
    <details class="sub" open><summary>Standing orders</summary>
      <textarea id="l-orders" rows="5"></textarea>
      <div class="row"><button id="l-save" class="primary">Save orders</button>
      <label class="inline"><input type="checkbox" id="l-auto"> Autopilot (Lidia answers finished sessions)</label></div>
    </details>
    <details class="sub"><summary>What Lidia learned from you</summary><div id="l-prec"></div></details>`;
  $('#l-orders').value = state.standingOrders;
  $('#l-auto').checked = state.settings.lidiaAutopilot;
  $('#l-auto').onchange = (e) => api('PATCH', '/api/settings', { lidiaAutopilot: e.target.checked });
  $('#l-save').onclick = () => api('PUT', '/api/orders', { text: $('#l-orders').value });
  const form = $('#l-form'), input = $('#l-input');
  form.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; input.value = ''; api('POST', '/api/lidia', { text: t }).catch(err => toast(err.message)); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); } };
  $('.mic-inline', form).onclick = () => startMic();
}
function refreshLidia() {
  const el = $('#l-log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = state.lidiaChat.map(m => `<div class="msg m-${m.role}"><span class="who">${m.role === 'jav' ? 'Jav' : 'Lidia'}</span><div>${esc(m.text)}${m.acts?.length ? `<div class="acts">→ ${esc(m.acts.join(' · '))}</div>` : ''}</div></div>`).join('')
    || '<p class="muted">Say hello to your captain.</p>';
  if (atBottom) el.scrollTop = el.scrollHeight;
  $('#l-prec').innerHTML = state.precedents.slice().reverse().map(p => `<div class="prec"><b>${esc(p.session)}:</b> ${esc(p.question)}<br>→ ${esc(p.answer)}</div>`).join('') || '<p class="muted">Nothing yet. Answer a red dweller and it shows up here.</p>';
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
      : h.apiKey ? '<b class="red">ANTHROPIC_API_KEY is set.</b> Survivors bill your API account per token, not your subscription. Unset it to use your plan.'
      : h.subscription ? '<b style="color:var(--green)">Signed in with your Claude subscription.</b> No API key in use.'
      : '<b class="red">Not signed in.</b> On the phone run <code>fortress login</code>, then <code>/login</code> with your Claude account.';
    $('#g-health').innerHTML = `<div>${line}<div class="muted small">${esc(h.platform)} · node ${esc(h.node)}</div></div>`;
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
  micBtn.classList.add('live');
  showTranscript('Listening…');
  voice.listen({
    onInterim: (t) => showTranscript(t),
    onResult: async (t) => {
      const r = voice.route(t, state.sessions, selected);
      const name = r.to === 'lidia' ? 'Lidia' : state.sessions.find(s => s.id === r.to)?.name;
      showTranscript(`→ ${name}: “${r.text}”`, 3500);
      if (r.to === 'lidia') { if (tab !== 'lidia') open('lidia'); await api('POST', '/api/lidia', { text: r.text }); }
      else { if (selected !== r.to) openSession(r.to); await api('POST', `/api/sessions/${r.to}/message`, { text: r.text }); }
    },
    onEnd: () => { micBtn.classList.remove('live'); },
    onError: (e) => { micBtn.classList.remove('live'); showTranscript(`Mic: ${e}`, 4000); },
  });
}
micBtn.onclick = startMic;
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'm' || e.key === 'M') startMic();
  if (e.key === 'Escape') close();
  if (e.key === 'l' || e.key === 'L') open('lidia');
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
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (tab === 'settings') mount(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ------------------------------------------------------------------ boot
game.initGame($('#world'), {
  onPick: (hit) => {
    if (hit.kind === 'lidia') open('lidia');
    else if (hit.kind === 'session') open('session', hit.id);
    else if (hit.kind === 'dig') open('new');
    else if (hit.kind === 'tab') open(hit.tab);
  },
});
game.focusOn('lidia');
close();
loadArt().then(connect);
