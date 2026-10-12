// Immutable-by-construction audit trail: append-only JSONL where every entry hashes the one before it,
// so any edit or deletion of history is detectable (verify()). Detail is PII/secret-redacted before it is written.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { sha256, redact } from './crypto.js';

const FILE = path.join(DATA_DIR, 'audit.log');
let last = { seq: 0, hash: '0'.repeat(64) };
let loaded = false;
let count = 0;

function load() {
  if (loaded) return; loaded = true;
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    count = lines.length;
    if (lines.length) { const e = JSON.parse(lines.at(-1)); last = { seq: e.seq, hash: e.hash }; }
  } catch {}
}

/** actor: jav | lidia | agent:<name> | system. */
export function record(actor, action, target = '', detail = '') {
  load();
  const e = { seq: last.seq + 1, ts: Date.now(), actor, action, target: String(target).slice(0, 120), detail: redact(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600), prev: last.hash };
  e.hash = sha256(JSON.stringify([e.seq, e.ts, e.actor, e.action, e.target, e.detail, e.prev]));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(e) + '\n');
  last = { seq: e.seq, hash: e.hash }; count++;
  return e;
}

export function entries() {
  load();
  try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

/** Walk the chain. Returns {ok, count, brokenAt}. */
export function verify() {
  let prev = '0'.repeat(64), n = 0;
  for (const e of entries()) {
    const want = sha256(JSON.stringify([e.seq, e.ts, e.actor, e.action, e.target, e.detail, e.prev]));
    if (e.prev !== prev || e.hash !== want || e.seq !== n + 1) return { ok: false, count: n, brokenAt: e.seq };
    prev = e.hash; n++;
  }
  return { ok: true, count: n, brokenAt: null };
}

export function query({ q = '', actor = '', until = Infinity, since = 0, limit = 300 } = {}) {
  const needle = String(q).toLowerCase();
  return entries().filter(e => e.ts >= since && e.ts <= until && (!actor || e.actor === actor)
    && (!needle || `${e.actor} ${e.action} ${e.target} ${e.detail}`.toLowerCase().includes(needle))).slice(-limit);
}
export const auditCount = () => { load(); return count; };
