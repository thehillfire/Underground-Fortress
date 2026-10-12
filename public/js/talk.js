// Texting. One chat screen for Lidia and for every agent: message bubbles with reactions,
// the thing that needs Jav (permission, money, crash, a question) as a card in the thread,
// and small ‹ › arrows that hop between Lidia and whoever needs Jav.
// Tapping Lidia in the bunker still opens her game-style dialogue scene first.
import { art } from './assets.js';
import { rich } from './rich.js';
import { makeAttach, fileChips } from './attach.js';
import { STYLES, COLORS, applyTheme, DEFAULT_THEME } from './themes.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const EMOJI = ['👍', '👎', '❤️', '💀', '😂', '‼️', '❓', '🔥', '👀'];

let ctx = null;        // { api, getState, openSession, openDetails, openOrders, startMic, onClose, onSeen, toast }
let mode = null;       // 'dialogue' | 'reports' | 'chat'
let peer = 'lidia';    // who the chat is with: 'lidia' or a session id
let typing = null;     // typewriter timer
let pending = null;    // { peer, text, ts } sent, not yet in state
let live = null;       // Lidia mid-reply: { started, thinking, acts, text }
const openThoughts = new Set();   // which "Thought for…" blocks Jav expanded
let attach = null;

const needsHelp = (s) => s.status === 'needs_jav' || s.status === 'error' || !!s.pendingPermission || !!s.pendingQuestion;
const agent = () => (peer === 'lidia' ? null : ctx.getState()?.sessions.find(s => s.id === peer));

export function initTalk(c) {
  ctx = c;
  $('#talk').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (b) return choose(b.dataset.c);
    if (mode !== 'chat' && e.target.closest('.talk-dialogue') && typing) finishTyping();
  });
  const form = $('#talk-form'), input = $('#talk-input');
  attach = makeAttach({ tray: $('#talk-tray'), cameraBtn: $('#talk-cam'), filesBtn: $('#talk-files') });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t && !attach.count()) return;
    const files = await attach.take();
    input.value = ''; input.style.height = '';
    try { await send(t, files); } catch (err) { ctx.toast(err.message); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); } };
  input.oninput = () => { input.style.height = ''; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
  $('#talk-mic').onclick = () => ctx.startMic();
  $('#chat-back').onclick = () => closeTalk();
  $('#chat-info').onclick = () => (peer === 'lidia' ? openTalk('dialogue') : ctx.openDetails(peer));
  $('#chat-more').onclick = (e) => { e.stopPropagation(); $('#chat-custom').hidden = true; $('#chat-menu').hidden = !$('#chat-menu').hidden; };
  $('#chat-menu').onclick = (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m; if (!m) return;
    $('#chat-menu').hidden = true;
    if (m === 'settings') { closeTalk(); ctx.openSettings(); } else openCustomize();
  };
  document.addEventListener('pointerdown', (e) => { if (!$('#chat-menu').hidden && !e.target.closest('#chat-menu, #chat-more')) $('#chat-menu').hidden = true; });
  $('#cc-done').onclick = () => { $('#chat-custom').hidden = true; };
  $('#chat-prev').onclick = () => hop(-1);
  $('#chat-next').onclick = () => hop(1);
  bindBubbles();
}

export const isOpen = () => !$('#talk').hidden;

/** Put words in the text box without sending (for the mic when nobody tapped SEND). */
export function draft(text) {
  const box = $('#talk-input');
  if (!text || !box || $('#talk').hidden) return;
  box.value = box.value ? `${box.value} ${text}` : text;
  box.dispatchEvent(new Event('input'));
  box.focus();
}

/** Lidia's live state while she works (null when she's done). */
export function setLive(l) {
  live = l;
  if (currentPeer() === 'lidia') update(ctx.getState(), { force: true });
}
export const currentPeer = () => (isOpen() && mode === 'chat' ? peer : null);

/** Lidia's dialogue scene (tap her in the bunker). */
export function openTalk(start = 'dialogue') {
  $('#talk').hidden = false;
  if (start === 'chat') return openChat('lidia');
  mode = 'dialogue';
  $('#talk-chat').hidden = true;
  $('#talk-reports').hidden = true;
  $('#talk-choices').hidden = false;
  drawPortrait();
  type(greeting(ctx.getState()));
}

