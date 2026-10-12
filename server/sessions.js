// Dwellers: each one is a Claude session living in its own room.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { store, id, WORKSPACES, PERMISSION_MODES } from './store.js';
import { runTurn, runReview } from './agent.js';
import { moneyHooks } from './guard.js';
import { installed as installedSkills } from './skills.js';
import { peakUsage, refreshSoon } from './usage.js';
import { agentScheduleServer, tz } from './schedule.js';
import { saveUploads, promptWithFiles, fileMeta } from './files.js';
import { DATA_DIR } from './store.js';
import { reactTool, takeNotes, setReaction } from './reactions.js';
import { project, projectDir, members, findProject, createProject, pruneEmpty, migrate } from './projects.js';
import * as lidia from './lidia.js';
import { mcpServersFor } from './connectors.js';
import { triagePermission } from './intent.js';
import { handleCrash, resolved, cancel as cancelIncident } from './incidents.js';

export const events = new EventEmitter(); // bubbles/animations for the browser

const running = new Map();       // session id -> AbortController
// Fortress tools that change something (a claim of action needs one of these, or a connected app, behind it).
const WRITE_TOOLS = new Set(['create_agent', 'message_agent', 'move_agent', 'create_project', 'rename_project', 'provide_data', 'set_model', 'set_permission_mode', 'answer_permission', 'update_settings', 'schedule_task', 'install_skills', 'connect_repo', 'evict_agent', 'retry_agent', 'stop_agent', 'set_standing_orders', 'remember_preference', 'cancel_schedule']);
const permissionWaiters = new Map(); // permission id -> resolve

function log(s, role, text, extra = {}) {
  s.log.push({ ts: Date.now(), role, text: String(text), ...extra });
  if (s.log.length > 1000) s.log.splice(0, s.log.length - 1000);
  store.changed();
}

/** What to show when an agent is flagged for Jav but nobody recorded why (never leave a red agent unexplained). */
const orphanAsk = (s) => {
  const last = [...s.log].reverse().find(e => e.role === 'claude')?.text;
  return `${s.name} was flagged for you, but no question was recorded.${last ? ` Its last message: "${String(last).replace(/\s+/g, ' ').slice(0, 280)}"` : ''} Tell it what to do next.`;
};

function setStatus(s, status, activity = s.activity) {
  if (status === 'needs_jav' && !String(s.pendingQuestion || '').trim() && !s.pendingPermission) s.pendingQuestion = orphanAsk(s);
  if (s.status !== status) s.statusSince = Date.now();
  s.status = status;
  s.activity = activity;
  store.changed();
}

migrate();
// Agents that crashed before crashes were tracked (Lidia escalated them as "needs Jav"): mark them crashed.
for (const s of store.state.sessions) {
  const lastSys = [...s.log].reverse().find(e => e.role === 'system');
  if (s.status !== 'needs_jav' || s.crash || !/exited with code|cannot be used with root/.test(lastSys?.text || '')) continue;
  const asked = [...s.log].reverse().find(e => e.role === 'jav' || e.role === 'lidia' || e.role === 'schedule');
  s.crash = { ts: lastSys.ts, reason: (/stderr: ([^\n]+)/.exec(lastSys.text)?.[1] || lastSys.text).slice(0, 300), text: asked?.text || s.goal, from: asked?.role || 'jav' };
  s.status = 'error'; s.activity = 'crashed'; s.pendingQuestion = null;
}

/**
 * Where an agent's turns run. A conversation can only be resumed from the folder it
 * started in, so an agent keeps that folder after it moves; the new project's folder
 * is added to its workspace instead (see projectExtraDirs).
 */
export function cwdFor(s) {
  if (s.cwd && s.sdkSessionId && fs.existsSync(s.cwd)) return s.cwd;
  const p = project(s.projectId);
  const dir = p ? projectDir(p) : path.join(WORKSPACES, s.id);
  fs.mkdirSync(dir, { recursive: true });
  s.cwd = dir;
  return dir;
}

