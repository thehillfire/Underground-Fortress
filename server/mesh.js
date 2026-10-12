// What every agent can do inside the fortress: message teammates, take and report tasks, share versioned
// artifacts, and keep memory. All identity comes from the closure (sid), never from tool arguments.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { store } from './store.js';
import * as bus from './bus.js';
import * as tasks from './tasks.js';
import * as artifacts from './artifacts.js';
import * as memory from './memory.js';
import { untrusted } from './safety.js';

const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const fail = (m) => ({ content: [{ type: 'text', text: String(m) }], isError: true });
const guard = (fn) => async (a) => { try { return ok(await fn(a)); } catch (e) { return fail(e.message); } };

export function meshTools(sid) {
  const me = () => store.session(sid);
  return [
    tool('send_message', 'Message a teammate (by name) or Lidia. type: REQUEST (asks them to do something), QUERY (asks a question), NOTIFY (fyi), RESPONSE (answers), ESCALATE (to Lidia only, when blocked on something only she or Jav can decide). Keep it short and put the facts in it.',
      { to: z.string(), type: z.enum(bus.TYPES).default('NOTIFY'), topic: z.string().default(''), body: z.string(), reply_to: z.string().optional() },
      guard(async ({ to, type, topic, body, reply_to }) => { const t = String(to).toLowerCase() === 'jav' ? 'lidia' : to; const m = bus.publish({ from: sid, to: t, type, topic, body, corr: reply_to }); return `Sent ${m.type} ${m.id}.`; })),
    tool('check_inbox', 'Messages other agents or Lidia sent you that you have not read.', {},
      guard(async () => { const list = bus.inbox(sid); bus.markRead(sid); return list.length ? list.map(m => `[${m.type} from ${store.session(m.from)?.name || m.from}${m.topic ? ` / ${m.topic}` : ''}] ${untrusted(`message:${m.id}`, m.body)}`).join('\n\n') : 'Inbox empty.'; })),
    tool('my_tasks', 'Tasks assigned to you, with what success looks like and what you may escalate.', {},
      guard(async () => tasks.forOwner(me().name).map(t => `${tasks.brief(t)}\nStatus: ${t.status}${tasks.blockedBy(t).length ? ` (waiting on ${tasks.blockedBy(t).join(', ')})` : ''}`).join('\n\n---\n') || 'No open tasks.')),
    tool('create_task', 'Add a task to the shared task graph (for yourself or a teammate). deps = ids of tasks that must finish first.',
      { title: z.string(), detail: z.string().default(''), owner: z.string().optional(), deps: z.array(z.string()).default([]), criteria: z.string().default('') },
      guard(async (a) => { const t = tasks.create({ ...a, owner: a.owner || me().name, creator: `agent:${me().name}` }); return `Created ${t.id}.`; })),
    tool('update_task', 'Report on a task: accepted | declined (say why) | running | blocked | done (say what was produced and where) | failed | escalated.',
      { id: z.string(), status: z.enum(tasks.STATUSES), note: z.string().default('') },
      guard(async ({ id, status, note }) => { const t = tasks.get(id); if (!t) throw new Error('No such task'); if (t.owner && t.owner.toLowerCase() !== me().name.toLowerCase()) throw new Error('That task belongs to someone else.'); tasks.setStatus(id, status, `agent:${me().name}`, note); return `Task ${id} is now ${status}.`; })),
    tool('put_artifact', 'Save a shared, versioned artifact (a plan, dataset, draft). Every save makes a new version teammates can read.',
      { name: z.string(), content: z.string(), note: z.string().default('') },
      guard(async ({ name, content, note }) => { const r = artifacts.put(name, content, `agent:${me().name}`, note); return `Saved ${r.name} v${r.version}.`; })),
    tool('get_artifact', 'Read a shared artifact (latest, or a specific version).', { name: z.string(), version: z.number().optional() },
      guard(async ({ name, version }) => { const a = artifacts.get(name, version); return `${a.name} v${a.version}/${a.latest} by ${a.meta.by}:\n${untrusted(`artifact:${a.name}`, a.content)}`; })),
    tool('list_artifacts', 'Shared artifacts and their versions.', {}, guard(async () => artifacts.list())),
    tool('remember', 'Store a memory. scope: short (this working session), long (durable fact), episodic (what happened), shared (every agent can recall it), private (encrypted, only you).',
      { scope: z.enum(memory.SCOPES).default('long'), text: z.string() },
      guard(async ({ scope, text }) => `Remembered (${memory.add(sid, scope, text)}).`)),
    tool('recall', 'Search your memories and shared memories by meaning.', { query: z.string(), k: z.number().default(5) },
      guard(async ({ query, k }) => { const r = memory.search(sid, query, { k: Math.min(k, 10) }); return r.length ? r.map(x => `(${x.scope}, ${x.score}) ${x.text}`).join('\n') : 'Nothing relevant.'; })),
  ];
}
