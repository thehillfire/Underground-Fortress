// Plan usage: the same numbers as Claude Code's /usage screen (current session
// and weekly limits), refreshed in the background and from every turn's
// rate-limit events.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { store } from './store.js';
import { MOCK, rateLimitListeners } from './agent.js';

const LABELS = { five_hour: 'Current session', seven_day: 'All models', seven_day_opus: 'Opus only',
  seven_day_sonnet: 'Sonnet only', seven_day_oauth_apps: 'Apps & tools', seven_day_overage_included: 'Weekly (incl. extra)' };
const GROUP = (k) => (k === 'five_hour' || k === 'session' ? 'session' : 'weekly');

function setUsage(patch) {
  const u = store.state.usage || {};
  store.state.usage = { ...u, ...patch, ts: Date.now() };
  store.changed();
}

/** Normalize either response shape into display rows. */
function rowsFrom(rl) {
  if (!rl) return [];
  if (Array.isArray(rl.limits)) {
    return rl.limits.map((r) => ({
      key: r.kind, group: r.group || GROUP(r.kind),
      label: r.label || r.title || r.scope?.model?.display_name || r.scope?.surface?.display_name || (r.group === 'session' ? 'Current session' : r.kind.replace(/_/g, ' ')),
      percent: Math.round(r.percent ?? 0), resetsAt: r.resets_at || null, severity: r.severity || null, active: !!r.is_active,
    }));
  }
  return Object.entries(rl)
    .filter(([, v]) => v && typeof v === 'object' && 'utilization' in v)
    .map(([k, v]) => ({ key: k, group: GROUP(k), label: LABELS[k] || k.replace(/_/g, ' '),
      percent: Math.round(v.utilization ?? 0), resetsAt: v.resets_at || null, severity: null, active: k === 'five_hour' }));
}

let inflight = null;
/** Ask Claude Code for /usage data. No model call, no cost. */
export function refreshUsage() {
  if (inflight) return inflight;
  inflight = (async () => {
    if (MOCK) {
      const now = Date.now();
      return setUsage({ available: true, plan: 'max', source: 'mock', rows: [
        { key: 'five_hour', group: 'session', label: 'Current session', percent: 63, resetsAt: new Date(now + 2.2 * 3600e3).toISOString(), active: true },
        { key: 'seven_day', group: 'weekly', label: 'All models', percent: 38, resetsAt: new Date(now + 3.6 * 86400e3).toISOString() },
        { key: 'seven_day_opus', group: 'weekly', label: 'Opus only', percent: 52, resetsAt: new Date(now + 3.6 * 86400e3).toISOString() },
      ] });
    }
    async function* idle() { await new Promise(r => setTimeout(r, 30000)); }
    const q = query({ prompt: idle(), options: { settingSources: [], tools: [] } });
    try {
      const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      const rows = rowsFrom(u.rate_limits);
      setUsage({ available: !!u.rate_limits_available && rows.length > 0, plan: u.subscription_type, source: 'usage', rows,
        extra: u.rate_limits?.extra_usage || null, error: null });
    } catch (err) {
      setUsage({ error: err.message });       // keep the last good numbers
    } finally {
      try { q.close?.(); } catch {}
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Live updates from any running agent: Claude Code emits these with each turn. */
rateLimitListeners.add((info) => {
  if (!info?.rateLimitType || info.utilization == null) return;
  const pct = Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization);
  const u = store.state.usage || {};
  const rows = [...(u.rows || [])];
  const i = rows.findIndex(r => r.key === info.rateLimitType || (info.rateLimitType === 'five_hour' && r.group === 'session' && r.active));
  const row = { key: info.rateLimitType, group: GROUP(info.rateLimitType), label: LABELS[info.rateLimitType] || info.rateLimitType,
    percent: pct, resetsAt: info.resetsAt ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null, active: info.rateLimitType === 'five_hour' };
  if (i > -1) rows[i] = { ...rows[i], percent: pct, resetsAt: row.resetsAt || rows[i].resetsAt }; else rows.push(row);
  setUsage({ available: true, rows, limited: info.status === 'rejected' ? info.rateLimitType : null });
});

/** Highest usage across session and weekly windows, 0-100 (null when unknown). */
export function peakUsage() {
  const rows = store.state.usage?.rows || [];
  return rows.length ? Math.max(...rows.map(r => r.percent || 0)) : null;
}

let timer = null;
export function startUsagePolling() {
  refreshUsage();
  clearInterval(timer);
  timer = setInterval(refreshUsage, 3 * 60_000);
}
let soon = null;
export function refreshSoon() { clearTimeout(soon); soon = setTimeout(refreshUsage, 15_000); }
