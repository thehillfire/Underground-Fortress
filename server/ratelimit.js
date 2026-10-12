// Token-bucket rate limiting, per key. Cheap, in memory, good enough for one phone.
const buckets = new Map();
export let limitedCount = 0;

/** allow(key, capacity, refillPerSec) -> true if a token was available. */
export function allow(key, capacity = 60, refillPerSec = 1, now = Date.now()) {
  let b = buckets.get(key);
  if (!b) { b = { tokens: capacity, ts: now }; buckets.set(key, b); }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 1000) * refillPerSec);
  b.ts = now;
  if (b.tokens < 1) { limitedCount++; return false; }
  b.tokens -= 1;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.ts > 600000) buckets.delete(k);
  return true;
}
export const resetLimits = () => buckets.clear();
