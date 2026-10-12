// Talking to Lidia: a game-style dialogue scene (portrait + dialogue box + choices),
// a reports board, and a texting view with her.
import { art } from './assets.js';
import { rich, copyBtn } from './rich.js';
import { makeAttach, fileChips } from './attach.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let ctx = null;        // { api, getState, openSession, openOrders, startMic, onClose }
let mode = null;       // 'dialogue' | 'reports' | 'chat'
let typing = null;     // typewriter timer
let waiting = false;   // Jav sent a text, Lidia hasn't answered yet
let attach = null;

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
    input.value = '';
    await send(t, files);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); } };
  $('#talk-mic').onclick = () => ctx.startMic();
}

export const isOpen = () => !$('#talk').hidden;

export function openTalk(start = 'dialogue') {
  $('#talk').hidden = false;
  drawPortrait();
  if (start === 'chat') return choose('text');
  mode = 'dialogue';
  $('#talk-chat').hidden = true;
  $('#talk-reports').hidden = true;
  $('#talk-choices').hidden = false;
  const line = greeting(ctx.getState());
  type(line);
}

export function closeTalk() {
  $('#talk').hidden = true;
  clearInterval(typing); typing = null;
  mode = null;
  ctx.onClose?.();
}

/** Send a text to Lidia (also used by the mic). */
export async function send(text, files = []) {
  if (mode !== 'chat') choose('text');
  waiting = true;
  update(ctx.getState(), { pending: text || `(${files.length} attachment${files.length > 1 ? 's' : ''})` });
  try { await ctx.api('POST', '/api/lidia', { text, files }); }
  catch (err) { waiting = false; update(ctx.getState(), { force: true }); throw err; }
  finally { waiting = false; update(ctx.getState()); }
}

function choose(c) {
  if (c === 'leave') return closeTalk();
  if (c === 'orders') { closeTalk(); return ctx.openOrders(); }
  if (c === 'back') { $('#talk-chat').hidden = true; return openTalk('dialogue'); }
  if (c === 'reports') {
    mode = 'reports';
    type(reportsLine(ctx.getState()));
    $('#talk-reports').hidden = false;
    renderReports(ctx.getState());
    return;
  }
  if (c === 'text') {
    mode = 'chat';
    $('#talk-chat').hidden = false;
    drawAvatar();
    update(ctx.getState());
    setTimeout(() => { const b = $('#talk-bubbles'); b.scrollTop = b.scrollHeight; }, 0);
  }
  if (c.startsWith('agent:')) { closeTalk(); ctx.openSession(c.slice(6)); }
}

/** Live refresh from a state push. */
export function update(st, opt = {}) {
  if (!isOpen() || !st) return;
  if (mode === 'reports') renderReports(st);
  if (mode !== 'chat') return;
  const busy = st.sessions.filter(s => s.status === 'working').length;
  $('#talk-status').textContent = waiting ? 'typing…' : busy ? `watching ${busy} at work` : 'on the bridge';
  // Interleave her texts with the reports she handled, in time order.
  const items = [
    ...st.lidiaChat.map(m => ({ ts: m.ts, html: bubble(m) })),
    ...(st.reports || []).map(r => ({ ts: r.ts, html: `<div class="bub report">${esc(r.name)} reported → ${r.decision === 'done' ? 'stood down' : r.decision === 'escalate' ? 'needs you' : 'kept going'}${r.note ? `: ${esc(r.note)}` : ''}<time>${time(r.ts)}</time></div>` })),
  ].sort((a, b) => a.ts - b.ts);
  if (opt.pending) items.push({ ts: Date.now(), html: bubble({ role: 'jav', text: opt.pending, ts: Date.now() }) });
  const el = $('#talk-bubbles');
  const key = `${st.lidiaChat.length}:${(st.reports || []).length}:${waiting}:${opt.pending || ''}`;
  if (el.dataset.key === key && !opt.force) return;
  el.dataset.key = key;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = items.map(i => i.html).join('') +
    (waiting ? '<div class="typing"><span></span><span></span><span></span></div>' : '') +
    (items.length ? '' : '<div class="bub report">Text her anything: “how is everyone?”, “spin up a researcher on sonnet”, “give Medic this list…”</div>');
  if (atBottom || opt.pending) el.scrollTop = el.scrollHeight;
}

function bubble(m) {
  const acts = m.acts?.length ? `<div class="acts">${m.acts.map(a => `<span>${esc(a)}</span>`).join('')}</div>` : '';
  return `<div class="bub ${m.role === 'jav' ? 'jav' : 'lidia'}">${m.text ? `<div class="msg-body">${rich(m.text)}</div>` : ''}${fileChips('lidia', m.files)}${acts}<div class="bub-foot"><time>${time(m.ts)}</time>${copyBtn(m.text)}</div></div>`;
}

function renderReports(st) {
  const reps = (st.reports || []).slice(-20).reverse();
  $('#talk-reports').innerHTML = reps.map(r => `<button class="rep" data-c="agent:${esc(r.sessionId)}"><i class="d-${esc(r.decision)}"></i>
      <span><b>${esc(r.name)}</b> ${esc(r.note || r.question || '')}</span><small>${time(r.ts)}</small></button>`).join('')
    || '<div class="muted">No reports yet. Agents report to me when they finish a turn.</div>';
}

// ------------------------------------------------------------------ her lines
function greeting(st) {
  if (!st) return 'Jav.';
  const n = st.sessions.length;
  if (!n) return "Bunker's quiet, Jav. No one on shift yet. Tap DIG, or text me and I'll put a team together.";
  const red = st.sessions.filter(s => s.status === 'needs_jav');
  const busy = st.sessions.filter(s => s.status === 'working' || s.status === 'reporting');
  const done = st.sessions.filter(s => s.status === 'done');
  const parts = [];
  if (red.length) {
    const q = red[0].pendingQuestion || (red[0].pendingPermission ? `wants permission to use ${red[0].pendingPermission.tool}` : 'is waiting on you');
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

// ------------------------------------------------------------------ portrait
function drawPortrait() {
  const p = art.portrait, cv = $('#talk-portrait');
  if (!p) return;
  const S = Math.max(2, Math.floor(Math.min((innerHeight - 300) / p.height, (innerWidth - 20) / p.width)));
  cv.width = p.width * S; cv.height = p.height * S;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(p, 0, 0, cv.width, cv.height);
}
function drawAvatar() {
  const p = art.portrait, cv = $('#talk-avatar');
  if (!p) return;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, 40, 40);
  // head and shoulders crop
  const side = Math.round(p.width * 0.62);
  g.drawImage(p, Math.round((p.width - side) / 2), 0, side, side, 0, 0, 40, 40);
}
