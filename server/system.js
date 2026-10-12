// System actions the app can trigger without typing in Termux: version check,
// update, restart, keep-alive. Only these fixed actions exist.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, store } from './store.js';

const run = (cmd, args, timeout = 300_000) => new Promise((resolve) => {
  // Inside proot the repo looks foreign-owned; tell git it's ours.
  if (cmd === 'git') args = ['-c', 'safe.directory=*', ...args];
  execFile(cmd, args, { cwd: ROOT, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), code: err?.code ?? 0 }));
});

/** Ask the Termux side (the launcher's watcher) to do one of its fixed actions. */
export function termuxAction(action, arg = '') {
  if (!['open-url', 'keep-alive'].includes(action)) throw new Error('unknown action');
  fs.writeFileSync(path.join(ROOT, '.termux-action'), `${action} ${arg}\n`);
}

export async function version() {
  const head = await run('git', ['rev-parse', '--short', 'HEAD'], 10_000);
  const fetched = await run('git', ['fetch', '--quiet', 'origin'], 60_000);
  const behind = fetched.ok ? await run('git', ['rev-list', '--count', 'HEAD..@{u}'], 10_000) : { ok: false, out: '' };
  const log = behind.ok && +behind.out > 0 ? await run('git', ['log', '--format=%s', '-n', '5', 'HEAD..@{u}'], 10_000) : { out: '' };
  return {
    commit: head.ok ? head.out : 'unknown',
    behind: behind.ok ? +behind.out : null,
    changes: log.out ? log.out.split('\n') : [],
    onPhone: fs.existsSync('/data/data/com.termux') || !!process.env.TERMUX_VERSION || ROOT.startsWith('/root/fortress'),
  };
}

let busy = false;
/** Pull the latest version and restart. Exit 75 = restart; 76 = phone setup changed, rerun it. */
export async function update() {
  if (busy) throw new Error('Already updating');
  busy = true;
  try {
    const before = (await run('git', ['rev-parse', 'HEAD'], 10_000)).out;
    const pull = await run('git', ['pull', '--ff-only'], 120_000);
    if (!pull.ok) throw new Error(`git pull failed: ${pull.out.slice(-300)}`);
    const after = (await run('git', ['rev-parse', 'HEAD'], 10_000)).out;
    if (before === after) return { updated: false, message: 'Already up to date.' };
    const changed = (await run('git', ['diff', '--name-only', before, after], 10_000)).out.split('\n');
    const setupChanged = changed.some(f => f.startsWith('scripts/'));
    if (!setupChanged && changed.some(f => f === 'package.json' || f === 'package-lock.json')) {
      const npm = await run('npm', ['install', '--no-audit', '--no-fund'], 600_000);
      if (!npm.ok) throw new Error(`npm install failed: ${npm.out.slice(-300)}`);
    }
    restartSoon(setupChanged ? 76 : 75);
    return { updated: true, message: setupChanged ? 'Updated. Re-running phone setup, then restarting.' : 'Updated. Restarting…' };
  } finally { busy = false; }
}

export function restartSoon(code = 75) {
  store.flush();
  setTimeout(() => process.exit(code), 800);   // the launcher restarts us
}
