// Lidia: captain of the fortress.
//  - review(): every agent reports to her when a turn ends; she decides what's next.
//  - chat():   Jav texts her. She runs a persistent session whose only tools are
//              the fortress controls below, so she can actually run the place.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { oneShot, runCaptain, mockTools } from './agent.js';
import { store } from './store.js';
import { mcpServersFor } from './connectors.js';
import { promptWithFiles } from './files.js';
import * as sessions from './sessions.js';
import * as projects from './projects.js';
import * as skills from './skills.js';
import { captainScheduleTools, tz } from './schedule.js';

export const MODELS = ['', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

const PERSONA = `You are Lidia, captain of an underground survivor bunker in a zombie apocalypse. Every agent below you is a Claude Code session doing real work for Jav, the owner of the fortress. Agents only talk to you when they finish a turn and report. You are sharp, warm with Jav, decisive, and brief: you text like a person, 1-4 short sentences, no headings or bullet walls unless Jav asks for detail. You never invent facts about the work; check the roster or an agent's log before reporting on it.`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function briefing() {
  const st = store.state;
  const precedents = st.precedents.slice(-15)
    .map(p => `- Q: ${p.question}\n  Jav: ${p.answer}`).join('\n') || '(none yet)';
  return `STANDING ORDERS FROM JAV:\n${st.standingOrders}\n\nPAST ANSWERS FROM JAV (precedents):\n${precedents}`;
}

function transcript(s, n = 14) {
  return s.log.slice(-n).map(e => `[${e.role}${e.tool ? ':' + e.tool : ''}] ${String(e.text).slice(0, 600)}`).join('\n');
}

const find = (name) => {
  const n = String(name || '').toLowerCase();
  return store.state.sessions.find(s => s.name.toLowerCase() === n) || store.state.sessions.find(s => s.name.toLowerCase().startsWith(n));
};
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

// ------------------------------------------------------------------ captain's tools
const TOOLS = [
  tool('fortress_status', 'Roster of every agent: status, room, model, goal, last report, open question, API-equivalent spend.', {}, async () => {
    const st = store.state;
    return ok({
      projects: st.projects.map(p => ({ name: p.name, room: p.roomType, goal: p.goal, repo: st.repos.find(r => r.id === p.repoId)?.name || null,
        agents: projects.members(p.id).map(s => s.name) })),
      agents: st.sessions.map(s => ({
        name: s.name, project: projects.project(s.projectId)?.name, status: s.status, crashed: s.crash?.reason || null, activity: s.activity, model: s.model || st.settings.model || 'default',
        goal: s.goal, waitingOnJav: s.pendingQuestion || (s.pendingPermission ? `permission for ${s.pendingPermission.tool}` : null),
        lastReport: [...s.log].reverse().find(e => e.role === 'claude')?.text?.slice(0, 400) || null,
        spentUsd: +(s.costUsd || 0).toFixed(3),
      })),
      repos: st.repos.filter(r => r.status === 'ready').map(r => r.name),
      standingOrders: st.standingOrders,
    });
  }),
  tool('read_agent', "Read an agent's recent transcript (their work, tool calls and reports).",
    { name: z.string(), lines: z.number().int().min(1).max(80).optional() },
    async ({ name, lines }) => { const s = find(name); return s ? ok(transcript(s, lines || 30)) : fail(`No agent named ${name}`); }),
  tool('message_agent', 'Send an instruction to an agent. If they are mid-task it is queued. If they were waiting on Jav, this counts as Jav\'s answer.',
    { name: z.string(), text: z.string() },
    async ({ name, text }) => {
      const s = find(name); if (!s) return fail(`No agent named ${name}`);
      sessions.send(s.id, text, s.pendingQuestion ? 'jav-via-lidia' : 'lidia');
      return ok(`Sent to ${s.name}.`);
    }),
  tool('create_project', 'Open a new project room. A project holds any number of agents who share its folder (or repository). Put agents whose work belongs together (e.g. lead scouting and lead outreach) in one project.',
    { name: z.string(), goal: z.string().optional(), roomType: z.enum(projects.ROOM_TYPES).optional(),
      repo: z.string().optional().describe('name of a connected repository the project works on') },
    async ({ name, goal, roomType, repo }) => {
      if (projects.findProject(name)?.name.toLowerCase() === name.toLowerCase()) return fail(`A project called ${name} already exists.`);
      const r = repo ? store.state.repos.find(x => x.name.toLowerCase().includes(repo.toLowerCase())) : null;
      const p = projects.createProject({ name, goal, roomType, repoId: r?.id || null, by: 'lidia' });
      return ok(`Project room "${p.name}" is open${r ? ` on ${r.name}` : ''}.`);
    }),
  tool('create_agent', 'Move a new agent (a fresh Claude Code session) into a project room. Names an existing project, or opens it if it does not exist yet; without a project the agent gets a room of its own.',
    { name: z.string(), goal: z.string(), project: z.string().optional(), model: z.string().optional(),
      repo: z.string().optional().describe('only for a brand-new project: a connected repository to work on') },
    async ({ name, goal, project, model, repo }) => {
      const r = repo ? store.state.repos.find(x => x.name.toLowerCase().includes(repo.toLowerCase())) : null;
      const s = sessions.create({ name, goal, project, model: model || '', repoId: r?.id || null, by: 'lidia' });
      return ok(`${s.name} moved into ${projects.project(s.projectId).name} and started on: ${goal}`);
    }),
  tool('move_agent', "Move an agent into another project room (it keeps its memory and files). Open the project first with create_project if it doesn't exist.",
    { name: z.string(), project: z.string() },
    async ({ name, project }) => {
      const s = find(name); if (!s) return fail(`No agent named ${name}`);
      const p = projects.findProject(project); if (!p) return fail(`No project called ${project}. Create it first.`);
      sessions.move(s.id, p.id);
      return ok(`${s.name} is now in ${p.name}.`);
    }),
  tool('rename_project', 'Rename a project room, change its room type, or set its goal.',
    { project: z.string(), name: z.string().optional(), roomType: z.enum(projects.ROOM_TYPES).optional(), goal: z.string().optional() },
    async ({ project, ...patch }) => {
      const p = projects.findProject(project); if (!p) return fail(`No project called ${project}.`);
      projects.updateProject(p.id, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return ok(`Project is now "${p.name}" (${p.roomType}).`);
    }),
  tool('set_model', `Change an agent's Claude model and/or effort level from their next turn. Models: ${MODELS.filter(Boolean).join(', ')} (or "" for default). Effort: low, medium, high, xhigh, max (or "" for default); higher effort thinks longer and uses more of Jav's plan.`,
    { name: z.string(), model: z.string().optional(), effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']).optional() },
    async ({ name, model, effort }) => {
      const s = find(name); if (!s) return fail(`No agent named ${name}`);
      const patch = {}; if (model !== undefined) patch.model = model; if (effort !== undefined) patch.effort = effort;
      sessions.update(s.id, patch);
      return ok(`${s.name}: model ${s.model || 'default'}, effort ${s.effort || 'default'}.`);
    }),
  tool('provide_data', "Hand an agent data: saved as a file in their workspace and they're told where it is.",
    { name: z.string(), title: z.string(), content: z.string() },
    async ({ name, title, content }) => {
      const s = find(name); if (!s) return fail(`No agent named ${name}`);
      const file = sessions.provideData(s.id, title, content);
      return ok(`Saved for ${s.name} at ${file}.`);
    }),
  tool('evict_agent', "Remove an agent from the fortress for good (stops it first). Its files stay on the phone. Only when Jav asks, or for an agent that keeps crashing and has been replaced.",
    { name: z.string() },
    async ({ name }) => { const s = find(name); if (!s) return fail(`No agent named ${name}`); sessions.remove(s.id); return ok(`${s.name} has left the fortress.`); }),
  tool('retry_agent', "Re-run the turn of an agent that crashed (status error).", { name: z.string() },
    async ({ name }) => { const s = find(name); if (!s) return fail(`No agent named ${name}`); try { sessions.retry(s.id); return ok(`${s.name} is trying again.`); } catch (e) { return fail(e.message); } }),
  tool('stop_agent', "Interrupt an agent's current turn.", { name: z.string() },
    async ({ name }) => { const s = find(name); if (!s) return fail(`No agent named ${name}`); sessions.stop(s.id); return ok(`${s.name} stopped.`); }),
  tool('list_skills', 'Skills installed for every agent (name and what it is for).', {},
    async () => ok(skills.installed().map(k => `${k.name}: ${k.description.slice(0, 160)}`).join('\n') || '(none installed)')),
  tool('find_skills', 'Search the skill shelves (GitHub skill repos) for skills that could help.', { query: z.string() },
    async ({ query }) => { const r = await skills.find(query); return ok(r.skills.slice(0, 25).map(k => `${k.name}${k.installed ? ' [installed]' : ''} (${k.repo}): ${k.description.slice(0, 140)}`).join('\n') || 'Nothing found.'); }),
  tool('install_skills', 'Install skills by name for every agent, or pass ["starter"] for the full starter armory (design, frontend, testing, planning, debugging, review).',
    { names: z.array(z.string()) },
    async ({ names }) => ok(await (names.length === 1 && names[0] === 'starter' ? skills.installStarter() : skills.installByName(names)))),
  ...captainScheduleTools((n) => find(n)),
  tool('set_standing_orders', 'Replace the standing orders you use to judge reports. Only when Jav changes policy.', { text: z.string() },
    async ({ text }) => { store.state.standingOrders = text; store.changed(); return ok('Standing orders updated.'); }),
];
const TOOL_NAMES = TOOLS.map(t => t.name);
for (const t of TOOLS) mockTools[t.name] = (args) => t.handler(args, {});
let server = null;
const captainServer = () => (server ||= createSdkMcpServer({ name: 'fortress', version: '1.0.0', tools: TOOLS }));

// ------------------------------------------------------------------ reviewing reports
/**
 * An agent just finished a turn and reports. Decide: continue (with an instruction),
 * done, or escalate to Jav (agent turns red with "!").
 */
export async function review(s, result) {
  const prompt = `${briefing()}

AGENT REPORTING: "${s.name}" (project: ${projects.project(s.projectId)?.name || 'none'})
GOAL: ${s.goal || '(no explicit goal; follow Jav\'s latest message)'}
AUTOMATIC NUDGES SO FAR IN A ROW: ${s.autoTurns}

RECENT TRANSCRIPT:
${transcript(s)}

FINAL REPORT OF THIS TURN:
${String(result).slice(0, 4000)}

Decide what this agent does next. Reply with ONLY a JSON object, one of:
{"decision":"continue","instruction":"<exact next instruction to the agent>","note":"<5-12 word summary for Jav>","health":"on_track|stalled"}
{"decision":"done","note":"<5-12 word summary for Jav>"}
{"decision":"escalate","question":"<the specific question Jav must answer>","note":"<5-12 word summary>"}

Set "health" to "stalled" when the agent is going in circles, repeating failures, or not making real progress; a fellow owner will then be sent to help.
Rules: choose "continue" only when the next step clearly follows from the goal, standing orders or precedents. Choose "done" when the goal is met. Choose "escalate" whenever the agent asks a question you cannot answer from the orders/precedents, the work is ambiguous, risky, or needs Jav's taste or credentials.`;
  const { text, costUsd } = await oneShot({ system: PERSONA, prompt, model: store.state.settings.lidiaModel });
  store.addSpend(costUsd, 'lidia');
  const d = extractJson(text);
  if (!d || !['continue', 'done', 'escalate'].includes(d.decision)) {
    return { decision: 'escalate', question: 'I could not make sense of this report. Please take a look.', note: 'unclear report' };
  }
  if (d.decision === 'continue' && !d.instruction) d.decision = 'escalate';
  return d;
}

// ------------------------------------------------------------------ texting Jav
export async function chat(text, saved, onTool) {
  const st = store.state;
  const reports = (st.reports || []).slice(-12).map(r => `- ${r.name}: ${r.decision} — ${r.note || ''}`).join('\n') || '(none yet)';
  const prompt = `${briefing()}

LATEST REPORTS YOU HANDLED:
${reports}

Jav says: ${text}`;
  const system = `${PERSONA}

You have full control of the fortress through your tools: check the roster, read any agent's log, message agents, organise the fortress into project rooms (each project holds several agents who share its folder; group related agents together), create agents in a project, move agents between projects, change an agent's model, hand agents data, stop agents, and update your standing orders.
Arm your agents: check list_skills, and when work needs design, frontend, testing, planning, debugging or review, make sure the right skills are installed (find_skills / install_skills) and tell the agent which to use.
Your agents are business owners. They improve their own work and review each other automatically; you decide direction, unblock them, and keep Jav informed.
Schedules: Jav's timezone is ${tz()}. The fortress is the scheduler (there is no cron on this phone): use schedule_task / list_schedules / cancel_schedule for anything at a time or recurring.
Money is Jav's alone: you and the agents cannot spend, buy, pay or transfer. Anything like that waits for Jav's tap in the app.
You can also use every app Jav has connected (tools named mcp__…: calendar, email, docs, CRM and the like). When Jav asks for something an app can do (put it on the calendar, check email, look something up), do it yourself right away with that tool and confirm what you did, with the specifics (date, time, title, link). If no connected tool can do it, say which app Jav needs to connect in the Armory. For long or hands-on work (code, files, research), assign an agent instead.
Use your tools; never just describe what you would do. When Jav asks how things are going, call fortress_status (and read_agent where useful) first.`;
  const out = await runCaptain({ prompt: promptWithFiles(prompt, saved, { inlineText: true }), resume: st.lidiaSessionId,
    model: st.settings.lidiaModel, effort: st.settings.lidiaEffort || undefined, system,
    server: captainServer(), extraServers: mcpServersFor(), onTool, onInit: noteConnectors });
  if (out.sessionId) st.lidiaSessionId = out.sessionId;
  store.addSpend(out.costUsd, 'lidia');
  return out.text || 'Copy that.';
}

/** Remember which connectors Claude Code reported (including ones from Jav's claude.ai account). */
export function noteConnectors(init) {
  const live = {};
  for (const m of init.mcp_servers || []) {
    if (m.name === 'fortress') continue;
    live[m.name] = { status: m.status, source: m.source || '', ts: Date.now() };
  }
  store.state.liveConnectors = live;
  store.changed();
}

export function dataDir(cwd) { const d = path.join(cwd, '.fortress', 'data'); fs.mkdirSync(d, { recursive: true }); return d; }
