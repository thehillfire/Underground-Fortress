// Underground Fortress server: REST + WebSocket on top of the Claude Agent SDK.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import { store, ROOT, id } from './store.js';
import * as sessions from './sessions.js';
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

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
app.use(express.json({ limit: '60mb' }));   // photos and files come in as base64
app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => async (req, res) => {
  try { res.json((await fn(req)) ?? { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
  };
}));

// Sessions
app.post('/api/sessions', wrap((r) => sessions.create(r.body)));
app.patch('/api/sessions/:id', wrap((r) => sessions.update(r.params.id, r.body)));
app.delete('/api/sessions/:id', wrap((r) => sessions.remove(r.params.id)));
app.post('/api/sessions/:id/message', wrap((r) => sessions.send(r.params.id, r.body.text, 'jav', r.body.files || [])));
// Attachments, for thumbnails and downloads in the chat.
app.get('/api/files/:owner/:name', (req, res) => {
  const s = req.params.owner === 'lidia' ? null : store.session(req.params.owner);
  const dir = req.params.owner === 'lidia' ? sessions.lidiaUploadDir() : s ? sessions.uploadDir(s) : null;
  const file = dir && resolveUpload(dir, req.params.name);
  if (!file) return res.status(404).end();
  res.sendFile(file, { dotfiles: 'allow' });   // uploads live under .fortress/
});
app.post('/api/sessions/:id/stop', wrap((r) => sessions.stop(r.params.id)));
app.post('/api/sessions/:id/permission', wrap((r) =>
  ({ ok: sessions.answerPermission(r.params.id, r.body.permissionId, !!r.body.allow) })));

// Lidia
app.post('/api/lidia', wrap((r) => sessions.talkToLidia(String(r.body.text || ''), r.body.files || [])));
app.put('/api/orders', wrap((r) => { store.state.standingOrders = String(r.body.text || ''); store.changed(); }));

// Settings
app.patch('/api/settings', wrap((r) => {
  const allowed = ['model', 'lidiaModel', 'permissionMode', 'lidiaAutopilot', 'maxAutoTurns', 'skillSources', 'autoApproveConnectors', 'refineEnabled', 'refineRounds', 'reviewEvery', 'reserveAt', 'effort', 'lidiaEffort'];
  for (const k of allowed) if (k in r.body) store.state.settings[k] = r.body[k];
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
wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'state', state: snapshot() })));

let pending = null;
store.on('change', () => {
  if (pending) return;
  pending = setTimeout(() => { pending = null; broadcast({ type: 'state', state: snapshot() }); }, 120);
});
for (const ev of ['bubble', 'report', 'alert', 'visit', 'visit-end']) sessions.events.on(ev, (p) => broadcast({ type: ev, ...p }));

await ensureAssets();
startUsagePolling();
startScheduler(sessions.send);
server.listen(PORT, HOST, () => {
  console.log(`\n  ⛏  Underground Fortress is open at http://${HOST}:${PORT}${MOCK ? '  (mock mode: no real Claude calls)' : ''}\n`);
});