/** The texting screen with Lidia or an agent. */
export function openChat(id) {
  $('#talk').hidden = false;
  mode = 'chat';
  peer = id || 'lidia';
  closeReactBar();
  $('#talk-chat').hidden = false;
  const el = $('#talk-bubbles'); el.dataset.key = '';
  update(ctx.getState(), { force: true });
  el.scrollTop = el.scrollHeight;
  ctx.onSeen?.(peer);
}

export function closeTalk() {
  $('#talk').hidden = true;
  $('#chat-menu').hidden = true; $('#chat-custom').hidden = true;
  clearInterval(typing); typing = null;
  mode = null;
  closeReactBar();
  ctx.onClose?.();
}

/** Send a text to whoever the chat is with (also used by the mic). */
export async function send(text, files = []) {
  if (mode !== 'chat') openChat(peer);
  ctx.onSend?.();
  const to = peer;
  pending = { peer: to, ts: Date.now(), text: text || `(${files.length} attachment${files.length > 1 ? 's' : ''})` };
  update(ctx.getState(), { force: true, scroll: true });
  try {
    if (to === 'lidia') await ctx.api('POST', '/api/lidia', { text, files });
    else await ctx.api('POST', `/api/sessions/${to}/message`, { text, files });
  } finally { pending = null; update(ctx.getState(), { force: true }); }
}

function choose(c) {
  if (c === 'leave') return closeTalk();
  if (c === 'orders') { closeTalk(); return ctx.openOrders(); }
  if (c === 'reports') {
    mode = 'reports';
    type(reportsLine(ctx.getState()));
    $('#talk-reports').hidden = false;
    renderReports(ctx.getState());
    return;
  }
  if (c === 'text') return openChat('lidia');
  if (c.startsWith('agent:')) ctx.openSession(c.slice(6));
}

/** ‹ › : Lidia, then every agent that needs Jav, in a loop. */
function hopList() {
  const st = ctx.getState();
  return ['lidia', ...(st?.sessions || []).filter(needsHelp).map(s => s.id)];
}
function hop(dir) {
  const list = hopList();
  if (list.length < 2 && peer === 'lidia') { ctx.toast('Nobody else needs you right now.'); return; }
  let i = list.indexOf(peer);
  if (i < 0) i = dir > 0 ? -1 : 0;     // from an agent that's fine: next goes to the first who needs help
  openChat(list[(i + dir + list.length) % list.length]);
}

// ------------------------------------------------------------------ look (themes only change CSS, never behavior)
let chosen = null;   // what Jav just picked, until the saved setting catches up
function theme(st) {
  const set = st?.settings || {};
  if (chosen && set.chatStyle === chosen.chatStyle && set.chatColor === chosen.chatColor) chosen = null;
  applyTheme($('#talk-chat'), chosen || set);
}
export const applyChatTheme = theme;

function openCustomize() {
  $('#chat-custom').hidden = false;
  renderCustomize();
}
function currentTheme() {
  const set = ctx.getState()?.settings || {};
  return chosen || { chatStyle: set.chatStyle || DEFAULT_THEME.chatStyle, chatColor: set.chatColor || DEFAULT_THEME.chatColor };
}
function renderCustomize() {
  const t = currentTheme();
  $('#cc-style').innerHTML = STYLES.map(s => `<button data-style="${s.id}" class="${s.id === t.chatStyle ? 'on' : ''}">${esc(s.name)}<small>${esc(s.note)}</small></button>`).join('');
  const custom = !COLORS.some(c => c.hex.toLowerCase() === t.chatColor.toLowerCase());
  $('#cc-colors').innerHTML = COLORS.map(c => `<button class="sw ${c.hex.toLowerCase() === t.chatColor.toLowerCase() ? 'on' : ''}" data-color="${c.hex}" style="background:${c.hex}" aria-label="${esc(c.name)}"></button>`).join('')
    + `<label class="sw-custom ${custom ? 'on' : ''}" aria-label="Custom color"><input type="color" id="cc-pick" value="${t.chatColor}"></label>`;
  $('#cc-style').onclick = (e) => { const b = e.target.closest('[data-style]'); if (b) pick({ chatStyle: b.dataset.style }); };
  $('#cc-colors').onclick = (e) => { const b = e.target.closest('[data-color]'); if (b) pick({ chatColor: b.dataset.color }); };
  $('#cc-pick').oninput = (e) => pick({ chatColor: e.target.value }, true);
  $('#cc-pick').onchange = (e) => pick({ chatColor: e.target.value });
}
let saveTimer = null;
function pick(change, quiet) {
  chosen = { ...currentTheme(), ...change };
  theme(ctx.getState());
  if (!quiet) renderCustomize();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ctx.api('PATCH', '/api/settings', { chatStyle: chosen.chatStyle, chatColor: chosen.chatColor }).catch(e => ctx.toast(e.message)), quiet ? 400 : 0);
}

