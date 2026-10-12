// Talk to the fortress with your microphone (Web Speech API) and hear Lidia reply.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SR;

let rec = null;
let listening = false;

/**
 * Start listening once. onResult(finalText) fires when you stop talking;
 * onInterim(text) streams partial words; onEnd() when the mic closes.
 */
export function listen({ onResult, onInterim, onEnd, onError }) {
  if (!SR) { onError?.('Speech recognition needs Chrome, Edge or Safari.'); return; }
  if (listening) { stop(); return; }
  rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let final = '';
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
    }
    onInterim?.(final + interim);
  };
  rec.onerror = (ev) => onError?.(ev.error === 'not-allowed' ? 'Microphone permission was denied.' : ev.error);
  rec.onend = () => { listening = false; if (final.trim()) onResult?.(final.trim()); onEnd?.(); };
  listening = true;
  rec.start();
}

export function stop() { try { rec?.stop(); } catch {} listening = false; }
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
