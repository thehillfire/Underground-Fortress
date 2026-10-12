// Agent memory. Scopes: short (rolling), long (semantic, vector-searched), episodic (what happened),
// shared (all agents), private (AES-256-GCM encrypted, only its owner can read it).
// Embeddings are local hashed bag-of-words vectors: no model, no API, runs on the phone.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, id } from './store.js';
import { encrypt, decrypt } from './crypto.js';

const FILE = path.join(DATA_DIR, 'memory.json');
const DIMS = 256;
export const SCOPES = ['short', 'long', 'episodic', 'shared', 'private'];
let mem = null;
const load = () => (mem ||= (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } })());
const save = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem), { mode: 0o600 }); };

const STOP = new Set('the a an and or of to in on for with is are was be what which who does do did my me it its this that at as by from about how'.split(' '));
const stem = (w) => w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w.replace(/s$/, '');
export function embed(text) {
  const v = new Array(DIMS).fill(0);
  const words = (String(text).toLowerCase().match(/[a-z0-9]{2,}/g) || []).filter(w => !STOP.has(w)).map(stem);
  const feats = [...words, ...words.slice(1).map((w, i) => `${words[i]}_${w}`)];
  for (const w of feats) { let h = 2166136261; for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619); v[(h >>> 0) % DIMS] += (h & 0x100 ? 1 : -1); }
  const n = Math.hypot(...v) || 1;
  return v.map(x => +(x / n).toFixed(4));
}
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

export function add(agentId, scope, text, tags = []) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new Error('empty memory');
  const m = { id: id('mem'), agentId, scope, ts: Date.now(), tags, vec: embed(t) };
  if (scope === 'private') m.enc = encrypt(t, `mem:${agentId}`); else m.text = t;
  load().push(m);
  // short-term memory is a rolling window per agent
  const shorts = mem.filter(x => x.agentId === agentId && x.scope === 'short');
  for (const old of shorts.slice(0, Math.max(0, shorts.length - 40))) mem.splice(mem.indexOf(old), 1);
  if (mem.length > 3000) mem.splice(0, mem.length - 3000);
  save();
  return m.id;
}

const textOf = (m, asAgent) => m.scope === 'private' ? (m.agentId === asAgent ? decrypt(m.enc, `mem:${m.agentId}`) : null) : m.text;

/** Semantic search visible to `asAgent`: its own memories + shared. */
export function search(asAgent, query, { k = 5, scopes = null } = {}) {
  const q = embed(query);
  return load().filter(m => (m.agentId === asAgent || m.scope === 'shared') && (!scopes || scopes.includes(m.scope)))
    .map(m => ({ m, s: cos(q, m.vec) })).filter(x => x.s > 0.08).sort((a, b) => b.s - a.s).slice(0, k)
    .map(({ m, s }) => ({ id: m.id, scope: m.scope, ts: m.ts, score: +s.toFixed(2), text: textOf(m, asAgent) })).filter(x => x.text);
}

export function forget(agentId, matchId) {
  const before = load().length;
  mem = mem.filter(m => !(m.agentId === agentId && (m.id === matchId)));
  save();
  return before - mem.length;
}
export function eraseAgent(agentId) { load(); mem = mem.filter(m => m.agentId !== agentId); save(); }
export function eraseAll() { mem = []; save(); }
export const stats = () => { const c = {}; for (const m of load()) c[m.scope] = (c[m.scope] || 0) + 1; return c; };

/** Promote old short-term notes into long-term (called now and then). */
export function consolidate(agentId) {
  const old = load().filter(m => m.agentId === agentId && m.scope === 'short' && Date.now() - m.ts > 6 * 3600e3);
  for (const m of old) m.scope = 'long';
  if (old.length) save();
  return old.length;
}
