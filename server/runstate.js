// How did the last run end? A clean exit (restart, update, Ctrl-C) leaves a marker. If the marker is missing
// at the next start, the process was killed from outside (Android), and the last heartbeat says when.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const RUN = path.join(DATA_DIR, '.running');
const LAST = path.join(DATA_DIR, 'last-stop.json');
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const write = (f, o) => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } catch {} };

let started = Date.now();

const memFreeMB = () => { try { const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); return m ? Math.round(+m[1] / 1024) : null; } catch { return null; } };

/** stats(): () => ({ working, agents }) so the heartbeat can say what the fortress was doing when it died. */
export function boot(stats = () => ({})) {
  const prev = read(RUN);
  if (prev && prev.clean === false && prev.beat) {
    write(LAST, { startedAt: prev.started, diedAbout: prev.beat, uptimeMin: Math.round((prev.beat - prev.started) / 60000), working: prev.working ?? null, memMB: prev.memMB ?? null, minMemMB: prev.minMemMB ?? null, seen: Date.now() });
  }
  started = Date.now();
  let minMem = null;
  const beat = () => {
    const memMB = memFreeMB();
    if (memMB != null) minMem = minMem == null ? memMB : Math.min(minMem, memMB);
    write(RUN, { pid: process.pid, started, beat: Date.now(), clean: false, memMB, minMemMB: minMem, ...stats() });
  };
  beat();
  setInterval(beat, 20_000).unref();
  const clean = () => write(RUN, { pid: process.pid, started, beat: Date.now(), clean: true });
  process.on('exit', clean);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { clean(); process.exit(0); });
}

/** The last time the fortress was killed from outside, if it was in the past week. */
export function lastUnexpectedStop() {
  const l = read(LAST);
  return l && Date.now() - l.seen < 7 * 864e5 ? l : null;
}
