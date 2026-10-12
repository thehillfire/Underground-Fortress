// The fortress alarm clock. The phone has no cron, but the fortress server runs
// all the time, so it wakes agents itself — in Jav's timezone, with catch-up
// for anything missed while the phone was off.
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { store, id } from './store.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
let sendFn = null;   // sessions.send, injected to avoid an import cycle

export const tz = () => store.state.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const jobs = () => (store.state.schedules ||= []);

/** Wall-clock parts of `date` in Jav's timezone. */
function local(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dow: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}

function parseDays(days) {
  if (!days || days === 'daily' || days === 'every day') return [0, 1, 2, 3, 4, 5, 6];
  if (days === 'weekdays') return [1, 2, 3, 4, 5];
  if (days === 'weekends') return [0, 6];
  const list = (Array.isArray(days) ? days : String(days).split(/[\s,]+/)).map(d => DAYS.indexOf(String(d).toLowerCase().slice(0, 3))).filter(d => d >= 0);
  return list.length ? [...new Set(list)].sort() : [0, 1, 2, 3, 4, 5, 6];
}

function normTime(t) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(t).trim());
  if (!m) throw new Error(`Time must look like 07:00 or 7am, got "${t}"`);
  let h = +m[1]; const min = +(m[2] || 0);
  if (m[3]) { h %= 12; if (/pm/i.test(m[3])) h += 12; }
  if (h > 23 || min > 59) throw new Error(`Invalid time "${t}"`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function addJob({ sessionId, time, days, instruction, by = 'jav', once = false }) {
  const s = store.session(sessionId);
  if (!s) throw new Error('No such agent');
  const job = { id: id('job'), sessionId, agent: s.name, time: normTime(time), days: parseDays(days), instruction: String(instruction).slice(0, 4000),
    by, once: !!once, enabled: true, createdAt: Date.now(), lastRunDay: null };
  // Created after today's slot already passed? Don't fire it right away.
  const now = local();
  if (job.time <= now.hm) job.lastRunDay = now.day;
  jobs().push(job);
  store.feed(`Scheduled: ${s.name} ${describe(job)}.`, 'info', s.id);
  return job;
}

export function removeJob(jobId) {
  const st = store.state;
  const before = jobs().length;
  st.schedules = jobs().filter(j => j.id !== jobId);
  store.changed();
  return before !== st.schedules.length;
}

export function describe(j) {
  const d = j.days.length === 7 ? 'every day' : j.days.join() === '1,2,3,4,5' ? 'weekdays' : j.days.map(i => DAYS[i]).join(', ');
  return `${j.once ? 'once' : d} at ${j.time} (${tz()}): ${j.instruction.slice(0, 80)}`;
}

/** Fire due jobs. A job missed earlier today (phone off) runs on the next tick. */
function tick() {
  const now = local();
  for (const j of jobs()) {
    if (!j.enabled || j.lastRunDay === now.day || !j.days.includes(now.dow) || j.time > now.hm) continue;
    const s = store.session(j.sessionId);
    if (!s) { j.enabled = false; continue; }
    const late = j.time < now.hm ? ` (was due ${j.time}; the fortress was offline)` : '';
    j.lastRunDay = now.day;
    j.lastRunAt = Date.now();
    if (j.once) j.enabled = false;
    store.feed(`Alarm: ${s.name} starts "${j.instruction.slice(0, 60)}"${late}.`, 'lidia', s.id);
    sendFn?.(s.id, `Scheduled task (${j.time} ${tz()})${late}: ${j.instruction}`, 'schedule');
  }
  store.changed();
}

let timer = null;
export function startScheduler(send) {
  sendFn = send;
  clearInterval(timer);
  timer = setInterval(tick, 30_000);
  setTimeout(tick, 5_000);   // catch up shortly after start
}

// ------------------------------------------------------------------ tools
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (m) => ({ content: [{ type: 'text', text: m }], isError: true });
const DAYS_DOC = '"daily", "weekdays", "weekends", or a list like "mon,wed,fri"';

/** Tools an agent gets for its own schedule. */
export function agentScheduleServer(sessionId, extraTools = []) {
  return createSdkMcpServer({ name: 'fortress', version: '1.0.0', tools: [
    ...extraTools,
    tool('schedule_task', `Have the fortress wake you up at a time of day in Jav's timezone (${tz()}) with an instruction. Use this instead of cron, at, or any OS scheduler (there is none on this device). days: ${DAYS_DOC}.`,
      { time: z.string().describe('e.g. 07:00 or 7am'), days: z.string().optional(), instruction: z.string(), once: z.boolean().optional() },
      async (a) => { try { const j = addJob({ sessionId, ...a, by: 'agent' }); return ok(`Scheduled ${describe(j)} [id ${j.id}]`); } catch (e) { return fail(e.message); } }),
    tool('list_my_schedules', 'Your scheduled tasks.', {},
      async () => ok(jobs().filter(j => j.sessionId === sessionId && j.enabled).map(j => `${j.id}: ${describe(j)}`).join('\n') || 'None.')),
    tool('cancel_schedule', 'Cancel one of your scheduled tasks by id.', { id: z.string() },
      async ({ id: jid }) => { const j = jobs().find(x => x.id === jid && x.sessionId === sessionId); return j && removeJob(jid) ? ok('Cancelled.') : fail('No such schedule of yours.'); }),
  ] });
}

/** Lidia's versions: any agent. */
export function captainScheduleTools(findAgent) {
  return [
    tool('schedule_task', `Schedule an agent to start an instruction at a time of day in Jav's timezone (${tz()}). days: ${DAYS_DOC}.`,
      { agent: z.string(), time: z.string(), days: z.string().optional(), instruction: z.string(), once: z.boolean().optional() },
      async ({ agent, ...a }) => { const s = findAgent(agent); if (!s) return fail(`No agent named ${agent}`); try { const j = addJob({ sessionId: s.id, ...a, by: 'lidia' }); return ok(`Scheduled ${s.name} ${describe(j)} [id ${j.id}]`); } catch (e) { return fail(e.message); } }),
    tool('list_schedules', 'All scheduled tasks in the fortress.', {},
      async () => ok(jobs().filter(j => j.enabled).map(j => `${j.id}: ${j.agent} ${describe(j)}`).join('\n') || 'None.')),
    tool('cancel_schedule', 'Cancel a scheduled task by id.', { id: z.string() },
      async ({ id: jid }) => (removeJob(jid) ? ok('Cancelled.') : fail('No such schedule.'))),
  ];
}
