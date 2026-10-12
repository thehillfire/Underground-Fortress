// Underground Fortress server: REST + WebSocket on top of the Claude Agent SDK.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import { store, ROOT, id, SETTINGS_KEYS, checkSettings } from './store.js';
import * as sessions from './sessions.js';
import * as projects from './projects.js';
import * as skills from './skills.js';
import * as repos from './repos.js';
import { CATALOG, searchRegistry, redact } from './connectors.js';
import { MOCK, API_KEY_STRIPPED } from './agent.js';
import { MODELS } from './lidia.js';
import { ensureAssets } from './assets.js';
import { refreshUsage, startUsagePolling } from './usage.js';
import { startScheduler, removeJob, addJob } from './schedule.js';
import * as system from './system.js';
import { resolveUpload } from './files.js';
import { javReacts } from './reactions.js';
import * as intent from './intent.js';
import * as prio from './priority.js';
import * as auth from './auth.js';
import * as audit from './audit.js';
import * as bus from './bus.js';
import * as taskGraph from './tasks.js';
import * as artifacts from './artifacts.js';
import * as memory from './memory.js';
import { guard as hostGuard, hostAllowed } from './hostguard.js';
import { allow as rateAllow, limitedCount } from './ratelimit.js';
import { isKilled } from './safety.js';
import { schemas } from './schemas.js';
import { renderMetrics } from './metrics.js';

// One agent or request throwing must not take the whole fortress down (it used to: the phone then
// showed "failed to fetch" until Termux was reopened). Log it, keep running.
const CRASH_LOG = path.join(ROOT, 'data', 'crash.log');
const noteCrash = (kind, err) => {
  const line = `${new Date().toISOString()} ${kind}: ${err?.stack || err}\n`;
  console.error(line);
  try { fs.appendFileSync(CRASH_LOG, line); } catch {}
};
process.on('uncaughtException', (e) => noteCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => noteCrash('unhandledRejection', e));
const lastCrash = () => {
  try { const st = fs.statSync(CRASH_LOG); if (Date.now() - st.mtimeMs > 7 * 864e5) return null; return fs.readFileSync(CRASH_LOG, 'utf8').trim().split('\n')[0].slice(0, 300) + ` (${st.mtime.toLocaleString()})`; } catch { return null; }
};

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
app.disable('x-powered-by');
app.use(hostGuard);
app.use(express.json({ limit: '60mb' }));   // photos and files come in as base64
app.use(express.static(path.join(ROOT, 'public')));

// Rate limits (per client), then login (when Jav has turned it on), then an audit line for every change.
const HEAVY = /^\/api\/(lidia|sessions\/[^/]+\/message|bus)$/;
app.use('/api', (req, res, next) => {
  const ip = req.socket.remoteAddress || 'local';
  if (!rateAllow(`api:${ip}`, 240, 20) || (req.method === 'POST' && HEAVY.test(req.originalUrl.split('?')[0]) && !rateAllow(`heavy:${ip}`, 40, 1)))
    return res.status(429).json({ error: 'Too many requests. Slow down a moment.' });
  next();
});
app.use(auth.middleware);
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.originalUrl.startsWith('/api/auth/'))
    audit.record('jav', `${req.method} ${req.originalUrl.split('?')[0]}`, '', `fields: ${Object.keys(req.body || {}).join(',')}`);
  next();
});

