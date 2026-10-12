// Talk to the fortress with your microphone (Web Speech API) and hear Lidia reply.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SR;

let rec = null;
let listening = false;
let cancelled = false;

const ERRORS = {
  'not-allowed': 'Microphone blocked. Allow the mic for Chrome: tap the lock/tune icon in the address bar, or Android Settings → Apps → Chrome → Permissions.',
  'service-not-allowed': 'Microphone blocked for this app. Allow it in Android Settings → Apps → Chrome → Permissions.',
  'audio-capture': 'No microphone found, or another app is using it.',
  'network': 'Speech recognition needs an internet connection.',
  'no-speech': "Didn't hear anything. Tap the mic and try again.",
  'aborted': null,
};

/**
 * Listen for one utterance.
 *  onStart()          the mic is live
 *  onSound(level)     0..1 hint of how much speech is coming in (drives the waves)
 *  onInterim(text)    words so far
 *  onResult(text)     the final sentence (not called when cancelled)
 *  onEnd()            mic closed
 *  onError(message)   human-readable problem
 */
export function listen({ onStart, onSound, onResult, onInterim, onEnd, onError }) {
  if (!SR) { onError?.('Voice needs Chrome on Android (or Edge/Safari).'); onEnd?.(); return; }
  if (listening) { stop(); return; }
  cancelled = false;
  rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let final = '';
  rec.onstart = () => { onStart?.(); onSound?.(0.15); };
  rec.onsoundstart = () => onSound?.(0.45);
  rec.onspeechstart = () => onSound?.(0.8);
  rec.onspeechend = () => onSound?.(0.1);
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
    }
    onSound?.(1);
    onInterim?.(final + interim);
  };
  rec.onerror = (ev) => { const m = ev.error in ERRORS ? ERRORS[ev.error] : `Mic error: ${ev.error}`; if (m) onError?.(m); };
  rec.onend = () => { listening = false; if (!cancelled && final.trim()) onResult?.(final.trim()); onEnd?.(); };
  listening = true;
  try { rec.start(); } catch (e) { listening = false; onError?.(`Mic error: ${e.message}`); onEnd?.(); }
}

/** Stop and send what was heard. */
export function stop() { try { rec?.stop(); } catch {} }
/** Stop and throw away what was heard. */
export function cancel() { cancelled = true; try { rec?.abort(); } catch {} }
export const isListening = () => listening;

let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  return vs.find(v => /female|samantha|victoria|zira|aria|jenny|google uk english female/i.test(v.name)) ||
         vs.find(v => v.lang?.startsWith((navigator.language || 'en').slice(0, 2))) || vs[0] || null;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); };

export function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  voice = voice || pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1.03; u.pitch = 1.0;
  speechSynthesis.speak(u);
}

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
