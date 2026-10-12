// Lidia's Command Deck and friends: escalation queue, priorities, thought stream, directives,
// message log, audit & replay, rooms/tasks/artifacts, safety, appearance, and the login screen.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
const TIERS = ['T0 just did it', 'T1 did & reported', 'T2 asked Jav', 'T3 Jav only'];

export const WORLD_THEMES = [
  ['fortress', 'Underground Fortress', 'Lidia the Overseer, below the surface'],
  ['spaceship', 'Spaceship', "Lidia as the Ship's AI Core"],
  ['westernTown', 'Wild West', 'Lidia the Sheriff'],
  ['pirateCove', 'Pirate Cove', 'Lidia the Captain'],
  ['cyberpunk', 'Cyberpunk Village', 'Lidia the Mainframe'],
];

let ctx = null;            // { api, toast, getState, openSession, refreshPanel }
let sub = 'command';       // deck sub-tab
let stream = [];           // decisions, oldest first
let streamQ = '', streamTier = '';
let timer = null;
let auditData = [], auditPos = 0, playTimer = null;

export function init(c) { ctx = c; }

const tabs = [['command', 'COMMAND'], ['messages', 'MESSAGES'], ['audit', 'AUDIT'], ['rooms', 'ROOMS'], ['safety', 'SAFETY']];

export function mountDeck(body) {
  body.innerHTML = `<div class="deck">
    <div class="deck-tabs" role="tablist" aria-label="Command deck sections">${tabs.map(([k, l]) => `<button role="tab" data-sub="${k}" aria-selected="${k === sub}" class="${k === sub ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="deck-body" aria-live="polite"></div></div>`;
  body.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { sub = b.dataset.sub; mountDeck(body); });
  clearInterval(timer); clearInterval(playTimer);
  ({ command: loadCommand, messages: loadMessages, audit: loadAudit, rooms: loadRooms, safety: loadSafety })[sub]();
  // Poll lightly while the deck is open; live decisions also arrive by socket.
  timer = setInterval(() => { if (document.getElementById('deck-body') && sub !== 'audit') ({ command: loadCommand, messages: loadMessages, rooms: loadRooms, safety: () => {} })[sub](true); else clearInterval(timer); }, 6000);
}
export function stopDeck() { clearInterval(timer); clearInterval(playTimer); }

const $d = () => document.getElementById('deck-body');
const keepScroll = (fn) => { const el = $d(); const y = el?.parentElement?.scrollTop; fn(); if (y != null && el?.parentElement) el.parentElement.scrollTop = y; };

