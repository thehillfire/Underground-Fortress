// Dwellers: each one is a Claude session living in its own room.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { store, id, WORKSPACES } from './store.js';
import { runTurn } from './agent.js';
import * as lidia from './lidia.js';
import { mcpServersFor } from './connectors.js';

export const events = new EventEmitter(); // bubbles/animations for the browser

const ROOM_TYPES = ['workshop', 'library', 'server', 'lab'];
const running = new Map();       // session id -> AbortController
const permissionWaiters = new Map(); // permission id -> resolve

function log(s, role, text, extra = {}) {
  s.log.push({ ts: Date.now(), role, text: String(text), ...extra });
  if (s.log.length > 1000) s.log.splice(0, s.log.length - 1000);
  store.changed();
}

function setStatus(s, status, activity = s.activity) {
  s.status = status;
  s.activity = activity;
  store.changed();
}

function cwdFor(s) {
  if (s.repoId) {
    const repo = store.state.repos.find(r => r.id === s.repoId);
    if (repo?.status === 'ready') return repo.path;
  }
  const dir = path.join(WORKSPACES, s.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function activityFor(tool) {
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|LS)$/.test(tool)) return 'researching';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'building';
  if (tool === 'Bash') return 'operating machines';
  if (tool.startsWith('mcp__')) return `using ${tool.split('__')[1]}`;
  if (tool === 'Task' || tool === 'Agent') return 'briefing a helper';
  if (tool === 'Skill') return 'using a skill';
  return tool;
}

export function create({ name, goal = '', roomType, repoId = null }) {
  const st = store.state;
  const s = {
    id: id('s'),
    name: (name || `Dweller ${st.sessions.length + 1}`).slice(0, 40),
    goal,
    roomType: ROOM_TYPES.includes(roomType) ? roomType : ROOM_TYPES[st.sessions.length % ROOM_TYPES.length],
    repoId,
    hue: Math.floor(Math.random() * 360),
    sdkSessionId: null,
    status: 'idle',
    activity: 'settling in',
    log: [],
    queue: [],
    autoTurns: 0,
    pendingQuestion: null,
    pendingPermission: null,
    costUsd: 0,
    createdAt: Date.now(),
  };
  st.sessions.push(s);
  store.feed(`${s.name} moved into a new ${s.roomType}.`, 'info', s.id);
  if (goal) send(s.id, goal, 'jav');
  return s;
}

export function remove(sid) {
  stop(sid);
  const st = store.state;
  st.sessions = st.sessions.filter(s => s.id !== sid);
  store.changed();
}

export function update(sid, patch) {
  const s = store.session(sid);
  if (!s) return null;
  for (const k of ['name', 'goal', 'roomType', 'repoId']) if (k in patch) s[k] = patch[k];
  store.changed();
  return s;
}

export function stop(sid) {
  running.get(sid)?.abort();
  const s = store.session(sid);
  if (s?.pendingPermission) answerPermission(sid, s.pendingPermission.id, false);
}

/** A message for a session, from Jav or Lidia. */
export function send(sid, text, from = 'jav') {
  const s = store.session(sid);
  if (!s || !text?.trim()) return;
  if (from === 'jav') {
    s.autoTurns = 0;
    if (s.pendingQuestion) {
      store.state.precedents.push({ ts: Date.now(), session: s.name, question: s.pendingQuestion, answer: text });
      if (store.state.precedents.length > 100) store.state.precedents.shift();
      s.pendingQuestion = null;
    }
  }
  if (running.has(sid)) {
    s.queue.push({ text, from });
    log(s, 'system', `Queued message from ${from === 'jav' ? 'Jav' : 'Lidia'}.`);
    return;
  }
  turn(s, text, from);
}

async function turn(s, text, from) {
  log(s, from, text);
  setStatus(s, 'working', 'thinking');
  if (from === 'lidia') events.emit('bubble', { who: 'lidia', sessionId: s.id, text });

  const ac = new AbortController();
  running.set(s.id, ac);
  let out;
  try {
    out = await runTurn({
      prompt: text,
      cwd: cwdFor(s),
      resume: s.sdkSessionId,
      model: store.state.settings.model,
      permissionMode: store.state.settings.permissionMode,
      mcpServers: mcpServersFor(),
      appendSystem: `You are "${s.name}", a dweller in Jav's Underground Fortress. Your captain is Lidia; when you finish a turn she reads your final message and decides what you do next, or asks Jav. End every turn with a short, plain report: what you did, what is left, and any question that blocks you.${s.goal ? `\nYour standing goal: ${s.goal}` : ''}`,
      abortController: ac,
      onInit: (m) => { if (m.session_id) s.sdkSessionId = m.session_id; store.changed(); },
      onText: (t) => { log(s, 'claude', t); events.emit('bubble', { who: 'session', sessionId: s.id, text: t }); },
      onTool: (name, input) => {
        log(s, 'tool', summarizeInput(input), { tool: name });
        setStatus(s, 'working', activityFor(name));
      },
      canUseTool: (toolName, input) => askPermission(s, toolName, input),
    });
  } catch (err) {
    out = { result: `Error: ${err.message}`, isError: true, costUsd: 0 };
  } finally {
    running.delete(s.id);
  }
  if (out.sessionId) s.sdkSessionId = out.sessionId;
  s.costUsd += out.costUsd || 0;

  if (ac.signal.aborted) {
    log(s, 'system', 'Stopped by Jav.');
    setStatus(s, 'idle', 'resting');
    return drainQueue(s);
  }
  if (out.isError) log(s, 'system', out.result);

  // Jav's queued words outrank Lidia's review.
  if (s.queue.length) return drainQueue(s);
  await report(s, out.result, out.isError);
}

