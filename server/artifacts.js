// Versioned artifacts shared between agents: every put creates a new immutable version.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, store } from './store.js';
import { sha256 } from './crypto.js';
import * as audit from './audit.js';

const DIR = path.join(DATA_DIR, 'artifacts');
const safe = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
const index = () => (store.state.artifacts ||= {});

export function put(name, content, by = 'system', note = '') {
  const n = safe(name);
  if (!n) throw new Error('name required');
  const text = String(content ?? '');
  if (text.length > 2_000_000) throw new Error('artifact too large (2 MB max)');
  const meta = (index()[n] ||= { name: n, versions: [] });
  const v = meta.versions.length + 1;
  fs.mkdirSync(path.join(DIR, n), { recursive: true });
  fs.writeFileSync(path.join(DIR, n, `v${v}.txt`), text);
  meta.versions.push({ v, ts: Date.now(), by, size: text.length, sha: sha256(text).slice(0, 16), note: String(note).slice(0, 200) });
  audit.record(by, 'artifact.put', `${n}@v${v}`, note);
  store.changed();
  return { name: n, version: v };
}

export function get(name, version) {
  const meta = index()[safe(name)];
  if (!meta) throw new Error(`No artifact ${name}`);
  const v = version ? Number(version) : meta.versions.length;
  if (!meta.versions.find(x => x.v === v)) throw new Error(`No version ${version}`);
  return { name: meta.name, version: v, latest: meta.versions.length, content: fs.readFileSync(path.join(DIR, meta.name, `v${v}.txt`), 'utf8'), meta: meta.versions.find(x => x.v === v) };
}

export const list = () => Object.values(index()).map(m => ({ name: m.name, versions: m.versions.length, latest: m.versions.at(-1) }));
export function history(name) { const m = index()[safe(name)]; if (!m) throw new Error(`No artifact ${name}`); return m.versions; }

/** Tiny line diff for the UI: counts plus changed lines. */
export function diff(name, a, b) {
  const x = get(name, a).content.split('\n'), y = get(name, b).content.split('\n');
  const sx = new Set(x), sy = new Set(y);
  return { removed: x.filter(l => !sy.has(l)).slice(0, 200), added: y.filter(l => !sx.has(l)).slice(0, 200) };
}
