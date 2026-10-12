// Priority engine (0-100) and escalation queue for Lidia's Command Deck.
import { store } from './store.js';
import { decisions } from './intent.js';

export const BANDS = [[90, 'Critical'], [70, 'High'], [40, 'Normal'], [20, 'Low'], [0, 'Background']];
export const band = (score) => BANDS.find(([min]) => score >= min)[1];

/** Score one agent: what needs attention first. */
export function score(s, now = Date.now()) {
  let n = { error: 82, needs_jav: 72, reporting: 45, working: 40, idle: 20, done: 8 }[s.status] ?? 30;
  if (s.pendingPermission?.kind === 'money') n = 100;
  else if (s.escalation?.level === 'CRITICAL') n = Math.max(n, 95);
  else if (s.escalation?.level === 'BLOCK') n = Math.max(n, 78);
  if (s.interrupted) n = Math.max(n, 60);
  // Waiting makes it more urgent, capped.
  const waitedMin = Math.max(0, (now - (s.statusSince || now)) / 60000);
  if (['error', 'needs_jav'].includes(s.status)) n += Math.min(12, waitedMin / 5);
  return Math.min(100, Math.round(n));
}

export function priorities(now = Date.now()) {
  return store.state.sessions.map(s => {
    const p = score(s, now);
    return { id: s.id, name: s.name, status: s.status, activity: s.activity, score: p, band: band(p), project: s.projectId };
  }).sort((a, b) => b.score - a.score);
}

/** Open items that need Jav, with an escalation level. */
export function escalations() {
  const out = [];
  for (const s of store.state.sessions) {
    if (s.pendingPermission) {
      const money = s.pendingPermission.kind === 'money';
      out.push({ id: s.id, name: s.name, level: money ? 'CRITICAL' : 'BLOCK', text: money ? `Money action waiting: ${s.pendingPermission.reason}` : `Needs permission for ${s.pendingPermission.tool}`, ts: s.statusSince || Date.now() });
    } else if (s.status === 'needs_jav' || s.status === 'error') {
      const e = s.escalation;
      out.push({ id: s.id, name: s.name, level: e?.level || (s.status === 'error' ? 'WARN' : 'BLOCK'), text: e?.text || s.pendingQuestion || s.crash?.reason || 'Needs a look', ts: e?.ts || s.statusSince || Date.now() });
    } else if (s.interrupted) {
      out.push({ id: s.id, name: s.name, level: 'INFO', text: 'Was interrupted by a restart', ts: s.statusSince || Date.now() });
    }
  }
  const rank = { CRITICAL: 0, BLOCK: 1, WARN: 2, INFO: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.ts - b.ts);
}

/** The thought stream: Lidia's decisions, newest last, filterable. */
export function thoughtStream({ q = '', tier = null, agentId = null, since = 0, limit = 200 } = {}) {
  const needle = String(q).toLowerCase();
  return decisions().filter(e => e.ts > since
    && (tier == null || e.tier === Number(tier))
    && (!agentId || e.agentId === agentId)
    && (!needle || `${e.agent} ${e.summary} ${e.decision} ${e.why}`.toLowerCase().includes(needle))).slice(-limit);
}
