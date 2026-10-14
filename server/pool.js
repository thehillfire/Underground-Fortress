// One line for every model call on the phone: agent turns, peer reviews, Lidia's reviews and her chat.
// The cap is how many Claude sessions run at once. Past that, the phone runs out of memory and battery.
// A higher priority jumps the line (Jav's chat first); equal priority is first come, first served.

let active = 0;
let waiters = [];                       // { priority, resolve, onWait }
let capOf = () => 3;

export function setCap(fn) { capOf = fn; }
const cap = () => Math.max(1, Math.min(12, Number(capOf()) || 3));
const tellPlaces = () => waiters.forEach((w, i) => w.onWait?.(i + 1));

/** Resolves true once a place is free, false if the signal stopped the wait first. */
export function take({ priority = 0, signal, onWait } = {}) {
  if (signal?.aborted) return Promise.resolve(false);
  if (active < cap() && waiters.length === 0) { active++; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const w = { priority, resolve, onWait };
    let i = waiters.length;
    while (i > 0 && waiters[i - 1].priority < priority) i--;   // after everyone of equal or higher priority
    waiters.splice(i, 0, w);
    tellPlaces();
    signal?.addEventListener('abort', () => {
      const j = waiters.indexOf(w);
      if (j >= 0) { waiters.splice(j, 1); resolve(false); tellPlaces(); }
    }, { once: true });
  });
}

/** Give a place back. Whoever is next in line gets it. */
export function give() {
  active = Math.max(0, active - 1);
  while (waiters.length && active < cap()) { active++; waiters.shift().resolve(true); }
  tellPlaces();
}

/** Run one model call in a place in line, and give the place back when it finishes. */
export async function lane(priority, fn, signal) {
  if (!(await take({ priority, signal }))) throw new Error('stopped while waiting for a free slot');
  try { return await fn(); } finally { give(); }
}

export const info = () => ({ active, waiting: waiters.length, max: cap() });