// ------------------------------------------------------------------ rendering
/** Live refresh from a state push. */
export function update(st, opt = {}) {
  if (!st) return;
  theme(st);
  if (!isOpen()) return;
  if (mode === 'reports') renderReports(st);
  if (mode !== 'chat') return;
  const s = agent();
  if (peer !== 'lidia' && !s) { openChat('lidia'); return; }   // agent evicted while open
  renderHeader(st, s);
  renderNav(st);

  const items = s ? agentItems(s) : lidiaItems(st);
  const mine = pending && pending.peer === peer;
  // Show the "Sending…" copy only until the real message is in the thread (no duplicate).
  const landed = mine && items.some(i => i.role === 'jav' && i.ts >= pending.ts - 5000 && (i.text === pending.text || i.files?.length));
  if (mine && !landed) items.push({ ts: Date.now(), role: 'jav', text: pending.text, sending: true });
  const working = s ? s.status === 'working' : !!(mine || live);
  const card = s ? actionCard(s) : '';

  const el = $('#talk-bubbles');
  const lastTs = items[items.length - 1]?.ts || 0;
  const reacts = items.map(i => Object.values(i.reactions || {}).join('')).join('|');
  const liveKey = !s && live ? `${live.thinking.length}/${live.acts.length}/${live.text.length}` : '';
  const toolsKey = s ? s.log.length : '';
  const key = `${peer}:${items.length}:${lastTs}:${reacts}:${working}:${card.length}:${s?.activity || ''}:${liveKey}:${toolsKey}:${[...openThoughts].join()}`;
  if (el.dataset.key === key && !opt.force) return;
  el.dataset.key = key;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const lastMine = items.map(i => i.role).lastIndexOf('jav');
  const seen = lastMine >= 0 && (working || items.slice(lastMine + 1).some(i => i.role === 'peer'));
  el.innerHTML = thread(items, seen ? lastMine : -1) + card + (working ? (s ? agentWorking(s) : lidiaLive()) : '') +
    (items.length ? '' : `<div class="sys">${s ? `Say hi, send a photo, or give ${esc(s.name)} a job.` : 'Text her anything: “how is everyone?”, “spin up a researcher on sonnet”, “did the lead list finish?”'}</div>`);
  if (atBottom || opt.scroll || mine) el.scrollTop = el.scrollHeight;
  bindCard(s);
  el.querySelectorAll('[data-thought]').forEach(d => d.onclick = () => {
    const k = d.dataset.thought; openThoughts.has(k) ? openThoughts.delete(k) : openThoughts.add(k);
    update(ctx.getState(), { force: true });
  });
}

const dots = '<span class="dots"><i></i><i></i><i></i></span>';
const secs = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

/** Lidia at work: her avatar, what she's doing, her thinking (faded), each command she runs, the reply as it's written. */
function lidiaLive() {
  const l = live || { started: pending?.ts || Date.now(), thinking: '', acts: [], text: '' };
  const phase = l.text ? 'writing' : l.acts.length && !l.thinking.endsWith(' ') ? 'working' : l.thinking ? 'thinking' : 'reading your text';
  const think = l.thinking.trim();
  return `<div class="them-row"><span class="ava">${avatarImg('lidia')}</span><div class="live">
    <div class="live-head">${dots} Lidia is ${phase}… <small>${secs(Date.now() - l.started)}</small></div>
    ${think ? `<div class="think live-think">${esc(think.slice(-700))}</div>` : ''}
    ${l.acts.length ? `<div class="cmds">${l.acts.map((a, i) => `<span class="${i === l.acts.length - 1 && !l.text ? 'run' : 'ok'}">${esc(a)}</span>`).join('')}</div>` : ''}
    ${l.text ? `<div class="bub them tail streaming"><div class="msg-body">${rich(l.text)}</div></div>` : ''}
  </div></div>`;
}