// ------------------------------------------------------------------ COMMAND
async function loadCommand(quiet) {
  const [esca, prio, intent, dec] = await Promise.all([
    ctx.api('GET', '/api/escalations'), ctx.api('GET', '/api/priorities'), ctx.api('GET', '/api/intent'),
    ctx.api('GET', `/api/decisions?limit=150${streamQ ? `&q=${encodeURIComponent(streamQ)}` : ''}${streamTier !== '' ? `&tier=${streamTier}` : ''}`),
  ]).catch(() => [null]);
  if (!esca || !$d()) return;
  stream = dec;
  const st = ctx.getState();
  const handled = (intent.digest || []).length;
  const typing = document.activeElement?.id === 'dk-q';
  keepScroll(() => {
    if (quiet && typing) { renderStream(); return; }
    $d().innerHTML = `
    ${st.killed ? `<div class="kill-banner" role="alert"><b>KILL SWITCH ON</b><span>${esc(st.killed.reason || 'All agents halted')}</span><button id="dk-resume" class="primary">RESUME</button></div>` : ''}
    <section><h4>NEEDS YOU <small>${esca.length}</small></h4>
      ${esca.length ? esca.map(e => `<button class="esc lvl-${e.level}" data-open="${esc(e.id)}"><i class="lvl">${e.level}</i><b>${esc(e.name)}</b><span>${esc(e.text)}</span><small>${time(e.ts)}</small></button>`).join('') : '<p class="muted">Nothing. Lidia is handling it.</p>'}
    </section>
    <section><h4>LIDIA HANDLED FOR YOU <small>last 24h</small></h4>
      <p class="muted">${handled ? `${handled} thing${handled === 1 ? '' : 's'} done without bothering you (tier 1). Scroll the thought stream for the why.` : 'No tier 1 actions yet.'}</p>
    </section>
    <section><h4>PRIORITIES</h4>
      ${prio.length ? prio.map(p => `<button class="prio band-${p.band}" data-open="${esc(p.id)}"><b>${esc(p.name)}</b><span>${esc(p.status)}${p.activity ? ` · ${esc(p.activity)}` : ''}</span><em>${p.band} ${p.score}</em><i style="width:${p.score}%"></i></button>`).join('') : '<p class="muted">No agents yet.</p>'}
    </section>
    <section><h4>STANDING DIRECTIVES</h4>
      <p class="muted small">Blanket permissions Lidia follows without asking again. Spending money can never be a directive.</p>
      <div id="dk-dirs">${(intent.directives || []).map(d => `<div class="dir"><span>${esc(d.text)}</span><button data-deldir="${esc(d.id)}" aria-label="Remove directive">X</button></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
      <form id="dk-dirform" class="row"><input id="dk-dirtext" maxlength="400" placeholder="e.g. Always download free assets without asking" aria-label="New standing directive"><button class="primary">ADD</button></form>
    </section>
    <section><h4>THOUGHT STREAM</h4>
      <div class="row"><input id="dk-q" type="search" value="${esc(streamQ)}" placeholder="Search decisions…" aria-label="Search the thought stream">
        <select id="dk-tier" aria-label="Filter by tier"><option value="">All tiers</option>${TIERS.map((t, i) => `<option value="${i}" ${String(i) === streamTier ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div id="dk-stream" class="stream"></div>
    </section>`;
    renderStream();
    $d().querySelectorAll('[data-open]').forEach(b => b.onclick = () => ctx.openSession(b.dataset.open));
    $d().querySelectorAll('[data-deldir]').forEach(b => b.onclick = async () => { await ctx.api('DELETE', `/api/directives/${b.dataset.deldir}`); loadCommand(); });
    $d().querySelector('#dk-dirform').onsubmit = async (e) => {
      e.preventDefault();
      try { await ctx.api('POST', '/api/directives', { text: $d().querySelector('#dk-dirtext').value }); loadCommand(); } catch (err) { ctx.toast(err.message); }
    };
    $d().querySelector('#dk-q').oninput = debounce((e) => { streamQ = e.target.value; loadCommand(true); }, 300);
    $d().querySelector('#dk-tier').onchange = (e) => { streamTier = e.target.value; loadCommand(); };
    $d().querySelector('#dk-resume')?.addEventListener('click', async () => { await ctx.api('POST', '/api/resume'); loadCommand(); });
  });
}

function renderStream() {
  const el = document.getElementById('dk-stream'); if (!el) return;
  el.innerHTML = stream.slice().reverse().map(e => `<details class="dec t${e.tier}"><summary><i class="tier">T${e.tier}</i><span class="when">${day(e.ts)} ${time(e.ts)}</span><b>${esc(e.agent || e.kind)}</b> ${esc(e.summary)} <em>→ ${esc(e.decision)}</em></summary><p>${esc(e.why || 'No reason recorded.')}</p></details>`).join('') || '<p class="muted">No decisions yet.</p>';
}
/** A decision arrived over the socket: show it live if the stream is on screen. */
export function onDecision(d) {
  if (sub !== 'command' || !document.getElementById('dk-stream')) return;
  if (streamQ || (streamTier !== '' && String(d.tier) !== streamTier)) return;
  stream.push(d); renderStream();
}

// ------------------------------------------------------------------ MESSAGES
let busQ = '';
async function loadMessages() {
  const [msgs, anom] = await Promise.all([ctx.api('GET', `/api/bus?limit=150${busQ ? `&q=${encodeURIComponent(busQ)}` : ''}`), ctx.api('GET', '/api/anomalies')]).catch(() => [null]);
  if (!msgs || !$d()) return;
  if (document.activeElement?.id === 'bus-q') { renderBus(msgs); return; }
  const agents = ctx.getState().sessions.map(s => s.name);
  $d().innerHTML = `
    ${anom.length ? `<section><h4>ANOMALIES <small>${anom.length}</small></h4>${anom.slice(-5).reverse().map(a => `<div class="anom">⚠ <b>${esc(a.agent)}</b> ${esc(a.reason)} <small>${time(a.ts)}</small></div>`).join('')}</section>` : ''}
    <section><h4>MESSAGE LOG</h4>
      <p class="muted small">Every message between agents is signed by the fortress with the sender's own key. A ✓ means the signature matches; ✗ means it was altered.</p>
      <input id="bus-q" type="search" value="${esc(busQ)}" placeholder="Search messages…" aria-label="Search messages">
      <div id="bus-list"></div>
    </section>
    <section><h4>SEND A MESSAGE</h4>
      <form id="bus-form" class="stack"><select id="bus-to" aria-label="To">${['lidia', ...agents].map(a => `<option>${esc(a)}</option>`).join('')}</select>
      <select id="bus-type" aria-label="Type">${['NOTIFY', 'REQUEST', 'QUERY', 'DELEGATE'].map(t => `<option>${t}</option>`).join('')}</select>
      <textarea id="bus-body" rows="2" maxlength="6000" placeholder="Message" aria-label="Message"></textarea><button class="primary">SEND</button></form>
    </section>`;
  renderBus(msgs);
  $d().querySelector('#bus-q').oninput = debounce((e) => { busQ = e.target.value; loadMessages(); }, 300);
  $d().querySelector('#bus-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await ctx.api('POST', '/api/bus', { to: $d().querySelector('#bus-to').value, type: $d().querySelector('#bus-type').value, body: $d().querySelector('#bus-body').value }); loadMessages(); } catch (err) { ctx.toast(err.message); }
  };
}
function renderBus(msgs) {
  const el = document.getElementById('bus-list'); if (!el) return;
  el.innerHTML = msgs.slice().reverse().map(m => `<div class="msg ${m.valid ? '' : 'bad'} ${m.suspicious ? 'sus' : ''}"><div class="mh"><i class="ty ty-${esc(m.type)}">${esc(m.type)}</i><b>${esc(m.fromName)}</b> → <b>${esc(m.toName)}</b><span class="sig" title="${m.valid ? 'Signature valid' : 'Signature does not match'}">${m.valid ? '✓' : '✗'}</span><small>${time(m.ts)}</small></div>${m.topic ? `<div class="mt">${esc(m.topic)}</div>` : ''}<p>${esc(m.body)}</p>${m.suspicious ? '<small class="red">flagged as a possible prompt-injection</small>' : ''}</div>`).join('') || '<p class="muted">No messages yet.</p>';
}

// ------------------------------------------------------------------ AUDIT & REPLAY
async function loadAudit() {
  const [v, rows] = await Promise.all([ctx.api('GET', '/api/audit/verify'), ctx.api('GET', '/api/audit?limit=1000')]).catch(() => [null]);
  if (!v || !$d()) return;
  auditData = rows; auditPos = Math.max(0, rows.length - 1);
  $d().innerHTML = `
    <section><h4>AUDIT TRAIL</h4>
      <div class="chain ${v.ok ? 'ok' : 'bad'}" role="status">${v.ok ? `✓ Chain intact · ${v.count} entries` : `✗ Chain broken at entry ${v.brokenAt}: history was altered`}</div>
      <p class="muted small">Every entry is hashed with the one before it, so edits or deletions show. Secrets and personal data are redacted before they are written.</p>
      <div class="replay"><button id="au-play" aria-label="Replay">▶</button><input id="au-range" type="range" min="0" max="${Math.max(0, rows.length - 1)}" value="${auditPos}" aria-label="Scrub through the timeline"><span id="au-at"></span></div>
      <input id="au-q" type="search" placeholder="Filter by actor, action or text…" aria-label="Filter audit entries">
      <div id="au-list" class="aulist"></div>
    </section>`;
  const draw = () => {
    const q = $d().querySelector('#au-q').value.toLowerCase();
    const upto = auditData.slice(0, auditPos + 1).filter(e => !q || `${e.actor} ${e.action} ${e.target} ${e.detail}`.toLowerCase().includes(q));
    const cur = auditData[auditPos];
    $d().querySelector('#au-at').textContent = cur ? `#${cur.seq} · ${day(cur.ts)} ${time(cur.ts)}` : 'empty';
    $d().querySelector('#au-list').innerHTML = upto.slice(-80).reverse().map(e => `<div class="au ${e === cur ? 'now' : ''}"><small>${time(e.ts)}</small><b>${esc(e.actor)}</b> <code>${esc(e.action)}</code> ${esc(e.target)} <span class="muted">${esc(e.detail)}</span></div>`).join('') || '<p class="muted">Nothing yet.</p>';
  };
  draw();
  $d().querySelector('#au-range').oninput = (e) => { auditPos = +e.target.value; draw(); };
  $d().querySelector('#au-q').oninput = debounce(draw, 200);
  $d().querySelector('#au-play').onclick = (e) => {
    if (playTimer) { clearInterval(playTimer); playTimer = null; e.currentTarget.textContent = '▶'; return; }
    auditPos = 0; e.currentTarget.textContent = '❚❚';
    playTimer = setInterval(() => {
      auditPos++;
      if (auditPos >= auditData.length - 1) { auditPos = auditData.length - 1; clearInterval(playTimer); playTimer = null; const b = document.getElementById('au-play'); if (b) b.textContent = '▶'; }
      const r = document.getElementById('au-range'); if (r) r.value = auditPos; draw();
    }, 120);
  };
}

// ------------------------------------------------------------------ ROOMS, TASKS, ARTIFACTS
async function loadRooms() {
  const [tasks, arts, archive] = await Promise.all([ctx.api('GET', '/api/tasks'), ctx.api('GET', '/api/artifacts'), ctx.api('GET', '/api/archive')]).catch(() => [null]);
  if (!tasks || !$d()) return;
  const st = ctx.getState();
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  keepScroll(() => {
    $d().innerHTML = `
    <section><h4>ROOMS</h4>
      ${st.projects.map(p => `<div class="room"><div><b>${esc(p.name)}</b> <small>${esc(p.lifecycle || 'persistent')}${p.parent ? ` · inside ${esc(st.projects.find(x => x.id === p.parent)?.name || '?')}` : ''} · ${st.sessions.filter(s => s.projectId === p.id).length} agents</small></div>
        <select data-life="${esc(p.id)}" aria-label="Lifecycle of ${esc(p.name)}"><option value="persistent" ${p.lifecycle !== 'ephemeral' ? 'selected' : ''}>persistent</option><option value="ephemeral" ${p.lifecycle === 'ephemeral' ? 'selected' : ''}>ephemeral</option></select>
        <select data-parent="${esc(p.id)}" aria-label="Nest ${esc(p.name)} inside"><option value="">top level</option>${st.projects.filter(x => x.id !== p.id).map(x => `<option value="${esc(x.id)}" ${p.parent === x.id ? 'selected' : ''}>in ${esc(x.name)}</option>`).join('')}</select>
        <button data-arch="${esc(p.id)}">ARCHIVE</button></div>`).join('') || '<p class="muted">No rooms.</p>'}
      ${archive.length ? `<h5>Archived</h5>${archive.map(p => `<div class="room dim"><b>${esc(p.name)}</b><button data-rest="${esc(p.id)}">RESTORE</button></div>`).join('')}` : ''}
    </section>
    <section><h4>TASK GRAPH <small>${tasks.length}</small></h4>
      ${tasks.slice().reverse().slice(0, 30).map(t => `<div class="task st-${esc(t.status)}"><div><i class="chip">${esc(t.status)}</i><b>${esc(t.title)}</b></div><small>${esc(t.owner || 'unassigned')} · by ${esc(t.creator)}${t.deps.length ? ` · waits on ${t.deps.map(d => esc(byId[d]?.title || d)).join(', ')}` : ''}</small>${t.criteria ? `<small>Done when: ${esc(t.criteria)}</small>` : ''}${t.result ? `<small>Result: ${esc(t.result)}</small>` : ''}</div>`).join('') || '<p class="muted">No tasks yet. Lidia creates them when she delegates.</p>'}
    </section>
    <section><h4>ARTIFACTS</h4>
      ${arts.map(a => `<div class="art"><b>${esc(a.name)}</b> <small>v${a.versions} · ${esc(a.latest?.by || '')}</small><button data-art="${esc(a.name)}">VIEW</button></div>`).join('') || '<p class="muted">Agents save shared, versioned files here.</p>'}
      <pre id="art-view" hidden></pre>
    </section>`;
    $d().querySelectorAll('[data-life]').forEach(s => s.onchange = () => ctx.api('PATCH', `/api/projects/${s.dataset.life}`, { lifecycle: s.value }).catch(e => ctx.toast(e.message)));
    $d().querySelectorAll('[data-parent]').forEach(s => s.onchange = () => ctx.api('PATCH', `/api/projects/${s.dataset.parent}`, { parent: s.value }).catch(e => ctx.toast(e.message)));
    $d().querySelectorAll('[data-arch]').forEach(b => b.onclick = async () => { try { await ctx.api('POST', `/api/projects/${b.dataset.arch}/archive`); loadRooms(); } catch (e) { ctx.toast(e.message); } });
    $d().querySelectorAll('[data-rest]').forEach(b => b.onclick = async () => { await ctx.api('POST', `/api/projects/${b.dataset.rest}/restore`); loadRooms(); });
    $d().querySelectorAll('[data-art]').forEach(b => b.onclick = async () => {
      const a = await ctx.api('GET', `/api/artifacts/${encodeURIComponent(b.dataset.art)}`);
      const v = $d().querySelector('#art-view'); v.hidden = false; v.textContent = `${a.name} v${a.version}/${a.latest}\n\n${a.content}`;
    });
  });
}

// ------------------------------------------------------------------ SAFETY
async function loadSafety() {
  const [auth, ver] = await Promise.all([ctx.api('GET', '/api/auth/status'), ctx.api('GET', '/api/audit/verify')]).catch(() => [null]);
  if (!auth || !$d()) return;
  const st = ctx.getState();
  $d().innerHTML = `
    <section><h4>KILL SWITCH</h4>
      <p class="muted">Stops every agent immediately and blocks new turns until you resume. Does not delete anything.</p>
      ${st.killed ? '<button id="sf-resume" class="primary">RESUME FORTRESS</button>' : '<button id="sf-kill" class="danger big">HALT EVERYTHING</button>'}
    </section>
    <section><h4>MONEY</h4><p class="muted">Agents and Lidia can never spend money. Every purchase, payment or booking freezes until you approve it in this app. No setting, directive or message changes that.</p></section>
    <section><h4>LOGIN</h4>
      <p class="muted">${auth.enabled ? `Login is ON${auth.mfa ? ' with an authenticator code' : ''}. Your session lasts 15 minutes and renews itself.` : 'Login is OFF. The fortress only listens on this phone, but you can add a passphrase.'}</p>
      ${auth.enabled ? '<button id="sf-logout">LOG OUT</button> <button id="sf-disable" class="danger">TURN LOGIN OFF</button>' : `<form id="sf-setup" class="stack"><input id="sf-pw" type="password" minlength="10" autocomplete="new-password" placeholder="New passphrase (10+ characters)" aria-label="New passphrase"><label class="inline"><input type="checkbox" id="sf-mfa"> Also require an authenticator code</label><button class="primary">TURN ON LOGIN</button></form><div id="sf-secret" class="card" hidden></div>`}
    </section>
    <section><h4>AUDIT</h4><div class="chain ${ver.ok ? 'ok' : 'bad'}">${ver.ok ? `✓ Chain intact · ${ver.count} entries` : `✗ Broken at ${ver.brokenAt}`}</div></section>
    <section><h4>YOUR DATA</h4>
      <p class="muted">Everything lives on this phone. Nothing is sent anywhere except to Claude when an agent works.</p>
      <a class="btn" href="/api/export" download>EXPORT EVERYTHING</a>
      <details><summary>Fresh start…</summary><p class="muted small">Backs everything up on the phone (agents, rooms, chats, memory), then restarts with just Lidia. Your settings, connected apps, repos and skills stay. Type FRESH START.</p>
      <form id="sf-fresh" class="row"><input id="sf-fconf" placeholder="FRESH START" aria-label="Type FRESH START to confirm"><button class="danger">START OVER</button></form></details>
      <details><summary>Erase everything…</summary><p class="muted small">Deletes all agents, chats, memory, tasks, messages and artifacts. The audit chain stays (already redacted). Type ERASE EVERYTHING.</p>
      <form id="sf-erase" class="row"><input id="sf-conf" placeholder="ERASE EVERYTHING" aria-label="Type ERASE EVERYTHING to confirm"><button class="danger">ERASE</button></form></details>
    </section>`;
  $d().querySelector('#sf-kill')?.addEventListener('click', async () => { if (confirm('Halt every agent now?')) { await ctx.api('POST', '/api/kill', { reason: 'Halted by Jav' }); loadSafety(); } });
  $d().querySelector('#sf-resume')?.addEventListener('click', async () => { await ctx.api('POST', '/api/resume'); loadSafety(); });
  $d().querySelector('#sf-logout')?.addEventListener('click', async () => { await ctx.api('POST', '/api/auth/logout'); location.reload(); });
  $d().querySelector('#sf-disable')?.addEventListener('click', async () => { await ctx.api('POST', '/api/auth/disable'); loadSafety(); });
  $d().querySelector('#sf-setup')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const pw = $d().querySelector('#sf-pw').value;
      const r = await ctx.api('POST', '/api/auth/setup', { passphrase: pw, mfa: $d().querySelector('#sf-mfa').checked });
      await ctx.api('POST', '/api/auth/login', { passphrase: pw, code: r.mfaSecret ? '' : undefined }).catch(() => {});
      if (r.mfaSecret) { const b = $d().querySelector('#sf-secret'); b.hidden = false; b.innerHTML = `<b>Authenticator secret</b><div class="mono">${esc(r.mfaSecret)}</div><small>Add it to an authenticator app (manual entry, 30-second codes), then log in again with a code. Save it now; it is not shown again.</small>`; }
      else loadSafety();
    } catch (err) { ctx.toast(err.message); }
  });
  $d().querySelector('#sf-fresh')?.addEventListener('submit', async (e) => { e.preventDefault(); try { const r = await ctx.api('POST', '/api/fresh-start', { confirm: $d().querySelector('#sf-fconf').value }); ctx.toast(r.message); setTimeout(() => location.reload(), 4000); } catch (err) { ctx.toast(err.message); } });
  $d().querySelector('#sf-erase')?.addEventListener('submit', async (e) => { e.preventDefault(); try { await ctx.api('POST', '/api/erase', { confirm: $d().querySelector('#sf-conf').value }); ctx.toast('Erased.'); loadSafety(); } catch (err) { ctx.toast(err.message); } });
}

