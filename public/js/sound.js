// Procedural ambient sound + effects (WebAudio only, no audio files). OFF by default.
//
// A world theme hands us a declarative `soundSpec`; we turn it into drones, filtered noise beds
// and randomly timed one-shot events. Nothing starts until setEnabled(true) AND the browser has
// seen a user gesture (autoplay policy), so enabling the setting before any click is safe.
//
// spec = {
//   master: 0.5,
//   drones: [{ type:'sine', freq:55, gain:0.05, detune:6, lfo:{ rate:0.1, depth:0.4 } }],
//   noise:  [{ color:'brown'|'pink'|'white', gain:0.05, filter:{ type:'lowpass', freq:400, q:0.7 },
//              lfo:{ rate:0.12, depth:0.5 } }],             // lfo modulates gain (depth = fraction)
//   events: [{ fx:'drip', every:[4,12], gain:0.08 }],        // random one-shots, `every` seconds
//   ui:     { click:'blip', message:'chime', alert:'zap', done:'chime' },
// }

let ac = null, master = null, bed = null;
let enabled = false, spec = null, themeId = '';
let timers = [], stoppers = [], gestureBound = false;
const noiseCache = {};

const hasAudio = () => typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);

function ensureCtx() {
  if (ac || !hasAudio()) return ac;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
  } catch { ac = null; }
  return ac;
}

function bindGesture() {
  if (gestureBound || typeof window === 'undefined') return;
  gestureBound = true;
  const go = () => {
    if (!enabled) return;
    if (ensureCtx()) { ac.resume?.(); startBed(); }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, go, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!ac) return;
    if (document.hidden) ac.suspend?.(); else if (enabled) ac.resume?.();
  });
}

function noiseBuffer(color) {
  if (noiseCache[color]) return noiseCache[color];
  const len = ac.sampleRate * 3, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else if (color === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    else d[i] = w * 0.5;
  }
  return (noiseCache[color] = buf);
}

function stopBed() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  const fade = ac ? 0.4 : 0;
  for (const s of stoppers) { try { s(fade); } catch { /* already stopped */ } }
  stoppers = [];
  if (bed) { const old = bed; setTimeout(() => { try { old.disconnect(); } catch { /* gone */ } }, 600); bed = null; }
}

function startBed() {
  if (!ac || !enabled || !spec) return;
  stopBed();
  bed = ac.createGain(); bed.gain.value = 1; bed.connect(master);
  const t0 = ac.currentTime;
  master.gain.cancelScheduledValues(t0);
  master.gain.setTargetAtTime(spec.master ?? 0.5, t0, 0.5);

  const reg = (node) => stoppers.push((fade) => { try { node.stop(ac.currentTime + fade); } catch { /* */ } });
  const lfo = (target, rate, depthAbs) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = rate; g.gain.value = depthAbs; o.connect(g); g.connect(target); o.start(); reg(o);
  };

  for (const d of spec.drones || []) {
    for (const det of d.detune ? [-d.detune, d.detune] : [0]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = d.type || 'sine'; o.frequency.value = d.freq; o.detune.value = det;
      g.gain.value = (d.gain ?? 0.04) / (d.detune ? 2 : 1);
      let out = g;
      if (d.filter) { const f = ac.createBiquadFilter(); f.type = d.filter.type; f.frequency.value = d.filter.freq; f.Q.value = d.filter.q ?? 0.7; o.connect(f); f.connect(g); } else o.connect(g);
      if (d.lfo) lfo(g.gain, d.lfo.rate, g.gain.value * d.lfo.depth);
      out.connect(bed); o.start(); reg(o);
    }
  }
  for (const n of spec.noise || []) {
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = noiseBuffer(n.color || 'pink'); src.loop = true; src.loop = true;
    g.gain.value = n.gain ?? 0.04;
    let node = src;
    if (n.filter) { const f = ac.createBiquadFilter(); f.type = n.filter.type; f.frequency.value = n.filter.freq; f.Q.value = n.filter.q ?? 0.7; src.connect(f); node = f; }
    node.connect(g); g.connect(bed);
    if (n.lfo) lfo(g.gain, n.lfo.rate, g.gain.value * n.lfo.depth);
    src.start(); reg(src);
  }
  for (const ev of spec.events || []) schedule(ev);
}

function schedule(ev) {
  const [a, b] = ev.every || [6, 14];
  const wait = (a + Math.random() * (b - a)) * 1000;
  timers.push(setTimeout(() => {
    if (!enabled || !ac || ac.state !== 'running') { if (enabled) schedule(ev); return; }
    oneShot(ev.fx, ev.gain ?? 0.08, bed);
    schedule(ev);
  }, wait));
}

// ------------------------------------------------------------------ one-shot synths
function env(g, t, a, hold, r, peak) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  g.gain.setValueAtTime(Math.max(0.0002, peak), t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + r);
}

function tone(dest, { type = 'sine', f0 = 440, f1 = null, t = 0, a = 0.005, hold = 0.02, r = 0.15, gain = 0.1, filter = null }) {
  const t0 = ac.currentTime + t, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t0);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + a + hold + r);
  env(g, t0, a, hold, r, gain);
  let n = o;
  if (filter) { const f = ac.createBiquadFilter(); f.type = filter.type; f.frequency.value = filter.freq; f.Q.value = filter.q ?? 1; o.connect(f); n = f; }
  n.connect(g); g.connect(dest);
  o.start(t0); o.stop(t0 + a + hold + r + 0.05);
}

