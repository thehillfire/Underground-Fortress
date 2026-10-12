// Autonomous error resolution: DETECT -> INTERROGATE -> DIAGNOSE -> RESOLVE -> VERIFY -> LOG -> ESCALATE.
// Detect happens where a turn crashes; verify happens when the next turn succeeds (resolved()).
// Lidia fixes what she can (wait out a rate limit, drop a bad model, retry a network blip) and only
// bothers Jav when the fix needs him (login, disk full) or three attempts failed.
import { record } from './intent.js';

const MAX_ATTEMPTS = 3;
const timers = new Map();

const KINDS = [
  { id: 'rate-limit', re: /(rate.?limit|429|overloaded|usage limit|limit reached|too many requests|quota)/i, wait: 90, fix: 'wait out the limit, then retry' },
  { id: 'bad-model', re: /(model.{0,40}(not found|invalid|unavailable|does not exist|not available)|invalid model|unknown model)/i, wait: 2, fix: 'drop the bad model setting and use the default', clearModel: true },
  { id: 'network', re: /(econn|enotfound|etimedout|socket hang|network|fetch failed|timed? out|eai_again|503|502|504)/i, wait: 20, fix: 'retry after a short wait' },
  { id: 'auth', re: /(log ?in|not authenticated|unauthori[sz]ed|401|credential|oauth|token (expired|invalid)|please run \/login)/i, human: true, fix: 'Claude needs you to log in again (run `claude` in Termux and /login)' },
  { id: 'disk', re: /(enospc|no space left|disk full)/i, human: true, fix: 'the phone is out of storage' },
];

/** INTERROGATE + DIAGNOSE: what kind of failure is this? */
export function diagnose(reason) {
  const r = String(reason || '');
  return KINDS.find(k => k.re.test(r)) || { id: 'unknown', wait: 10, fix: 'retry once; if it fails the same way, escalate' };
}

/**
 * A turn crashed. Decide and act. deps: { retry(sid), escalate(s, text, level), setModel(s, '') }.
 * Returns the action taken: 'retrying' | 'escalated'.
 */
export function handleCrash(s, reason, deps) {
  const inc = (s.incident ||= { n: 0, first: Date.now(), steps: [] });
  inc.n += 1;
  const dx = diagnose(reason);
  const give = dx.human || inc.n > MAX_ATTEMPTS || (dx.id === 'unknown' && inc.n > 1);
  inc.steps.push({ ts: Date.now(), kind: dx.id, n: inc.n });
  if (give) {
    record({ tier: 2, kind: 'incident', agentId: s.id, agent: s.name, summary: `${s.name} failed (${dx.id}): ${String(reason).slice(0, 160)}`,
      decision: 'escalated', why: dx.human ? dx.fix : `${inc.n - 1} automatic fix attempts did not work.` });
    deps.escalate(s, dx.human ? dx.fix : `I tried to fix ${s.name} ${inc.n - 1} time${inc.n === 2 ? '' : 's'} and it keeps failing: ${String(reason).slice(0, 200)}`, dx.id === 'auth' || dx.id === 'disk' ? 'CRITICAL' : 'BLOCK');
    return 'escalated';
  }
  if (dx.clearModel && s.model) deps.setModel(s, '');
  const wait = Math.min(900, dx.wait * 2 ** (inc.n - 1));
  record({ tier: 1, kind: 'incident', agentId: s.id, agent: s.name, summary: `${s.name} failed (${dx.id}): ${String(reason).slice(0, 160)}`,
    decision: `auto-fix #${inc.n}: ${dx.fix} (in ${wait}s)`, why: 'Diagnosed automatically; retrying without bothering Jav.' });
  clearTimeout(timers.get(s.id));
  timers.set(s.id, setTimeout(() => { timers.delete(s.id); try { deps.retry(s.id); } catch {} }, wait * 1000));
  return 'retrying';
}

/** VERIFY: a turn finished fine after an incident. */
export function resolved(s) {
  if (!s.incident) return;
  record({ tier: 1, kind: 'incident', agentId: s.id, agent: s.name, summary: `${s.name} recovered`, decision: 'resolved', why: `Fixed after ${s.incident.n} attempt${s.incident.n === 1 ? '' : 's'}.` });
  delete s.incident;
}

export function cancel(sid) { clearTimeout(timers.get(sid)); timers.delete(sid); }
