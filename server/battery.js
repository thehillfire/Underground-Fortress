// Battery: the Android app reports the level and charging state now and then. The fortress keeps six hours
// of those samples, forecasts the next hour from the last hour's drain, and tells the work loop when to hold back.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, store } from './store.js';

const FILE = path.join(DATA_DIR, 'battery-history.json');
const KEEP_MS = 6 * 3600e3;
const WINDOW_MS = 3600e3;
const MIN_SPAN_MS = 10 * 60e3;          // a rate needs at least ten minutes of samples to mean anything
const DEFAULT_FLOOR = 20;

const valid = (x) => x && Number.isFinite(x.ts) && Number.isFinite(x.level) && x.level >= 0 && x.level <= 100;
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).filter(valid); } catch { return []; }
}
let history = load();

/** A reading from the phone. Throws if the level is not a number from 0 to 100. */
export function record({ level, charging = false, ts = Date.now() } = {}) {
  const lv = Number(level);
  if (!Number.isFinite(lv) || lv < 0 || lv > 100) throw new Error('level must be a number from 0 to 100');
  const sample = { ts: Number(ts), level: lv, charging: !!charging };
  history.push(sample);
  history = history.filter(x => sample.ts - x.ts <= KEEP_MS).sort((a, b) => a.ts - b.ts);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(history));
  fs.renameSync(FILE + '.tmp', FILE);
  return sample;
}

/**
 * What the next hour looks like. state: 'ok' | 'watch' (floor within two hours) | 'slow' (floor within the hour,
 * or already under it, so new background work waits for charging).
 */
export function forecast(now = Date.now()) {
  const floor = Number(store.state.settings.batteryFloor) || DEFAULT_FLOOR;
  const last = history[history.length - 1];
  if (!last) return { known: false, state: 'ok', floor, note: 'no battery reading from the phone yet' };
  if (last.charging) return { known: true, state: 'ok', charging: true, level: last.level, floor, sampledAt: last.ts };

  const recent = history.filter(x => now - x.ts <= WINDOW_MS);
  // The phone has gone quiet for over an hour: we don't know the trend, so don't hold anything back on it.
  if (!recent.length) return { known: false, stale: true, state: 'ok', level: last.level, floor, sampledAt: last.ts, note: 'no reading in the last hour' };
  const first = recent[0];
  const span = last.ts - first.ts;
  const charged = recent.some(x => x.charging);
  let rate = null;
  if (span >= MIN_SPAN_MS && !charged) rate = Math.max(0, (first.level - last.level) / (span / 3600e3));   // %/hour

  const minutesToFloor = rate && last.level > floor ? ((last.level - floor) / rate) * 60 : (last.level <= floor ? 0 : null);
  let state = 'ok';
  if (last.level <= floor || (minutesToFloor != null && minutesToFloor <= 60)) state = 'slow';
  else if (minutesToFloor != null && minutesToFloor <= 120) state = 'watch';

  return {
    known: true, charging: false, level: last.level, floor, sampledAt: last.ts,
    ratePerHour: rate == null ? null : Math.round(rate * 10) / 10,
    projectedInHour: rate == null ? null : Math.max(0, Math.round(last.level - rate)),
    minutesToFloor: minutesToFloor == null ? null : Math.round(minutesToFloor),
    state,
  };
}

/** True when new background work (not Jav's own messages) should wait for charging. */
export const holdBackNewWork = (now) => { const f = forecast(now); return f.known && !f.charging && f.state === 'slow'; };
/** True when the optional extras (peer reviews, polish rounds) should pause to save the phone. */
export const tight = (now) => { const f = forecast(now); return f.known && !f.charging && f.state !== 'ok'; };