/** An agent at work: typing dots, what it's doing, and its last few commands. */
function agentWorking(s) {
  const since = s.log.map(e => e.role).lastIndexOf('claude');
  const cmds = s.log.slice(since + 1).filter(e => e.role === 'tool').slice(-3);
  return `<div class="them-row"><span class="ava">${avatarImg(s.id)}</span><div class="live">
    <div class="live-head">${dots} ${esc(s.name)} is ${esc(s.activity || 'working')}…</div>
    ${cmds.length ? `<div class="cmds">${cmds.map((c, i) => `<span class="${i === cmds.length - 1 ? 'run' : 'ok'}">${esc(c.tool || 'tool')}: ${esc(String(c.text).slice(0, 80))}</span>`).join('')}</div>` : ''}
  </div></div>`;
}

function lidiaItems(st) {
  return [
    ...st.lidiaChat.map(m => ({ ts: m.ts, role: m.role === 'jav' ? 'jav' : 'peer', text: m.text, files: m.files, acts: m.acts, reactions: m.reactions, owner: 'lidia', thinking: m.thinking, thoughtMs: m.thoughtMs })),
    ...(st.reports || []).map(r => ({ ts: r.ts, role: 'sys', text: `${r.name} reported → ${r.decision === 'done' ? 'stood down' : r.decision === 'escalate' ? 'needs you' : 'kept going'}${r.note ? `: ${r.note}` : ''}` })),
  ].sort((a, b) => a.ts - b.ts).reduce((out, m) => {
    // A run of reports between texts collapses to the latest one, so the thread stays a conversation.
    const prev = out[out.length - 1];
    if (m.role === 'sys' && prev?.role === 'sys') { m.more = (prev.more || 0) + 1; out[out.length - 1] = m; } else out.push(m);
    return out;
  }, []);
}

function agentItems(s) {
  return s.log.filter(e => (e.role === 'jav' || e.role === 'claude' || e.role === 'schedule') && !e.goal)
    .map(e => ({ ts: e.ts, role: e.role === 'jav' ? 'jav' : e.role === 'schedule' ? 'sys' : 'peer', text: e.role === 'schedule' ? `⏰ ${e.text}` : e.text,
      files: e.files, reactions: e.reactions, queued: e.queued, owner: s.id }));
}