const wrap = (fn, schema) => async (req, res) => {
  try {
    if (schema) { const p = schema.safeParse(req.body ?? {}); if (!p.success) throw new Error(`Invalid input: ${p.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).slice(0, 3).join('; ')}`); req.body = p.data; }
    res.json((await fn(req, res)) ?? { ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};

function snapshot() {
  const st = store.publicState();
  return { ...st, connectors: st.connectors.map(redact), skills: skills.installed(), mock: MOCK };
}

app.get('/api/state', wrap(() => snapshot()));

// Which Claude account will the dwellers run on?
app.get('/api/health', wrap(() => {
  const home = os.homedir();
  const subscription = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || fs.existsSync(path.join(home, '.claude', '.credentials.json'));
  return {
    mock: MOCK,
    subscription,
    apiKeyStripped: API_KEY_STRIPPED,
    lastCrash: lastCrash(),
    uptimeSec: Math.round(process.uptime()),
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
  };
}));

// Projects (rooms) and the agents in them
app.post('/api/projects', wrap((r) => projects.createProject({ ...r.body, auto: false, by: 'jav' })));
app.patch('/api/projects/:id', wrap((r) => projects.updateProject(r.params.id, r.body)));
app.delete('/api/projects/:id', wrap((r) => projects.removeProject(r.params.id)));
app.post('/api/projects/:id/archive', wrap((r) => projects.archiveProject(r.params.id)));
app.post('/api/projects/:id/restore', wrap((r) => projects.restoreProject(r.params.id)));
app.get('/api/archive', wrap(() => store.state.projects.filter(p => p.archived)));

// Sessions
app.post('/api/sessions', wrap((r) => sessions.create({ ...r.body, by: 'jav' }), schemas.session));
app.patch('/api/sessions/:id', wrap((r) => sessions.update(r.params.id, r.body)));
app.delete('/api/sessions/:id', wrap((r) => sessions.remove(r.params.id)));
app.post('/api/sessions/:id/message', wrap((r) => sessions.send(r.params.id, r.body.text, 'jav', r.body.files || []), schemas.message));
// Attachments, for thumbnails and downloads in the chat.
app.get('/api/files/:owner/:name', (req, res) => {
  const s = req.params.owner === 'lidia' ? null : store.session(req.params.owner);
  const dir = req.params.owner === 'lidia' ? sessions.lidiaUploadDir() : s ? sessions.uploadDir(s) : null;
  const file = dir && resolveUpload(dir, req.params.name);
  if (!file) return res.status(404).end();
  res.sendFile(file, { dotfiles: 'allow' });   // uploads live under .fortress/
});
app.post('/api/sessions/:id/stop', wrap((r) => sessions.stop(r.params.id)));
app.post('/api/sessions/:id/retry', wrap((r) => sessions.retry(r.params.id)));
app.post('/api/sessions/:id/permission', wrap((r) =>
  ({ ok: sessions.answerPermission(r.params.id, r.body.permissionId, !!r.body.allow) })));

// Lidia
app.post('/api/lidia', wrap((r) => sessions.talkToLidia(String(r.body.text || ''), r.body.files || []), schemas.lidia));
app.post('/api/react', wrap((r) => { javReacts(String(r.body.owner), r.body.ts, r.body.emoji || ''); }));
app.put('/api/orders', wrap((r) => { store.state.standingOrders = String(r.body.text || ''); store.changed(); }));

// Lidia's autonomy: intent model, standing directives, thought stream, priorities, escalations
app.get('/api/intent', wrap(() => ({ model: intent.intentModel(), directives: intent.directives(), digest: intent.digest(Date.now() - 864e5) })));
app.post('/api/directives', wrap((r) => intent.addDirective(r.body.text, 'jav'), schemas.directive));
app.delete('/api/directives/:id', wrap((r) => ({ removed: intent.removeDirective(r.params.id) })));
app.get('/api/decisions', wrap((r) => prio.thoughtStream({ q: r.query.q, tier: r.query.tier ?? null, agentId: r.query.agent, since: Number(r.query.since) || 0, limit: Math.min(500, Number(r.query.limit) || 200) })));
app.get('/api/priorities', wrap(() => prio.priorities()));
app.get('/api/escalations', wrap(() => prio.escalations()));

// Login (optional, off until Jav sets a passphrase)
app.get('/api/auth/status', wrap((r) => ({ enabled: auth.enabled(), mfa: auth.mfaEnabled(), authed: auth.isAuthed(r.headers) })));
app.post('/api/auth/setup', wrap((r) => { if (auth.enabled() && !auth.isAuthed(r.headers)) throw new Error('login required'); return auth.setup(r.body.passphrase, !!r.body.mfa); }, schemas.setup));
app.post('/api/auth/login', wrap((r, res) => { auth.login(res, r.socket.remoteAddress || 'local', r.body.passphrase, r.body.code); }, schemas.login));
app.post('/api/auth/refresh', wrap((r, res) => { auth.refresh(r, res); }));
app.post('/api/auth/logout', wrap((r, res) => { auth.logout(r, res); }));
app.post('/api/auth/disable', wrap((r) => { if (!auth.isAuthed(r.headers)) throw new Error('login required'); auth.disable(); }));

// Mesh: tasks, message bus, artifacts, memory
app.get('/api/tasks', wrap(() => taskGraph.tasks()));
app.post('/api/tasks', wrap((r) => taskGraph.create({ ...r.body, creator: 'jav' }), schemas.task));
app.patch('/api/tasks/:id', wrap((r) => taskGraph.setStatus(r.params.id, r.body.status, 'jav', r.body.note), schemas.taskPatch));
app.get('/api/bus', wrap((r) => bus.view({ q: String(r.query.q || ''), agent: String(r.query.agent || ''), limit: Math.min(500, Number(r.query.limit) || 200) })));
app.post('/api/bus', wrap((r) => bus.publish({ from: 'jav', ...r.body }), schemas.bus));
app.get('/api/anomalies', wrap(() => store.state.anomalies || []));
app.get('/api/artifacts', wrap(() => artifacts.list()));
app.get('/api/artifacts/:name', wrap((r) => (r.query.a && r.query.b ? artifacts.diff(r.params.name, r.query.a, r.query.b) : r.query.history ? artifacts.history(r.params.name) : artifacts.get(r.params.name, r.query.version))));
app.post('/api/artifacts', wrap((r) => artifacts.put(r.body.name, r.body.content, 'jav', r.body.note), schemas.artifact));
app.get('/api/memory', wrap(() => memory.stats()));

// Audit trail and replay
app.get('/api/audit', wrap((r) => audit.query({ q: String(r.query.q || ''), actor: String(r.query.actor || ''), until: Number(r.query.until) || Infinity, since: Number(r.query.since) || 0, limit: Math.min(1000, Number(r.query.limit) || 300) })));
app.get('/api/audit/verify', wrap(() => audit.verify()));

// Kill switch, observability, data rights
app.post('/api/kill', wrap((r) => { sessions.killAll(r.body.reason || 'Stopped by Jav', 'jav'); return { killed: true }; }, schemas.kill));
app.post('/api/resume', wrap(() => { sessions.resumeAll('jav'); return { killed: false }; }));
app.get('/api/metrics', (req, res) => { res.type('text/plain; version=0.0.4').send(renderMetrics({ limited: limitedCount })); });
app.get('/api/export', (req, res) => {
  audit.record('jav', 'data.export', '');
  const st = store.publicState();
  res.set('Content-Disposition', 'attachment; filename="fortress-export.json"').json({ exportedAt: new Date().toISOString(), state: { ...st, connectors: st.connectors.map(redact) },
    tasks: taskGraph.tasks(), bus: bus.log(), decisions: intent.decisions(), directives: intent.directives(), artifacts: artifacts.list(), memory: memory.stats() });
});
app.post('/api/erase', wrap(() => {
  audit.record('jav', 'data.erase', '', 'all agents, chat, memory, artifacts, tasks (audit chain kept, redacted)');
  for (const s of [...store.state.sessions]) sessions.remove(s.id);
  Object.assign(store.state, { lidiaChat: [], reports: [], precedents: [], preferences: [], decisions: [], directives: [], tasks: [], bus: [], anomalies: [], artifacts: {}, feed: [] });
  memory.eraseAll(); fs.rmSync(path.join(ROOT, 'data', 'artifacts'), { recursive: true, force: true });
  store.changed();
}, schemas.erase));

// Settings
app.patch('/api/settings', wrap((r) => {
  const bad = checkSettings(r.body); if (bad) throw new Error(bad);
  for (const k of SETTINGS_KEYS) if (k in r.body) store.state.settings[k] = r.body[k];
  store.changed();
}));

app.put('/api/plan', wrap((r) => {
  const usd = Number(r.body.monthlyUsd);
  if (!(usd > 0)) throw new Error('monthlyUsd must be positive');
  store.state.plan = { name: String(r.body.name || 'Custom'), monthlyUsd: usd };
  store.changed();
}));
app.get('/api/models', wrap(() => MODELS));
// The phone's browser knows Jav's real timezone (the Ubuntu layer thinks it's UTC).
app.post('/api/client', wrap((r) => {
  const t = String(r.body.tz || '');
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); } catch { throw new Error('bad timezone'); }
  if (t && store.state.settings.timezone !== t) { store.state.settings.timezone = t; store.changed(); }
}));
app.get('/api/system/version', wrap(() => system.version()));
app.post('/api/system/update', wrap(() => system.update()));
app.post('/api/system/restart', wrap(() => { system.restartSoon(75); return { message: 'Restarting…' }; }));
app.post('/api/notify-test', wrap(() => { setTimeout(() => sessions.events.emit('notify', { text: 'This is a test from Lidia. Notifications are working.' }), 4000); }));
app.post('/api/system/keep-alive', wrap(() => { system.termuxAction('keep-alive'); return { message: 'Opening Termux settings…' }; }));
app.post('/api/schedules', wrap((r) => addJob({ ...r.body, by: 'jav' })));
app.delete('/api/schedules/:id', wrap((r) => ({ ok: removeJob(r.params.id) })));
app.post('/api/usage/refresh', wrap(async () => { await refreshUsage(); return store.state.usage; }));

// Repositories
app.post('/api/repos', wrap((r) => repos.connect(r.body.url)));
app.delete('/api/repos/:id', wrap((r) => repos.disconnect(r.params.id)));

// Connectors (MCP servers)
app.get('/api/connectors/catalog', wrap(() => CATALOG));
app.get('/api/connectors/search', wrap((r) => searchRegistry(String(r.query.q || ''))));
app.post('/api/connectors', wrap((r) => {
  const b = r.body;
  const name = String(b.name || '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  if (!name) throw new Error('name required');
  if (store.state.connectors.some(c => c.name === name)) throw new Error(`"${name}" is already connected`);
  const c = { id: id('c'), name, label: b.label || name, type: b.type, url: b.url, command: b.command,
              args: b.args || [], env: b.env || {}, token: b.token || undefined, enabled: true };
  store.state.connectors.push(c);
  store.feed(`Connector ${c.label} wired into the fortress.`, 'info');
  return redact(c);
}));
app.patch('/api/connectors/:id', wrap((r) => {
  const c = store.state.connectors.find(x => x.id === r.params.id);
  if (!c) throw new Error('not found');
  if ('enabled' in r.body) c.enabled = !!r.body.enabled;
  if (r.body.token) c.token = r.body.token;
  store.changed();
  return redact(c);
}));
app.delete('/api/connectors/:id', wrap((r) => {
  store.state.connectors = store.state.connectors.filter(c => c.id !== r.params.id);
  store.changed();
}));

// Skills
app.get('/api/skills/find', wrap((r) => skills.find(String(r.query.q || ''), String(r.query.repo || ''))));
app.post('/api/skills/install', wrap((r) => skills.install(r.body.repo, r.body.dir)));
app.post('/api/skills/starter', wrap(() => skills.installStarter()));
app.get('/api/skills/starter', wrap(() => skills.STARTER));
app.delete('/api/skills/:dir', wrap((r) => skills.uninstall(r.params.dir)));

// Live updates
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
};
wss.on('connection', (ws, req) => {
  if (!hostAllowed(req.headers.host) || !auth.isAuthed(req.headers)) return ws.close(4401, 'login required');
  const o = req.headers.origin;
  if (o) { let oh; try { oh = new URL(o).host; } catch {} if (oh !== req.headers.host) return ws.close(4403, 'bad origin'); }
  ws.send(JSON.stringify({ type: 'state', state: snapshot() }));
});

let pending = null;
store.on('change', () => {
  if (pending) return;
  pending = setTimeout(() => { pending = null; broadcast({ type: 'state', state: snapshot() }); }, 120);
});
// Notifications are only for when Lidia comes to Jav (her replies and decisions she can't make), not for other agents finishing.
// App open or minimized: the app shows it. App closed (no live connection): the Termux side raises it, if Termux:API is installed.
sessions.events.on('notify', ({ text, sessionId }) => {
  const body = String(text).replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!body) return;
  broadcast({ type: 'notify', title: 'Lidia', text: body, sessionId });
  if (!wss.clients.size) { try { system.termuxAction('notify', body); } catch {} }
});
intent.intentEvents.on('decision', (e) => { broadcast({ type: 'decision', decision: e }); audit.record('lidia', `decision.${e.kind}`, e.agent, `${e.summary} -> ${e.decision}`); });
bus.busEvents.on('message', (m) => broadcast({ type: 'bus', message: { ...m, fromName: store.session(m.from)?.name || m.from, toName: store.session(m.to)?.name || m.to } }));
bus.busEvents.on('anomaly', (a) => broadcast({ type: 'anomaly', anomaly: a }));
for (const ev of ['bubble', 'report', 'alert', 'visit', 'visit-end', 'lidia-live', 'lidia-reviewing']) sessions.events.on(ev, (p) => broadcast({ type: ev, ...p }));

await ensureAssets();
startUsagePolling();
startScheduler(sessions.send);
setInterval(() => { projects.sweepEphemeral(); for (const x of store.state.sessions) memory.consolidate(x.id); }, 60_000).unref();
server.listen(PORT, HOST, () => {
  sessions.recoverInterrupted();
  console.log(`\n  ⛏  Underground Fortress is open at http://${HOST}:${PORT}${MOCK ? '  (mock mode: no real Claude calls)' : ''}\n`);
});