// ------------------------------------------------------------------ SETTINGS: appearance + accessibility
export function mountAppearance(host) {
  const st = ctx.getState().settings;
  host.innerHTML = `
    <h4>World theme</h4>
    <p class="muted small">Same fortress, same agents, same save. Only the look, sound and Lidia's form change.</p>
    <div class="themes" role="radiogroup" aria-label="World theme">${WORLD_THEMES.map(([id, name, sub]) => `<button role="radio" aria-checked="${(st.worldTheme || 'fortress') === id}" class="theme-card ${(st.worldTheme || 'fortress') === id ? 'on' : ''}" data-theme="${id}"><b>${esc(name)}</b><small>${esc(sub)}</small></button>`).join('')}</div>
    <h4>Accessibility</h4>
    <label class="inline"><input type="checkbox" id="ap-motion" ${st.reduceMotion ? 'checked' : ''}> Reduce motion</label>
    <label class="inline"><input type="checkbox" id="ap-sound" ${st.soundOn ? 'checked' : ''}> Ambient sound</label>
    <label>Color vision <select id="ap-cb">${[['none', 'Standard'], ['protanopia', 'Protanopia (red-weak)'], ['deuteranopia', 'Deuteranopia (green-weak)'], ['tritanopia', 'Tritanopia (blue-weak)']].map(([v, l]) => `<option value="${v}" ${(st.colorblind || 'none') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="muted small">Everything works by touch or keyboard: Tab to move, Enter to open, Esc to close a panel. Status is never color alone.</p>`;
  const save = (patch) => ctx.api('PATCH', '/api/settings', patch).catch(e => ctx.toast(e.message));
  host.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { host.querySelectorAll('[data-theme]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); save({ worldTheme: b.dataset.theme }); });
  host.querySelector('#ap-motion').onchange = (e) => save({ reduceMotion: e.target.checked });
  host.querySelector('#ap-sound').onchange = (e) => save({ soundOn: e.target.checked });
  host.querySelector('#ap-cb').onchange = (e) => save({ colorblind: e.target.value });
}

// ------------------------------------------------------------------ LOGIN
export function showLogin(onDone) {
  if (document.getElementById('login')) return;
  const d = document.createElement('div');
  d.id = 'login'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', 'Log in');
  d.innerHTML = `<form><h3>FORTRESS LOCKED</h3><input id="lg-pw" type="password" autocomplete="current-password" placeholder="Passphrase" aria-label="Passphrase" autofocus><input id="lg-code" inputmode="numeric" maxlength="6" placeholder="Authenticator code (if set)" aria-label="Authenticator code"><button class="primary">OPEN</button><p id="lg-err" class="red" role="alert"></p></form>`;
  document.body.appendChild(d);
  d.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: d.querySelector('#lg-pw').value, code: d.querySelector('#lg-code').value || undefined }) });
    if (r.ok) { d.remove(); onDone?.(); } else d.querySelector('#lg-err').textContent = (await r.json().catch(() => ({}))).error || 'Could not log in';
  };
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
