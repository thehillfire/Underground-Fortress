// Prometheus text format, served locally at /api/metrics (point any scraper at the phone, or just read it).
import { store } from './store.js';
import * as audit from './audit.js';
import * as bus from './bus.js';
import * as tasks from './tasks.js';
import * as memory from './memory.js';
import { decisions } from './intent.js';
import { isKilled } from './safety.js';

export function renderMetrics({ limited = 0 } = {}) {
  const L = [];
  const g = (name, help, v, labels = '') => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${v}`); };
  const byStatus = {};
  for (const s of store.state.sessions) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  L.push('# HELP fortress_agents Agents by status', '# TYPE fortress_agents gauge');
  for (const [k, v] of Object.entries(byStatus)) L.push(`fortress_agents{status="${k}"} ${v}`);
  const tByStatus = {};
  for (const t of tasks.tasks()) tByStatus[t.status] = (tByStatus[t.status] || 0) + 1;
  L.push('# HELP fortress_tasks Tasks by status', '# TYPE fortress_tasks gauge');
  for (const [k, v] of Object.entries(tByStatus)) L.push(`fortress_tasks{status="${k}"} ${v}`);
  g('fortress_projects', 'Rooms', store.state.projects.length);
  g('fortress_bus_messages', 'Messages on the bus', bus.log().length);
  g('fortress_anomalies', 'Flagged anomalies', (store.state.anomalies || []).length);
  g('fortress_decisions', 'Lidia decisions logged', decisions().length);
  g('fortress_memories', 'Stored memories', Object.values(memory.stats()).reduce((a, b) => a + b, 0));
  g('fortress_audit_entries', 'Audit log entries', audit.auditCount());
  g('fortress_rate_limited_total', 'Requests refused by rate limits', limited);
  g('fortress_killed', 'Kill switch on', isKilled() ? 1 : 0);
  g('fortress_uptime_seconds', 'Server uptime', Math.round(process.uptime()));
  g('fortress_rss_bytes', 'Resident memory', process.memoryUsage().rss);
  return L.join('\n') + '\n';
}
