// Talk to the fortress with your microphone (Web Speech API). Replies are text only.
//
// Works like Claude's mic: it keeps listening through pauses (Chrome ends a recognition session
// after a short silence, so we quietly start the next one and keep every word), and it only sends
// when Jav taps SEND. The screen is held awake while the mic is on.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SR;
// Android Chrome repeats text in continuous mode, so there we run short sessions back to back instead.
const ANDROID = /android/i.test(navigator.userAgent);
const QUIET_LIMIT = 3 * 60e3;       // nobody has spoken for this long: stop listening and hand the words back

const ERRORS = {
  'not-allowed': 'Microphone blocked. Allow the mic for Chrome: tap the lock/tune icon in the address bar, or Android Settings → Apps → Chrome → Permissions.',
  'service-not-allowed': 'Microphone blocked for this app. Allow it in Android Settings → Apps → Chrome → Permissions.',
  'audio-capture': 'No microphone found, or another app is using it.',
  'network': 'Speech recognition needs an internet connection.',
};
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

let state = 'idle';          // idle | listening | stopping
let rec = null, running = false, announced = false;
let committed = '', heard = '';   // words from finished sessions / from the session in progress
let cb = {};
let restartTimer = 0, quietTimer = 0, netFails = 0, startedAt = 0, wake = null;

const join = (a, b) => (a && b ? `${a.trimEnd()} ${b.trimStart()}` : a || b);
const full = () => join(committed, heard);

// ---- keep the screen on while the mic is on (and pick the mic back up if the phone was locked)
async function holdScreen() {
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch {}
}
function releaseScreen() { try { wake?.release(); } catch {} wake = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || state !== 'listening') return;
  holdScreen();
  if (!running) { clearTimeout(restartTimer); begin(); }
});

function armQuiet() {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    if (state !== 'listening') return;
    const text = full().trim();
    teardown(); cb.onTimeout?.(text); cb.onEnd?.();
  }, QUIET_LIMIT);
}
function teardown() {
  state = 'idle'; running = false;
  clearTimeout(restartTimer); clearTimeout(quietTimer);
  releaseScreen();
  try { rec?.abort(); } catch {}
  rec = null;
}
function fail(message) {
  teardown();
  if (message) cb.onError?.(message);
  cb.onEnd?.();
}
function finish() {
  if (state === 'idle') return;
  const text = full().trim();
  teardown();
  if (text) cb.onResult?.(text);
  cb.onEnd?.();
}

function begin() {
  if (state !== 'listening') return;
  const r = new SR();
  rec = r;
  r.lang = navigator.language || 'en-US';
  r.interimResults = true;
  r.continuous = !ANDROID;
  heard = '';
  r.onstart = () => {
    running = true; startedAt = Date.now();
    if (!announced) { announced = true; cb.onStart?.(); }
    cb.onSound?.(0.15);
  };
  r.onsoundstart = () => cb.onSound?.(0.45);
  r.onspeechstart = () => { cb.onSound?.(0.8); armQuiet(); };
  r.onspeechend = () => cb.onSound?.(0.1);
  r.onresult = (ev) => {
    if (r !== rec) return;
    armQuiet(); netFails = 0;
    const parts = Array.from(ev.results, (x) => x[0].transcript);
    heard = ANDROID ? parts[parts.length - 1] || '' : parts.join('');
    cb.onSound?.(1);
    cb.onInterim?.(full());
  };
  r.onerror = (ev) => {
    if (r !== rec || state === 'idle') return;
    if (FATAL.has(ev.error)) return fail(ERRORS[ev.error] || `Mic error: ${ev.error}`);
    if (ev.error === 'network' && ++netFails > 5) return fail(ERRORS.network);
    // no-speech, aborted, a hiccup: not worth stopping for. onend starts the next session.
  };
  r.onend = () => {
    if (r !== rec) return;
    running = false;
    committed = join(committed, heard); heard = '';
    if (state === 'stopping') return finish();
    // Chrome closed the session (a pause, or its own time limit): keep going.
    clearTimeout(restartTimer);
    restartTimer = setTimeout(begin, Date.now() - startedAt < 1200 ? 900 : 150);
  };
  try { r.start(); }
  catch (e) {
    if (e.name === 'InvalidStateError') { restartTimer = setTimeout(begin, 400); return; }
    fail(`Mic error: ${e.message}`);
  }
}

/**
 * Start listening. It runs until stop() (send) or cancel() (throw away).
 *  onStart()          the mic is live
 *  onSound(level)     0..1 hint of how much speech is coming in (drives the waves)
 *  onInterim(text)    everything said so far
 *  onResult(text)     everything said, when Jav sends (not called when cancelled)
 *  onTimeout(text)    nobody spoke for a few minutes: listening stopped, nothing sent
 *  onEnd()            mic closed
 *  onError(message)   human-readable problem
 */
export function listen(callbacks) {
  if (!SR) { callbacks.onError?.('Voice needs Chrome on Android (or Edge/Safari).'); callbacks.onEnd?.(); return; }
  if (state !== 'idle') { stop(); return; }
  cb = callbacks;
  state = 'listening'; announced = false; committed = ''; heard = ''; netFails = 0;
  holdScreen(); armQuiet();
  begin();
}

/** Done talking: send everything that was heard. */
export function stop() {
  if (state !== 'listening') return;
  state = 'stopping';
  clearTimeout(restartTimer);
  if (!running) return finish();                 // between two sessions: nothing left to wait for
  try { rec.stop(); } catch { return finish(); }
  setTimeout(() => finish(), 2500);              // if Chrome never reports the end
}
/** Throw away what was heard. */
export function cancel() {
  if (state === 'idle') return;
  teardown();
  cb.onEnd?.();
}
export const isListening = () => state !== 'idle';

/**
 * Route a spoken sentence: "Lidia, ..." goes to the captain, "<name>, ..." to that
 * dweller, anything else to whoever is selected (or Lidia).
 */
export function route(text, sessions, selected) {
  const t = text.trim();
  const lower = t.toLowerCase();
  const strip = (n) => t.slice(n).replace(/^[\s,.:;!-]+/, '');
  for (const key of ['lidia', 'lydia', 'captain', 'lidiya']) {
    if (lower.startsWith(key)) return { to: 'lidia', text: strip(key.length) || t };
  }
  const byName = [...sessions].sort((a, b) => b.name.length - a.name.length)
    .find(s => lower.startsWith(s.name.toLowerCase()));
  if (byName) return { to: byName.id, text: strip(byName.name.length) || t };
  return { to: selected && selected !== 'lidia' ? selected : 'lidia', text: t };
}