/** Bubbles grouped like a messaging app: consecutive texts from one side share a tail; time stamps between gaps. */
function thread(items, seenIdx = -1) {
  let out = '', prevTs = 0;
  items.forEach((m, i) => {
    if (m.ts - prevTs > 15 * 60e3) out += `<div class="stamp">${dayTime(m.ts)}</div>`;
    prevTs = m.ts;
    if (m.role === 'sys') { out += `<div class="sys">${esc(m.text)}${m.more ? ` <small>+${m.more} earlier</small>` : ''}</div>`; return; }
    const next = items[i + 1];
    const tail = !next || next.role !== m.role || next.ts - m.ts > 5 * 60e3;
    const theirs = m.role === 'jav' ? m.reactions?.peer : m.reactions?.jav;
    const owner = m.owner || peer;
    const thought = m.thinking ? `<button class="thought ${openThoughts.has(String(m.ts)) ? 'open' : ''}" data-thought="${m.ts}">Thought for ${secs(m.thoughtMs || 0)} <i>${openThoughts.has(String(m.ts)) ? '▾' : '▸'}</i></button>${openThoughts.has(String(m.ts)) ? `<div class="think">${esc(m.thinking)}</div>` : ''}` : '';
    if (m.role !== 'jav') out += `${thought}<div class="them-row"><span class="ava">${tail ? avatarImg(owner) : ''}</span>`;
    out += `<div class="bub ${m.role === 'jav' ? 'me' : 'them'}${tail ? ' tail' : ''}${theirs ? ' reacted' : ''}${m.queued ? ' dim' : ''}" data-ts="${m.ts}" data-owner="${esc(owner)}" data-role="${m.role}">
      ${m.text ? `<div class="msg-body">${rich(m.text)}</div>` : ''}${fileChips(owner, m.files)}
      ${m.acts?.length ? `<div class="acts">${m.acts.map(a => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
      ${theirs ? `<span class="react">${theirs}</span>` : ''}
    </div>${m.role !== 'jav' ? '</div>' : ''}${tail ? `<div class="meta ${m.role === 'jav' ? 'me' : 'them'}">${m.queued ? 'Delivered after this turn' : time(m.ts)}${i === seenIdx ? ' <b class="seen">● Seen</b>' : ''}</div>` : ''}`;
  });
  return out;
}

function dayTime(ts) {
  const d = new Date(ts), today = new Date().toDateString() === d.toDateString();
  return today ? time(ts) : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time(ts)}`;
}

/** What the agent needs from Jav, as a card in the thread. */
function actionCard(s) {
  const p = s.pendingPermission;
  if (p?.kind === 'money') return `<div class="card-ask money"><b>Money: only you can approve this</b>
    <p>${esc(s.name)} wants to run ${esc(p.reason)} using <code>${esc(p.tool)}</code>.</p><pre>${esc(p.input)}</pre>
    <div class="row"><button class="danger" data-allow="0">DENY</button><button class="primary" data-allow="1">APPROVE</button></div></div>`;
  if (p?.tool === 'ExitPlanMode') return `<div class="card-ask"><b>${esc(s.name)}'s plan</b><div class="plan-text">${rich(p.input)}</div>
    <div class="row"><button class="primary" data-allow="1">APPROVE PLAN</button><button class="danger" data-allow="0">KEEP PLANNING</button></div></div>`;
  if (p) return `<div class="card-ask"><b>May I use ${esc(p.tool)}?</b><pre>${esc(p.input)}</pre>
    <div class="row"><button class="primary" data-allow="1">ALLOW</button><button class="danger" data-allow="0">DENY</button></div></div>`;
  if (s.status === 'error' && s.crash) return `<div class="card-ask money"><b>${esc(s.name)} crashed</b>
    <p>Claude couldn't run this turn:</p><pre>${esc(s.crash.reason)}</pre>
    <div class="row"><button class="primary" data-crash="retry">TRY AGAIN</button><button class="danger" data-crash="evict">EVICT</button></div></div>`;
  if (s.pendingQuestion) return `<div class="card-ask"><b>Needs your call</b><p>${esc(s.pendingQuestion)}</p><small>Just text your answer. Lidia remembers it for next time.</small></div>`;
  return '';
}

function bindCard(s) {
  if (!s) return;
  const el = $('#talk-bubbles');
  el.querySelectorAll('[data-allow]').forEach(b => b.onclick = () =>
    ctx.api('POST', `/api/sessions/${s.id}/permission`, { permissionId: s.pendingPermission?.id, allow: b.dataset.allow === '1' }).catch(e => ctx.toast(e.message)));
  el.querySelectorAll('[data-crash]').forEach(b => b.onclick = async () => {
    if (b.dataset.crash === 'retry') return ctx.api('POST', `/api/sessions/${s.id}/retry`).catch(e => ctx.toast(e.message));
    if (confirm(`Evict ${s.name}? Their files stay on the phone.`)) { await ctx.api('DELETE', `/api/sessions/${s.id}`); openChat('lidia'); }
  });
}

const STATUS = { idle: 'online', working: 'working', reporting: 'reporting to Lidia', needs_jav: 'needs you', done: 'done for now', error: 'crashed' };
function renderHeader(st, s) {
  $('#chat-name').textContent = s ? s.name : 'Lidia';
  const status = $('#talk-status');
  if (s) {
    status.textContent = s.status === 'working' ? `${s.activity || 'working'}…` : STATUS[s.status] || s.status;
    status.className = needsHelp(s) ? 'red' : s.status === 'working' ? 'green' : '';
  } else {
    const busy = st.sessions.filter(x => x.status === 'working').length;
    status.textContent = live ? (live.text ? 'writing…' : 'thinking…') : pending?.peer === 'lidia' ? 'typing…' : busy ? `watching ${busy} at work` : 'on the bridge';
    status.className = 'green';
  }
  const nm = s ? s.name : 'Lidia';
  $('#talk-input').placeholder = nm.length <= 12 ? `Text ${nm}…` : 'Text…';
  drawAvatar(s);
}

function renderNav(st) {
  const others = st.sessions.filter(needsHelp);
  const i = others.findIndex(x => x.id === peer);
  const label = others.length
    ? (i >= 0 ? `${i + 1} of ${others.length} need you` : `${others.length} need${others.length > 1 ? '' : 's'} you`)
    : 'nobody needs you';
  $('#chat-nav-label').textContent = label;
  $('#chat-nav-label').className = others.length ? 'red' : '';
}

// ------------------------------------------------------------------ reactions + copy (press and hold a bubble)
let reactFor = null;
function bindBubbles() {
  const box = $('#talk-bubbles');
  let timer = null, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.bub');
    if (!b || e.target.closest('a, button, .codeblock')) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { timer = null; openReactBar(b); }, 420);
  });
  box.addEventListener('pointermove', (e) => { if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel(); });
  box.addEventListener('pointerup', cancel);
  box.addEventListener('pointercancel', cancel);
  box.addEventListener('scroll', () => { cancel(); closeReactBar(); });
  box.addEventListener('contextmenu', (e) => { if (e.target.closest('.bub')) e.preventDefault(); });
  box.addEventListener('dblclick', (e) => { const b = e.target.closest('.bub.them'); if (b) react(b, '❤️'); });
  document.addEventListener('pointerdown', (e) => { if (!$('#react-bar').hidden && !e.target.closest('#react-bar, .bub')) closeReactBar(); });
}

function openReactBar(b) {
  reactFor = b;
  navigator.vibrate?.(12);
  const bar = $('#react-bar');
  const theirs = b.dataset.role !== 'jav';
  bar.innerHTML = (theirs ? EMOJI.map(e => `<button data-e="${e}">${e}</button>`).join('') : '') + '<button data-e="copy" class="copy">Copy</button>';
  bar.hidden = false;
  const r = b.getBoundingClientRect(), host = $('#talk-chat').getBoundingClientRect();
  const top = Math.max(r.top - host.top - bar.offsetHeight - 6, 60);
  bar.style.top = `${top}px`;
  bar.style.left = theirs ? '10px' : 'auto';
  bar.style.right = theirs ? 'auto' : '10px';
  document.querySelectorAll('.bub.lift').forEach(x => x.classList.remove('lift'));
  b.classList.add('lift');
  bar.onclick = (e) => {
    const k = e.target.closest('[data-e]')?.dataset.e;
    if (!k) return;
    if (k === 'copy') copyText(b.querySelector('.msg-body')?.innerText || '');
    else react(b, k);
    closeReactBar();
  };
}
function closeReactBar() {
  const bar = $('#react-bar'); if (bar) bar.hidden = true;
  document.querySelectorAll('.bub.lift').forEach(x => x.classList.remove('lift'));
  reactFor = null;
}
function react(b, emoji) {
  ctx.api('POST', '/api/react', { owner: b.dataset.owner, ts: Number(b.dataset.ts), emoji }).catch(e => ctx.toast(e.message));
}
function copyText(t) {
  const done = () => ctx.toast('Copied');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
  else fallbackCopy(t, done);
}
function fallbackCopy(t, done) {
  const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch {} ta.remove();
}

// ------------------------------------------------------------------ Lidia's dialogue scene
function renderReports(st) {
  const reps = (st.reports || []).slice(-20).reverse();
  $('#talk-reports').innerHTML = reps.map(r => `<button class="rep" data-c="agent:${esc(r.sessionId)}"><i class="d-${esc(r.decision)}"></i>
      <span><b>${esc(r.name)}</b> ${esc(r.note || r.question || '')}</span><small>${time(r.ts)}</small></button>`).join('')
    || '<div class="muted">No reports yet. Agents report to me when they finish a turn.</div>';
}

function greeting(st) {
  if (!st) return 'Jav.';
  const n = st.sessions.length;
  if (!n) return "Bunker's quiet, Jav. No one on shift yet. Tap DIG, or text me and I'll put a team together.";
  const red = st.sessions.filter(needsHelp);
  const busy = st.sessions.filter(s => s.status === 'working' || s.status === 'reporting');
  const done = st.sessions.filter(s => s.status === 'done');
  const parts = [];
  if (red.length) {
    const q = red[0].pendingQuestion || (red[0].pendingPermission ? `wants permission to use ${red[0].pendingPermission.tool}` : red[0].status === 'error' ? 'crashed' : 'is waiting on you');
    parts.push(`${list(red.map(s => s.name))} ${red.length > 1 ? 'need' : 'needs'} you. ${red[0].name}: ${q}`);
  }
  parts.push(busy.length ? `${list(busy.map(s => s.name))} ${busy.length > 1 ? 'are' : 'is'} working.` : 'Nobody is working right now.');
  if (done.length) parts.push(`${done.length} stood down.`);
  const last = (st.reports || [])[st.reports.length - 1];
  if (last) parts.push(`Last report: ${last.name}, ${last.note || last.decision}.`);
  return `Jav. ${parts.join(' ')}`;
}

function reportsLine(st) {
  const n = (st.reports || []).length;
  return n ? 'Latest reports from the floors. Tap one and I\'ll take you to them.' : 'Nothing has come up the shaft yet.';
}

const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

function type(text) {
  clearInterval(typing);
  const el = $('#talk-text');
  el.textContent = '';
  $('#talk-next').hidden = true;
  let i = 0;
  typing = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) finishTyping();
  }, 24);
  el.dataset.full = text;
}
function finishTyping() {
  clearInterval(typing); typing = null;
  const el = $('#talk-text');
  el.textContent = el.dataset.full || el.textContent;
  $('#talk-next').hidden = mode !== 'dialogue';
}

