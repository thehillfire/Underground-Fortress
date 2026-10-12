// Dwellers: each one is a Claude session living in its own room.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { store, id, WORKSPACES } from './store.js';
import { runTurn, runReview } from './agent.js';
import { moneyHooks } from './guard.js';
import { installed as installedSkills } from './skills.js';
import { peakUsage, refreshSoon } from './usage.js';
import { agentScheduleServer, tz } from './schedule.js';
import { saveUploads, promptWithFiles, fileMeta } from './files.js';
import { DATA_DIR } from './store.js';
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

export function cwdFor(s) {
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

export function create({ name, goal = '', roomType, repoId = null, model = '', by = 'jav' }) {
  const st = store.state;
  const s = {
    id: id('s'),
    name: (name || `Dweller ${st.sessions.length + 1}`).slice(0, 40),
    goal,
    roomType: ROOM_TYPES.includes(roomType) ? roomType : ROOM_TYPES[st.sessions.length % ROOM_TYPES.length],
    repoId,
    hue: Math.floor(Math.random() * 360),
    model,                 // '' = fortress default
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
  store.feed(`${by === 'lidia' ? 'Lidia assigned' : 'Jav assigned'} ${s.name} to a new ${s.roomType}.`, 'info', s.id);
  if (goal) send(s.id, goal, by);
  return s;
}

export function remove(sid) {
  stop(sid);
  const st = store.state;
  st.sessions = st.sessions.filter(s => s.id !== sid);
  store.changed();
}

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
const queries = new Map();   // session id -> live SDK query, for mid-turn mode changes
const modeFor = (s) => s.permissionMode || store.state.settings.permissionMode || 'acceptEdits';

export function update(sid, patch) {
  const s = store.session(sid);
  if (!s) return null;
  for (const k of ['name', 'goal', 'roomType', 'repoId', 'model', 'effort']) if (k in patch) s[k] = patch[k];
  if ('permissionMode' in patch) {
    const m = patch.permissionMode || '';
    if (m && !PERMISSION_MODES.includes(m)) throw new Error(`unknown permission mode ${m}`);
    s.permissionMode = m;
    // Like shift+tab in Claude Code: a running turn switches right away.
    queries.get(sid)?.setPermissionMode(modeFor(s)).catch(() => {});
  }
  store.changed();
  return s;
}

export function stop(sid) {
  running.get(sid)?.abort();
  const s = store.session(sid);
  if (s?.pendingPermission) answerPermission(sid, s.pendingPermission.id, false);
}

/** A message for a session, from Jav or Lidia. */
export const uploadDir = (s) => path.join(cwdFor(s), '.fortress', 'uploads');

export function send(sid, text, from = 'jav', files = []) {
  const s = store.session(sid);
  if (!s || (!text?.trim() && !files.length)) return;
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
    return;
  }
  turn(s, text, from, saved);
}

async function turn(s, text, from, saved = [], logged = false) {
  if (from === 'jav-via-lidia') from = 'lidia';
  if (logged) { const q = [...s.log].reverse().find(e => e.queued); if (q) delete q.queued; }
  else log(s, from, text || '', saved.length ? { files: fileMeta(saved) } : {});
  setStatus(s, 'working', 'thinking');
  if (from === 'lidia') events.emit('bubble', { who: 'lidia', sessionId: s.id, text });

  const ac = new AbortController();
  running.set(s.id, ac);
  let out;
  try {
    out = await runTurn({
      prompt: promptWithFiles(text, saved),
      effort: s.effort || store.state.settings.effort || undefined,
      cwd: cwdFor(s),
      resume: s.sdkSessionId,
      model: s.model || store.state.settings.model,
      permissionMode: modeFor(s),
      onQuery: (q) => queries.set(s.id, q),
      mcpServers: { ...mcpServersFor(), fortress: agentScheduleServer(s.id) },
      appendSystem: ownerBrief(s),
      hooks: moneyHooks((tool, input, reason) => holdMoney(s, tool, input, reason)),
      abortController: ac,
      onInit: (m) => { if (m.session_id) s.sdkSessionId = m.session_id; if (m.mcp_servers) lidia.noteConnectors(m); store.changed(); },
      onText: (t) => { log(s, 'claude', t); events.emit('bubble', { who: 'session', sessionId: s.id, text: t }); },
      onTool: (name, input) => {
        log(s, 'tool', summarizeInput(input), { tool: name });
        setStatus(s, 'working', activityFor(name));
      },
      canUseTool: (toolName, input) => (toolName.startsWith('mcp__') && store.state.settings.autoApproveConnectors !== false
        ? Promise.resolve({ behavior: 'allow', updatedInput: input })   // connectors Jav set up are trusted
        : askPermission(s, toolName, input)),
    });
  } catch (err) {
    out = { result: `Error: ${err.message}`, isError: true, costUsd: 0 };
  } finally {
    running.delete(s.id);
    queries.delete(s.id);
  }
  if (out.sessionId) s.sdkSessionId = out.sessionId;
  s.costUsd += out.costUsd || 0;
  store.addSpend(out.costUsd, s.id);

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
  if (next) turn(s, next.text, next.from, next.saved || [], !!next.logged);
}

/** Every agent runs its room like a business it owns. */
function ownerBrief(s) {
  const skills = installedSkills().map(k => k.name);
  return `You are "${s.name}", a business owner in Jav's Underground Fortress. Your room is your business${s.goal ? ` and your mission is: ${s.goal}` : ''}.
Operate like an owner who wants the best possible result:
- Plan before you act. Execute in small, verified steps. Check your work actually runs or reads well.
- Critique yourself before reporting: score your output 1-10 on outcome, quality, and how good it looks and reads to a human, and fix the weakest part if you can.
- Use skills. ${skills.length ? `Installed skills: ${skills.join(', ')}.` : 'Check which skills are installed.'} Whenever one fits (planning, design, frontend, testing, debugging, docs, review), invoke it instead of improvising.
- Use Jav's connected apps (calendar, email, docs, CRM…) whenever they help.
- Time and schedules: Jav's timezone is ${tz()} (this machine's clock says UTC; ignore that). There is no cron or OS scheduler here. For anything at a time of day or recurring, use your schedule_task tool: the fortress wakes you up and hands you the instruction.
- Fellow owners will review your work and send fixes. Take them seriously, and push back with reasons when they're wrong.
- MONEY RULE: never spend money. Never buy, pay, subscribe, transfer, book, or enter payment details. Prepare it fully and ask Jav; the fortress blocks those actions until Jav approves.
Your captain is Lidia. End every turn with a short report: what you did, your self-score (n/10), what's next, and any blocker.`;
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

  store.report({ sessionId: s.id, name: s.name, decision: d.decision, note: d.note || '', instruction: d.instruction, question: d.question });
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
    s.pendingQuestion = d.question;
    log(s, 'lidia', `I need Jav on this: ${d.question}`);
    store.feed(`${s.name} needs Jav: ${d.question}`, 'alert', s.id);
    setStatus(s, 'needs_jav', 'waiting for Jav');
    events.emit('alert', { sessionId: s.id, text: d.question });
  }
}

