// Task graph: tasks with dependencies, owners, success criteria, constraints and escalation criteria.
// Delegation from Lidia creates tasks; owners accept, decline or escalate; dependents unlock when deps finish.
import { store, id } from './store.js';
import * as audit from './audit.js';

export const STATUSES = ['pending', 'accepted', 'declined', 'running', 'blocked', 'done', 'failed', 'escalated'];
export const tasks = () => (store.state.tasks ||= []);
export const get = (tid) => tasks().find(t => t.id === tid);

function wouldCycle(newId, deps) {
  const seen = new Set();
  const walk = (x) => { if (x === newId) return true; if (seen.has(x)) return false; seen.add(x); return (get(x)?.deps || []).some(walk); };
  return deps.some(walk);
}

export function create({ title, detail = '', owner = '', creator = 'lidia', deps = [], criteria = '', constraints = '', escalateIf = '', priority = 50 }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('title required');
  const dep = (deps || []).filter(d => get(d));
  const task = { id: id('task'), title: t.slice(0, 160), detail: String(detail).slice(0, 4000), owner, creator, deps: dep, criteria: String(criteria).slice(0, 800),
    constraints: String(constraints).slice(0, 800), escalateIf: String(escalateIf).slice(0, 500), priority: Math.max(0, Math.min(100, +priority || 50)),
    status: 'pending', result: '', created: Date.now(), history: [{ ts: Date.now(), status: 'pending', by: creator }] };
  if (wouldCycle(task.id, dep)) throw new Error('That dependency would make a loop.');
  tasks().push(task);
  audit.record(creator, 'task.create', task.id, task.title);
  store.changed();
  return task;
}

export function setStatus(tid, status, by = 'system', note = '') {
  const t = get(tid);
  if (!t) throw new Error('No such task');
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  t.status = status;
  if (note) t.result = String(note).slice(0, 2000);
  t.history.push({ ts: Date.now(), status, by, note: String(note).slice(0, 200) });
  audit.record(by, `task.${status}`, t.id, t.title);
  store.changed();
  return t;
}

/** Make `tid` wait on `depId`. Refuses anything that would create a loop. */
export function addDep(tid, depId) {
  const t = get(tid), d = get(depId);
  if (!t || !d) throw new Error('No such task');
  if (tid === depId || wouldCycle(tid, [depId])) throw new Error('That dependency would make a loop.');
  if (!t.deps.includes(depId)) { t.deps.push(depId); audit.record('system', 'task.dep', tid, depId); store.changed(); }
  return t;
}

export const ready = () => tasks().filter(t => t.status === 'pending' && t.deps.every(d => get(d)?.status === 'done'));
export const blockedBy = (t) => t.deps.filter(d => get(d)?.status !== 'done');
export const forOwner = (name) => tasks().filter(t => t.owner && t.owner.toLowerCase() === String(name).toLowerCase() && !['done', 'failed', 'declined'].includes(t.status));

/** The brief an agent receives for a delegated task: goal, success criteria, constraints, when to escalate. */
export function brief(t) {
  return `TASK ${t.id}: ${t.title}
${t.detail}
SUCCESS LOOKS LIKE: ${t.criteria || 'the work is real, tested where it can be, and reported with evidence.'}
CONSTRAINTS: ${t.constraints || 'stay inside your workspace; never spend money.'}
ESCALATE ONLY IF: ${t.escalateIf || 'you need money, credentials, or a destructive/irreversible choice. Everything else, decide and keep going.'}
Use your update_task tool to accept, decline (with a reason), or mark it done with evidence.`;
}