// ------------------------------------------------------------------ portraits
function drawPortrait() {
  const p = art.portrait, cv = $('#talk-portrait');
  if (!p) return;
  const S = Math.max(2, Math.floor(Math.min((innerHeight - 300) / p.height, (innerWidth - 20) / p.width)));
  cv.width = p.width * S; cv.height = p.height * S;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(p, 0, 0, cv.width, cv.height);
}

const avatars = new Map();
/** Small round avatar for the thread: Lidia's portrait or the agent's own character. */
function avatarImg(who) {
  const s = who === 'lidia' ? null : ctx.getState()?.sessions.find(x => x.id === who);
  const k = s ? `${s.id}:${s.look}:${art.cast?.length}` : `lidia:${!!art.portrait}`;
  if (!avatars.has(k)) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 40;
    paintAvatar(cv, s);
    avatars.set(k, cv.toDataURL());
  }
  return `<img src="${avatars.get(k)}" alt=""${s ? ` style="background:hsl(${s.hue ?? 0},28%,22%)"` : ''}>`;
}

const hash = (str) => [...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function drawAvatar(s) {
  const cv = $('#talk-avatar');
  cv.style.background = s ? `hsl(${s.hue ?? 0},28%,22%)` : '';
  paintAvatar(cv, s);
}
function paintAvatar(cv, s) {
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, 40, 40);
  if (!s) {
    const p = art.portrait; if (!p) return;
    const side = Math.round(p.width * 0.62);
    g.drawImage(p, Math.round((p.width - side) / 2), 0, side, side, 0, 0, 40, 40);
    return;
  }
  // The agent's own character: head and shoulders of their first frame.
  const look = art.cast?.length ? art.cast[(s.look ?? hash(s.id)) % art.cast.length] : null;
  const f = (look?.anims || art.chars.survivor)?.walk?.[0];
  if (!f) return;
  const side = Math.round(f.width * 0.9), S = 40 / side;
  g.drawImage(f, Math.round((f.width - side) / 2), 0, side, side, 0, Math.round(4 * S / 2), 40, 40);
}