// ------------------------------------------------------------------ peer review
const reviewing = new Set();   // critics currently out on a review

/** Pick a fellow owner to do the review: someone not busy, not the owner. */
function pickCritic(owner) {
  const free = store.state.sessions.filter(x => x.id !== owner.id && !running.has(x.id) && !reviewing.has(x.id));
  free.sort((a, b) => (a.reviewsGiven || 0) - (b.reviewsGiven || 0));
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
  const acts = [];
  let reply;
  try {
    reply = await lidia.chat(text, saved, (full, input) => {
      const [, server = '', tool = full] = /^mcp__(.+?)__(.+)$/.exec(full) || [];
      if (server === 'fortress' && (tool === 'fortress_status' || tool === 'read_agent')) return;
      const app = server === 'fortress' ? '' : `${server.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ')}: `;
      acts.push(`${app}${tool.replace(/_/g, ' ')}${input?.name ? ` → ${input.name}` : input?.summary ? ` → ${input.summary}` : ''}`);
    });
  } catch (err) { reply = `I can't reach the surface right now: ${err.message}`; }
  st.lidiaChat.push({ ts: Date.now(), role: 'lidia', text: reply, acts });
  store.changed();
  events.emit('bubble', { who: 'lidia', text: reply });
  return { reply, acts };
}