function burst(dest, { color = 'white', t = 0, a = 0.02, hold = 0.05, r = 0.2, gain = 0.08, filter = { type: 'bandpass', freq: 1200, q: 1 }, sweep = null }) {
  const t0 = ac.currentTime + t, s = ac.createBufferSource(), g = ac.createGain(), f = ac.createBiquadFilter();
  s.buffer = noiseBuffer(color); f.type = filter.type; f.frequency.setValueAtTime(filter.freq, t0); f.Q.value = filter.q ?? 1;
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t0 + a + hold + r);
  env(g, t0, a, hold, r, gain);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t0, Math.random() * 2); s.stop(t0 + a + hold + r + 0.05);
}

const FX = {
  drip:  (d, v) => tone(d, { f0: 1500, f1: 600, r: 0.12, gain: v }),
  thump: (d, v) => { tone(d, { f0: 90, f1: 38, r: 0.5, gain: v * 2.2 }); burst(d, { color: 'brown', r: 0.4, gain: v, filter: { type: 'lowpass', freq: 200 } }); },
  creak: (d, v) => tone(d, { type: 'sawtooth', f0: 180 + Math.random() * 60, f1: 120 + Math.random() * 60, a: 0.15, hold: 0.25, r: 0.4, gain: v * 0.5, filter: { type: 'bandpass', freq: 500, q: 6 } }),
  blip:  (d, v) => tone(d, { type: 'square', f0: 900, f1: 1300, a: 0.002, hold: 0.015, r: 0.05, gain: v * 0.5 }),
  chime: (d, v) => { [660, 880, 1320].forEach((f, i) => tone(d, { type: 'triangle', f0: f, t: i * 0.09, r: 0.5, gain: v * 0.7 })); },
  zap:   (d, v) => { tone(d, { type: 'sawtooth', f0: 1400, f1: 120, r: 0.3, gain: v * 0.6, filter: { type: 'lowpass', freq: 3000 } }); },
  alarm: (d, v) => { for (let i = 0; i < 3; i++) tone(d, { type: 'square', f0: 620, f1: 540, t: i * 0.22, hold: 0.12, r: 0.06, gain: v * 0.45 }); },
  gust:  (d, v) => burst(d, { color: 'pink', a: 1.2, hold: 0.6, r: 1.8, gain: v, filter: { type: 'bandpass', freq: 500, q: 0.8 }, sweep: 900 }),
  gull:  (d, v) => { tone(d, { f0: 1900, f1: 1300, a: 0.03, hold: 0.1, r: 0.2, gain: v * 0.5 }); tone(d, { f0: 2100, f1: 1500, t: 0.28, a: 0.03, hold: 0.1, r: 0.25, gain: v * 0.5 }); },
  bell:  (d, v) => { [523, 784, 1318].forEach((f, i) => tone(d, { f0: f, r: 1.6 - i * 0.3, gain: v * (0.6 - i * 0.15) })); },
  glitch:(d, v) => { for (let i = 0; i < 4; i++) tone(d, { type: 'square', f0: 300 + Math.random() * 2400, t: i * 0.035, hold: 0.015, r: 0.02, gain: v * 0.4 }); },
  ping:  (d, v) => tone(d, { f0: 1760, r: 0.9, gain: v * 0.6 }),
  clop:  (d, v) => { tone(d, { f0: 300, f1: 180, r: 0.07, gain: v * 1.4 }); tone(d, { f0: 280, f1: 170, t: 0.18, r: 0.07, gain: v * 1.2 }); },
  honk:  (d, v) => tone(d, { type: 'sawtooth', f0: 110, f1: 100, a: 0.03, hold: 0.5, r: 0.5, gain: v * 0.5, filter: { type: 'lowpass', freq: 400 } }),
};

function oneShot(name, vol, dest) {
  if (!ac || !FX[name]) return;
  try { FX[name](dest || master, vol); } catch { /* audio never breaks the game */ }
}

// ------------------------------------------------------------------ public API
const UI_DEFAULT = { click: 'blip', message: 'chime', alert: 'alarm', done: 'chime' };

/** Turn sound on/off. Mirrors settings.soundOn. Starts after the first user gesture. */
export function setEnabled(on) {
  enabled = !!on;
  bindGesture();
  if (!enabled) {
    if (ac) { master.gain.setTargetAtTime(0, ac.currentTime, 0.2); setTimeout(() => { if (!enabled) { stopBed(); ac.suspend?.(); } }, 800); }
    return;
  }
  if (ensureCtx()) { ac.resume?.().then?.(() => startBed()).catch?.(() => {}); startBed(); }
}

/** Hand over the active theme's soundSpec. Restarts the loops when sound is on. */
export function setSpec(newSpec, id = '') {
  spec = newSpec || null; themeId = id;
  if (enabled && ac) startBed();
}

/** Play a UI effect: 'click' | 'message' | 'alert' | 'done' (or any raw FX name). */
export function play(name, vol = 0.12) {
  if (!enabled || !ac || ac.state !== 'running') return;
  const fx = (spec?.ui && spec.ui[name]) || UI_DEFAULT[name] || name;
  oneShot(fx, vol, master);
}

export const isEnabled = () => enabled;
export const currentSoundTheme = () => themeId;
export const effects = () => Object.keys(FX);

if (typeof window !== 'undefined') window.fortressSound = { setEnabled, setSpec, play, isEnabled, effects };