function drainQueue(s) {
  const next = s.queue.shift();
  if (next) turn(s, next.text, next.from);
}

/** Walk up to Lidia and get told what to do next. */
async function report(s, result, isError) {
  const st = store.state;
  if (!st.settings.lidiaAutopilot) {
    setStatus(s, 'idle', 'waiting for Jav');
    return;
  }
  setStatus(s, 'reporting', 'reporting to Lidia');
  events.emit('report', { sessionId: s.id });

  let d;
  if (s.autoTurns >= st.settings.maxAutoTurns) {
    d = { decision: 'escalate', question: `I've pushed ${s.name} ${s.autoTurns} times in a row. Should they keep going, and in what direction?`, note: 'auto-turn limit reached' };
  } else {
    try { d = await lidia.review(s, isError ? `THE TURN FAILED: ${result}` : result); }
    catch (err) { d = { decision: 'escalate', question: `I couldn't review this report (${err.message}).`, note: 'review failed' }; }
  }
  // Jav may have spoken while Lidia was thinking.
  if (s.queue.length) return drainQueue(s);

  if (d.decision === 'continue') {
    s.autoTurns += 1;
    store.feed(`Lidia → ${s.name}: ${d.note || d.instruction}`, 'lidia', s.id);
    turn(s, d.instruction, 'lidia');
  } else if (d.decision === 'done') {
    log(s, 'lidia', `Good work. ${d.note || 'Goal complete.'}`);
    events.emit('bubble', { who: 'lidia', sessionId: s.id, text: 'Good work. Stand down.' });
    store.feed(`${s.name} finished: ${d.note || 'goal complete'}`, 'done', s.id);
    setStatus(s, 'done', 'off duty');
  } else {
    s.pendingQuestion = d.question;
    log(s, 'lidia', `I need Jav on this: ${d.question}`);
    store.feed(`${s.name} needs Jav: ${d.question}`, 'alert', s.id);
    setStatus(s, 'needs_jav', 'waiting for Jav');
    events.emit('alert', { sessionId: s.id, text: d.question });
  }
}

function askPermission(s, toolName, input) {
  const pid = id('perm');
  return new Promise((resolve) => {
    s.pendingPermission = { id: pid, tool: toolName, input: summarizeInput(input) };
    const prev = s.status;
    setStatus(s, 'needs_jav', `asking to use ${toolName}`);
    store.feed(`${s.name} asks permission for ${toolName}.`, 'alert', s.id);
    events.emit('alert', { sessionId: s.id, text: `May I use ${toolName}?` });
    permissionWaiters.set(pid, (allow) => {
      s.pendingPermission = null;
      setStatus(s, prev === 'needs_jav' ? 'working' : prev, activityFor(toolName));
      resolve(allow ? { behavior: 'allow', updatedInput: input }
                    : { behavior: 'deny', message: 'Jav denied this action.' });
    });
  });
}

export function answerPermission(sid, pid, allow) {
  const fn = permissionWaiters.get(pid);
  if (!fn) return false;
  permissionWaiters.delete(pid);
  const s = store.session(sid);
  if (s) log(s, 'jav', allow ? `Allowed ${s.pendingPermission?.tool}.` : `Denied ${s.pendingPermission?.tool}.`);
  fn(allow);
  return true;
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const v = input.command || input.file_path || input.pattern || input.query || input.url || input.description || input.prompt;
  return String(v ?? JSON.stringify(input)).slice(0, 300);
}

/** Jav talks to Lidia. */
export async function talkToLidia(text) {
  const st = store.state;
  st.lidiaChat.push({ ts: Date.now(), role: 'jav', text });
  store.changed();
  events.emit('bubble', { who: 'lidia-thinking' });
  let r;
  try { r = await lidia.chat(text); }
  catch (err) { r = { reply: `I can't reach the surface right now: ${err.message}` }; }

  const acts = [];
  if (r.standingOrders) { st.standingOrders = r.standingOrders; acts.push('updated standing orders'); }
  for (const d of r.dispatch || []) {
    const s = st.sessions.find(x => x.name.toLowerCase() === String(d.session).toLowerCase());
    if (s && d.message) { send(s.id, d.message, 'lidia'); acts.push(`relayed to ${s.name}`); }
  }
  if (r.newSession?.name) {
    const s = create({ name: r.newSession.name, goal: r.newSession.goal || '', roomType: r.newSession.roomType });
    acts.push(`opened a room for ${s.name}`);
  }
  st.lidiaChat.push({ ts: Date.now(), role: 'lidia', text: r.reply || 'Copy that.', acts });
  store.changed();
  events.emit('bubble', { who: 'lidia', text: r.reply, speak: true });
  return r;
}