function projectExtraDirs(s) {
  const p = project(s.projectId);
  const dir = p && projectDir(p);
  return dir && dir !== cwdFor(s) ? [dir] : [];
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

/**
 * A new agent. It joins `projectId`, or the project named `project` (opened if it
 * doesn't exist yet); with neither, it gets a room of its own.
 */
export function create({ name, goal = '', projectId, project: projectName, roomType, repoId = null, model = '', effort = '', permissionMode = '', by = 'jav' }) {
  const st = store.state;
  name = (name || `Dweller ${st.sessions.length + 1}`).slice(0, 40);
  let p = projectId ? project(projectId) : null;
  if (!p && projectName) p = findProject(projectName) || createProject({ name: projectName, roomType, repoId, by });
  if (!p) p = createProject({ name, goal, roomType, repoId, auto: true, by });
  const s = {
    id: id('s'),
    name,
    goal,
    projectId: p.id,
    hue: Math.floor(Math.random() * 360),
    look: Math.floor(Math.random() * 1000),   // which character they are
    model,                 // '' = fortress default
    effort,
    permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : '',
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
  store.feed(`${by === 'lidia' ? 'Lidia assigned' : 'Jav assigned'} ${s.name} to ${p.name}.`, 'info', s.id);
  if (goal) {
    send(s.id, goal, by);
    const first = s.log[s.log.length - 1];
    if (first?.text === goal) first.goal = true;   // the goal lives in the details, not in the texts
  }
  return s;
}

export function remove(sid) {
  stop(sid);
  const st = store.state;
  st.sessions = st.sessions.filter(s => s.id !== sid);
  pruneEmpty();
  store.changed();
}

/** After a restart: tell each cut-off agent, and (unless switched off) carry on where it was. */
export function recoverInterrupted() {
  const list = store.state.sessions.filter(s => s.interrupted);
  const auto = store.state.settings.resumeOnRestart !== false;
  list.forEach((s, i) => {
    log(s, 'system', `The fortress restarted while ${s.name} was ${s.interrupted.while}.${auto ? ' Picking it back up.' : ''}`);
    if (auto) setTimeout(() => resumeInterrupted(s), 4000 + i * 3000);   // staggered: no stampede on the plan limit
  });
}
function resumeInterrupted(s) {
  const info = s.interrupted;
  if (!info || running.has(s.id)) return;
  delete s.interrupted;
  if (info.wasReporting) {                      // it had finished; Lidia hadn't decided yet
    const last = [...s.log].reverse().find(e => e.role === 'claude');
    return report(s, last?.text || '(the agent finished its turn)', false);
  }
  turn(s, s.sdkSessionId
    ? 'The fortress restarted while you were working. Pick up exactly where you left off: check what is already done, then carry on.'
    : (info.text || s.goal || 'Carry on.'), 'lidia');
}

/** Run the turn that crashed again. */
export function retry(sid) {
  const s = store.session(sid);
  if (s?.interrupted && !s.crash) { if (running.has(sid)) throw new Error(`${s.name} is already working`); resumeInterrupted(s); return { ok: true }; }
  if (!s?.crash) throw new Error('Nothing to retry');
  if (running.has(sid)) throw new Error(`${s.name} is already working`);
  const { text, from } = s.crash;
  turn(s, text || 'Continue where you left off.', from === 'jav' ? 'jav' : 'lidia');
  return { ok: true };
}

/** Move an agent into another project room. */
export function move(sid, projectId) {
  const s = store.session(sid), p = project(projectId);
  if (!s || !p) throw new Error('No such agent or project');
  if (s.projectId === p.id) return s;
  cwdFor(s);                      // pin the folder its conversation lives in
  s.projectId = p.id;
  // Said once, with the next message: the brief alone doesn't beat the habit of its old folder.
  s.moveNote = `[Fortress: you have moved into the "${p.name}" project room. Its shared folder is ${projectDir(p)}; your teammates work there. From now on, "your project folder" means that folder: read and write the project's work there.]`;
  log(s, 'system', `Moved to ${p.name}.`);
  store.feed(`${s.name} moved into ${p.name}.`, 'info', s.id);
  pruneEmpty();
  store.changed();
  return s;
}

export { PERMISSION_MODES };
const queries = new Map();   // session id -> live SDK query, for mid-turn mode changes
const modeFor = (s) => s.permissionMode || store.state.settings.permissionMode || 'acceptEdits';
// What Claude Code actually runs in. Bypass runs as accept-edits with every remaining prompt approved
// by the fortress (canUseTool), because the real bypass flag can't start as root (the phone).
const sdkMode = (s) => (modeFor(s) === 'bypassPermissions' ? 'acceptEdits' : modeFor(s));

export function update(sid, patch) {
  const s = store.session(sid);
  if (!s) return null;
  for (const k of ['name', 'goal', 'model', 'effort']) if (k in patch) s[k] = patch[k];
  if (patch.projectId) move(sid, patch.projectId);
  if ('permissionMode' in patch) {
    const m = patch.permissionMode || '';
    if (m && !PERMISSION_MODES.includes(m)) throw new Error(`unknown permission mode ${m}`);
    s.permissionMode = m;
    // Like shift+tab in Claude Code: a running turn switches right away.
    queries.get(sid)?.setPermissionMode(sdkMode(s)).catch(() => {});
  }
  store.changed();
  return s;
}

/** Lidia texts Jav about something only he can fix. level: INFO | WARN | BLOCK | CRITICAL. */
function escalateToJav(s, text, level = 'BLOCK') {
  s.escalation = { level, text, ts: Date.now() };
  store.state.lidiaChat.push({ ts: Date.now(), role: 'lidia', text: `${s.name}: ${text}`, about: s.id });
  store.feed(`${level}: ${s.name}: ${text}`, 'alert', s.id);
  events.emit('alert', { sessionId: s.id, text });
  events.emit('notify', { text: `${s.name}: ${text}`, sessionId: s.id });
  store.changed();
}

export function stop(sid) {
  cancelIncident(sid);
  running.get(sid)?.abort();
  const s = store.session(sid);
  if (s?.pendingPermission) answerPermission(sid, s.pendingPermission.id, false);
}

/** A message for a session, from Jav or Lidia. */
export const uploadDir = (s) => path.join(cwdFor(s), '.fortress', 'uploads');

export function send(sid, text, from = 'jav', files = []) {
  const s = store.session(sid);
  if (!s || (!text?.trim() && !files.length)) return null;
  const saved = files.length ? saveUploads(uploadDir(s), files) : [];
  if (from === 'jav' || from === 'jav-via-lidia' || from === 'schedule') {
    s.autoTurns = 0;
    s.refineRound = 0;      // new direction from Jav: fresh improvement budget
    if (s.pendingQuestion) {
      store.state.precedents.push({ ts: Date.now(), session: s.name, question: s.pendingQuestion, answer: text });
      if (store.state.precedents.length > 100) store.state.precedents.shift();
      s.pendingQuestion = null;
    }
  }
  if (running.has(sid)) {
    // Show it in the chat right away; it's delivered when the current turn ends.
    const role = from === 'jav-via-lidia' ? 'lidia' : from;
    log(s, role, text || '', { queued: true, ...(saved.length ? { files: fileMeta(saved) } : {}) });
    s.queue.push({ text, from, saved, logged: true });
    return 'queued';
  }
  turn(s, text, from, saved);
  return 'started';
}

/** Wait for real signs of life from an agent just given work (or its crash), so Lidia only reports what happened. */
export async function confirmAlive(sid, since, ms = 20000) {
  const s = store.session(sid);
  const t0 = Date.now();
  while (s && Date.now() - t0 < ms) {
    if (s.crash) return { ok: false, detail: `crashed on launch: ${s.crash.reason}` };
    const sign = s.log.find(e => e.ts >= since && (e.role === 'claude' || e.role === 'tool'));
    if (sign) {
      // A failed launch often "speaks" once (the error text) and stops: give that a moment to show before believing it.
      await new Promise(r => setTimeout(r, 1500));
      const err = s.log.find(e => e.ts >= since && e.error);
      const looksLikeError = sign.role === 'claude' && /^(there'?s an issue with|api error|invalid api key|credit balance|you'?ve hit your|rate limit|usage limit|error:)/i.test(String(sign.text).trim());
      if (s.crash || s.status === 'error' || err || looksLikeError) return { ok: false, detail: `failed to run: ${String(s.crash?.reason || err?.text || sign.text).replace(/\s+/g, ' ').slice(0, 160)}` };
    }
    if (sign) return { ok: true, detail: sign.role === 'tool' ? `started (first action: ${sign.tool || 'tool'} ${String(sign.text).replace(/\s+/g, ' ').slice(0, 60)})` : `started ("${String(sign.text).replace(/\s+/g, ' ').slice(0, 80)}")` };
    if (s.status === 'needs_jav') return { ok: true, detail: 'started, and is now waiting on an approval' };
    if (s.status === 'error') return { ok: false, detail: 'stopped with an error' };
    await new Promise(r => setTimeout(r, 400));
  }
  return { ok: null, detail: 'accepted the task but shows no activity yet (it may still be starting)' };
}

async function turn(s, text, from, saved = [], logged = false) {
  if (from === 'jav-via-lidia') from = 'lidia';
  delete s.interrupted;
  delete s.escalation;
  if (logged) { const q = [...s.log].reverse().find(e => e.queued); if (q) delete q.queued; }
  else log(s, from, text || '', saved.length ? { files: fileMeta(saved) } : {});
  setStatus(s, 'working', 'thinking');
  if (from === 'lidia') events.emit('bubble', { who: 'lidia', sessionId: s.id, text });

  const ac = new AbortController();
  running.set(s.id, ac);
  let out;
  try {
    out = await runTurn({
      prompt: promptWithFiles(`${s.moveNote ? `${s.moveNote}\n\n` : ''}${from === 'jav' ? takeNotes(s) : ''}${text}`, saved),
      effort: s.effort || store.state.settings.effort || undefined,
      cwd: cwdFor(s),
      additionalDirectories: projectExtraDirs(s),
      resume: s.sdkSessionId,
      model: s.model || store.state.settings.model,
      permissionMode: sdkMode(s),
      onQuery: (q) => queries.set(s.id, q),
      mcpServers: { ...mcpServersFor(), fortress: agentScheduleServer(s.id, [reactTool(() => s.log)]) },
      onMockReact: from === 'jav' ? () => { const m = [...s.log].reverse().find(e => e.role === 'jav'); if (m) setReaction(m, 'peer', '👀'); } : undefined,
      appendSystem: ownerBrief(s),
      hooks: moneyHooks((tool, input, reason) => holdMoney(s, tool, input, reason)),
      abortController: ac,
      onInit: (m) => { if (m.session_id) s.sdkSessionId = m.session_id; if (m.mcp_servers) lidia.noteConnectors(m); store.changed(); },
      onText: (t) => { log(s, 'claude', t); events.emit('bubble', { who: 'session', sessionId: s.id, text: t }); },
      onTool: (name, input) => {
        log(s, 'tool', summarizeInput(input), { tool: name });
        setStatus(s, 'working', activityFor(name));
      },
      canUseTool: (toolName, input) => {
        // Bypass: approve everything (read each time, so switching mid-turn works). The money gate
        // is a PreToolUse hook and has already run before this is asked.
        if (modeFor(s) === 'bypassPermissions' && toolName !== 'ExitPlanMode') return Promise.resolve({ behavior: 'allow', updatedInput: input });
        if (toolName.startsWith('mcp__') && store.state.settings.autoApproveConnectors !== false)
          return Promise.resolve({ behavior: 'allow', updatedInput: input });   // connectors Jav set up are trusted
        // Lidia triages: tier 0-1 she approves herself (tier 1 lands in her digest); tier 2-3 goes to Jav.
        if (toolName !== 'ExitPlanMode' && modeFor(s) !== 'plan') {
          const t = triagePermission(s, toolName, input, [cwdFor(s), ...projectExtraDirs(s)].map(d => path.resolve(d)));
          if (t.handled) return Promise.resolve({ behavior: 'allow', updatedInput: input });
        }
        return askPermission(s, toolName, input);
      },
    });
  } catch (err) {
    // Claude Code itself failed (couldn't start, or died): not something Lidia can answer.
    out = { result: `Error: ${err.message}`, isError: true, costUsd: 0, crashed: true };
  } finally {
    running.delete(s.id);
    queries.delete(s.id);
  }
  if (out.sessionId) s.sdkSessionId = out.sessionId;
  if (!out.isError) delete s.moveNote;
  s.costUsd += out.costUsd || 0;
  store.addSpend(out.costUsd, s.id);

  if (ac.signal.aborted) {
    log(s, 'system', 'Stopped by Jav.');
    setStatus(s, 'idle', 'resting');
    return drainQueue(s);
  }
  if (out.crashed) {
    const reason = (/stderr: ([^\n]+)/.exec(out.result)?.[1] || out.result.replace(/^Error: /, '')).slice(0, 300);
    s.crash = { ts: Date.now(), reason, text, from };
    log(s, 'system', `Claude couldn't run this turn: ${reason}`, { error: true });
    store.feed(`${s.name} crashed: ${reason}`, 'alert', s.id);
    setStatus(s, 'error', 'crashed');
    events.emit('alert', { sessionId: s.id, text: `Crashed: ${reason}` });
    // Lidia tries to fix it herself first (wait out a limit, drop a bad model, retry); Jav only hears if that fails.
    if (store.state.settings.lidiaAutopilot !== false) handleCrash(s, reason, { retry, setModel: (x, m) => { x.model = m; }, escalate: escalateToJav });
    return;   // a message from Jav retries; queued messages wait for that
  }
  delete s.crash;
  resolved(s);
  if (out.isError) log(s, 'system', out.result, { error: true });

  // Jav's queued words outrank Lidia's review.
  if (s.queue.length) return drainQueue(s);
  await report(s, out.result, out.isError);
}

function drainQueue(s) {
  const next = s.queue.shift();
  if (next) turn(s, next.text, next.from, next.saved || [], !!next.logged);
}

/** Every agent runs its room like a business it owns. */
function ownerBrief(s) {
  const skills = installedSkills().map(k => k.name);
  const p = project(s.projectId);
  const mates = p ? members(p.id).filter(x => x.id !== s.id) : [];
  const team = p ? `
PROJECT: you work in the "${p.name}" room${p.goal ? ` (project goal: ${p.goal})` : ''}. Its shared folder is ${projectDir(p)}; keep the project's work there.${mates.length ? `
Your teammates in this room: ${mates.map(m => `${m.name}${m.goal ? ` (${m.goal.slice(0, 120)})` : ''}`).join('; ')}. You share the folder: build on their files, don't overwrite their work, and leave handoff notes in a NOTES.md there when your work feeds theirs.` : ''}` : '';
  return `You are "${s.name}", a business owner in Jav's Underground Fortress. Your room is your business${s.goal ? ` and your mission is: ${s.goal}` : ''}.${team}
Operate like an owner who wants the best possible result:
- Plan before you act. Execute in small, verified steps. Check your work actually runs or reads well.
- Critique yourself before reporting: score your output 1-10 on outcome, quality, and how good it looks and reads to a human, and fix the weakest part if you can.
- Use skills. ${skills.length ? `Installed skills: ${skills.join(', ')}.` : 'Check which skills are installed.'} Whenever one fits (planning, design, frontend, testing, debugging, docs, review), invoke it instead of improvising.
- Texting Jav: when Jav messages you directly, react to his text with the react tool first (👍 on it / done, 👎 can't, 👀 looking, ❓ unclear, 🔥 great), then answer. Keep replies to Jav short and plain, like a text.
- Use Jav's connected apps (calendar, email, docs, CRM…) whenever they help.
- Time and schedules: Jav's timezone is ${tz()} (this machine's clock says UTC; ignore that). There is no cron or OS scheduler here. For anything at a time of day or recurring, use your schedule_task tool: the fortress wakes you up and hands you the instruction.
- Fellow owners will review your work and send fixes. Take them seriously, and push back with reasons when they're wrong.
- MONEY RULE: never spend money. Never buy, pay, subscribe, transfer, book, or enter payment details. Prepare it fully and ask Jav; the fortress blocks those actions until Jav approves.
Your captain is Lidia. End every turn with a short report: what you did, your self-score (n/10), what's next, and any blocker.`;
}

/** Walk up to Lidia and get told what to do next. */
// Which agents Lidia is reviewing right now (the app shows "Lidia is reviewing X…" and her thinking).
const reviewingNow = new Map();
let reviewTimer = null;
function emitReviewing() {
  if (reviewTimer) return;
  reviewTimer = setTimeout(() => {
    reviewTimer = null;
    events.emit('lidia-reviewing', { list: [...reviewingNow.entries()].map(([id, r]) => ({ id, name: r.name, since: r.since, thinking: r.thinking.slice(-600) })) });
  }, 120);
}

async function report(s, result, isError) {
  const st = store.state;
  if (!st.settings.lidiaAutopilot) {
    setStatus(s, 'idle', 'waiting for Jav');
    return;
  }
  setStatus(s, 'reporting', 'reporting to Lidia');
  events.emit('report', { sessionId: s.id });

  let d;
  const rv = { name: s.name, since: Date.now(), thinking: '' };
  reviewingNow.set(s.id, rv); emitReviewing();
  try {
    if (s.autoTurns >= st.settings.maxAutoTurns) {
      d = { decision: 'escalate', note: 'auto-turn limit reached', reasoning: `I have already pushed ${s.name} ${s.autoTurns} times in a row without hearing from you.`,
        message_to_jav: `I've pushed ${s.name} ${s.autoTurns} times in a row. Should it keep going, and in what direction?` };
    } else {
      try { d = await lidia.review(s, isError ? `THE TURN FAILED: ${result}` : result, { onThinking: (t) => { rv.thinking += t; emitReviewing(); } }); }
      catch (err) { d = { decision: 'escalate', note: 'review failed', reasoning: `My review failed: ${err.message}`, message_to_jav: `${s.name} reported, but I couldn't review it (${err.message}). Can you look?` }; }
    }
  } finally { reviewingNow.delete(s.id); emitReviewing(); }
  // Jav may have spoken while Lidia was thinking.
  if (s.queue.length) return drainQueue(s);

  // Real delegation: work that this agent's output unlocks goes to a teammate, now.
  const handed = [];
  for (const t of (Array.isArray(d.delegate) ? d.delegate : []).slice(0, 3)) {
    const mate = st.sessions.find(x => x.name.toLowerCase() === String(t?.agent || '').toLowerCase());
    if (!mate || mate.id === s.id || !String(t.instruction || '').trim()) continue;
    send(mate.id, `From Lidia, after ${s.name} reported: ${t.instruction}`, 'lidia');
    handed.push(mate.name);
    store.feed(`Lidia handed work from ${s.name} to ${mate.name}.`, 'lidia', mate.id);
  }

  store.report({
    sessionId: s.id, name: s.name, decision: d.decision, note: d.note || '', instruction: d.instruction, question: d.question,
    state: d.state, asked: d.agent_asked, evidence: d.evidence, reasoning: d.reasoning, verification: d.verification, handed,
    message: d.message_to_jav, thinking: String(d.thinking || '').trim().slice(-3000),
  });
  const cfg = st.settings;
  refreshSoon();
  // Near the plan limit: keep doing the work, but skip the optional extras (reviews, polish rounds).
  const peak = peakUsage();
  const tight = peak != null && peak >= (cfg.reserveAt ?? 85);
  if (tight && cfg.refineEnabled && !s.warnedTight) { s.warnedTight = true; store.feed(`Usage at ${peak}%: pausing peer reviews and polish rounds to save your limit.`, 'alert'); }
  if (!tight) s.warnedTight = false;
  const refine = cfg.refineEnabled && !tight;
  s.errorStreak = isError ? (s.errorStreak || 0) + 1 : 0;
  s.reportsSinceReview = (s.reportsSinceReview || 0) + 1;
  const falling = s.errorStreak >= 2 || d.health === 'stalled';

  if (d.decision === 'continue') {
    s.autoTurns += 1;
    // Falling behind, or due for a check-up: a fellow owner reviews before the next step.
    if (refine && (falling || s.reportsSinceReview >= cfg.reviewEvery)) {
      return peerReview(s, falling ? 'rescue' : 'checkup', d.instruction);
    }
    store.feed(`Lidia → ${s.name}: ${d.note || d.instruction}`, 'lidia', s.id);
    turn(s, d.instruction, 'lidia');
  } else if (d.decision === 'done') {
    // "Done" isn't the end for an owner: improvement rounds until the budget is spent.
    if (refine && (s.refineRound || 0) < cfg.refineRounds) {
      s.refineRound = (s.refineRound || 0) + 1;
      store.feed(`${s.name} hit the goal. Improvement round ${s.refineRound}/${cfg.refineRounds}.`, 'lidia', s.id);
      return peerReview(s, 'improve');
    }
    log(s, 'lidia', `Good work. ${d.note || 'Goal complete.'}`);
    events.emit('bubble', { who: 'lidia', sessionId: s.id, text: 'Good work. Stand down.' });
    store.feed(`${s.name} finished: ${d.note || 'goal complete'}`, 'done', s.id);
    setStatus(s, 'done', 'off duty');
  } else {
    // Lidia can't decide: she tells Jav, in her own words, what happened and what she'd do.
    const ask = String(d.message_to_jav || d.question || '').trim() || orphanAsk(s);
    s.pendingQuestion = ask;
    s.escalation = { level: (d.tier ?? 2) >= 3 ? 'CRITICAL' : 'BLOCK', text: ask, ts: Date.now() };
    log(s, 'lidia', `I need Jav on this: ${ask}`);
    st.lidiaChat.push({ ts: Date.now(), role: 'lidia', text: `${s.name} needs a call from you.\n\n${ask}`, about: s.id });
    store.feed(`${s.name} needs Jav: ${ask}`, 'alert', s.id);
    setStatus(s, 'needs_jav', 'waiting for Jav');
    events.emit('alert', { sessionId: s.id, text: ask });
    events.emit('notify', { text: `${s.name}: ${ask}`, sessionId: s.id });   // Lidia is bringing Jav a decision
  }
}

// ------------------------------------------------------------------ peer review
const reviewing = new Set();   // critics currently out on a review

/** Pick a fellow owner to do the review: someone not busy, not the owner. */
function pickCritic(owner) {
  const free = store.state.sessions.filter(x => x.id !== owner.id && !running.has(x.id) && !reviewing.has(x.id));
  // Teammates know the project best, so they review first.
  free.sort((a, b) => (b.projectId === owner.projectId) - (a.projectId === owner.projectId) || (a.reviewsGiven || 0) - (b.reviewsGiven || 0));
  return free[0] || null;
}

function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  try { return a > -1 && b > a ? JSON.parse(text.slice(a, b + 1)) : null; } catch { return null; }
}

/**
 * A fellow owner walks over, reads the actual work (read-only), scores it and
 * hands back fixes. kind: checkup | rescue | improve.
 */
async function peerReview(owner, kind, nextStep = '') {
  const critic = pickCritic(owner);
  const criticName = critic ? critic.name : 'the Inspector';
  setStatus(owner, 'reporting', `under review by ${criticName}`);
  if (critic) { reviewing.add(critic.id); critic.reviewsGiven = (critic.reviewsGiven || 0) + 1; events.emit('visit', { from: critic.id, to: owner.id }); }
  events.emit('bubble', { who: 'session', sessionId: critic?.id || owner.id, text: kind === 'rescue' ? `Let me help, ${owner.name}.` : `Let's see your work, ${owner.name}.` });
  store.feed(`${criticName} is ${kind === 'rescue' ? 'helping' : 'reviewing'} ${owner.name}.`, 'info', owner.id);

  const focus = {
    checkup: 'This is a routine check-up mid-project. Catch problems early.',
    rescue: `${owner.name} is falling behind (errors or no progress). Diagnose what is going wrong and give a concrete way forward.`,
    improve: `${owner.name} believes the goal is done. Push them from good to excellent: what would make a demanding human say "wow"?`,
  }[kind];
  const system = `You are ${criticName}, a fellow business owner in Jav's fortress, doing a peer review of ${owner.name}'s business. You can read their files and the web, nothing else. Be direct and specific; praise only what earns it.`;
  const prompt = `${focus}

${owner.name}'s mission: ${owner.goal || '(see their recent work)'}

Their recent transcript:
${owner.log.slice(-16).map(e => `[${e.role}${e.tool ? ':' + e.tool : ''}] ${String(e.text).slice(0, 500)}`).join('\n')}

Inspect the actual work in this workspace (files, output) before judging. Then reply with ONLY JSON:
{"score": <1-10 overall>, "verdict": "<one sentence>", "fixes": ["<specific fix>", "... 3-5 total, most important first"], "praise": "<what is genuinely good>", "skills": ["<installed skill they should use next, if any>"], "healthy": <true|false>}`;

  let r;
  try {
    const out = await runReview({ cwd: cwdFor(owner), prompt, system, model: owner.model || store.state.settings.model });
    store.addSpend(out.costUsd, critic?.id || 'lidia');
    if (critic) critic.costUsd += out.costUsd || 0;
    r = extractJson(out.text);
  } catch (err) { r = null; log(owner, 'system', `Peer review failed: ${err.message}`); }
  finally { if (critic) { reviewing.delete(critic.id); events.emit('visit-end', { from: critic.id }); } }

  if (!r || !Array.isArray(r.fixes)) {               // review fell through: carry on as Lidia said
    if (nextStep) return turn(owner, nextStep, 'lidia');
    return setStatus(owner, 'done', 'off duty');
  }
  owner.reportsSinceReview = 0;
  owner.scores = [...(owner.scores || []), { ts: Date.now(), score: r.score, by: criticName, kind }].slice(-20);
  const text = `Peer review from ${criticName} (${kind}): ${r.score}/10. ${r.verdict || ''}
Fixes:
${r.fixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}${r.praise ? `\nWorking well: ${r.praise}` : ''}${r.skills?.length ? `\nSkills to use: ${r.skills.join(', ')}` : ''}`;
  owner.lastReview = { by: criticName, score: r.score, kind, ts: Date.now() };
  if (critic) log(critic, 'system', `Reviewed ${owner.name}: ${r.score}/10.`);
  store.feed(`${criticName} reviewed ${owner.name}: ${r.score}/10, ${r.fixes.length} fixes.`, 'review', owner.id);
  events.emit('bubble', { who: 'session', sessionId: critic?.id || owner.id, text: `${r.score}/10. ${r.fixes[0]}` });

  const ask = kind === 'improve'
    ? `${text}\n\nYou hit your goal; now make it excellent. Work through these fixes (push back on any you disagree with, with reasons), verify, and report with a new self-score.`
    : `${text}\n\nAddress these fixes${nextStep ? `, then continue with: ${nextStep}` : ''}. Push back on any you disagree with, with reasons. Report with a new self-score.`;
  turn(owner, ask, 'critic');
}

function askPermission(s, toolName, input, kind = 'tool', reason = '') {
  const pid = id('perm');
  return new Promise((resolve) => {
    const shown = kind === 'money' ? JSON.stringify(input ?? {}, null, 1).slice(0, 900)
      : toolName === 'ExitPlanMode' ? String(input?.plan || '').slice(0, 4000) : summarizeInput(input);
    s.pendingPermission = { id: pid, tool: toolName, input: shown, kind, reason };
    const prev = s.status;
    setStatus(s, 'needs_jav', kind === 'money' ? 'waiting for Jav: money' : `asking to use ${toolName}`);
    const what = kind === 'money' ? `MONEY: ${s.name} wants to run ${reason}. Waiting for you.` : `${s.name} asks permission for ${toolName}.`;
    store.feed(what, 'alert', s.id);
    events.emit('alert', { sessionId: s.id, text: kind === 'money' ? `${s.name} wants to run ${reason}. Only you can approve.` : `May I use ${toolName}?` });
    permissionWaiters.set(pid, (allow) => {
      s.pendingPermission = null;
      setStatus(s, prev === 'needs_jav' ? 'working' : prev, activityFor(toolName));
      resolve(allow ? { behavior: 'allow', updatedInput: input }
                    : { behavior: 'deny', message: 'Jav denied this action.' });
    });
  });
}

/** Money actions: frozen until Jav taps approve in the app. Resolves true/false. */
function holdMoney(s, toolName, input, reason) {
  return askPermission(s, toolName, input, 'money', reason).then(r => r.behavior === 'allow');
}

export function answerPermission(sid, pid, allow) {
  const fn = permissionWaiters.get(pid);
  if (!fn) return false;
  permissionWaiters.delete(pid);
  const s = store.session(sid);
  if (s) log(s, 'jav', allow ? `Allowed ${s.pendingPermission?.tool}.` : `Denied ${s.pendingPermission?.tool}.`);
  // Approving a plan leaves plan mode, as in Claude Code; otherwise the agent would only ever plan.
  if (s && allow && s.pendingPermission?.tool === 'ExitPlanMode' && modeFor(s) === 'plan') {
    s.permissionMode = 'acceptEdits';
    queries.get(sid)?.setPermissionMode('acceptEdits').catch(() => {});
  }
  fn(allow);
  return true;
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const v = input.command || input.file_path || input.pattern || input.query || input.url || input.description || input.prompt;
  return String(v ?? JSON.stringify(input)).slice(0, 300);
}

/** Write data Lidia (or Jav) hands to an agent into their workspace and tell them. */
export function provideData(sid, title, content) {
  const s = store.session(sid);
  const dir = path.join(cwdFor(s), '.fortress', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(title).replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 60) || 'data'}.md`);
  fs.writeFileSync(file, content);
  send(sid, `Lidia left you data: "${title}" at ${file}. Read it and use it.`, 'lidia');
  return file;
}

/** Jav texts Lidia. */
export const lidiaUploadDir = () => path.join(DATA_DIR, 'uploads');

export async function talkToLidia(text, files = []) {
  const st = store.state;
  const saved = files.length ? saveUploads(lidiaUploadDir(), files) : [];
  st.lidiaChat.push({ ts: Date.now(), role: 'jav', text, ...(saved.length ? { files: fileMeta(saved) } : {}) });
  store.changed();
  events.emit('bubble', { who: 'lidia-thinking' });
  const acts = [], called = [];
  // What Jav watches while she works: her thinking, the commands she runs, the reply as it's written.
  const live = { started: Date.now(), thinking: '', acts, text: '' };
  let liveTimer = null;
  const push = () => { if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; events.emit('lidia-live', { ...live, acts: [...acts] }); }, 120); };
  let reply, thinking = '';
  try {
    ({ text: reply, thinking } = await lidia.chat(text, saved, (full, input) => {
      const [, server = '', tool = full] = /^mcp__(.+?)__(.+)$/.exec(full) || [];
      if (server === 'fortress' && ['fortress_status', 'read_agent', 'react'].includes(tool)) return;
      called.push({ server, tool });
      const app = server === 'fortress' ? '' : `${server.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ')}: `;
      acts.push(`${app}${tool.replace(/_/g, ' ')}${input?.name ? ` → ${input.name}` : input?.summary ? ` → ${input.summary}` : ''}`);
      push();
    }, {
      onThinking: (t) => { live.thinking += t; push(); },
      onText: (t, reset) => { live.text = reset ? '' : live.text + t; push(); },
    }));
  } catch (err) { reply = `I can't reach the surface right now: ${err.message}`; }
  const asked = [...st.lidiaChat].reverse().find(m => m.role === 'jav');
  // A reaction can be the whole answer; otherwise a reply with nothing in it still says something.
  if (!reply.trim() && !acts.length && !asked?.reactions?.peer) reply = 'Copy that.';
  // Claim check: she must not say she did something that no tool call did. One correction pass, then it stands.
  const claim = lidia.claimsAction(reply);
  const acted = called.some(c => c.server !== 'fortress' || WRITE_TOOLS.has(c.tool));
  if (claim && !acted) {
    try {
      const again = await lidia.chat(`[Fortress check. Jav did not write this.] You just told Jav "${claim}", but no tool call of yours did that. Do it now with the right tool, or tell him plainly that it has not been done. Don't repeat your earlier text.`, [], (full, input) => {
        const [, server = '', tool = full] = /^mcp__(.+?)__(.+)$/.exec(full) || [];
        called.push({ server, tool });
        if (server !== 'fortress' || WRITE_TOOLS.has(tool)) acts.push(`${tool.replace(/_/g, ' ')}${input?.name ? ` → ${input.name}` : ''}`);
        push();
      }, { onThinking: (t) => { live.thinking += t; push(); }, onText: (t, reset) => { live.text = reset ? '' : live.text + t; push(); } });
      reply = again.text || `I said I'd do that, but I haven't actually done it. Tell me to go ahead and I will.`;
      thinking = `${thinking}\n${again.thinking || ''}`.trim();
    } catch { reply = `I said I'd do that, but I haven't actually done it. Tell me to go ahead and I will.`; }
  }
  clearTimeout(liveTimer);
  events.emit('lidia-live', null);
  if (reply.trim()) events.emit('notify', { text: reply });   // she has something for Jav
  const thought = thinking.trim() ? { thinking: thinking.trim().slice(-6000), thoughtMs: Date.now() - live.started } : {};
  if (reply.trim() || acts.length) st.lidiaChat.push({ ts: Date.now(), role: 'lidia', text: reply, acts, ...thought });
  store.changed();
  events.emit('bubble', { who: 'lidia', text: reply || asked?.reactions?.peer || '' });
  return { reply, acts };
}
