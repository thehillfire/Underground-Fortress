// Fetch the OpenArt-generated art into public/assets. Re-downloads a file
// whenever its URL in manifest.json changes (art gets regenerated).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.js';

const DIR = path.join(ROOT, 'public', 'assets');
const SOURCES = path.join(DIR, '.sources.json');

export async function ensureAssets() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  let have = {};
  try { have = JSON.parse(fs.readFileSync(SOURCES, 'utf8')); } catch {}
  const todo = Object.entries(manifest).filter(([f, url]) =>
    !f.startsWith('_') && (have[f] !== url || !fs.existsSync(path.join(DIR, f))));
  if (!todo.length) return;
  console.log(`  Fetching ${todo.length} art assets from OpenArt…`);
  await Promise.all(todo.map(async ([file, url]) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(path.join(DIR, file), Buffer.from(await res.arrayBuffer()));
      have[file] = url;
    } catch (e) {
      console.warn(`  ! ${file}: ${e.message} (falling back to drawn art)`);
    }
  }));
  fs.writeFileSync(SOURCES, JSON.stringify(have, null, 2));
}
