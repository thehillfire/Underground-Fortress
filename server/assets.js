// Fetch the OpenArt-generated art into public/assets the first time the fortress opens.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.js';

const DIR = path.join(ROOT, 'public', 'assets');

export async function ensureAssets() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const missing = Object.entries(manifest).filter(([f]) => !f.startsWith('_') && !fs.existsSync(path.join(DIR, f)));
  if (!missing.length) return;
  console.log(`  Fetching ${missing.length} art assets from OpenArt…`);
  await Promise.all(missing.map(async ([file, url]) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(path.join(DIR, file), Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      console.warn(`  ! ${file}: ${e.message} (falling back to drawn art)`);
    }
  }));
}
